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
 * Stub — full implementation is Stage 5 (docs/BUILD_ORDER.md), which adds
 * reply auto-pause and bounce/unsuppress handling. Kept here as a no-op body
 * so the doPost whitelist in Code.gs (which references it by name) is valid
 * and Stage 4 is independently deployable before Stage 5 lands.
 */
function reportSignals(email, secret, signals) {
  requireSender_(email, secret);
  // TODO Stage 5: appendRow_('Signals', ...) per signal, reply auto-pause,
  // bounce -> Health rollup, unsubscribe -> addSuppression_. Never touch body/snippet.
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
