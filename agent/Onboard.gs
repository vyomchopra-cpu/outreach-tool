/**
 * Run once, manually, by the exec (or an admin walking them through it)
 * right after installing the agent and granting the Tier B scopes. Sets up
 * everything the agent needs and nothing more.
 */
function onboardSender(displayName, timezone) {
  const email = getMyEmail_();
  if (!email.toLowerCase().endsWith('@' + REPLY_TO_DOMAIN)) {
    throw new Error('This agent is only for ' + REPLY_TO_DOMAIN + ' accounts, got ' + email);
  }
  const secret = getOrCreateSecret_();
  callCentral_('registerSender', [email, secret, displayName, timezone]);
  ensureLabelsAndFilters_();
  ensureAgentTrigger_();
  Logger.log('Onboarded ' + email + ' — labels, filters, and the 5-minute send trigger are active.');
}

/** Single fixed Reply-To tag, not per-campaign — see docs/ARCHITECTURE.md §4 for why. */
function replyToAddress_() {
  const localPart = getMyEmail_().split('@')[0];
  return localPart + '+o@' + REPLY_TO_DOMAIN;
}

function unsubscribeAddress_() {
  const localPart = getMyEmail_().split('@')[0];
  return localPart + '+unsub@' + REPLY_TO_DOMAIN;
}

function ensureLabelsAndFilters_() {
  ensureFilter_({ to: replyToAddress_() }, 'Outreach/Replies');
  ensureFilter_({ from: 'mailer-daemon@googlemail.com' }, 'Outreach/Bounces');
  ensureFilter_({ to: unsubscribeAddress_() }, 'Outreach/Unsubscribes', { skipInbox: true });
}

function ensureAgentTrigger_() {
  const existing = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'tick';
  });
  if (existing) return;
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
}

/** For an exec who wants to stop entirely — instant, unilateral, no admin involvement (README/ARCHITECTURE promise). */
function disconnectSender() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Trigger removed. To fully revoke, also remove this app at myaccount.google.com/permissions.');
}
