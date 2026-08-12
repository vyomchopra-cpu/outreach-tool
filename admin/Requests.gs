/**
 * Request → approval, not self-service self-grant.
 *
 * The gap this closes: admin/Access.gs's grantAccess and setSenderExpiry let
 * ANY current admin grant ANY level of access to ANYONE, including
 * themselves, with nothing but a free-text note as a record of why. Someone
 * could grant themselves 30 days of sending access and write "VP approved
 * this" in the note — nothing checks that a VP did anything at all.
 *
 * Here, the requester names an approver. The approver — authenticated as
 * themselves, via the same Google sign-in as everything else, not a code
 * they were sent — is the only one who can decide it. The resulting grant's
 * `granted_by` / `sends_granted_by` is that person's real identity, because
 * applyAccessGrant_/applySenderExpiry_ (admin/Access.gs) were called with
 * their authenticated email as `actor`, not typed into a form by the
 * requester.
 *
 * Deliberately reachable WITHOUT prior console access — see admin/Code.gs's
 * doGet. Someone with zero access can't reach the full console to request
 * some, and a named approver (e.g. a VP who has never used this tool) can't
 * reach it to decide one either. Both get a minimal, standalone page instead.
 */

function requireDomainUser_() {
  const email = Session.getActiveUser().getEmail();
  if (!email || !email.toLowerCase().endsWith('@' + REPLY_TO_DOMAIN)) {
    throw new Error('Sign in with a @' + REPLY_TO_DOMAIN + ' account');
  }
  return email.toLowerCase();
}

function newRequestId_() {
  return 'req_' + Utilities.getUuid().split('-')[0];
}

/**
 * kind: 'console' (build/launch campaigns) or 'sending' (mail under the
 * requester's own name — the requester must ALSO separately complete the
 * agent's own OAuth onboarding; approving this only sets how long that
 * authorization is allowed to send for, per admin/Access.gs).
 */
function requestAccess(kind, approverEmail, days, reason) {
  const requester = requireDomainUser_();
  if (kind !== 'console' && kind !== 'sending') throw new Error('kind must be "console" or "sending"');

  const approver = String(approverEmail || '').toLowerCase().trim();
  if (!isValidEmail_(approver)) throw new Error('Not a valid approver email: ' + approverEmail);
  if (!approver.endsWith('@' + REPLY_TO_DOMAIN)) throw new Error('The approver must also be a @' + REPLY_TO_DOMAIN + ' address');
  if (approver === requester) throw new Error('You cannot name yourself as the approver — that defeats the point of asking');

  const n = Math.floor(Number(days));
  if (!isFinite(n) || n < 1 || n > 365) throw new Error('Days must be a whole number between 1 and 365');

  const id = newRequestId_();
  appendRow_('AccessRequests', {
    id: id, requested_by: requester, approver_email: approver, kind: kind,
    days_requested: n, reason: reason || '', status: 'pending',
    created_at: new Date(), decided_by: '', decided_at: '',
  });
  logEvent_(requester, 'admin_action', { detail: { action: 'request_access', kind: kind, approverEmail: approver, days: n } });

  // Best-effort — a missing/unset webhook must never block the request itself.
  try {
    notifyChat_({
      severity: 'info', detector: 'access_request',
      summary: requester + ' is requesting ' + n + ' day(s) of ' + kind + ' access, approver: ' + approver,
      detail: (reason || '(no reason given)') + ' — decide it at ' + ADMIN_WEBAPP_URL,
    });
  } catch (e) { /* Monitor.gs not deployed yet, or webhook unset — fine, request is still recorded */ }

  return { id: id };
}

/** Everyone with at least one pending request addressed to them — used by doGet to decide which minimal page to show someone who isn't a full admin. */
function listPendingRequestsForApprover_(email) {
  const lower = String(email || '').toLowerCase();
  return readRows_('AccessRequests', function (r) { return r.status === 'pending' && r.approver_email === lower; });
}

/** UI-callable version of the above — for an approver who IS also an admin, reachable from inside the full console's Access tab. */
function listPendingRequestsForMe() {
  const email = requireDomainUser_();
  return listPendingRequestsForApprover_(email).map(function (r) {
    return { id: r.id, requestedBy: r.requested_by, kind: r.kind, days: r.days_requested, reason: r.reason, createdAt: r.created_at };
  });
}

/** So a requester can see the status of what they asked for, without needing to be an admin either. */
function listMyRequests() {
  const email = requireDomainUser_();
  return readRows_('AccessRequests', function (r) { return r.requested_by === email; })
    .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })
    .map(function (r) {
      return {
        id: r.id, approverEmail: r.approver_email, kind: r.kind, days: r.days_requested,
        status: r.status, createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at,
      };
    });
}

/**
 * The one real authorization check in this file: not "are you an admin",
 * but "are you literally the person this specific request names as
 * approver". That is what makes the whole flow trustworthy — anyone could
 * claim to be deciding on the VP's behalf; only the VP's own authenticated
 * Google session can actually satisfy this check.
 */
function requireRequestApprover_(request) {
  const email = Session.getActiveUser().getEmail();
  if (!email || email.toLowerCase() !== request.approver_email) {
    throw new Error('Only ' + request.approver_email + ' can decide this request — you are signed in as ' + (email || 'unknown'));
  }
  return email.toLowerCase();
}

/**
 * approve=true grants exactly what was requested; false just closes it out.
 * Re-checks status first — a stale tab or double-click can't double-grant.
 *
 * The grant is applied BEFORE the request row is marked 'approved', not
 * after — a 'sending' request can legitimately fail here (the requester
 * approved a request before finishing their own agent onboarding, so
 * applySenderExpiry_'s "no such sender" fires). Ordering it this way means
 * that failure leaves the request cleanly 'pending' for a retry once they've
 * onboarded, instead of stuck 'approved' with no grant actually applied.
 */
function decideAccessRequest(id, approve, note) {
  const found = readRows_('AccessRequests', function (r) { return r.id === id; })[0];
  if (!found) throw new Error('No such request: ' + id);
  const approver = requireRequestApprover_(found);
  if (found.status !== 'pending') throw new Error('This request was already ' + found.status + ' by ' + found.decided_by);

  let result = { granted: false };
  if (approve) {
    result = (found.kind === 'console')
      ? Object.assign({ granted: true, kind: 'console' }, applyAccessGrant_(found.requested_by, found.days_requested, note || ('Approved via request ' + id), approver))
      : Object.assign({ granted: true, kind: 'sending' }, applySenderExpiry_(found.requested_by, found.days_requested, approver));
  }

  updateRow_('AccessRequests', id, { status: approve ? 'approved' : 'denied', decided_by: approver, decided_at: new Date() });
  logEvent_(approver, 'admin_action', { detail: { action: approve ? 'approve_request' : 'deny_request', requestId: id, requestedBy: found.requested_by } });
  return result;
}
