/**
 * Web app entry point for the human-facing admin console only. All real
 * authorization happens here (isAuthorizedAdmin_ / requireAdmin_) — the
 * appsscript.json `access: DOMAIN` setting is a second, outer layer on top
 * of that, not a replacement for it.
 *
 * This project no longer handles agent traffic (no doPost here) — that
 * moved to gateway/, a separate Apps Script project deployed
 * executeAs:"USER_DEPLOYING" because Bearer-token calls from another
 * unverified internal Apps Script project were rejected by this Workspace's
 * OAuth policy, even under USER_ACCESSING. Full story in gateway/AgentApi.gs's
 * header comment and docs/ARCHITECTURE.md §2-3. Real human browser visits
 * were never affected by that issue — only the machine-to-machine call was —
 * so this project's deployment reverted to DOMAIN once doPost moved out;
 * ANYONE was only ever needed to accommodate the agent call this project no
 * longer receives.
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
