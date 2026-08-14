/**
 * "Let me send mail from your account for N days."
 *
 * This is the tool's whole reason to exist. An operator (often not technical,
 * often junior to the person they're asking) needs to run outreach that goes
 * out under a senior exec's name. The exec cannot be onboarded onto an
 * outreach platform, cannot hand over a password, and should not have to
 * think about this again after one click.
 *
 * So: the operator raises a request here, sends the exec ONE link, and the
 * exec — signed in as himself, on his own agent page, granting his own Google
 * consent — picks the number of days and approves. His click is the
 * authorization. Nothing in this file lets an operator set their own access.
 *
 * The days are HIS to choose. requestDelegation records what was asked for;
 * gateway/AgentApi.gs's approveDelegation records what he actually granted,
 * which may be less. Only revocation is available to the operator side, and
 * that only ever removes access, never extends it.
 */

/** Unguessable, single-use, and the only thing that lets the anonymous gateway trust the approval. Two UUIDs — the same strength as the per-sender secret. */
function newClaimToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function newDelegationId_() {
  return 'dg_' + Utilities.getUuid().split('-')[0];
}

/**
 * Raises the ask. Deliberately does NOT create any capability — the row is
 * inert until the delegator approves it. Returns the link to send them.
 */
function requestDelegation(delegatorEmail, days, reason) {
  const requester = requireAdmin_();

  const delegator = String(delegatorEmail || '').toLowerCase().trim();
  if (!isValidEmail_(delegator)) throw new Error('Not a valid email: ' + delegatorEmail);
  if (!isAllowedAgentUser_(delegator)) {
    throw new Error('You can only ask a @' + REPLY_TO_DOMAIN + ' colleague'
      + ' (or an address listed in EXTERNAL_TEST_DELEGATORS, for testing the flow)');
  }
  if (delegator === requester) {
    throw new Error('You cannot ask yourself — to send under your own name, onboard yourself as a sender instead');
  }

  const n = Math.floor(Number(days));
  if (!isFinite(n) || n < 1 || n > 365) throw new Error('Days must be a whole number between 1 and 365');

  // One live ask at a time per person, so a forgotten request can't be
  // approved months later by someone clicking an old link in their inbox.
  const existing = readRows_('Delegations', function (r) {
    return r.delegator_email === delegator && r.status === 'pending';
  });
  existing.forEach(function (r) {
    updateRow_('Delegations', r.id, { status: 'superseded', decided_at: new Date() });
  });

  const id = newDelegationId_();
  const token = newClaimToken_();
  appendRow_('Delegations', {
    id: id, claim_token: token, requested_by: requester, delegator_email: delegator,
    days_requested: n, reason: reason || '', status: 'pending', created_at: new Date(),
    days_approved: '', approval_mode: '', decided_at: '', revoked_by: '', revoked_at: '',
  });
  logEvent_(requester, 'admin_action', {
    senderEmail: delegator,
    detail: { action: 'request_delegation', days: n, superseded: existing.length },
  });

  return { id: id, approvalUrl: delegationApprovalUrl_(token, delegator), delegatorEmail: delegator, days: n };
}

/**
 * The single link the delegator opens. Points at the agent, not this console
 * — that is where their own Google consent and their own send authorization
 * live.
 *
 * Which URL form depends on who is being asked, and getting it wrong breaks
 * the link in one direction or the other:
 *
 *   inside the domain  -> /a/macros/<domain>/s/... , so a delegator who is
 *      also signed into a personal Gmail doesn't get silently resolved
 *      against that account and dead-ended on a Google re-verification
 *      screen their IT policy may block.
 *   outside the domain -> plain /macros/s/... , because the /a/ form REQUIRES
 *      an account in that Workspace and rejects a personal account outright.
 *
 * This used to always domain-scope, leaving the operator to hand-edit the URL
 * for an external test delegator — which promptly produced a broken link,
 * because deleting the /a/macros/<domain>/ segment also deletes the /macros/
 * the generic form still needs. Not something a human should be doing by
 * hand at all.
 */
function delegationApprovalUrl_(token, delegatorEmail) {
  const internal = String(delegatorEmail || '').toLowerCase().endsWith('@' + REPLY_TO_DOMAIN);
  const base = internal ? domainScopedUrl_(AGENT_WEBAPP_URL) : AGENT_WEBAPP_URL;
  return base + '?approve=' + encodeURIComponent(token);
}

/**
 * A ready-to-paste note for the operator to send. Exists because the exec
 * hits Google's consent screen BEFORE our page can explain itself — Apps
 * Script offers no way to reorder that — so the explanation has to arrive
 * before the link does, or the first thing a CTO sees is a permission prompt
 * with no context.
 */
function delegationInviteText(delegationId) {
  requireAdmin_();
  const row = findRow_('Delegations', delegationId);
  if (!row) throw new Error('No such request: ' + delegationId);
  const who = row.requested_by.split('@')[0].replace(/[._]/g, ' ');

  return 'Hi,\n\n'
    + 'I\'m running an email campaign that would go out under your name, and I need your '
    + 'sign-off before anything can send.\n\n'
    + 'The link below takes you to a page where you approve it yourself — you choose how many '
    + 'days, and it stops automatically when that runs out. Google will ask you to allow '
    + '"send email on your behalf" first; that consent is what makes this work without anyone '
    + 'ever having your password or seeing your inbox.\n\n'
    + (row.reason ? 'What it\'s for: ' + row.reason + '\n\n' : '')
    + 'I\'ve asked for ' + row.days_requested + ' days — change it to whatever you\'re comfortable with:\n'
    + delegationApprovalUrl_(row.claim_token, row.delegator_email) + '\n\n'
    + 'Open it with your @' + REPLY_TO_DOMAIN + ' account. If you\'re also signed into a personal '
    + 'Gmail, Google may try that one instead and get stuck on a "Verify it\'s you" screen — if that '
    + 'happens, open the link in an incognito window and sign in with work.\n\n'
    + 'You can see everything sent from your account, and cut it off instantly, from that same page.\n\n'
    + 'Thanks,\n' + who;
}

/**
 * Re-fetch the link for a request that is still pending. Exists because the
 * alternative is a human retyping or trimming a 64-character token out of a
 * URL, which has now gone wrong twice: once truncated by hand-editing, once
 * broken by removing a path segment. A link the operator can always re-copy
 * exactly makes both impossible.
 */
function getDelegationLink(delegationId) {
  requireAdmin_();
  const row = findRow_('Delegations', delegationId);
  if (!row) throw new Error('No such request: ' + delegationId);
  if (row.status !== 'pending') {
    throw new Error('That request is ' + row.status + ' — its link no longer does anything. Create a new one.');
  }
  const token = String(row.claim_token || '');
  return {
    url: delegationApprovalUrl_(token, row.delegator_email),
    delegatorEmail: row.delegator_email,
    // Same shape the approval page reports back on a failed lookup, so the
    // two can be compared directly rather than inferred from symptoms.
    fingerprint: token.length + ' chars, ' + token.slice(0, 6) + '…' + token.slice(-6),
  };
}

/**
 * The link that restarts a sender's own polling agent.
 *
 * Needed because the trigger lives inside that person's Google account and
 * only they can create it — an operator cannot repair someone else's agent,
 * by the same design that stops this tool touching anyone's mailbox without
 * them. What an operator CAN do is hand them the right link, and that should
 * not involve assembling a URL by hand for each person; doing that manually
 * has already broken twice.
 */
/**
 * Clears a sender's stored key so their agent can register again.
 *
 * The recovery valve for an agent that can no longer authenticate — a local
 * secret lost, cleared, or (as happened here) stranded by a change in where
 * it was stored. Before this there was no way back: the agent could not
 * authenticate with the wrong secret and could not re-register either,
 * because registration refuses an email that already has a row.
 *
 * Safe for an operator to hold, because it only ever REMOVES the ability to
 * act. It grants nothing: the sender still has to re-register from their own
 * account, and their sending window is untouched — this cannot extend it.
 */
function resetSenderKey(email) {
  const admin = requireAdmin_();
  const clean = String(email || '').toLowerCase().trim();
  const sender = findRow_('Senders', clean);
  if (!sender) throw new Error('No such sender: ' + clean);

  updateRow_('Senders', clean, { secret_hash: '' });
  logEvent_(admin, 'admin_action', { senderEmail: clean, detail: { action: 'reset_sender_key' } });
  return { email: clean, reonboardUrl: agentReonboardUrlFor_(clean) };
}

function agentReonboardUrlFor_(senderEmail) {
  const internal = String(senderEmail || '').toLowerCase().endsWith('@' + REPLY_TO_DOMAIN);
  return (internal ? domainScopedUrl_(AGENT_WEBAPP_URL) : AGENT_WEBAPP_URL) + '?onboard=1';
}

function agentRepairUrlFor_(senderEmail) {
  const internal = String(senderEmail || '').toLowerCase().endsWith('@' + REPLY_TO_DOMAIN);
  return (internal ? domainScopedUrl_(AGENT_WEBAPP_URL) : AGENT_WEBAPP_URL) + '?repair=1';
}

/** Everything the operator has asked for, newest first, with live state resolved from the Senders row. */
function listDelegations() {
  requireAdmin_();
  const now = new Date();
  const senders = {};
  readRows_('Senders').forEach(function (s) { senders[s.email] = s; });

  return readRows_('Delegations')
    .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })
    .map(function (r) {
      const sender = senders[r.delegator_email];
      const expiresAt = (r.status === 'approved' && sender && sender.sends_expire_at)
        ? new Date(sender.sends_expire_at) : null;
      const live = r.status === 'approved' && expiresAt && expiresAt > now;
      return {
        id: r.id,
        delegatorEmail: r.delegator_email,
        requestedBy: r.requested_by,
        daysRequested: r.days_requested,
        daysApproved: r.days_approved || null,
        approvalMode: r.approval_mode || null,
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at,
        decidedAt: r.decided_at || null,
        revokedBy: r.revoked_by || null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        daysLeft: live ? Math.ceil((expiresAt - now) / 86400000) : null,
        live: live,
        onboarded: !!sender,
      };
    });
}

/**
 * Cut sending off early. Available to the operator because it only ever
 * REMOVES capability — the asymmetry is the point. Extending requires going
 * back to the delegator for a fresh approval.
 *
 * The delegator can also do this themselves, instantly and without us, from
 * their own agent page (and, more completely, by removing the app at
 * myaccount.google.com/permissions).
 */
function revokeDelegation(delegationId) {
  const admin = requireAdmin_();
  const row = findRow_('Delegations', delegationId);
  if (!row) throw new Error('No such request: ' + delegationId);

  if (findRow_('Senders', row.delegator_email)) {
    updateRow_('Senders', row.delegator_email, { sends_expire_at: new Date(0), status: 'revoked' });
  }
  updateRow_('Delegations', delegationId, {
    status: 'revoked', revoked_by: admin, revoked_at: new Date(),
  });
  logEvent_(admin, 'revoke', {
    senderEmail: row.delegator_email,
    detail: { action: 'revoke_delegation', delegationId: delegationId },
  });
  return { revoked: row.delegator_email };
}

/**
 * Who can I actually send as right now — the one question the Senders tab
 * exists to answer. Derived from Senders (the live state), annotated with the
 * approval that produced it.
 */
function listAvailableSenders() {
  requireAdmin_();
  const now = new Date();
  const approvals = {};
  readRows_('Delegations', function (r) { return r.status === 'approved'; })
    .forEach(function (r) { approvals[r.delegator_email] = r; });

  return readRows_('Senders').map(function (s) {
    const expiresAt = s.sends_expire_at ? new Date(s.sends_expire_at) : null;
    const expired = !!expiresAt && expiresAt <= now;
    const approval = approvals[s.email];
    return {
      email: s.email,
      displayName: s.display_name,
      canSend: s.status === 'active' && !expired,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      daysLeft: (!expired && expiresAt) ? Math.ceil((expiresAt - now) / 86400000) : null,
      permanent: !expiresAt,
      approvalMode: approval ? approval.approval_mode : null,
      approvedByThem: !!approval,
      approvedAt: approval ? approval.decided_at : null,
      lastHeartbeat: s.last_heartbeat || null,
    };
  });
}
