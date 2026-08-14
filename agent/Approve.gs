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

/**
 * Whether this visitor's Google account has actually granted everything the
 * page will need, and if not, the URL that fixes it.
 *
 * Needed because of an Apps Script behaviour that produces a genuinely
 * stuck user: once an account holds ANY grant for a script, opening the web
 * app does not re-prompt for scopes it is missing. doGet runs, the page
 * renders, and the first call needing the absent scope throws
 * "You do not have permission to call UrlFetchApp.fetch" at runtime.
 *
 * The instinct is to tell the person to remove the app at
 * myaccount.google.com/permissions and start over. That was tried and does
 * not reliably work — the entry is not always there to remove, and on a
 * managed device the account screens themselves can be restricted. Google's
 * own answer is getAuthorizationUrl(): a link that requests exactly the
 * missing scopes, with no revoking and no settings to change. Send them
 * there instead of asking them to dismantle anything.
 *
 * Deliberately defensive: if this check cannot run, it reports "not
 * required" rather than throwing, so a diagnostic never becomes the thing
 * that blocks an approval.
 */
function getAuthStatus() {
  try {
    const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    const required = info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED;
    return { required: required, authUrl: required ? info.getAuthorizationUrl() : null };
  } catch (e) {
    return { required: false, authUrl: null, checkFailed: String(e && e.message || e) };
  }
}

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
  if (!isAllowedAgentUser_(email)) throw new Error('This account is not set up to use this tool: ' + (email || 'unknown'));
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
