/**
 * Everything the agent needs to talk to the gateway/ project (NOT admin/ —
 * see gateway/AgentApi.gs's header comment for why they're separate
 * projects). The Bearer token is still sent, and UrlFetchApp still needs
 * SOME valid Google-authenticated request to satisfy the gateway's
 * access:"ANYONE" front door, but the gateway (executeAs:"USER_DEPLOYING") does not
 * need to resolve that token to a specific identity the way admin/'s
 * USER_ACCESSING deployment tried to — that's what made the original
 * design fail in this Workspace. The actual authentication that matters is
 * the per-sender secret below, checked by requireSender_ on the other side.
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
  const token = ScriptApp.getOAuthToken();
  Logger.log('callCentral_(' + action + '): token prefix=' + token.slice(0, 12) + '... length=' + token.length);
  const response = UrlFetchApp.fetch(CENTRAL_WEBAPP_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ action: action, args: args }),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  Logger.log('callCentral_(' + action + '): HTTP ' + code + ', body length=' + text.length
    + ', headers=' + JSON.stringify(response.getAllHeaders()));
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new Error('Central returned non-JSON (HTTP ' + code + '), body="' + text.slice(0, 300) + '"');
  }
  if (!body.ok) throw new Error('Central API error (' + action + '): ' + body.error);
  return body.result;
}
