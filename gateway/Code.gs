/**
 * doPost only — no UI, no doGet console. This project exists purely so
 * agents have a machine-callable endpoint that doesn't hit the
 * USER_ACCESSING Bearer-token rejection admin/ ran into (see AgentApi.gs
 * header comment / docs/ARCHITECTURE.md §3 for the full story).
 *
 * Hand-picked whitelist, not "call any global function by name" — doPost
 * is reachable by anyone who can construct an HTTP request, so the attack
 * surface is exactly the functions listed here, each of which does its own
 * auth (AgentApi.gs) before touching the Store: requireSender_ for the
 * steady-state calls, or the single-use claim token for the three
 * delegation calls that necessarily run BEFORE a sender row exists.
 *
 * Adding a function to AgentApi.gs does not expose it — it has to be added
 * here too. That is deliberate, and it is also easy to forget: the three
 * delegation actions were written, deployed, and silently unreachable until
 * a direct curl against the live endpoint returned "Unknown action". Worth
 * remembering that a green unit suite proves nothing about this file.
 */
const AGENT_API_ACTIONS = {
  registerSender: registerSender,
  heartbeat: heartbeat,
  pollDueJobs: pollDueJobs,
  reportSent: reportSent,
  reportFailed: reportFailed,
  reportSignals: reportSignals,
  // Delegated sending — see AgentApi.gs "Delegated sending" section.
  lookupDelegation: lookupDelegation,
  approveDelegation: approveDelegation,
  denyDelegation: denyDelegation,
  senderSelfStatus: senderSelfStatus,
  revokeOwnDelegation: revokeOwnDelegation,
};

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ error: 'Malformed JSON body' }, 400);
  }
  const fn = AGENT_API_ACTIONS[body.action];
  if (!fn) return jsonResponse_({ error: 'Unknown action: ' + body.action }, 400);
  try {
    const result = fn.apply(null, body.args || []);
    return jsonResponse_({ ok: true, result: result });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message }, 200); // 200 so agent can parse the structured error
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** A GET here means someone opened the URL in a browser out of curiosity — not an error. */
function doGet(e) {
  return HtmlService.createHtmlOutput('<p>This is a machine API endpoint (agent -> central). Nothing to see here.</p>');
}
