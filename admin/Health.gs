/**
 * One snapshot of everything an operator needs to answer "is this healthy,
 * and what is it doing right now" — assembled server-side in a single call
 * rather than a dozen google.script.run round trips, because each one costs a
 * full Apps Script cold start.
 *
 * Every number here is derived from our own records: what we queued, what the
 * agents reported back, and what admins did. Nothing is inferred from
 * recipient behaviour — there is no tracking pixel and no link rewriting, so
 * there is deliberately no "open rate" or "click rate" to report. See
 * docs/ANALYTICS.md for why that is a design position and not an omission.
 *
 * Scaling note: this reads whole tabs. Fine at pilot volume (hundreds of
 * rows). Past a few thousand, move the per-campaign rollups into the nightly
 * Health job rather than recomputing them on every page load.
 */

function tallyBy_(rows, key) {
  const out = {};
  rows.forEach(function (r) {
    const k = r[key] || 'unknown';
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}

function getHealthSnapshot() {
  requireAdmin_();

  const campaigns = readRows_('Campaigns');
  const recipients = readRows_('Recipients');
  const queue = readRows_('Queue');
  const senders = readRows_('Senders');
  const suppression = readRows_('Suppression');
  const events = readRows_('Events');
  const now = new Date();
  const staleMs = GOVERNANCE.agentStaleMinutes * 60 * 1000;

  // --- Senders: capacity used today, and whether the agent is even alive ---
  const senderRows = senders.map(function (s) {
    const caps = s.capabilities || {};
    const lastBeat = s.last_heartbeat ? new Date(s.last_heartbeat) : null;
    const capToday = capForSenderToday_(s.ramp_start_date, now, DAILY_CAP_RAMP, s.daily_cap_override || null);
    const todayLocal = formatInZoneViaUtilities_(now, s.timezone || 'Asia/Kolkata').slice(0, 10);
    const sentToday = queue.filter(function (q) {
      if (q.sender_email !== s.email || q.status !== 'sent' || !q.sent_at) return false;
      if (String(q.recipient_id).indexOf('seed:') === 0) return false; // seeds are not prospect touches
      return formatInZoneViaUtilities_(new Date(q.sent_at), s.timezone || 'Asia/Kolkata').slice(0, 10) === todayLocal;
    }).length;

    return {
      email: s.email,
      displayName: s.display_name,
      status: s.status,
      transport: caps.transport || 'unknown',
      signalsWorking: caps.signals === true,
      agentVersion: s.agent_version || '—',
      lastHeartbeat: s.last_heartbeat || '',
      stale: !lastBeat || (now - lastBeat) > staleMs,
      sentToday: sentToday,
      capToday: capToday,
      capUsedPct: capToday ? Math.round((sentToday / capToday) * 100) : 0,
      providerQuota: caps.providerQuota == null ? '—' : caps.providerQuota,
      // "No recent heartbeat" is only useful if the next step is obvious.
      // The trigger lives in that person's own account, so the fix is always
      // "send them this and have them open it" — never something an operator
      // can do for them. See agentRepairUrlFor_.
      repairUrl: agentRepairUrlFor_(s.email),
    };
  });

  // --- Campaigns: the funnel, per campaign ---
  const campaignRows = campaigns.map(function (c) {
    const mine = recipients.filter(function (r) { return r.campaign_id === c.id; });
    const byStatus = tallyBy_(mine, 'status');
    const q = queue.filter(function (x) { return x.campaign_id === c.id; });
    const pending = q.filter(function (x) { return x.status === 'pending'; });
    const nextDue = pending
      .map(function (x) { return new Date(x.due_at_utc); })
      .sort(function (a, b) { return a - b; })[0] || null;

    return {
      id: c.id,
      name: c.name,
      status: c.status,
      interval: c.interval_minutes || '',
      total: mine.length,
      queued: byStatus.queued || 0,
      scheduled: byStatus.scheduled || 0,
      sent: byStatus.sent || 0,
      replied: byStatus.replied || 0,
      bounced: byStatus.bounced || 0,
      unsubscribed: byStatus.unsubscribed || 0,
      failed: byStatus.failed || 0,
      pendingSends: pending.length,
      nextDue: nextDue ? nextDue.toISOString() : '',
      projectedCompletion: c.projected_completion || '',
    };
  }).sort(function (a, b) { return a.id < b.id ? 1 : -1; });

  // --- Totals that matter for deliverability, not vanity ---
  const sentAll = queue.filter(function (q) { return q.status === 'sent'; }).length;
  const bounced = recipients.filter(function (r) { return r.status === 'bounced'; }).length;
  const replied = recipients.filter(function (r) { return r.status === 'replied'; }).length;

  // --- What went wrong, most recent first: the first thing to look at ---
  const failures = queue
    .filter(function (q) { return q.status === 'failed' || (q.error && q.status !== 'sent'); })
    .sort(function (a, b) { return (b.sent_at || '') < (a.sent_at || '') ? -1 : 1; })
    .slice(0, 15)
    .map(function (q) {
      return { id: q.id, campaign: q.campaign_id, sender: q.sender_email, attempts: q.attempts, error: q.error };
    });

  const recentEvents = events.slice(-25).reverse().map(function (e) {
    return {
      ts: e.ts, actor: e.actor, type: e.type,
      campaign: e.campaign_id || '', sender: e.sender_email || '',
      detail: e.detail ? JSON.stringify(e.detail) : '',
    };
  });

  return {
    generatedAt: now.toISOString(),
    system: {
      killSwitch: isKillSwitchOn_(),
      suppressionCount: suppression.length,
      sendersActive: senderRows.filter(function (s) { return s.status === 'active' && !s.stale; }).length,
      sendersTotal: senderRows.length,
      signalsDegraded: senderRows.filter(function (s) { return !s.signalsWorking; }).length,
      sentAllTime: sentAll,
      repliedAllTime: replied,
      bouncedAllTime: bounced,
      bounceRatePct: sentAll ? Math.round((bounced / sentAll) * 1000) / 10 : 0,
      replyRatePct: sentAll ? Math.round((replied / sentAll) * 1000) / 10 : 0,
      bounceHaltAt: GOVERNANCE.bounceRateHaltPct,
    },
    senders: senderRows,
    campaigns: campaignRows,
    failures: failures,
    events: recentEvents,
  };
}
