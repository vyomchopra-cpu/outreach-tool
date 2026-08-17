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
  const email = currentUserEmail_();

  /**
   * Reachable by anyone in the domain, before the authorization check,
   * BECAUSE the thing it diagnoses is the authorization check itself.
   *
   * Reveals nothing an unauthorized visitor does not already know — their own
   * address, and whether we recognise it. Without it, "Not authorized" and
   * "Google did not tell us who you are" are the same screen, and they need
   * completely different fixes: one is a missing grant, the other is a
   * browser signed into the wrong account.
   */
  if (e && e.parameter && e.parameter.whoami === '1') {
    const grant = email ? isAccessGrantValid_(email.toLowerCase()) : false;
    const listed = email ? ADMIN_ALLOWLIST.indexOf(email.toLowerCase()) !== -1 : false;
    return HtmlService.createHtmlOutput(''
      + '<div style="font-family:-apple-system,Arial,sans-serif;padding:20px;max-width:640px;line-height:1.6">'
      + '<h3>Console access check</h3><ul>'
      + '<li>Google reports you as: <strong>' + (email || '(nothing — this is the problem)') + '</strong></li>'
      + '<li>Right domain: <strong>' + (email && email.toLowerCase().endsWith('@' + REPLY_TO_DOMAIN) ? 'yes' : 'NO') + '</strong></li>'
      + '<li>On the permanent list: <strong>' + (listed ? 'yes' : 'no') + '</strong></li>'
      + '<li>Has a time-boxed grant: <strong>' + (grant ? 'yes' : 'no') + '</strong></li>'
      + '<li>Allowed in: <strong>' + (isAuthorizedAdmin_(email) ? 'YES' : 'no') + '</strong></li>'
      + '</ul>'
      + '<p style="color:#666;font-size:13px">If the first line is blank, your browser is signed '
      + 'into more than one Google account. Open this in an incognito window with your work '
      + 'account only. If it shows the right address but "Allowed in" is no, you need a grant '
      + '— send this page to whoever runs the console.</p></div>');
  }

  if (!isAuthorizedAdmin_(email)) {
    // Deliberately a dead end now. Delegators never come here — approving
    // "send as me" happens on their OWN agent page, where their Google
    // consent and their send authorization already live (agent/Approve.gs).
    // This console is only ever for people operating campaigns.
    return HtmlService.createHtmlOutput(
      '<p>Not authorized. This console is restricted to ' + REPLY_TO_DOMAIN + ' accounts '
      + 'that have been granted access.</p>'
      + '<p style="color:#666;font-size:13px">If you were sent a link to approve sending from '
      + 'your account, that is a different link — it opens a one-page approval, not this console. '
      + 'Ask whoever sent it to re-share it.</p>'
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

  // Same reasoning as ?bootstrap=1 — installing the health-monitoring trigger
  // is a one-time setup step, and the editor's Run button proved unreliable
  // enough times this session that nothing new should depend on it working.
  if (e.parameter && e.parameter.setupMonitoring === '1') {
    try {
      setupHealthMonitoring_();
      return HtmlService.createHtmlOutput('<p>Health monitoring installed — checking every '
        + MONITOR_INTERVAL_MIN + ' minutes. Set <code>CHAT_WEBHOOK_URL</code> in Script Properties '
        + 'for alerts, then use the Health tab\'s "Send test alert" to confirm it fires.</p>');
    } catch (err) {
      return HtmlService.createHtmlOutput('<p>setupHealthMonitoring_ failed: ' + err.message + '</p>');
    }
  }

  const template = HtmlService.createTemplateFromFile('ui/Index');
  template.adminEmail = email;
  return template.evaluate()
    .setTitle('MIS Outreach — Admin Console')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * True if either the permanent allowlist (ADMIN_ALLOWLIST, shared/Config.gs —
 * a code change, reviewed like any other) or a live, non-expired, non-revoked
 * AccessGrants row (admin/Access.gs — a two-click dashboard action) covers
 * this email. Domain-restricted either way: this is an internal tool.
 */
function isAuthorizedAdmin_(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (!lower.endsWith('@' + REPLY_TO_DOMAIN)) return false;
  if (ADMIN_ALLOWLIST.indexOf(lower) !== -1) return true;
  return isAccessGrantValid_(lower);
}

/**
 * Who is actually using the console.
 *
 * getActiveUser ONLY, and deliberately never getEffectiveUser.
 *
 * This project is deployed executeAs USER_DEPLOYING, so getEffectiveUser is
 * always the owner regardless of who is on the page. Falling back to it when
 * getActiveUser comes back blank would silently promote every visitor to the
 * owner's identity — full admin for anyone in the domain, with the audit log
 * cheerfully recording the owner as the actor. A blank result must therefore
 * DENY, never substitute. That asymmetry is the entire safety of running this
 * project as its owner, and test/qa.mjs pins it.
 *
 * Within one Workspace domain Google resolves the accessing user normally, so
 * blank should not occur — but "should not" is not a thing to bet an
 * authorization check on.
 */
function currentUserEmail_() {
  return Session.getActiveUser().getEmail();
}

/** Throws if the caller isn't an authorized admin — call at the top of every server function. */
function requireAdmin_() {
  const email = currentUserEmail_();
  if (!isAuthorizedAdmin_(email)) {
    throw new Error('Not authorized: ' + (email || 'Google did not report who you are — try an incognito window, signed in with your work account only'));
  }
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
    seedMailboxes: SEED_MAILBOXES,
    seedMailboxCount: SEED_MAILBOXES.length,
    agentWebAppUrl: AGENT_WEBAPP_URL,
    pollMinutes: AGENT_POLL_MINUTES,
    dailyCapRamp: DAILY_CAP_RAMP,
    allowMultiTouch: ALLOW_MULTI_TOUCH,
    replyToDomain: REPLY_TO_DOMAIN,
  };
}

/**
 * Everything the page needs on first paint, in one round trip.
 *
 * Each google.script.run call pays a fixed Apps Script execution cost — a
 * new sandboxed VM, not a lightweight HTTP handler — measured in the low
 * hundreds of milliseconds regardless of how little work the function does.
 * The original page fired getClientConfig, getKillSwitchStatus, and
 * listCampaigns as three separate calls; the browser overlaps them, but each
 * still pays its own overhead, so wall time is roughly the slowest of the
 * three rather than free. One call pays that cost once.
 *
 * Kept alongside the individual functions (getClientConfig etc.) rather than
 * replacing them — the Health and Launch tabs still call their own endpoints
 * on demand, since bundling data nobody asked for yet into every load would
 * be the same mistake in the other direction.
 */
function getBootstrap() {
  requireAdmin_();
  return {
    config: getClientConfig(),
    killSwitch: isKillSwitchOn_(),
    campaigns: listCampaigns(),
  };
}
