/**
 * The 5-minute trigger entry point (installed by agent/Onboard.gs). Every
 * tick: heartbeat + kill-switch check, poll for due jobs (already cap-limited
 * server-side), then for each job re-verify the send window independently
 * before sending — README hard rule 6, "the guard lives in the agent."
 */
function tick() {
  // getUserLock, NOT getScriptLock. One deployment now serves every delegator
  // (agent/Web.gs), and a script lock is shared across all of them — so one
  // sender's tick would block every other sender's tick, turning independent
  // agents into a single serialised queue. The thing being guarded is "don't
  // let MY next tick start while MY last one is still running", which is
  // exactly per-user.
  const lock = LockService.getUserLock();
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

    recordTickOutcome_(true, '');
  } catch (e) {
    Logger.log('tick() error: ' + e.message);
    recordTickOutcome_(false, e.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Records the outcome of the last tick in this sender's own UserProperties,
 * so ?whoami=1 can show it.
 *
 * Logger output is only readable by whoever can open the script project —
 * which a delegator cannot, and should not have to. Without this, a tick
 * that failed every single run was indistinguishable from a trigger that had
 * never fired at all: both present as a heartbeat that stops advancing, and
 * the two need completely different fixes. That ambiguity is what made a
 * blank-email bug take this long to find.
 */
function recordTickOutcome_(ok, message) {
  try {
    const props = userProps_();
    props.setProperty('LAST_TICK_AT', new Date().toISOString());
    props.setProperty('LAST_TICK_OK', ok ? '1' : '0');
    props.setProperty('LAST_TICK_ERROR', ok ? '' : String(message || '').slice(0, 400));
  } catch (e) { /* diagnostics must never break the thing they describe */ }
}

/** What ?whoami=1 reports. Absent values mean the trigger has genuinely never run. */
function lastTickStatus_() {
  try {
    const props = userProps_();
    return {
      at: props.getProperty('LAST_TICK_AT') || '',
      ok: props.getProperty('LAST_TICK_OK') === '1',
      error: props.getProperty('LAST_TICK_ERROR') || '',
    };
  } catch (e) {
    return { at: '', ok: false, error: '' };
  }
}

function processJob_(email, secret, job) {
  try {
    // Independent window check: sender-mode uses this agent's own project
    // timezone (appsscript.json), recipient-mode uses the recipient's own tz.
    const timeZone = job.campaign.tz_mode === 'recipient' ? job.recipient.recipient_tz : Session.getScriptTimeZone();
    // Seed sends go to our own mailboxes to check rendering — holding one until
    // 9am tomorrow would make verifying a campaign before launch impractical,
    // and there is no prospect on the other end to disturb.
    if (!job.skipSendWindow && !isWithinSendWindow_(new Date(), timeZone, SEND_WINDOW, formatInZoneViaUtilities_)) {
      Logger.log('Skipping ' + job.queueId + ' — outside send window on agent-side re-check (' + timeZone + ')');
      return; // left pending; central already scheduled it inside the window, this should be rare
    }

    // render_ throws on any unresolved {{token}} — must never send a broken merge.
    // {{unsubscribe}} resolves here, not at queue time, because it's the
    // sending exec's own plus-alias rather than anything about the recipient.
    const extras = { unsubscribe: unsubscribeAddress_() };
    const rendered = render_(job.campaign.body_source, job.recipient, extras,
      { preheader: job.campaign.preheader });
    // escape:false — the subject is plain text, and an escaped one would show
    // the recipient a literal "&amp;" in their inbox list.
    const subject = applyMerge_(job.campaign.subject, mergeDataForRecipient_(job.recipient, extras),
      { escape: false });

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
