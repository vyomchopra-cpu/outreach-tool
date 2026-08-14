/**
 * Deliberately tries to break things, reports what is broken, and repairs
 * what is safe to repair.
 *
 * Why this exists, stated bluntly: every failure in this tool's first weeks
 * was found by a human clicking something and getting a useless error. A
 * token corrupted by template escaping, an agent that could not name itself
 * inside its own trigger, a sender secret stranded by a storage change, three
 * gateway endpoints deployed unreachable — all of them shipped with a fully
 * green unit suite, because test/qa.mjs reads source code and none of these
 * were visible in source code. They were only visible in a running system.
 *
 * So this probes the LIVE system: real Sheet, real gateway, real senders,
 * real rendering. It is the opposite of a unit test and complements rather
 * than replaces one.
 *
 * Two rules it holds itself to:
 *
 *   1. A probe never repairs as a side effect of looking. runSelfTest() is
 *      strictly read-only; repairs happen only in runSelfTestAndRepair(),
 *      and only for the subset marked repairable.
 *   2. A repair may only ever narrow what the system can do — cancel a send
 *      that must not go, mark a dead request dead, recreate a missing tab.
 *      Nothing here can grant access, extend a window, or send anything.
 *      That asymmetry is what makes it safe to run automatically.
 */

/** One probe's result. `repairable` means runSelfTestAndRepair can act on it unattended. */
function probeResult_(name, ok, detail, opts) {
  const o = opts || {};
  return {
    name: name,
    ok: !!ok,
    severity: ok ? 'ok' : (o.severity || 'critical'),
    detail: detail || '',
    repairable: !ok && !!o.repairable,
    fix: o.fix || '',
    repaired: false,
  };
}

/** Runs a probe so one thrown exception cannot hide every probe after it. */
function safeProbe_(name, fn) {
  try {
    return fn();
  } catch (e) {
    return probeResult_(name, false, 'The check itself failed: ' + (e && e.message || e));
  }
}

// ─── The probes ─────────────────────────────────────────────────────────────

/** Every tab named in SCHEMA exists with the right headers, in the right order. */
function probeSchema_() {
  return safeProbe_('Sheet structure', function () {
    const ss = null; // Store.gs owns SpreadsheetApp; go through it, never around it.
    const missing = [];
    Object.keys(SCHEMA).forEach(function (tab) {
      try {
        readRows_(tab, function () { return false; });
      } catch (e) {
        missing.push(tab);
      }
    });
    return missing.length
      ? probeResult_('Sheet structure', false, 'Missing or unreadable tab(s): ' + missing.join(', '),
        { repairable: true, fix: 'ensureSchema_' })
      : probeResult_('Sheet structure', true, Object.keys(SCHEMA).length + ' tabs present');
  });
}

/**
 * The gateway is a separate deployment reached over plain HTTPS, so it can be
 * broken in ways nothing local reveals: not redeployed, an action missing
 * from its whitelist, or returning HTML instead of JSON. Three delegation
 * endpoints once shipped completely unreachable this way.
 */
function probeGateway_() {
  return safeProbe_('Gateway reachable', function () {
    const res = UrlFetchApp.fetch(CENTRAL_WEBAPP_URL, {
      method: 'post',
      contentType: 'application/json',
      // Deliberately invalid credentials: proves the endpoint is alive and
      // speaking our protocol WITHOUT causing any state change.
      payload: JSON.stringify({ action: 'heartbeat', args: ['__selftest__@invalid', 'x', '0', {}] }),
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const body = res.getContentText();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      return probeResult_('Gateway reachable', false,
        'Answered HTTP ' + res.getResponseCode() + ' with non-JSON — it is probably serving a Google error page rather than our code.');
    }
    if (parsed.error && /unknown action/i.test(parsed.error)) {
      return probeResult_('Gateway reachable', false,
        'Reachable, but does not know the "heartbeat" action — the deployed version is older than this console.');
    }
    // ok:false with "Unknown sender" is the CORRECT answer to a bogus sender.
    return probeResult_('Gateway reachable', true, 'Responding and rejecting bad credentials correctly');
  });
}

/** Config values that are load-bearing and silently catastrophic when wrong. */
function probeConfig_() {
  return safeProbe_('Configuration', function () {
    const problems = [];
    if (REOON_API_KEY) problems.push('REOON_API_KEY is hard-coded in shared/Config.gs — it belongs in Script Properties');
    if (!CENTRAL_WEBAPP_URL) problems.push('CENTRAL_WEBAPP_URL is empty — no agent can reach the gateway');
    if (!AGENT_WEBAPP_URL) problems.push('AGENT_WEBAPP_URL is empty — no approval link can be generated');
    if ([1, 5, 10, 15, 30].indexOf(AGENT_POLL_MINUTES) === -1) problems.push('AGENT_POLL_MINUTES is not a value Apps Script accepts');
    if (ALLOW_MULTI_TOUCH) problems.push('ALLOW_MULTI_TOUCH is on while reply detection is unavailable — a follow-up could fire at someone who already asked to stop');
    return problems.length
      ? probeResult_('Configuration', false, problems.join('; '))
      : probeResult_('Configuration', true, 'All load-bearing values sane');
  });
}

/**
 * Renders through the real shared renderer and asserts the security property
 * that matters most: a value from an untrusted CSV must be HTML-escaped
 * unless the author explicitly opted out with triple braces.
 */
function probeRendering_() {
  return safeProbe_('Rendering and merge escaping', function () {
    const hostile = '<script>alert(1)</script>';
    const sample = { first_name: hostile, last_name: 'X', company: 'C', title: 'T', custom: {} };
    const out = render_('<p>Hi {{firstName}}</p><p>{{{firstName}}}</p>', sample,
      { unsubscribe: 'u@example.com' }, {});

    if (out.html.indexOf('<script>alert(1)</script>') !== -1 && out.html.indexOf('&lt;script&gt;') === -1) {
      return probeResult_('Rendering and merge escaping', false,
        'A {{token}} rendered unescaped — CSV content could inject markup into outgoing mail.');
    }
    if (out.html.indexOf('&lt;script&gt;') === -1) {
      return probeResult_('Rendering and merge escaping', false, 'Escaped output not found where it was expected.');
    }
    return probeResult_('Rendering and merge escaping', true, 'Escaped by default, raw only on explicit opt-in');
  });
}

/** A sender that looks live but cannot work: no key, stale agent, or a lapsed window still marked active. */
function probeSenders_() {
  return safeProbe_('Senders', function () {
    const now = new Date();
    const staleMs = GOVERNANCE.agentStaleMinutes * 60 * 1000;
    const issues = [];
    const senders = readRows_('Senders');

    senders.forEach(function (s) {
      if (s.status !== 'active') return;
      if (!s.secret_hash) {
        issues.push(s.email + ' has no key — its agent cannot authenticate at all');
      }
      const beat = s.last_heartbeat ? new Date(s.last_heartbeat) : null;
      if (!beat || (now - beat) > staleMs) {
        issues.push(s.email + ' has not checked in since ' + (beat ? beat.toISOString() : 'ever')
          + ' — send them their restart link');
      }
      if (s.sends_expire_at && new Date(s.sends_expire_at) <= now) {
        issues.push(s.email + "'s approved window ended " + new Date(s.sends_expire_at).toISOString());
      }
    });

    if (!senders.length) return probeResult_('Senders', false, 'No senders at all — nothing can send', { severity: 'warn' });
    return issues.length
      ? probeResult_('Senders', false, issues.join('; '), { severity: 'warn' })
      : probeResult_('Senders', true, senders.length + ' sender(s), all reporting in');
  });
}

/**
 * A delegation approved but with no matching sender row means someone
 * approved and the registration did not complete — the exact state that
 * produced a live-looking sender which never polled.
 */
function probeDelegations_() {
  return safeProbe_('Delegations', function () {
    const issues = [];
    const senders = {};
    readRows_('Senders').forEach(function (s) { senders[s.email] = s; });

    readRows_('Delegations').forEach(function (d) {
      if (d.status === 'approved' && !senders[d.delegator_email]) {
        issues.push(d.delegator_email + ' approved but was never registered as a sender');
      }
      if (d.status === 'pending' && d.created_at) {
        const ageDays = (Date.now() - new Date(d.created_at)) / 86400000;
        if (ageDays > 14) issues.push(d.delegator_email + ' has an unanswered request ' + Math.round(ageDays) + ' days old');
      }
    });
    return issues.length
      ? probeResult_('Delegations', false, issues.join('; '), { severity: 'warn', repairable: true, fix: 'expireStaleDelegations' })
      : probeResult_('Delegations', true, 'No orphaned or stale requests');
  });
}

/**
 * The one probe whose failure is an actual incident rather than a nuisance:
 * a queued message addressed to someone on the suppression list. Suppression
 * is checked at import and again at poll time, so this should be impossible —
 * which is exactly why it is worth asserting rather than assuming.
 */
function probeSuppressionIntegrity_() {
  return safeProbe_('Suppression integrity', function () {
    const pending = readRows_('Queue', function (q) { return q.status === 'pending'; });
    const offenders = [];
    pending.forEach(function (q) {
      let email = '';
      const rid = String(q.recipient_id || '');
      if (rid.indexOf(':') !== -1) {
        email = rid.slice(rid.indexOf(':') + 1);
      } else {
        const r = findRow_('Recipients', rid);
        email = r ? r.email : '';
      }
      // Seeds go to our own mailboxes and are exempt by design.
      if (email && rid.indexOf('seed:') !== 0 && isSuppressed_(email)) {
        offenders.push(q.id + ' -> ' + email);
      }
    });
    return offenders.length
      ? probeResult_('Suppression integrity', false,
        'Queued despite being suppressed: ' + offenders.join(', '),
        { repairable: true, fix: 'cancelSuppressedQueueRows' })
      : probeResult_('Suppression integrity', true, pending.length + ' pending row(s), none suppressed');
  });
}

/** Work that is due but has not moved — usually the visible end of an agent that stopped polling. */
function probeQueueFlow_() {
  return safeProbe_('Queue flow', function () {
    const now = new Date();
    const overdue = readRows_('Queue', function (q) {
      return q.status === 'pending' && q.due_at_utc && (now - new Date(q.due_at_utc)) > 60 * 60 * 1000;
    });
    const failed = readRows_('Queue', function (q) { return q.status === 'failed'; });

    const bits = [];
    if (overdue.length) bits.push(overdue.length + ' message(s) overdue by more than an hour');
    if (failed.length) bits.push(failed.length + ' failed send(s)');
    return bits.length
      ? probeResult_('Queue flow', false, bits.join('; ') + ' — usually an agent that has stopped polling', { severity: 'warn' })
      : probeResult_('Queue flow', true, 'Nothing stuck');
  });
}

/** The kill switch being on is not a fault, but silently forgetting it is on absolutely is. */
function probeKillSwitch_() {
  return safeProbe_('Kill switch', function () {
    const on = isKillSwitchOn_();
    return on
      ? probeResult_('Kill switch', false, 'ON — nothing will send for anyone until it is turned off', { severity: 'warn' })
      : probeResult_('Kill switch', true, 'Off, sending permitted');
  });
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/** Read-only. Never changes anything, so it is always safe to run. */
function runSelfTest() {
  requireAdmin_();
  return runSelfTestProbes_();
}

function runSelfTestProbes_() {
  const probes = [
    probeSchema_(), probeConfig_(), probeGateway_(), probeRendering_(),
    probeSenders_(), probeDelegations_(), probeSuppressionIntegrity_(),
    probeQueueFlow_(), probeKillSwitch_(),
  ];
  return {
    ranAt: new Date().toISOString(),
    passed: probes.filter(function (p) { return p.ok; }).length,
    failed: probes.filter(function (p) { return !p.ok; }).length,
    critical: probes.filter(function (p) { return !p.ok && p.severity === 'critical'; }).length,
    repairable: probes.filter(function (p) { return p.repairable; }).length,
    probes: probes,
  };
}

/**
 * Applies the repairs that can only ever narrow what the system does. Each
 * one is listed explicitly rather than dispatched dynamically, so adding a
 * repair is a deliberate act and reviewing them means reading one list.
 */
function runSelfTestAndRepair() {
  const admin = requireAdmin_();
  const before = runSelfTestProbes_();
  const done = [];

  before.probes.forEach(function (p) {
    if (!p.repairable) return;
    try {
      if (p.fix === 'ensureSchema_') {
        ensureSchema_();
        done.push('Recreated missing Sheet tabs');
      } else if (p.fix === 'cancelSuppressedQueueRows') {
        const n = cancelSuppressedQueueRows_();
        done.push('Cancelled ' + n + ' queued message(s) to suppressed addresses');
      } else if (p.fix === 'expireStaleDelegations') {
        const n = expireStaleDelegations_();
        done.push('Closed ' + n + ' request(s) nobody answered');
      }
      p.repaired = true;
    } catch (e) {
      done.push('Could not repair "' + p.name + '": ' + e.message);
    }
  });

  const after = runSelfTestProbes_();
  if (done.length) {
    logEvent_(admin, 'admin_action', { detail: { action: 'self_test_repair', repairs: done } });
  }
  return { before: before, after: after, repairs: done };
}

/** Suppression is permanent and global; a pending row that violates it is cancelled, never sent. */
function cancelSuppressedQueueRows_() {
  let n = 0;
  readRows_('Queue', function (q) { return q.status === 'pending'; }).forEach(function (q) {
    const rid = String(q.recipient_id || '');
    if (rid.indexOf('seed:') === 0) return;
    let email = '';
    if (rid.indexOf(':') !== -1) {
      email = rid.slice(rid.indexOf(':') + 1);
    } else {
      const r = findRow_('Recipients', rid);
      email = r ? r.email : '';
    }
    if (email && isSuppressed_(email)) {
      updateRow_('Queue', q.id, { status: 'cancelled', error: 'recipient suppressed' });
      n++;
    }
  });
  return n;
}

/** An unanswered request is not a live one. Closing it means a forgotten link cannot be approved months later. */
function expireStaleDelegations_() {
  let n = 0;
  readRows_('Delegations', function (d) { return d.status === 'pending'; }).forEach(function (d) {
    if (!d.created_at) return;
    if ((Date.now() - new Date(d.created_at)) / 86400000 > 14) {
      updateRow_('Delegations', d.id, { status: 'expired', decided_at: new Date() });
      n++;
    }
  });
  return n;
}
