/**
 * Health monitoring + alerting — the same pattern proven in the Gmail
 * Rewriter's Health.gs, scoped down for this tool's actual shape.
 *
 * Gmail Rewriter buffers events in CacheService because it's a
 * high-frequency request proxy where an inline Sheet write on every call
 * caused a real latency regression. This console has no equivalent request
 * path — an admin's own actions already cost one Apps Script round trip
 * each, and detectors only need to run periodically, not per-request — so
 * detectors here read straight from the Sheet's existing tabs (Queue,
 * Senders, Health, Suppression) on a time trigger. No buffer, no flush step.
 *
 * SETUP (once): visit the admin console with ?setupMonitoring=1 (see
 * admin/Code.gs's doGet) — creates the Incidents sheet and a 15-minute time
 * trigger through the same reliable, authenticated web-app path
 * ?bootstrap=1 already uses, rather than the Apps Script editor's Run
 * button, which proved unreliable enough times this session that nothing
 * new should depend on it. Then set CHAT_WEBHOOK_URL in Script Properties
 * (Google Chat space -> Apps & integrations -> Webhooks -> Add webhook) for
 * alerts. Without it, everything still detects and logs to Incidents — you
 * just get no push. Health tab's "Send test alert" confirms the webhook fires.
 */

const MONITOR_WINDOW_MIN = 60;      // detectors reason over this trailing window
const MONITOR_INTERVAL_MIN = 15;    // how often the trigger fires
const ALERT_COOLDOWN_MIN = 30;      // don't re-alert the same detector inside this window
const STALE_SENDER_MIN = 30;        // matches GOVERNANCE.agentStaleMinutes — kept independent on purpose, see detectStaleSenders

function setupHealthMonitoring_() {
  ensureSchema_(); // creates the Incidents tab if this is the first time — same idempotent bootstrap as everything else
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runHealthCheck_'; });
  if (!exists) ScriptApp.newTrigger('runHealthCheck_').timeBased().everyMinutes(MONITOR_INTERVAL_MIN).create();
  Logger.log('Health monitoring installed — every ' + MONITOR_INTERVAL_MIN + ' min. Set CHAT_WEBHOOK_URL in Script Properties for alerts.');
}

// ─── Detectors ──────────────────────────────────────────────────────────────
// Each is a pure function over freshly-read Sheet state; returns null
// (healthy) or an incident object. Wrapped individually in runDetectors_ so
// one throwing can never blind the rest.

/** Nothing sends while this is on — the single most important thing to know immediately. */
function detectKillSwitch_() {
  if (!isKillSwitchOn_()) return null;
  const row = findRow_('Control', 'kill_switch');
  return {
    severity: 'critical', detector: 'kill_switch_on',
    summary: 'Kill switch is ON — nothing is sending',
    detail: 'Set by ' + (row ? row.updated_by : 'unknown') + ' at ' + (row ? row.updated_at : 'unknown')
      + '. If this was not deliberate, check Incidents for why (likely a bounce/complaint-rate breach) before turning it back on.',
  };
}

/**
 * A sender with no heartbeat means its trigger is gone or its agent lost
 * authorization — sends silently stop with no error anywhere else, since
 * there is no failed Queue row, just an absence of new 'sent' ones.
 *
 * Independent constant from GOVERNANCE.agentStaleMinutes (30) rather than
 * reusing it directly: that value governs per-sender UI staleness display,
 * this one governs when to actively page someone. They happen to match
 * today; keeping them separate means changing one doesn't silently change
 * the other's intent later.
 */
function detectStaleSenders_() {
  const now = new Date();
  const stale = readRows_('Senders').filter(function (s) {
    if (s.status !== 'active') return false;
    if (!s.last_heartbeat) return true;
    return (now - new Date(s.last_heartbeat)) > STALE_SENDER_MIN * 60000;
  });
  if (!stale.length) return null;
  return {
    severity: 'critical', detector: 'stale_senders',
    summary: stale.length + ' active sender(s) with no heartbeat in ' + STALE_SENDER_MIN + ' min',
    detail: stale.map(function (s) { return s.email + ' (last: ' + (s.last_heartbeat || 'never') + ')'; }).join(', ')
      + '. Their trigger is likely gone or their agent lost authorization — send them the Operations tab\'s Onboard link to re-register.',
  };
}

/**
 * Jobs stuck 'pending' well past their due time means an agent is up
 * (heartbeat looks fine) but not actually pulling work — a subtler failure
 * than detectStaleSenders_, since the agent still LOOKS alive.
 */
function detectQueueBacklog_() {
  const now = new Date();
  const overdue = readRows_('Queue', function (q) {
    return q.status === 'pending' && (now - new Date(q.due_at_utc)) > MONITOR_WINDOW_MIN * 60000;
  });
  if (overdue.length < 3) return null;
  const bySender = {};
  overdue.forEach(function (q) { bySender[q.sender_email] = (bySender[q.sender_email] || 0) + 1; });
  return {
    severity: 'warn', detector: 'queue_backlog',
    summary: overdue.length + ' send(s) overdue by more than ' + MONITOR_WINDOW_MIN + ' min',
    detail: Object.keys(bySender).map(function (s) { return s + ': ' + bySender[s]; }).join(', ')
      + '. Check that sender\'s agent is actually ticking (Health tab), not just reporting a heartbeat.',
  };
}

/** Bounce auto-halt already fires (gateway/AgentApi.gs), but a human still needs to be told, not just the kill switch. */
function detectBounceRate_() {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const rows = readRows_('Health', function (h) { return h.date === today; });
  const worst = rows.filter(function (h) { return h.bounce_rate > GOVERNANCE.bounceRateHaltPct; })
    .sort(function (a, b) { return b.bounce_rate - a.bounce_rate; })[0];
  if (!worst) return null;
  return {
    severity: 'critical', detector: 'bounce_rate',
    summary: worst.sender_email + ' bounce rate ' + worst.bounce_rate.toFixed(1) + '% (halts at ' + GOVERNANCE.bounceRateHaltPct + '%)',
    detail: worst.bounced + ' bounced of ' + worst.sent + ' sent today. The kill switch should already be on from this — '
      + 'if it is not, that is itself a second bug worth reporting.',
  };
}

/** No detector catches list-quality problems until a real send bounces — this catches it one step earlier, at import. */
function detectVerificationRisk_() {
  if (!reoonConfigured_()) return null;
  const risky = readRows_('Recipients', function (r) {
    return r.status === 'queued' && (r.verify_status === 'invalid' || r.verify_status === 'disposable');
  });
  if (risky.length < 5) return null;
  return {
    severity: 'warn', detector: 'unverified_risk',
    summary: risky.length + ' queued recipient(s) marked invalid/disposable by Reoon but not yet removed',
    detail: 'Campaigns: ' + [...new Set(risky.map(function (r) { return r.campaign_id; }))].join(', ')
      + '. Audience tab -> Hard checks -> remove them before these campaigns launch.',
  };
}

/**
 * Positive-news detector: the Gmail API being newly reachable means the
 * single-touch restriction and manual reply/filter workflow could both be
 * lifted. Nobody manually re-checks this once it's known to be broken —
 * this makes the good news arrive on its own instead of staying broken by
 * default forever. Reads capabilities off whichever agent last reported them.
 */
function detectGcpAvailable_() {
  const senders = readRows_('Senders');
  const anyGmailApi = senders.some(function (s) { return s.capabilities && s.capabilities.gmailApi === true; });
  if (!anyGmailApi) return null;
  return {
    severity: 'info', detector: 'gcp_available',
    summary: 'The Gmail API is now reachable from at least one agent',
    detail: 'docs/GCP_CONSTRAINT.md\'s blocker may be resolved. Worth reconsidering ALLOW_MULTI_TOUCH and automatic '
      + 'label/filter setup now that the underlying restriction may be gone — re-run ?diagnose=1 to confirm before changing anything.',
  };
}

function runDetectors_() {
  const out = [];
  [detectKillSwitch_, detectStaleSenders_, detectQueueBacklog_, detectBounceRate_, detectVerificationRisk_, detectGcpAvailable_]
    .forEach(function (fn) {
      try { const inc = fn(); if (inc) out.push(inc); }
      catch (err) { console.error('[monitor] detector failed: ' + fn.name + ': ' + err.message); }
    });
  return out;
}

// ─── Alerting ───────────────────────────────────────────────────────────────

/**
 * Configured from the Health tab, not the Apps Script editor. A webhook URL
 * carries its own key in the query string — anyone holding it can post into
 * the space — so it goes into this project's private Script Properties by
 * the same route as the Reoon key (admin/EmailVerify.gs setReoonApiKey) and
 * is never read back into the UI, never logged, and never in the repo.
 */
function getChatWebhookStatus() {
  requireAdmin_();
  const url = PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK_URL') || '';
  return {
    configured: !!url,
    // Enough to tell two spaces apart when rotating, not enough to post with.
    hint: url ? url.replace(/^https:\/\/([^/]+).*$/, '$1') + ' · …' + url.slice(-6) : '',
    monitoringInstalled: ScriptApp.getProjectTriggers()
      .some(function (t) { return t.getHandlerFunction() === 'runHealthCheck_'; }),
  };
}

function setChatWebhook(url) {
  const admin = requireAdmin_();
  const clean = String(url || '').trim();
  if (!clean) throw new Error('Webhook URL was empty');
  if (!/^https:\/\/chat\.googleapis\.com\//.test(clean)) {
    throw new Error('That is not a Google Chat webhook — it should start with https://chat.googleapis.com/');
  }
  PropertiesService.getScriptProperties().setProperty('CHAT_WEBHOOK_URL', clean);
  logEvent_(admin, 'config_change', { detail: { action: 'set_chat_webhook' } }); // never the value
  return { configured: true };
}

function clearChatWebhook() {
  const admin = requireAdmin_();
  PropertiesService.getScriptProperties().deleteProperty('CHAT_WEBHOOK_URL');
  logEvent_(admin, 'config_change', { detail: { action: 'clear_chat_webhook' } });
  return { configured: false };
}

/** Installs the recurring health check from the console, so nothing here needs the editor's Run button. */
function installHealthMonitoring() {
  const admin = requireAdmin_();
  setupHealthMonitoring_();
  logEvent_(admin, 'config_change', { detail: { action: 'install_health_monitoring', everyMinutes: MONITOR_INTERVAL_MIN } });
  return { installed: true, everyMinutes: MONITOR_INTERVAL_MIN };
}

function notifyChat_(inc) {
  const url = PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK_URL');
  if (!url) return false;
  const icon = inc.severity === 'critical' ? '🔴' : inc.severity === 'warn' ? '🟠' : 'ℹ️';
  const text = icon + ' *MIS Outreach — ' + inc.severity.toUpperCase() + '*\n*' + inc.summary + '*\n' + inc.detail
    + '\n_detector: ' + inc.detector + '_';
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ text: text }), muteHttpExceptions: true,
    });
    return res.getResponseCode() === 200;
  } catch (err) {
    console.error('[monitor] chat notify failed: ' + err.message);
    return false;
  }
}

function recordIncidents_(incidents) {
  const props = PropertiesService.getScriptProperties();
  incidents.forEach(function (inc) {
    const key = 'ALERT_LAST_' + inc.detector;
    const last = parseInt(props.getProperty(key) || '0', 10);
    const due = Date.now() - last > ALERT_COOLDOWN_MIN * 60000;
    let notified = 'suppressed (cooldown)';
    if (due) {
      notified = notifyChat_(inc) ? 'chat' : 'no channel configured';
      props.setProperty(key, String(Date.now()));
    }
    appendRow_('Incidents', {
      ts: new Date(), severity: inc.severity, detector: inc.detector,
      summary: inc.summary, detail: inc.detail, notified: notified,
    });
  });
}

/** The time-trigger entry point. Also reachable manually from the Health tab for an on-demand check. */
function runHealthCheck_() {
  const incidents = runDetectors_();

  // The detectors watch the data — backlogs, bounce rates, stale agents. The
  // self-test watches the machinery itself: is the gateway answering, does
  // escaping still hold, did a delegation approve without registering. Those
  // are the failures that reached real people, and none of them would show up
  // as an anomaly in the data, because nothing was flowing to be anomalous.
  try {
    const selfTest = runSelfTestProbes_();
    selfTest.probes.filter(function (p) { return !p.ok; }).forEach(function (p) {
      incidents.push({
        severity: p.severity === 'warn' ? 'warn' : 'critical',
        detector: 'selftest_' + p.name.toLowerCase().replace(/[^a-z]+/g, '_'),
        summary: 'Self-test: ' + p.name,
        detail: p.detail + (p.repairable ? ' — repairable from the Health tab.' : ''),
      });
    });
  } catch (e) {
    incidents.push({
      severity: 'warn', detector: 'selftest_failed',
      summary: 'The self-test could not run',
      detail: String(e && e.message || e),
    });
  }

  if (incidents.length) recordIncidents_(incidents);
  return incidents;
}

/** Admin-callable version for the console — "check now" instead of waiting for the next 15-minute tick. */
function runHealthCheckNow() {
  requireAdmin_();
  const incidents = runHealthCheck_();
  return { checked: new Date().toISOString(), incidents: incidents };
}

/** Recent incidents for the Health tab — collapses repeats so one ongoing issue doesn't bury everything else. */
function getRecentIncidents() {
  requireAdmin_();
  // Incidents stays small at pilot volume (one row per detector firing, most
  // suppressed by the 30-min cooldown) — reading it whole and slicing in JS
  // is simpler than hand-rolling a reverse-paginated range read, and correct
  // at this scale. Revisit if this tab ever grows into the thousands.
  const rows = readRows_('Incidents').slice(-200).reverse();
  const byKey = {};
  const out = [];
  rows.forEach(function (r) {
    const key = r.detector + '|' + r.summary;
    if (byKey[key]) { byKey[key].count++; return; }
    const item = { ts: r.ts, severity: r.severity, detector: r.detector, summary: r.summary, detail: r.detail, notified: r.notified, count: 1 };
    byKey[key] = item;
    out.push(item);
  });
  return out.slice(0, 20);
}

/** UI-callable, not editor-only — same reliability reasoning as everything else in this file's header comment. */
function sendTestAlert() {
  requireAdmin_();
  const ok = notifyChat_({
    severity: 'warn', detector: 'test_alert',
    summary: 'Test alert from MIS Outreach health monitoring',
    detail: 'If you see this in Chat, the webhook is wired correctly. Safe to ignore.',
  });
  return { sent: ok };
}
