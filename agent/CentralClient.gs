/**
 * Everything the agent needs to talk to the admin web app. The OAuth bearer
 * token proves this call comes from this exec's own Google identity — that
 * identity, plus the shared secret below, is the two-factor auth described
 * in docs/ARCHITECTURE.md §3. Nothing here ever touches SpreadsheetApp
 * directly; only admin/Store.gs does that, on the other side of this call.
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
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ action: action, args: args }),
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (e) {
    throw new Error('Central returned non-JSON (HTTP ' + code + '): ' + response.getContentText().slice(0, 200));
  }
  if (!body.ok) throw new Error('Central API error (' + action + '): ' + body.error);
  return body.result;
}
