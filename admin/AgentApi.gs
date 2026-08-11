/**
 * Everything a sender agent calls over HTTP (via doPost in Code.gs). Guarded
 * by requireSender_ instead of requireAdmin_ — the caller here is an exec's
 * agent, never an admin. Auth is two-layered per docs/ARCHITECTURE.md §3:
 * the Google identity on the request (Session.getActiveUser(), reliable
 * within one Workspace domain) plus a per-sender shared secret issued at
 * onboarding, hashed at rest in Senders.secret_hash.
 */

function sha256Hex_(text) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  return raw.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

function requireSender_(email, secret) {
  const row = findRow_('Senders', email);
  if (!row) throw new Error('Unknown sender: ' + email);
  const activeIdentity = Session.getActiveUser().getEmail();
  if (activeIdentity && activeIdentity !== email) {
    throw new Error('Identity mismatch: token belongs to ' + activeIdentity + ', claimed ' + email);
  }
  if (row.secret_hash !== sha256Hex_(secret)) throw new Error('Bad secret for ' + email);
  return row;
}

/**
 * First call an agent ever makes. The caller supplies its own secret (a
 * fresh random value it generated and will keep in its own PropertiesService
 * from then on) — the central Sheet only ever stores the hash.
 */
function registerSender(email, secretPlain, displayName, timezone) {
  const identity = Session.getActiveUser().getEmail();
  if (identity !== email) throw new Error('Can only register your own account (' + identity + ')');
  const existing = findRow_('Senders', email);
  if (existing) throw new Error('Sender already registered: ' + email + ' — contact an admin to re-key');
  upsertRow_('Senders', {
    email: email,
    display_name: displayName,
    status: 'active',
    ramp_start_date: new Date(),
    daily_cap_override: '',
    timezone: timezone,
    agent_version: '',
    last_heartbeat: new Date(),
    secret_hash: sha256Hex_(secretPlain),
    consent_recorded_at: new Date(),
  });
  logEvent_(email, 'onboard', { senderEmail: email, detail: { action: 'register' } });
}

function heartbeat(email, secret, agentVersion) {
  const sender = requireSender_(email, secret);
  updateRow_('Senders', email, { last_heartbeat: new Date(), agent_version: agentVersion });
  return { killSwitch: isKillSwitchOn_(), status: sender.status };
}

function sentTodayCountFor_(senderRow) {
  const todayLocal = formatInZoneViaUtilities_(new Date(), senderRow.timezone).slice(0, 10);
  return readRows_('Queue', function (q) {
    if (q.sender_email !== senderRow.email || q.status !== 'sent' || !q.sent_at) return false;
    return formatInZoneViaUtilities_(new Date(q.sent_at), senderRow.timezone).slice(0, 10) === todayLocal;
  }).length;
}

/**
 * Returns due jobs, hard-capped to what's left of today's allowance
 * (remainingCapToday_) so a backlog from downtime can never be sent as a
 * burst. Returns [] outright if the kill switch is on or the sender isn't active.
 */
function pollDueJobs(email, secret) {
  const sender = requireSender_(email, secret);
  if (isKillSwitchOn_()) return [];
  if (sender.status !== 'active') return [];

  const capToday = capForSenderToday_(sender.ramp_start_date, new Date(), DAILY_CAP_RAMP, sender.daily_cap_override || null);
  const sentToday = sentTodayCountFor_(sender);
  const allowance = remainingCapToday_(capToday, sentToday);
  if (allowance <= 0) return [];

  const now = new Date();
  const due = readRows_('Queue', function (q) {
    return q.sender_email === email && q.status === 'pending' && new Date(q.due_at_utc) <= now;
  }).sort(function (a, b) { return new Date(a.due_at_utc) - new Date(b.due_at_utc); });

  return due.slice(0, allowance).map(function (q) {
    const recipient = findRow_('Recipients', q.recipient_id);
    const campaign = findRow_('Campaigns', q.campaign_id);
    if (!recipient || recipient.status === 'suppressed' || isSuppressed_(recipient.email)) return null;
    return {
      queueId: q.id,
      campaign: campaign,
      recipient: recipient,
      idempotencyKey: q.idempotency_key,
      senderDisplayName: sender.display_name,
    };
  }).filter(Boolean);
}

function reportSent(email, secret, queueId, gmailMessageId) {
  requireSender_(email, secret);
  const q = findRow_('Queue', queueId);
  if (!q) throw new Error('No such queue row: ' + queueId);
  if (q.status === 'sent') return; // idempotent — already recorded, agent retried the report
  updateRowAt_('Queue', q._row, { status: 'sent', sent_at: new Date(), sent_message_id: gmailMessageId });
  updateRow_('Recipients', q.recipient_id, { status: 'sent' });
  logEvent_(email, 'send', { campaignId: q.campaign_id, recipientId: q.recipient_id, senderEmail: email, detail: { queueId: queueId } });
}

/**
 * Cancels every still-pending Queue row for one recipient (used on reply/unsub).
 * A no-op today beyond a single row, since v1 schedules one Queue row per
 * Recipient — kept general so it's already correct once multi-touch
 * sequences exist (docs/BUILD_ORDER.md notes this as a known v1 scope gap).
 */
function cancelPendingQueueForRecipient_(recipientId, reason) {
  readRows_('Queue', function (q) { return q.recipient_id === recipientId && q.status === 'pending'; })
    .forEach(function (q) { updateRowAt_('Queue', q._row, { status: 'cancelled', error: reason }); });
}

/** Suppression is global (docs/SCHEMA.md) — cancels pending sends to this email across every campaign, not just the one it came from. */
function cancelPendingQueueForEmail_(email, reason) {
  const recipientRows = readRows_('Recipients', function (r) { return r.email === email; });
  recipientRows.forEach(function (r) { cancelPendingQueueForRecipient_(r.id, reason); });
}

function findRecipientByRfcMessageId_(rfcMessageId) {
  if (!rfcMessageId) return null;
  const q = readRows_('Queue', function (row) { return row.sent_message_id === rfcMessageId; })[0];
  if (!q) return null;
  return findRow_('Recipients', q.recipient_id);
}

/** bump today's bounce count for a sender and trip the global kill switch if the rolling rate breaches threshold. */
function recordBounceAndCheckHalt_(senderEmail) {
  const sender = findRow_('Senders', senderEmail);
  if (!sender) return;
  const todayLocal = formatInZoneViaUtilities_(new Date(), sender.timezone).slice(0, 10);
  const sentToday = sentTodayCountFor_(sender);
  const existing = readRows_('Health', function (h) { return h.date === todayLocal && h.sender_email === senderEmail; })[0];
  const bounced = (existing ? existing.bounced : 0) + 1;
  const bounceRate = sentToday > 0 ? (bounced / sentToday) * 100 : 0;
  upsertHealth_({
    date: todayLocal, sender_email: senderEmail,
    sent: sentToday, bounced: bounced,
    replied: existing ? existing.replied : 0,
    unsubscribed: existing ? existing.unsubscribed : 0,
    bounce_rate: bounceRate,
    complaint_rate: existing ? existing.complaint_rate : 0,
  });
  if (bounceRate > GOVERNANCE.bounceRateHaltPct && sentToday >= 5) { // ignore the noisy small-sample-size regime
    setKillSwitch_(true, 'system:bounce-rate-breach:' + senderEmail);
    logEvent_('system', 'halt', { senderEmail: senderEmail, detail: { reason: 'bounce_rate', rate: bounceRate } });
  }
}

/**
 * Tier B in practice: appends the header-only signal row, then reacts —
 * reply cancels remaining sends to that person, bounce feeds the circuit
 * breaker, unsubscribe adds a permanent global suppression. Never reads or
 * stores a message body (docs/SCHEMA.md Signals has no body-shaped column,
 * and test/qa.mjs asserts that structurally).
 */
function reportSignals(email, secret, signals) {
  requireSender_(email, secret);
  (signals || []).forEach(function (sig) {
    const recipient = findRecipientByRfcMessageId_(sig.in_reply_to);
    appendRow_('Signals', {
      ts: new Date(),
      sender_email: email,
      kind: sig.kind,
      gmail_message_id: sig.gmail_message_id,
      in_reply_to: sig.in_reply_to || '',
      from_header: sig.from_header || '',
      matched_recipient_id: recipient ? recipient.id : '',
    });

    if (sig.kind === 'reply' && recipient) {
      updateRow_('Recipients', recipient.id, { status: 'replied' });
      cancelPendingQueueForRecipient_(recipient.id, 'recipient replied');
      logEvent_(email, 'admin_action', { recipientId: recipient.id, senderEmail: email, detail: { action: 'auto_pause_on_reply' } });
    } else if (sig.kind === 'bounce') {
      if (recipient) updateRow_('Recipients', recipient.id, { status: 'bounced' });
      recordBounceAndCheckHalt_(email);
    } else if (sig.kind === 'unsubscribe' && sig.from_header) {
      addSuppression_(sig.from_header, 'unsubscribe', 'sender:' + email);
      cancelPendingQueueForEmail_(sig.from_header, 'unsubscribed');
    }
  });
}

function reportFailed(email, secret, queueId, errorMessage) {
  requireSender_(email, secret);
  const q = findRow_('Queue', queueId);
  if (!q) throw new Error('No such queue row: ' + queueId);
  const attempts = (q.attempts || 0) + 1;
  if (attempts >= GOVERNANCE.maxSendAttempts) {
    updateRowAt_('Queue', q._row, { status: 'failed', attempts: attempts, error: errorMessage });
    updateRow_('Recipients', q.recipient_id, { status: 'failed', status_reason: errorMessage });
  } else {
    const nextDue = new Date(Date.now() + backoffMinutes_(attempts) * 60000);
    updateRowAt_('Queue', q._row, { attempts: attempts, error: errorMessage, due_at_utc: nextDue });
  }
}
