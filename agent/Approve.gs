/**
 * The delegator's side of "let me send mail from your account."
 *
 * Everything here runs inside the delegator's own session — this web app is
 * executeAs USER_ACCESSING with access DOMAIN, so Google has already
 * authenticated whoever is on the page and the code runs as them, with their
 * own OAuth grant and their own UserProperties. That is what makes their
 * click a real authorization rather than a claim someone typed on their
 * behalf.
 *
 * Note the ordering constraint we cannot design away: Apps Script shows its
 * OAuth consent screen BEFORE doGet runs, so a delegator meets a permission
 * prompt before our page can explain itself. admin/Delegation.gs's
 * delegationInviteText exists to get the explanation there first. The page
 * below then re-states it plainly and makes clear that consenting has not
 * yet authorized anything to send.
 */

/** What the page needs on first paint. Read-only — opening the link decides nothing. */
function getDelegationForApproval(token) {
  const email = getMyEmail_();
  const info = callCentral_('lookupDelegation', [token, email]);
  return {
    myEmail: email,
    suggestedName: prettyNameFromEmail_(email),
    requestedBy: info.requestedBy,
    requestedByName: prettyNameFromEmail_(info.requestedBy),
    daysRequested: info.daysRequested,
    reason: info.reason,
    status: info.status,
  };
}

/** "chaitanya.pandey@moveinsync.com" -> "Chaitanya Pandey". Only ever a suggestion; the delegator can correct it before approving. */
function prettyNameFromEmail_(email) {
  return String(email || '').split('@')[0].split(/[._-]+/)
    .filter(function (p) { return p; })
    .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); })
    .join(' ');
}

/**
 * The approval. Order matters: register centrally FIRST, and only start the
 * local send trigger once that has succeeded. A trigger running against a
 * sender row that was never written would poll, fail to authenticate, and
 * bury the real error in trigger-execution logs where the delegator would
 * never see it — whereas a failure here surfaces on the page in front of
 * them, which is where a failure belongs.
 */
function approveDelegationFromPage(token, days, mode, displayName, timezone) {
  const email = getMyEmail_();
  const secret = getOrCreateSecret_();

  const result = callCentral_('approveDelegation', [
    token, email, secret, days, mode,
    displayName || prettyNameFromEmail_(email),
    timezone || Session.getScriptTimeZone(),
  ]);

  ensureAgentTrigger_();

  // Filters only sort incoming replies — sending already works without them,
  // so this must never be able to fail the approval the delegator just made.
  let filters = 'manual setup required';
  try {
    ensureLabelsAndFilters_();
    filters = 'created automatically';
  } catch (e) {
    filters = isApiNotEnabledError_(e) ? 'manual setup required' : 'failed: ' + e.message;
  }

  return {
    email: result.email,
    days: result.days,
    mode: result.mode,
    expiresAt: result.expiresAt,
    requestedByName: prettyNameFromEmail_(result.requestedBy),
    filters: filters,
    filterSpec: manualFilterSpec_(),
  };
}

function denyDelegationFromPage(token) {
  const email = getMyEmail_();
  const result = callCentral_('denyDelegation', [token, email]);
  return { requestedByName: prettyNameFromEmail_(result.requestedBy) };
}

/** Instant, unilateral, no admin involvement — the promise made in docs/EXEC_CONSENT.md, reachable from the delegator's own page. */
function revokeMyDelegation() {
  const email = getMyEmail_();
  callCentral_('revokeOwnDelegation', [email, getOrCreateSecret_()]);
  disconnectSender();
  return { revoked: email };
}

/** Their own current state — "am I lending my name to anything right now, and until when." */
function getMyDelegationStatus() {
  const email = getMyEmail_();
  const status = callCentral_('senderSelfStatus', [email, getOrCreateSecret_()]);
  return {
    myEmail: email,
    canSend: status.canSend,
    expiresAt: status.expiresAt,
    daysLeft: status.daysLeft,
    sentCount: status.sentCount,
    lastSentAt: status.lastSentAt,
    operators: status.operators,
    filterSpec: manualFilterSpec_(),
  };
}
