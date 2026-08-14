/**
 * Two audiences, one deployment.
 *
 * Deployed access:DOMAIN + executeAs USER_ACCESSING, so every visitor runs as
 * THEMSELVES with their own OAuth grant, their own trigger, and their own
 * UserProperties (see agent/CentralClient.gs userProps_). One deployment
 * therefore serves every exec who delegates sending — nobody has to be given
 * their own copy of this project, which is the entire point: a CTO can lend
 * their name by opening a link, not by being onboarded onto a platform.
 *
 * It was access:MYSELF until that was understood, which is why the tool used
 * to require an admin to type someone else's permissions in on their behalf.
 *
 *   ?approve=<token>  the delegator's own approval page — the important one
 *   (no parameter)    whoever is signed in, looking at their own state
 *   ?diagnose / ?setup / ?testsend / ?onboard / ?disconnect  operator tools
 */
function doGet(e) {
  const email = getMyEmail_();

  // With access:ANYONE (see EXTERNAL_TEST_DELEGATORS in shared/Config.gs),
  // Google's own deployment setting no longer keeps strangers out — this
  // check is what does. Every route below is behind it.
  if (!isAllowedAgentUser_(email)) {
    return html_(''
      + '<h3>Not authorized</h3>'
      + (email
        ? '<p>You are signed in as <strong>' + email + '</strong>, which is not set up to use this tool.</p>'
        : '<p>Google did not report an email address for your session. Try opening this link in an '
          + 'incognito window and signing in again.</p>')
      + '<p style="color:#666;font-size:13px">If you were asked to approve sending from your account, '
      + 'check you are signed in with the address the request was sent to.</p>');
  }

  const p = e.parameter || {};

  if (p.approve) {
    const t = HtmlService.createTemplateFromFile('ui/Approve');
    // Tokens are hex by construction (admin/Delegation.gs newClaimToken_).
    // Stripping anything else guarantees the value is inert in a JS string
    // literal, which is what lets the template print it unescaped.
    t.token = String(p.approve).replace(/[^0-9a-fA-F]/g, '');
    return t.evaluate()
      .setTitle('Approve sending — MIS Outreach')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  /**
   * Runs one poll immediately, in the browser, where the result is visible.
   *
   * Waiting for the timer only ever answered "still nothing", because tick()
   * catches everything and writes to a log a delegator cannot open. Running
   * it here surfaces the same outcome in front of whoever is trying to fix
   * it — the difference between "the trigger never fired" and "it fires and
   * fails every time" is the whole diagnosis, and those look identical from
   * the console.
   */
  if (p.tick === '1') {
    tick();
    const after = lastTickStatus_();
    return html_('<h3>Check run</h3>'
      + (after.ok
        ? '<p style="color:#1c8558"><strong>Worked.</strong> Your agent reached the system and reported in.</p>'
        : '<p style="color:#b93a31"><strong>Failed:</strong> ' + (after.error || 'no detail recorded') + '</p>')
      + '<p><a href="?whoami=1">Back to the account check</a></p>');
  }

  /**
   * Deliberately touches nothing but Session, ScriptApp and UserProperties —
   * no network, no Gmail, no gateway. ?diagnose=1 cannot answer "why did this
   * fail" when the failure IS the network call, because it needs the same
   * permission that is missing. This route still renders when everything else
   * is broken, which is the only time anyone needs it.
   */
  if (p.whoami === '1') {
    const auth = getAuthStatus();
    const triggers = countMyTickTriggers_();
    // NOT named `tick` — a const by that name shadows the global tick()
    // across this whole function, putting the ?tick=1 route's call into the
    // temporal dead zone and throwing before it can run.
    const tickStatus = lastTickStatus_();
    return html_(''
      + '<h3>Account check</h3>'
      + '<ul>'
      + '<li>Signed in as: <strong>' + email + '</strong></li>'
      + '<li>Allowed to use this tool: <strong>' + (isAllowedAgentUser_(email) ? 'yes' : 'NO') + '</strong></li>'
      + '<li>Extra authorization needed: <strong>' + (auth.required ? 'YES' : 'no') + '</strong></li>'
      + (auth.checkFailed ? '<li>Check failed: <code>' + auth.checkFailed + '</code></li>' : '')
      + '<li>Send triggers you own: <strong>' + triggers + '</strong>'
      + (triggers ? '' : ' — nothing will send until this is at least 1') + '</li>'
      + '<li>Last check: ' + (tickStatus.at
        ? '<strong>' + tickStatus.at + '</strong> — ' + (tickStatus.ok
          ? '<span style="color:#1c8558">worked</span>'
          : '<span style="color:#b93a31">FAILED: ' + tickStatus.error + '</span>')
        : '<strong>never run</strong>') + '</li>'
      + '</ul>'
      + '<p><a href="?tick=1"><strong>Run a check now</strong></a> — does not wait for the timer.</p>'
      + (auth.authUrl
        ? '<p><a href="' + auth.authUrl + '" target="_blank" rel="noopener">Grant the missing permission</a>'
          + ' — then reload this page; it should say "no".</p>'
        : '')
      + (triggers ? '' : '<p><a href="?repair=1"><strong>Start my sending agent</strong></a>'
        + ' — safe to click more than once.</p>')
      + '<p style="color:#666;font-size:13px">Send a screenshot of this page to whoever asked you '
      + 'to approve — it says exactly which account you are on and what, if anything, is missing.</p>');
  }

  /**
   * Re-runs the one-time setup an approval performs. Exists because that
   * setup happens after the approval is already committed centrally, so a
   * failure there leaves a sender that is active everywhere except where it
   * matters — registered, shown as live, and never polling. Without a way to
   * retry, the only fix was to revoke and re-approve from scratch.
   */
  if (p.repair === '1') {
    let msg;
    try {
      ensureAgentTrigger_();
      const n = countMyTickTriggers_();
      msg = n
        ? '<p style="color:#1c8558"><strong>Started.</strong> Your agent now checks for work every '
          + AGENT_POLL_MINUTES + ' minute(s). Nothing else to do.</p>'
        : '<p style="color:#b93a31">Setup reported success but no trigger exists afterwards. '
          + 'Send this page to whoever asked you to approve.</p>';
    } catch (err) {
      msg = '<p style="color:#b93a31">Could not start it: ' + err.message + '</p>';
    }
    return html_('<h3>Sending agent</h3>' + msg + '<p><a href="?whoami=1">Re-check</a></p>');
  }

  if (p.diagnose === '1') {
    return html_(renderDiagnosticsHtml_(runDiagnostics_()));
  }

  if (p.setup === '1') {
    return html_(renderManualSetupHtml_());
  }

  if (p.testsend === '1') {
    return html_(runSelfTestSend_());
  }

  if (p.onboard === '1') {
    try {
      const r = onboardSender(p.displayName || email, p.timezone || 'Asia/Kolkata');
      return html_(renderOnboardResultHtml_(r));
    } catch (err) {
      return html_('<h3>Onboarding failed</h3><p style="color:#c0392b">' + err.message + '</p>'
        + '<p>Run <a href="?diagnose=1">?diagnose=1</a> to see which capability is missing.</p>');
    }
  }

  if (p.disconnect === '1') {
    disconnectSender();
    return html_('<p>Trigger removed for ' + email + '. Sending is paused.</p>'
      + '<p>To resume, visit <code>?onboard=1</code> again.</p>');
  }

  return html_(''
    + '<h3>MIS Outreach — sender agent</h3>'
    + '<p>Signed in as <strong>' + email + '</strong></p>'
    + '<ul>'
    + '<li><a href="?diagnose=1">Run diagnostics</a> — check every capability</li>'
    + '<li><a href="?testsend=1">Send a test to yourself</a> — proves the real send path end to end</li>'
    + '<li><a href="?setup=1">Manual filter setup</a> — the four steps to sort replies</li>'
    + '<li><code>?onboard=1&amp;displayName=Your+Name&amp;timezone=Asia/Kolkata</code> — register + start sending</li>'
    + '<li><code>?disconnect=1</code> — pause sending immediately</li>'
    + '</ul>');
}

/**
 * Sends one message to the signed-in exec's own address, through the real
 * render + merge + transport path — the same functions a live campaign uses,
 * not a simplified imitation. Proves end-to-end sending works without needing
 * a campaign, recipients, preflight, or the 5-minute trigger to have fired.
 *
 * Hard-wired to the caller's own mailbox: it takes no recipient parameter, so
 * this route cannot be turned into a way to send mail to anyone else.
 */
function runSelfTestSend_() {
  const email = getMyEmail_();
  // Every claim this message makes about merging must itself be a merge tag —
  // an earlier version asserted "the company reads Example Corp" with the
  // company name as literal text, which proved nothing about {{company}}.
  const body = '<p>Hi {{firstName}},</p>'
    + '<p>This is a test send from the MIS Outreach agent, rendered through the '
    + 'same merge and transport path a real campaign uses.</p>'
    + '<p>Merge check — every value below is substituted, none is hard-coded:</p>'
    + '<ul>'
    + '<li>First name: <strong>{{firstName}}</strong> (expected: Sam)</li>'
    + '<li>Company: <strong>{{company}}</strong> (expected: Example Corp)</li>'
    + '<li>Title: <strong>{{title}}</strong> (expected: VP Engineering)</li>'
    + '</ul>'
    + '<p>If those three read as expected, merge tags work. If this arrived at '
    + 'all, the send transport works.</p>'
    + '<p style="color:#666;font-size:12px">Unsubscribe: {{unsubscribe}}</p>';

  const sampleRecipient = {
    first_name: 'Sam', last_name: 'Prospect',
    company: 'Example Corp', title: 'VP Engineering', custom: {},
  };

  try {
    const rendered = render_(body, sampleRecipient, { unsubscribe: unsubscribeAddress_() });
    const result = sendMessage_({
      fromDisplayName: 'MIS Outreach (test)',
      fromEmail: email,
      toEmail: email,
      replyTo: replyToAddress_(),
      subject: 'MIS Outreach — transport test',
      html: rendered.html,
      text: rendered.text,
    });
    return '<h3>Test send dispatched</h3>'
      + '<ul>'
      + '<li>To: <strong>' + email + '</strong></li>'
      + '<li>Transport: <strong>' + result.transport + '</strong></li>'
      + '<li>Reply-To: <code>' + replyToAddress_() + '</code></li>'
      + '<li>Rendered size: ' + rendered.bytes + ' bytes (limit ' + MAX_HTML_BYTES + ')</li>'
      + '<li>RFC Message-ID captured: ' + (result.rfcMessageId ? 'yes' : 'no — expected under the mailapp transport') + '</li>'
      + '</ul>'
      + '<p>Check your inbox. Reply to it and the reply should land on '
      + '<code>' + replyToAddress_() + '</code> — which is what the '
      + '<a href="?setup=1">Outreach/Replies filter</a> sorts on.</p>';
  } catch (err) {
    return '<h3>Test send failed</h3><p style="color:#c0392b">' + err.message + '</p>'
      + '<p><a href="?diagnose=1">Run diagnostics</a></p>';
  }
}

function html_(body) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,Arial,sans-serif;padding:20px;max-width:900px;line-height:1.5">'
    + body + '</div>'
  );
}

function renderOnboardResultHtml_(r) {
  const warn = r.warnings.length
    ? '<div style="background:#fff8e1;border-left:3px solid #f0ad4e;padding:12px;margin:16px 0">'
      + r.warnings.map(function (w) { return '<p style="margin:4px 0">' + w + '</p>'; }).join('')
      + '</div>'
    : '';
  const filtersNeedManual = r.filters === 'manual setup required';
  return ''
    + '<h3>Onboarded ' + r.email + '</h3>'
    + '<ul>'
    + '<li>Central registration: <strong>' + (r.registered ? 'done' : 'failed') + '</strong></li>'
    + '<li>5-minute send trigger: <strong>' + (r.trigger ? 'active' : 'failed') + '</strong></li>'
    + '<li>Gmail labels &amp; filters: <strong>' + r.filters + '</strong></li>'
    + '</ul>'
    + warn
    + (filtersNeedManual
      ? '<p><strong>Next:</strong> <a href="?setup=1">set the filters up by hand</a> (about five minutes). '
        + 'Sending already works without this — the filters only sort incoming replies.</p>'
      : '<p>Nothing else to do. <a href="?diagnose=1">Run diagnostics</a> to confirm everything.</p>');
}

function renderManualSetupHtml_() {
  const spec = manualFilterSpec_();
  const steps = spec.map(function (f, i) {
    return '<li style="margin-bottom:18px">'
      + '<strong>Filter ' + (i + 1) + ' — label “' + f.label + '”</strong>'
      + '<div style="color:#666;font-size:13px;margin:4px 0">' + f.why + '</div>'
      + '<div style="background:#f6f8fa;border:1px solid #ddd;border-radius:4px;padding:10px;font-family:monospace;font-size:13px">'
      + f.criterion + '</div>'
      + '<div style="margin-top:6px">Then tick: ' + f.actions.map(function (a) { return '<em>' + a + '</em>'; }).join(', ') + '</div>'
      + '</li>';
  }).join('');

  return ''
    + '<h3>Manual filter setup</h3>'
    + '<p>The agent could not create these automatically (the Gmail API is not enabled for its '
    + 'Google Cloud project, which regular Workspace users usually cannot change). Setting them up '
    + 'by hand takes about five minutes and has a real upside: the agent never needs permission to '
    + 'touch your Gmail settings at all.</p>'
    + '<p><strong>In Gmail:</strong> Settings (gear) → See all settings → '
    + '<em>Filters and Blocked Addresses</em> → <em>Create a new filter</em>. '
    + 'Paste the criterion into the matching field, click <em>Create filter</em>, then tick the actions. '
    + 'Gmail will offer to create each label the first time you use it.</p>'
    + '<ol>' + steps + '</ol>'
    + '<p style="color:#666;font-size:13px">Note: Gmail filters never apply to your Sent folder, so campaign '
    + 'messages you send will still appear in Sent as normal — they are genuinely your mail.</p>'
    + '<p><a href="?diagnose=1">Run diagnostics</a></p>';
}
