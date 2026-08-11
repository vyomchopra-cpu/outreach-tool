/**
 * Web app entry point. All real authorization happens HERE, in code — not in
 * appsscript.json's `access` setting. That setting is "ANYONE" (any Google
 * account, not "DOMAIN") deliberately: a DOMAIN-restricted deployment rejects
 * server-to-server Bearer-token calls at Google's front door before the
 * script ever runs, which breaks the agent-to-admin call in
 * agent/CentralClient.gs even for a same-domain, same-person token. Since
 * executeAs is USER_ACCESSING, Session.getActiveUser() still reflects the
 * real caller regardless of the access setting, so isAuthorizedAdmin_ /
 * ADMIN_ALLOWLIST (doGet) and requireSender_ (doPost, admin/AgentApi.gs) are
 * the actual gate — see docs/ARCHITECTURE.md §2-3 for the full reasoning.
 */

function doGet(e) {
  const email = Session.getActiveUser().getEmail();
  if (!isAuthorizedAdmin_(email)) {
    return HtmlService.createHtmlOutput(
      '<p>Not authorized. This console is restricted to a named admin allowlist. ' +
      'Contact an existing admin to be added to ADMIN_ALLOWLIST.</p>'
    );
  }

  // One-time-use bootstrap trigger: visiting ?bootstrap=1 runs ensureSchema_().
  // Exists purely because the Apps Script editor's manual Run button is
  // unreliable for a fresh project in some browser/org configurations —
  // this reaches the exact same idempotent function through the web app's
  // normal auth path instead. Safe to hit repeatedly; safe to leave in place.
  if (e.parameter && e.parameter.bootstrap === '1') {
    try {
      ensureSchema_();
      return HtmlService.createHtmlOutput('<p>Schema bootstrapped OK. Tabs created/verified: '
        + Object.keys(SCHEMA).join(', ') + '. You can remove ?bootstrap=1 and reload for the console.</p>');
    } catch (err) {
      return HtmlService.createHtmlOutput('<p>ensureSchema_ failed: ' + err.message + '</p>');
    }
  }

  const template = HtmlService.createTemplateFromFile('ui/Index');
  template.adminEmail = email;
  return template.evaluate()
    .setTitle('MIS Outreach — Admin Console')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function isAuthorizedAdmin_(email) {
  if (!email) return false;
  const domainOk = email.toLowerCase().endsWith('@' + REPLY_TO_DOMAIN);
  const allowlisted = ADMIN_ALLOWLIST.indexOf(email.toLowerCase()) !== -1;
  return domainOk && allowlisted;
}

/** Throws if the caller isn't an authorized admin — call at the top of every server function. */
function requireAdmin_() {
  const email = Session.getActiveUser().getEmail();
  if (!isAuthorizedAdmin_(email)) throw new Error('Not authorized: ' + (email || 'unknown user'));
  return email;
}

/**
 * HTTP entry point for sender agents (a separate Apps Script project per
 * exec — see agent/CentralClient.gs). Deliberately a hand-picked whitelist
 * rather than "call any global function by name": doPost is reachable by
 * anyone who can construct an HTTP request, so the attack surface is exactly
 * these six functions, each of which does its own requireSender_ auth
 * (admin/AgentApi.gs) before touching the Store.
 */
const AGENT_API_ACTIONS = {
  registerSender: registerSender,
  heartbeat: heartbeat,
  pollDueJobs: pollDueJobs,
  reportSent: reportSent,
  reportFailed: reportFailed,
  reportSignals: reportSignals,
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

/** Lets ui/Index.html pull in ui/Preview.html etc. via <?!= include('ui/Preview') ?> if split up later. */
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** What the client needs to render the builder form — no secrets, just shape. */
function getClientConfig() {
  requireAdmin_();
  return {
    senderPool: SENDER_POOL.map(function (s) { return { email: s.email, displayName: s.displayName }; }),
    maxHtmlBytes: MAX_HTML_BYTES,
    sendWindow: SEND_WINDOW,
    seedMailboxCount: SEED_MAILBOXES.length,
  };
}
