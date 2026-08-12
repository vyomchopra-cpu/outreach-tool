/**
 * Not a real web app — this agent has no UI for day-to-day use. It exists so
 * one-time and occasional actions are reachable by URL instead of through the
 * Apps Script editor's Run button, which proved unreliable for a fresh project
 * in this environment.
 *
 * Deployed access:MYSELF, so every route here is reachable only by the account
 * that owns the agent. That is the entire authorization model for this file —
 * there is deliberately nothing here that another user could reach.
 */
function doGet(e) {
  const email = getMyEmail_();
  if (!email.toLowerCase().endsWith('@' + REPLY_TO_DOMAIN)) {
    return html_('<p>This agent is only for ' + REPLY_TO_DOMAIN + ' accounts.</p>');
  }

  const p = e.parameter || {};

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
