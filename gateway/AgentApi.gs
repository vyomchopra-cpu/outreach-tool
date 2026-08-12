/**
 * Everything a sender agent calls over HTTP, via doPost in this project's
 * own Code.gs — a project SEPARATE from admin/, deployed executeAs:"USER_DEPLOYING".
 *
 * Why separate: this used to live in admin/ (executeAs:"USER_ACCESSING"),
 * authenticated by Session.getActiveUser() (the caller's real Google
 * identity) PLUS a per-sender secret. That two-factor design was correct on
 * paper, but in practice, this Workspace's OAuth policy rejects
 * Bearer-token calls from one unverified internal Apps Script project to
 * another's USER_ACCESSING web app — Google's front door returns a bare
 * "WWW-Authenticate: Bearer" 401 before the script ever runs, even for a
 * same-domain, same-person token, discovered empirically during pilot
 * onboarding (see git history / docs/ARCHITECTURE.md §3 for the full
 * diagnosis). executeAs:"USER_DEPLOYING" sidesteps this because Google doesn't need to
 * resolve the caller's identity at all — the script always runs as its
 * owner regardless of who calls it.
 *
 * The honest trade-off: Session.getActiveUser() inside this project always
 * returns the deploying admin, never the real caller, so identity can no
 * longer be cross-checked against the claimed sender email. Authentication
 * for this narrow surface is now secret-only (requireSender_ below) — a
 * 144-bit random value (two UUIDs) generated at onboarding, hashed at rest,
 * never transmitted except over HTTPS to this one endpoint. This surface
 * can only poll for pre-approved work and report status/signals; it cannot
 * create or launch campaigns — that stays behind the admin console's own,
 * untouched, fully identity-gated deployment (admin/Code.gs, USER_ACCESSING).
 */

function sha256Hex_(text) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  return raw.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

function requireSender_(email, secret) {
  const row = findRow_('Senders', email);
  if (!row) throw new Error('Unknown sender: ' + email);
  if (row.secret_hash !== sha256Hex_(secret)) throw new Error('Bad secret for ' + email);
  return row;
}

/**
 * First call an agent ever makes. gateway/ is deployed access:ANYONE_ANONYMOUS
 * (see file header) — no Google auth layer, no identity cross-check possible.
 * Without a guard, anyone on the internet could pre-register any email
 * before the real exec does, since there's no existing secret_hash to check
 * yet. SENDER_POOL (shared/Config.gs, admin-controlled) is the guard: only
 * an email an admin has explicitly listed as an intended pilot sender can
 * ever be registered. This doesn't verify the caller — SENDER_POOL is a
 * config allowlist, not proof of who's calling — but it closes the "squat
 * an arbitrary address" hole down to "squat one of a small, admin-chosen set."
 */
function registerSender(email, secretPlain, displayName, timezone) {
  const allowed = SENDER_POOL.some(function (s) { return s.email === email; });
  if (!allowed) throw new Error(email + ' is not in SENDER_POOL — an admin must add it (shared/Config.gs) before this account can register');
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

/**
 * capabilities is what the agent reports it can actually do right now
 * (agent/Diagnostics.gs currentCapabilities_) — notably whether the Gmail API
 * is reachable, which determines whether reply/bounce detection works at all.
 * Stored so an admin can see a degraded sender in the Sheet rather than
 * inferring it from missing Signals rows.
 */
function heartbeat(email, secret, agentVersion, capabilities) {
  const sender = requireSender_(email, secret);
  updateRow_('Senders', email, {
    last_heartbeat: new Date(),
    agent_version: agentVersion,
    capabilities: capabilities || null,
  });
  return { killSwitch: isKillSwitchOn_(), status: sender.status };
}

/**
 * Seed sends go to our own test mailboxes, not to prospects. They are queued
 * with a synthetic recipient id rather than a Recipients row, because there is
 * no prospect to record — which means every lookup path has to know about them
 * explicitly. (It didn't, originally: pollDueJobs looked the id up in
 * Recipients, got null, and silently dropped the job, so seed sends were
 * queued and never delivered.)
 */
const SEED_PREFIX = 'seed:';

function isSeedRecipientId_(recipientId) {
  return String(recipientId || '').indexOf(SEED_PREFIX) === 0;
}

/**
 * A seed send still has to exercise the real merge path, so it carries the
 * same placeholder values the admin console's preview uses — if a merge tag
 * would break for a prospect, it breaks here too, which is the point.
 */
function syntheticSeedRecipient_(recipientId) {
  return {
    id: recipientId,
    campaign_id: '',
    email: recipientId.slice(SEED_PREFIX.length),
    first_name: 'Sam',
    last_name: 'Prospect',
    company: 'Example Corp',
    title: 'VP Engineering',
    recipient_tz: '',
    custom: {},
    assigned_sender: '',
    status: 'queued',
    status_reason: '',
  };
}

/** Prospect touches only — seed sends to our own mailboxes must not consume the outreach cap. */
function sentTodayCountFor_(senderRow) {
  const todayLocal = formatInZoneViaUtilities_(new Date(), senderRow.timezone).slice(0, 10);
  return readRows_('Queue', function (q) {
    if (q.sender_email !== senderRow.email || q.status !== 'sent' || !q.sent_at) return false;
    if (isSeedRecipientId_(q.recipient_id)) return false;
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

  // Seed sends are not prospect touches: they bypass the daily allowance
  // (their volume is bounded by SEED_MAILBOXES) and, on the agent side, the
  // send window — a render check to our own inbox at 9pm harms nobody, and
  // requiring one to wait until tomorrow morning would make verifying a
  // campaign before launch impractical.
  const seeds = due.filter(function (q) { return isSeedRecipientId_(q.recipient_id); });
  const prospects = due.filter(function (q) { return !isSeedRecipientId_(q.recipient_id); });

  return seeds.concat(prospects.slice(0, allowance)).map(function (q) {
    const isSeed = isSeedRecipientId_(q.recipient_id);
    const recipient = isSeed ? syntheticSeedRecipient_(q.recipient_id) : findRow_('Recipients', q.recipient_id);
    const campaign = findRow_('Campaigns', q.campaign_id);
    if (!recipient) return null;
    if (!isSeed && (recipient.status === 'suppressed' || isSuppressed_(recipient.email))) return null;
    return {
      queueId: q.id,
      campaign: campaign,
      recipient: recipient,
      idempotencyKey: q.idempotency_key,
      senderDisplayName: sender.display_name,
      isSeed: isSeed,
    };
  }).filter(Boolean);
}

function reportSent(email, secret, queueId, gmailMessageId) {
  requireSender_(email, secret);
  const q = findRow_('Queue', queueId);
  if (!q) throw new Error('No such queue row: ' + queueId);
  if (q.status === 'sent') return; // idempotent — already recorded, agent retried the report
  updateRowAt_('Queue', q._row, { status: 'sent', sent_at: new Date(), sent_message_id: gmailMessageId });
  // Seed rows have no Recipients row to update — updateRow_ would throw.
  if (!isSeedRecipientId_(q.recipient_id)) updateRow_('Recipients', q.recipient_id, { status: 'sent' });
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
    if (!isSeedRecipientId_(q.recipient_id)) {
      updateRow_('Recipients', q.recipient_id, { status: 'failed', status_reason: errorMessage });
    }
  } else {
    const nextDue = new Date(Date.now() + backoffMinutes_(attempts) * 60000);
    updateRowAt_('Queue', q._row, { attempts: attempts, error: errorMessage, due_at_utc: nextDue });
  }
}
