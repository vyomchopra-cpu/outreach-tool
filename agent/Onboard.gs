/**
 * Run once by the exec (or an admin walking them through it) right after
 * installing the agent and granting scopes.
 *
 * Structured so that the parts requiring no special Google Cloud access —
 * central registration and the send trigger, i.e. everything needed to
 * actually send mail — complete first and independently. Label/filter
 * creation needs the Gmail API, which needs a GCP project this Workspace's
 * regular users may not be able to administer; if that step fails, onboarding
 * still SUCCEEDS and returns manual setup instructions instead of aborting.
 * The earlier version failed the whole onboarding on that one step, which
 * made a fully working agent look completely broken.
 */
function onboardSender(displayName, timezone) {
  const email = getMyEmail_();
  if (!email.toLowerCase().endsWith('@' + REPLY_TO_DOMAIN)) {
    throw new Error('This agent is only for ' + REPLY_TO_DOMAIN + ' accounts, got ' + email);
  }

  const result = { email: email, registered: false, trigger: false, filters: 'not attempted', warnings: [] };
  const secret = getOrCreateSecret_();

  // 1. Central registration — plain HTTPS to the gateway, no GCP dependency.
  try {
    callCentral_('registerSender', [email, secret, displayName, timezone]);
    result.registered = true;
  } catch (e) {
    if (/already registered/i.test(String(e.message))) {
      result.registered = true;
      result.warnings.push('Already registered centrally — reusing the existing Senders row. '
        + 'If this agent was reinstalled and its local secret changed, an admin must clear the '
        + 'Senders row so it can re-key.');
    } else {
      throw e; // genuinely fatal: without this, there is no work to poll for
    }
  }

  // 2. Send trigger — ScriptApp only, no GCP dependency.
  ensureAgentTrigger_();
  result.trigger = true;

  // 3. Labels + filters — Gmail API, may be unavailable. Never fatal.
  try {
    ensureLabelsAndFilters_();
    result.filters = 'created automatically';
  } catch (e) {
    result.filters = isApiNotEnabledError_(e) ? 'manual setup required' : 'failed: ' + e.message;
    result.warnings.push('Could not create Gmail labels/filters automatically'
      + (isApiNotEnabledError_(e) ? ' (the Gmail API is not enabled for this script\'s Google Cloud project, '
        + 'which regular Workspace users often cannot change). Sending is unaffected — set the filters up by hand, '
        + 'takes about five minutes.' : ': ' + e.message));
  }

  return result;
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

/**
 * Apps Script exposes no way to read an existing trigger's interval, so the
 * configured value is recorded alongside it. Without that, changing
 * AGENT_POLL_MINUTES would silently do nothing on every already-onboarded
 * agent — the trigger exists, so the old code returned early and left the old
 * interval running forever.
 */
function ensureAgentTrigger_() {
  const allowed = [1, 5, 10, 15, 30];
  if (allowed.indexOf(AGENT_POLL_MINUTES) === -1) {
    throw new Error('AGENT_POLL_MINUTES must be one of ' + allowed.join(', ') + ', got ' + AGENT_POLL_MINUTES);
  }
  const props = PropertiesService.getScriptProperties();
  const desired = String(AGENT_POLL_MINUTES);
  const existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'tick';
  });

  if (existing.length === 1 && props.getProperty('TRIGGER_MINUTES') === desired) return;

  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(AGENT_POLL_MINUTES).create();
  props.setProperty('TRIGGER_MINUTES', desired);
}

/** For an exec who wants to stop entirely — instant, unilateral, no admin involvement (README/ARCHITECTURE promise). */
function disconnectSender() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Trigger removed. To fully revoke, also remove this app at myaccount.google.com/permissions.');
}

/**
 * The exact filters to create by hand when the Gmail API path is unavailable.
 * Returned as data (not prose) so agent/Web.gs can render it and so the
 * addresses always match what replyToAddress_/unsubscribeAddress_ actually
 * put on outgoing mail — a hand-written setup doc would drift.
 */
function manualFilterSpec_() {
  return [
    {
      label: 'Outreach/Replies',
      criterion: 'To: ' + replyToAddress_(),
      actions: ['Apply the label "Outreach/Replies"'],
      why: 'Every campaign message sets this as its Reply-To, so replies land pre-sorted.',
    },
    {
      label: 'Outreach/Bounces',
      criterion: 'From: mailer-daemon@googlemail.com',
      actions: ['Apply the label "Outreach/Bounces"'],
      why: 'Delivery failures are reported by Gmail from this address.',
    },
    {
      label: 'Outreach/Unsubscribes',
      criterion: 'To: ' + unsubscribeAddress_(),
      actions: ['Apply the label "Outreach/Unsubscribes"', 'Skip the Inbox'],
      why: 'The unsubscribe address in every message footer. Skipping the inbox keeps it quiet — '
        + 'but the label must still be checked, since these must be honoured.',
    },
  ];
}
