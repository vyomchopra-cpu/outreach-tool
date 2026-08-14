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
  // A blank secret_hash means an admin has deliberately cleared it
  // (admin/Delegation.gs resetSenderKey) precisely so this agent can re-key.
  // Without that, an agent whose local secret is lost or unreadable is stuck
  // forever: it cannot authenticate, and it cannot re-register either.
  if (existing && existing.secret_hash) {
    throw new Error('Sender already registered: ' + email + ' — ask an admin to reset the key first');
  }
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
    // Blank = permanent. This path is SELF-onboarding: someone in SENDER_POOL
    // setting themselves up to send under their own name, where there is no
    // third party whose permission is at stake. Delegated sending — an
    // operator sending as someone else — never comes through here; it goes
    // through approveDelegation below, which is the only path that writes a
    // time-boxed sends_expire_at, and only ever from the delegator's own
    // authenticated approval.
    sends_expire_at: '',
    sends_granted_by: email, // themselves
  });
  logEvent_(email, 'onboard', { senderEmail: email, detail: { action: 'register' } });
}

/**
 * ── Delegated sending ────────────────────────────────────────────────────
 *
 * The exec opens one link, lands on their own agent page (executeAs
 * USER_ACCESSING, so Google has authenticated them and the page runs as
 * them), and approves. These three functions are what that page calls.
 *
 * gateway/ is ANYONE_ANONYMOUS and therefore cannot verify the email the
 * agent asserts. The claim token is what closes that: minted by
 * admin/Delegation.gs, unguessable, delivered only to the delegator's own
 * address, matched against the row's delegator_email, and burned on use. A
 * caller without the token cannot act on a delegation at all; a caller with
 * it can only act on the one delegation it belongs to, and only once.
 *
 * Worth being precise about what a stolen token would and would not buy:
 * it could mark a delegation approved and register a sender row, but it
 * could NOT send anything. Sending requires the delegator's own OAuth grant
 * inside their own Google account, which no token can forge.
 */
/**
 * The token stays on the row after a decision rather than being overwritten.
 * Single-use is enforced by the status check in approve/deny, not by
 * destroying the key — and keeping it means "already approved" and "never
 * existed" stay distinguishable. When they were not, a link that had simply
 * been mistyped reported the same thing as one that had been used, and the
 * only available advice was "ask for a fresh one" no matter which had
 * happened.
 */
function findDelegationByToken_(token) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('Missing approval token');
  const rows = readRows_('Delegations', function (r) { return String(r.claim_token).trim() === clean; });
  if (!rows.length) {
    throw new Error('This approval link is not recognised — it looks incomplete or mistyped. '
      + 'Ask for the link to be sent again, and open it without editing it.');
  }
  return rows[0];
}

/** Checks the link belongs to whoever is actually signed in, so a forwarded link cannot be approved by the wrong person. */
function requireDelegator_(row, assertedEmail) {
  const asserted = String(assertedEmail || '').toLowerCase().trim();
  if (asserted !== row.delegator_email) {
    throw new Error('This approval was addressed to ' + row.delegator_email
      + ', but you are signed in as ' + (asserted || 'nobody') + '.');
  }
}

/** Read-only: what the exec sees before deciding. Does not burn the token. */
function lookupDelegation(token, assertedEmail) {
  const row = findDelegationByToken_(token);
  requireDelegator_(row, assertedEmail);
  return {
    id: row.id,
    requestedBy: row.requested_by,
    daysRequested: row.days_requested,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * The authorization itself. `days` is the delegator's own choice — it is NOT
 * validated against days_requested, because the whole point is that the
 * number is theirs to set. They may grant less than was asked for, and
 * routinely should.
 *
 * mode 'blanket'      — the operator may send anything for the window
 *      'per_campaign' — each campaign additionally needs their sign-off
 *                       before it sends (admin/Campaign.gs approveCampaignAsExec)
 */
function approveDelegation(token, assertedEmail, secretPlain, days, mode, displayName, timezone) {
  const row = findDelegationByToken_(token);
  requireDelegator_(row, assertedEmail);
  if (row.status !== 'pending') {
    throw new Error('This request was already ' + row.status + '. Ask for a fresh link.');
  }

  const n = Math.floor(Number(days));
  if (!isFinite(n) || n < 1 || n > 365) throw new Error('Days must be a whole number between 1 and 365');
  if (mode !== 'blanket' && mode !== 'per_campaign') throw new Error('Unknown approval mode: ' + mode);

  const email = row.delegator_email;
  const expiresAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  const existing = findRow_('Senders', email);

  // Upsert, not insert: an exec re-approving after a window lapses is the
  // normal case, and must not hit registerSender's "already registered" wall.
  upsertRow_('Senders', {
    email: email,
    display_name: displayName || (existing && existing.display_name) || email.split('@')[0],
    status: 'active',
    ramp_start_date: (existing && existing.ramp_start_date) || new Date(),
    daily_cap_override: (existing && existing.daily_cap_override) || '',
    timezone: timezone || (existing && existing.timezone) || 'Asia/Kolkata',
    agent_version: (existing && existing.agent_version) || '',
    last_heartbeat: new Date(),
    secret_hash: sha256Hex_(secretPlain),
    consent_recorded_at: new Date(),
    capabilities: (existing && existing.capabilities) || null,
    sends_expire_at: expiresAt,
    sends_granted_by: email, // themselves — the only value this may ever hold on this path
  });

  // Burn the token in the same step that grants the capability.
  updateRow_('Delegations', row.id, {
    status: 'approved',
    days_approved: n,
    approval_mode: mode,
    decided_at: new Date(),
  });

  logEvent_(email, 'consent', {
    senderEmail: email,
    detail: { action: 'approve_delegation', delegationId: row.id, requestedBy: row.requested_by,
      daysRequested: row.days_requested, daysApproved: n, mode: mode },
  });

  return { email: email, days: n, mode: mode, expiresAt: expiresAt.toISOString(), requestedBy: row.requested_by };
}

/** Declining is a first-class outcome, recorded as plainly as approval. Burns the token too — a "no" should not be re-openable by clicking the link again. */
function denyDelegation(token, assertedEmail) {
  const row = findDelegationByToken_(token);
  requireDelegator_(row, assertedEmail);
  if (row.status !== 'pending') throw new Error('This request was already ' + row.status + '.');

  updateRow_('Delegations', row.id, {
    status: 'denied', decided_at: new Date(),
  });
  logEvent_(row.delegator_email, 'admin_action', {
    senderEmail: row.delegator_email,
    detail: { action: 'deny_delegation', delegationId: row.id, requestedBy: row.requested_by },
  });
  return { denied: true, requestedBy: row.requested_by };
}

/**
 * What the delegator sees about their own account: is anything live, until
 * when, how much has gone out under their name, and who is running it.
 *
 * Lending your name to someone else's outreach is only reasonable if you can
 * see what went out. Without this the delegator's only options are to trust
 * the operator completely or to trawl their own Sent folder, and the first
 * one is not a security model.
 */
function senderSelfStatus(email, secret) {
  const sender = requireSender_(email, secret);
  const now = new Date();
  const expiresAt = sender.sends_expire_at ? new Date(sender.sends_expire_at) : null;
  const expired = !!expiresAt && expiresAt <= now;

  const sent = readRows_('Queue', function (q) {
    return q.sender_email === email && q.status === 'sent';
  });
  let lastSentAt = null;
  sent.forEach(function (q) {
    const t = q.sent_at ? new Date(q.sent_at) : null;
    if (t && (!lastSentAt || t > lastSentAt)) lastSentAt = t;
  });

  // Who has been asking to use this name — shown so the delegator can spot an
  // operator they did not expect, rather than only the aggregate count.
  const operators = {};
  readRows_('Delegations', function (r) { return r.delegator_email === email; })
    .forEach(function (r) { operators[r.requested_by] = true; });

  return {
    canSend: sender.status === 'active' && !expired,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    daysLeft: (!expired && expiresAt) ? Math.ceil((expiresAt - now) / 86400000) : null,
    sentCount: sent.length,
    lastSentAt: lastSentAt ? lastSentAt.toISOString() : null,
    operators: Object.keys(operators),
  };
}

/**
 * Lets the delegator stop everything themselves, from their own page, with no
 * admin in the loop. Authenticated by the sender secret their own agent holds
 * — no claim token needed, since the token is long since burned by the time
 * they might want this.
 */
function revokeOwnDelegation(email, secret) {
  requireSender_(email, secret);
  updateRow_('Senders', email, { sends_expire_at: new Date(0), status: 'revoked' });
  readRows_('Delegations', function (r) { return r.delegator_email === email && r.status === 'approved'; })
    .forEach(function (r) {
      updateRow_('Delegations', r.id, { status: 'revoked', revoked_by: email, revoked_at: new Date() });
    });
  logEvent_(email, 'revoke', { senderEmail: email, detail: { action: 'revoke_own_delegation' } });
  return { revoked: true };
}

/** True once a time-boxed sending grant has lapsed. Blank sends_expire_at means permanent — never expires. */
function senderSendingExpired_(senderRow) {
  return !!senderRow.sends_expire_at && new Date(senderRow.sends_expire_at) <= new Date();
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
  // 'expired' is derived, not stored — a time-boxed grant lapsing shouldn't
  // require a write to flip a status column, and the agent needs to see it
  // reflected the moment the clock passes expires_at, not on whatever cadence
  // something else might re-check the Sheet.
  const status = senderSendingExpired_(sender) ? 'expired' : sender.status;
  return { killSwitch: isKillSwitchOn_(), status: status };
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

/**
 * A one-off test send: arbitrary address, arbitrary content, sent through the
 * real render/merge/MIME/transport path so that "it worked" means something.
 *
 * Kept distinct from seed: on purpose, because the two need DIFFERENT rules
 * and collapsing them would be a real bug. Both skip the daily cap and the
 * send window — neither is a prospect touch. But a seed goes to SEED_MAILBOXES,
 * a fixed list of our own inboxes, so skipping the suppression check is
 * harmless; a test send goes wherever the operator types, which could be
 * someone who has unsubscribed. Test sends are suppression-checked like any
 * real send.
 */
const TEST_PREFIX = 'test:';

function isSeedRecipientId_(recipientId) {
  return String(recipientId || '').indexOf(SEED_PREFIX) === 0;
}

function isTestRecipientId_(recipientId) {
  return String(recipientId || '').indexOf(TEST_PREFIX) === 0;
}

/** Neither seed nor test is a prospect touch, so neither consumes the cap or waits for the window. */
function isSyntheticRecipientId_(recipientId) {
  return isSeedRecipientId_(recipientId) || isTestRecipientId_(recipientId);
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
    // Strip whichever prefix this is — 'seed:' and 'test:' are the same
    // length, but slicing a hard-coded one would silently mangle the address
    // if that ever stops being true.
    email: recipientId.slice(recipientId.indexOf(':') + 1),
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
    if (isSyntheticRecipientId_(q.recipient_id)) return false;
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
  if (senderSendingExpired_(sender)) return []; // the window the delegator approved has run out — see approveDelegation

  const capToday = capForSenderToday_(sender.ramp_start_date, new Date(), DAILY_CAP_RAMP, sender.daily_cap_override || null);
  const sentToday = sentTodayCountFor_(sender);
  const allowance = remainingCapToday_(capToday, sentToday);
  if (allowance <= 0) return [];

  const now = new Date();
  const due = readRows_('Queue', function (q) {
    return q.sender_email === email && q.status === 'pending' && new Date(q.due_at_utc) <= now;
  }).sort(function (a, b) { return new Date(a.due_at_utc) - new Date(b.due_at_utc); });

  // Neither seeds nor test sends are prospect touches: both bypass the daily
  // allowance and, on the agent side, the send window — a render check or a
  // test to a known address at 9pm harms nobody, and making one wait until
  // tomorrow morning would make verifying anything impractical.
  const synthetic = due.filter(function (q) { return isSyntheticRecipientId_(q.recipient_id); });
  const prospects = due.filter(function (q) { return !isSyntheticRecipientId_(q.recipient_id); });

  return synthetic.concat(prospects.slice(0, allowance)).map(function (q) {
    const isSynthetic = isSyntheticRecipientId_(q.recipient_id);
    const recipient = isSynthetic ? syntheticSeedRecipient_(q.recipient_id) : findRow_('Recipients', q.recipient_id);
    const campaign = findRow_('Campaigns', q.campaign_id);
    if (!recipient) return null;

    // Suppression is skipped ONLY for seeds, which go to SEED_MAILBOXES — a
    // fixed list of our own inboxes. A test send goes wherever the operator
    // typed, so it is checked exactly like a real send: someone who has
    // unsubscribed must not receive mail because it was labelled a test.
    if (!isSeedRecipientId_(q.recipient_id)
      && (recipient.status === 'suppressed' || isSuppressed_(recipient.email))) return null;

    return {
      queueId: q.id,
      campaign: campaign,
      recipient: recipient,
      idempotencyKey: q.idempotency_key,
      senderDisplayName: sender.display_name,
      skipSendWindow: isSynthetic,
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
  if (!isSyntheticRecipientId_(q.recipient_id)) updateRow_('Recipients', q.recipient_id, { status: 'sent' });
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
    if (!isSyntheticRecipientId_(q.recipient_id)) {
      updateRow_('Recipients', q.recipient_id, { status: 'failed', status_reason: errorMessage });
    }
  } else {
    const nextDue = new Date(Date.now() + backoffMinutes_(attempts) * 60000);
    updateRowAt_('Queue', q._row, { attempts: attempts, error: errorMessage, due_at_utc: nextDue });
  }
}
