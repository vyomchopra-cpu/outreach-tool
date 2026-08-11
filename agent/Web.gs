/**
 * Not a real web app — this agent has no UI. Exists purely so onboarding
 * can be triggered by visiting a URL instead of using the Apps Script
 * editor's manual Run button, which has proven unreliable across some
 * browser/org configurations for fresh projects (see admin/Code.gs's
 * ?bootstrap=1 for the same workaround on the admin side). Safe: the only
 * action available is onboarding this exec's own account, gated by
 * REPLY_TO_DOMAIN, and onboardSender is itself idempotent-ish (ensureFilter_
 * / getOrCreateLabelId_ / ensureAgentTrigger_ all no-op if already set up).
 */
function doGet(e) {
  const email = getMyEmail_();
  if (!email.toLowerCase().endsWith('@' + REPLY_TO_DOMAIN)) {
    return HtmlService.createHtmlOutput('<p>This agent is only for ' + REPLY_TO_DOMAIN + ' accounts.</p>');
  }

  const p = e.parameter || {};
  if (p.onboard === '1') {
    try {
      onboardSender(p.displayName || email, p.timezone || 'Asia/Kolkata');
      return HtmlService.createHtmlOutput(
        '<p>Onboarded ' + email + '. Labels, filters, and the 5-minute send trigger are now active.</p>'
        + '<p>You can close this tab. To pause, visit this URL again with ?disconnect=1.</p>'
      );
    } catch (err) {
      return HtmlService.createHtmlOutput('<p>onboardSender failed: ' + err.message + '</p>');
    }
  }

  if (p.disconnect === '1') {
    disconnectSender();
    return HtmlService.createHtmlOutput('<p>Trigger removed for ' + email + '. Sending is paused.</p>');
  }

  return HtmlService.createHtmlOutput(
    '<p>Signed in as ' + email + '.</p>'
    + '<p>Append <code>?onboard=1&displayName=Your+Name&timezone=Asia/Kolkata</code> to this URL to onboard.</p>'
    + '<p>Append <code>?disconnect=1</code> to pause sending.</p>'
  );
}
