/**
 * Web app entry point. All auth happens here before any Campaign.gs function
 * is reachable — appsscript.json's DOMAIN access setting is the outer gate,
 * ADMIN_ALLOWLIST (shared/Config.gs) is defence in depth per docs/ARCHITECTURE.md §2.
 */

function doGet(e) {
  const email = Session.getActiveUser().getEmail();
  if (!isAuthorizedAdmin_(email)) {
    return HtmlService.createHtmlOutput(
      '<p>Not authorized. This console is restricted to a named admin allowlist. ' +
      'Contact an existing admin to be added to ADMIN_ALLOWLIST.</p>'
    );
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
