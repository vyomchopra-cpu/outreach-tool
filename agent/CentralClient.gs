/**
 * Everything the agent needs to talk to the gateway/ project (NOT admin/ —
 * see gateway/AgentApi.gs's header comment for why they're separate
 * projects).
 *
 * No Authorization header is sent, deliberately. Confirmed empirically
 * (direct curl testing against the live deployed projects, both with and
 * without a Bearer token): a token from this agent's own OAuth client —
 * scoped to include gmail.send/gmail.settings.basic/gmail.metadata, all
 * classified as sensitive/restricted by Google — was rejected outright by
 * this Workspace's OAuth policy when used to authenticate to a *different*
 * Google service (any script.google.com destination, regardless of that
 * destination's own executeAs/access settings). A plain, unauthenticated
 * request to gateway/ (deployed access:ANYONE_ANONYMOUS) succeeded cleanly.
 * The actual authentication that matters is the per-sender secret below,
 * checked by requireSender_ on the other side — see
 * docs/ARCHITECTURE.md §2 ("Agent-API Gateway") for the full diagnosis and
 * gateway/AgentApi.gs's registerSender for the SENDER_POOL guard this
 * required, since ANYONE_ANONYMOUS means zero Google auth layer at all.
 * Nothing here touches SpreadsheetApp directly; only admin/Store.gs (via
 * gateway/AgentApi.gs's synced copy) does that.
 */

/**
 * Whose agent this is — and it has to be right in TWO very different
 * contexts, which is where this went wrong.
 *
 * In the web app (executeAs USER_ACCESSING) the visitor is both the active
 * and the effective user, so either call works. In a time-driven trigger
 * there is no active user at all: getActiveUser() returns an empty string,
 * particularly when the trigger's owner is not the script's owner — which is
 * every delegator on this shared deployment. getEffectiveUser() is the one
 * that resolves in both, returning the identity the code is actually running
 * as.
 *
 * The failure this caused was near-invisible: tick() called heartbeat with a
 * blank email, the gateway answered "Unknown sender: ", tick()'s catch
 * swallowed it into Logger, and the console showed a registered, active
 * sender whose heartbeat simply never advanced. Nothing anywhere said why.
 */
function getMyEmail_() {
  const effective = Session.getEffectiveUser().getEmail();
  if (effective) return effective;
  return Session.getActiveUser().getEmail();
}

/**
 * Per-person state, NOT per-script.
 *
 * This one deployment is shared by every exec who delegates sending (the web
 * app is executeAs USER_ACCESSING + access DOMAIN, so each visitor runs as
 * themselves with their own OAuth grant). ScriptProperties is a single store
 * shared across all of them — writing a sender secret there meant the second
 * exec to onboard silently overwrote the first, and both then failed to
 * authenticate to the gateway. Anything keyed to "this exec" must go through
 * here. Anything genuinely global (there is currently nothing) would not.
 */
function userProps_() {
  return PropertiesService.getUserProperties();
}

/** Generated once per exec, stored only in that exec's own UserProperties — never the plain value, and never centrally. */
function getOrCreateSecret_() {
  const props = userProps_();
  let secret = props.getProperty('CENTRAL_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('CENTRAL_SECRET', secret);
  }
  return secret;
}

/**
 * The secret as it was stored BEFORE this deployment became multi-tenant.
 *
 * Moving per-person state from ScriptProperties to UserProperties was the
 * right change — a shared store meant the second sender to onboard silently
 * clobbered the first — but it was made without migrating what was already
 * there. Existing agents therefore found nothing in UserProperties, minted a
 * brand-new secret, and started failing every call with "Bad secret", because
 * the Senders row still held the hash of the old one. Nothing about that
 * error suggested a storage move was the cause.
 */
function legacyScriptSecret_() {
  try {
    return PropertiesService.getScriptProperties().getProperty('CENTRAL_SECRET') || '';
  } catch (e) {
    return '';
  }
}

/**
 * Recovers from that migration by TESTING the old secret rather than assuming
 * it belongs to whoever is running.
 *
 * That distinction matters on a shared deployment: the legacy value sits in a
 * store every user can read, so adopting it blindly would hand one sender's
 * credential to another. Instead it is offered to the gateway, which checks
 * it against the Senders row for THIS email specifically — so it can only
 * ever be adopted by the account it actually belonged to. Everyone else's
 * attempt is rejected and nothing is written.
 *
 * Returns true if the secret was recovered and stored.
 */
function adoptLegacySecretIfValid_() {
  const legacy = legacyScriptSecret_();
  if (!legacy) return false;
  const props = userProps_();
  if (props.getProperty('CENTRAL_SECRET') === legacy) return false; // already using it

  const email = getMyEmail_();
  const probe = callCentralRaw_('heartbeat', [email, legacy, AGENT_VERSION, currentCapabilities_()]);
  if (!probe || !probe.ok) return false;

  props.setProperty('CENTRAL_SECRET', legacy);
  Logger.log('Adopted pre-multi-tenant secret for ' + email);
  return true;
}

/**
 * Posts to the gateway and returns the raw {ok, result, error} envelope
 * without throwing. Callers that care about the distinction between "the pipe
 * is broken" and "the pipe works and the answer was no" use this directly.
 *
 * Retries transport-level failures only. A POST to an Apps Script web app is
 * answered with a 302 to a one-shot googleusercontent.com content URL, and
 * that second hop intermittently 404s or returns an empty body — observed
 * live, on a call made moments after an identical one succeeded. Retrying a
 * business-level rejection (a structured ok:false) would be wrong and is
 * never done: those return immediately.
 */
function callCentralRaw_(action, args) {
  if (!CENTRAL_WEBAPP_URL) throw new Error('CENTRAL_WEBAPP_URL is not configured (shared/Config.gs)');
  const payload = JSON.stringify({ action: action, args: args });
  let lastFailure = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = UrlFetchApp.fetch(CENTRAL_WEBAPP_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const code = response.getResponseCode();
    const text = response.getContentText();

    try {
      return JSON.parse(text); // structured answer, success or not — done either way
    } catch (e) {
      lastFailure = 'HTTP ' + code + ', body="' + text.slice(0, 200) + '"';
      if (attempt < 3) Utilities.sleep(attempt * 1500);
    }
  }
  throw new Error('Central unreachable after 3 attempts (' + action + '): ' + lastFailure);
}

function callCentral_(action, args) {
  const body = callCentralRaw_(action, args);
  if (!body.ok) throw new Error('Central API error (' + action + '): ' + body.error);
  return body.result;
}
