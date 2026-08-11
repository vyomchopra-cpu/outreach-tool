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

function getMyEmail_() {
  return Session.getActiveUser().getEmail();
}

/** Generated once per exec's agent install, stored only in that agent's own ScriptProperties — never the plain value, and never centrally. */
function getOrCreateSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('CENTRAL_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('CENTRAL_SECRET', secret);
  }
  return secret;
}

function callCentral_(action, args) {
  if (!CENTRAL_WEBAPP_URL) throw new Error('CENTRAL_WEBAPP_URL is not configured (shared/Config.gs)');
  const response = UrlFetchApp.fetch(CENTRAL_WEBAPP_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ action: action, args: args }),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new Error('Central returned non-JSON (HTTP ' + code + '), body="' + text.slice(0, 300) + '"');
  }
  if (!body.ok) throw new Error('Central API error (' + action + '): ' + body.error);
  return body.result;
}
