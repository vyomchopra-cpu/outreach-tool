/**
 * One click, every capability probed, every error surfaced verbatim.
 *
 * This exists because the first deployment session burned hours guessing at
 * opaque failures (a bare 401 with an empty body, a 403 naming a GCP project
 * number and nothing else) one round-trip at a time. Any future environment
 * surprise — a scope revoked, an API disabled, an org policy changed, a
 * gateway URL gone stale — should be identifiable from a single page rather
 * than reconstructed from a sequence of failed onboarding attempts.
 *
 * Reachable at the agent web app's ?diagnose=1 (agent/Web.gs). The agent is
 * deployed access:MYSELF, so only the account that owns it can run this.
 */

function probe_(name, detail, fn) {
  try {
    const value = fn();
    return { name: name, detail: detail, ok: true, value: String(value) };
  } catch (e) {
    return { name: name, detail: detail, ok: false, value: String(e && e.message || e) };
  }
}

function runDiagnostics_() {
  const probes = [];

  probes.push(probe_('Identity', 'Who this script runs as', function () {
    return Session.getActiveUser().getEmail() || '(empty — userinfo.email scope missing?)';
  }));

  probes.push(probe_('Script timezone', 'Used for sender-clock scheduling', function () {
    return Session.getScriptTimeZone();
  }));

  // --- Sending, no-GCP path ---
  probes.push(probe_('MailApp quota', 'Sends remaining today (no GCP needed)', function () {
    return MailApp.getRemainingDailyQuota();
  }));

  // --- Sending + mailbox settings, GCP-dependent path ---
  probes.push(probe_('Gmail API: labels.list', 'Needs Gmail API enabled in the GCP project', function () {
    const r = gmailFetch_('/labels', 'get');
    return (r.labels || []).length + ' labels visible';
  }));

  probes.push(probe_('Gmail API: settings.filters.list', 'Needed to auto-create reply filters', function () {
    const r = gmailFetch_('/settings/filters', 'get');
    return (r.filter || []).length + ' filters';
  }));

  // --- Central connectivity ---
  probes.push(probe_('Gateway reachable', 'POST to CENTRAL_WEBAPP_URL', function () {
    if (!CENTRAL_WEBAPP_URL) throw new Error('CENTRAL_WEBAPP_URL is empty (shared/Config.gs)');
    const hb = callCentral_('heartbeat', [getMyEmail_(), getOrCreateSecret_(), AGENT_VERSION]);
    return 'status=' + hb.status + ', killSwitch=' + hb.killSwitch;
  }));

  probes.push(probe_('Registered centrally', 'Is there a Senders row for this account', function () {
    const jobs = callCentral_('pollDueJobs', [getMyEmail_(), getOrCreateSecret_()]);
    return jobs.length + ' job(s) currently due';
  }));

  // --- Local agent state ---
  probes.push(probe_('Send trigger installed', '5-minute tick()', function () {
    const n = ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction() === 'tick';
    }).length;
    if (n === 0) throw new Error('no tick() trigger — run onboarding');
    return n + ' trigger(s)';
  }));

  probes.push(probe_('Secret provisioned', 'Local per-agent shared secret', function () {
    return getOrCreateSecret_() ? 'present' : 'missing';
  }));

  // --- Derived summary ---
  const gmailApiOk = probes.filter(function (p) { return p.name.indexOf('Gmail API') === 0 && p.ok; }).length > 0;
  probes.push({
    name: 'Effective transport',
    detail: 'Which path sends will actually take',
    ok: true,
    value: (TRANSPORT_MODE === 'auto' ? (gmailApiOk ? 'advanced (auto)' : 'mailapp (auto — Gmail API unavailable)') : TRANSPORT_MODE),
  });

  probes.push({
    name: 'Reply/bounce detection',
    detail: 'Tier B signals — requires the Gmail API',
    ok: gmailApiOk,
    value: gmailApiOk ? 'available' : 'UNAVAILABLE — campaigns must stay single-touch (see docs/GCP_CONSTRAINT.md)',
  });

  return probes;
}

/** Compact capability object reported to central on every heartbeat, stored in Senders.capabilities. */
function currentCapabilities_() {
  const gmailApi = gmailApiAvailable_();
  return {
    transport: activeTransport_(),
    gmailApi: gmailApi,
    signals: gmailApi,
    providerQuota: remainingProviderQuota_(),
    agentVersion: AGENT_VERSION,
    checkedAt: new Date().toISOString(),
  };
}

function renderDiagnosticsHtml_(probes) {
  const rows = probes.map(function (p) {
    const color = p.ok ? '#1a7f37' : '#c0392b';
    const mark = p.ok ? 'OK' : 'FAIL';
    return '<tr>'
      + '<td style="padding:6px 10px;font-weight:600;color:' + color + '">' + mark + '</td>'
      + '<td style="padding:6px 10px">' + p.name + '<div style="color:#666;font-size:12px">' + p.detail + '</div></td>'
      + '<td style="padding:6px 10px;font-family:monospace;font-size:12px;white-space:pre-wrap">' + p.value + '</td>'
      + '</tr>';
  }).join('');
  return '<div style="font-family:-apple-system,Arial,sans-serif;padding:20px;max-width:1000px">'
    + '<h2 style="margin:0 0 4px">Agent diagnostics</h2>'
    + '<div style="color:#666;font-size:13px;margin-bottom:16px">Every capability this agent depends on, probed just now.</div>'
    + '<table style="border-collapse:collapse;width:100%;border:1px solid #ddd">' + rows + '</table></div>';
}
