/**
 * The 5-minute trigger entry point (installed by agent/Onboard.gs). Every
 * tick: heartbeat + kill-switch check, poll for due jobs (already cap-limited
 * server-side), then for each job re-verify the send window independently
 * before sending — README hard rule 6, "the guard lives in the agent."
 */
function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // a previous tick is still running — skip, don't stack up
  try {
    const email = getMyEmail_();
    const secret = getOrCreateSecret_();

    const hb = callCentral_('heartbeat', [email, secret, AGENT_VERSION, currentCapabilities_()]);
    if (hb.killSwitch) { Logger.log('Kill switch on — idle.'); return; }
    if (hb.status !== 'active') { Logger.log('Sender status is ' + hb.status + ' — idle.'); return; }

    const jobs = callCentral_('pollDueJobs', [email, secret]);
    jobs.forEach(function (job) { processJob_(email, secret, job); });

    // Signals need the Gmail API. When it's unavailable the agent is still
    // fully functional for sending, so this is skipped quietly rather than
    // retried and logged as an error every five minutes forever.
    if (gmailApiAvailable_()) {
      try {
        scanSignals_();
      } catch (signalErr) {
        Logger.log('scanSignals_ error: ' + signalErr.message);
      }
    }
  } catch (e) {
    Logger.log('tick() error: ' + e.message);
  } finally {
    lock.releaseLock();
  }
}

function processJob_(email, secret, job) {
  try {
    // Independent window check: sender-mode uses this agent's own project
    // timezone (appsscript.json), recipient-mode uses the recipient's own tz.
    const timeZone = job.campaign.tz_mode === 'recipient' ? job.recipient.recipient_tz : Session.getScriptTimeZone();
    if (!isWithinSendWindow_(new Date(), timeZone, SEND_WINDOW, formatInZoneViaUtilities_)) {
      Logger.log('Skipping ' + job.queueId + ' — outside send window on agent-side re-check (' + timeZone + ')');
      return; // left pending; central already scheduled it inside the window, this should be rare
    }

    // render_ throws on any unresolved {{token}} — must never send a broken merge.
    // {{unsubscribe}} resolves here, not at queue time, because it's the
    // sending exec's own plus-alias rather than anything about the recipient.
    const extras = { unsubscribe: unsubscribeAddress_() };
    const rendered = render_(job.campaign.body_source, job.recipient, extras);
    const subject = applyMerge_(job.campaign.subject, mergeDataForRecipient_(job.recipient, extras));

    // sendMessage_ picks the transport (agent/Transport.gs). Under the
    // MailApp fallback rfcMessageId is '' — reply matching is impossible for
    // that send, which is why campaigns stay single-touch while the Gmail API
    // is unavailable (see docs/GCP_CONSTRAINT.md).
    const sent = sendMessage_({
      fromDisplayName: job.senderDisplayName,
      fromEmail: email,
      toEmail: job.recipient.email,
      replyTo: replyToAddress_(),
      subject: subject,
      html: rendered.html,
      text: rendered.text,
    });
    callCentral_('reportSent', [email, secret, job.queueId, sent.rfcMessageId || '']);
  } catch (e) {
    try {
      callCentral_('reportFailed', [email, secret, job.queueId, String(e.message).slice(0, 500)]);
    } catch (reportErr) {
      Logger.log('Also failed to report failure for ' + job.queueId + ': ' + reportErr.message);
    }
  }
}
