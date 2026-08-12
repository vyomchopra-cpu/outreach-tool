/**
 * Turns queued Recipients into scheduled Queue rows using shared/Schedule.gs
 * math. Split from that file because everything here touches the Store —
 * Senders lookups, Queue writes, Recipients status updates — which is exactly
 * what shared/Schedule.gs's pure functions are kept free of for testability.
 */

/**
 * Schedules one sender's slice of recipients, continuing from whatever index
 * that sender already has queued for this campaign (so canary -> release
 * doesn't restart day/slot numbering from zero).
 */
function scheduleForSender_(campaign, senderEmail, recipients) {
  const senderRow = findRow_('Senders', senderEmail);
  if (!senderRow) {
    throw new Error('Sender ' + senderEmail + ' has not completed onboarding (no Senders row) — see docs/BUILD_ORDER.md Stage 4');
  }
  if (senderRow.status !== 'active') {
    throw new Error('Sender ' + senderEmail + ' is not active (status: ' + senderRow.status + ')');
  }

  const alreadyQueued = readRows_('Queue', function (q) {
    return q.campaign_id === campaign.id && q.sender_email === senderEmail;
  }).length;

  const windowMinutes = (SEND_WINDOW.endHour - SEND_WINDOW.startHour) * 60;
  const interval = campaign.interval_minutes ? Number(campaign.interval_minutes) : null;

  const capLookup = function (dayOffset) {
    const day = businessDayOffset_(new Date(), dayOffset);
    const cap = capForSenderToday_(senderRow.ramp_start_date, day, DAILY_CAP_RAMP, senderRow.daily_cap_override || null);
    // A fixed interval can be the tighter constraint: at 60-minute spacing an
    // 8-hour window physically holds 9 sends, however high the cap is.
    return interval ? Math.min(cap, slotsPerWindow_(interval, windowMinutes)) : cap;
  };

  /**
   * Interval mode anchors on "now" for today only, so a campaign launched
   * mid-window starts immediately rather than at slots already in the past.
   * Later days start at the top of the window as usual.
   */
  const anchorFor_ = function (dayOffset, timeZone) {
    if (!interval || dayOffset > 0) return 0;
    const nowLocal = localMinutes_(new Date(), timeZone, formatInZoneViaUtilities_);
    return Math.max(0, nowLocal - SEND_WINDOW.startHour * 60);
  };

  let lastDue = null;

  recipients.forEach(function (recipient, idx) {
    const globalIndex = alreadyQueued + idx;
    const slot = scheduleSlotForIndex_(globalIndex, capLookup);
    const sendDate = businessDayOffset_(new Date(), slot.dayOffset);
    const timeZone = campaign.tz_mode === 'recipient' ? recipient.recipient_tz : senderRow.timezone;
    if (!timeZone) {
      throw new Error('No timezone available for recipient ' + recipient.email + ' (tz_mode=' + campaign.tz_mode + ')');
    }
    const minuteOffset = interval
      ? fixedIntervalMinutes_(slot.slotIndex, interval, anchorFor_(slot.dayOffset, timeZone))
      : jitteredSlotMinutes_(slot.slotIndex, windowMinutes, slot.capThatDay, 0.4);
    const dueAt = dueAtUtcForSlot_(sendDate, SEND_WINDOW.startHour, minuteOffset, timeZone, formatInZoneViaUtilities_);

    appendRow_('Queue', {
      id: recipient.id + '-q',
      campaign_id: campaign.id,
      recipient_id: recipient.id,
      sender_email: senderEmail,
      due_at_utc: dueAt,
      status: 'pending',
      attempts: 0,
      idempotency_key: recipient.id + '-' + campaign.id,
      sent_message_id: '',
      sent_at: '',
      error: '',
    });
    updateRow_('Recipients', recipient.id, { status: 'scheduled' });
    lastDue = dueAt;
  });

  return lastDue;
}

function scheduleRecipients_(campaign, recipients) {
  const bySender = {};
  recipients.forEach(function (r) {
    (bySender[r.assigned_sender] = bySender[r.assigned_sender] || []).push(r);
  });
  let latest = null;
  Object.keys(bySender).forEach(function (senderEmail) {
    const due = scheduleForSender_(campaign, senderEmail, bySender[senderEmail]);
    if (due && (!latest || due > latest)) latest = due;
  });
  return latest;
}

function assertLaunchGatesClear_(campaign) {
  const preflight = runPreflight_(campaign);
  if (!preflight.ok) {
    throw new Error('Preflight failing: ' + preflight.checks.filter(function (c) { return !c.ok && c.blocking !== false; }).map(function (c) { return c.name; }).join(', '));
  }
  if (!campaign.seed_passed_at) throw new Error('Seed send has not been confirmed passed');
  const seedAgeHours = (new Date() - new Date(campaign.seed_passed_at)) / (60 * 60 * 1000);
  if (seedAgeHours > GOVERNANCE.seedSendMaxAgeHours) {
    throw new Error('Seed pass is ' + Math.round(seedAgeHours) + 'h old, exceeds the ' + GOVERNANCE.seedSendMaxAgeHours + 'h freshness window — re-seed');
  }
  if (!campaign.exec_approved_at) throw new Error('No exec has approved this campaign yet');
}

/** Schedules only the first 5 recipients (by import order) and holds everything else back. */
function launchCampaignCanary(campaignId) {
  const admin = requireAdmin_();
  const campaign = getCampaign(campaignId);
  assertLaunchGatesClear_(campaign);

  const queued = readRows_('Recipients', function (r) { return r.campaign_id === campaignId && r.status === 'queued'; });
  if (queued.length === 0) throw new Error('No queued recipients to launch');

  const canary = queued.slice(0, 5);
  scheduleRecipients_(campaign, canary);
  updateRow_('Campaigns', campaignId, { status: 'canary' });
  logEvent_(admin, 'admin_action', { campaignId: campaignId, detail: { action: 'launch_canary', count: canary.length } });
}

/** Schedules everyone still queued, after an admin has reviewed the canary's real sends. */
function releaseCanary(campaignId) {
  const admin = requireAdmin_();
  const campaign = getCampaign(campaignId);
  if (campaign.status !== 'canary') throw new Error('Campaign is not in canary status (is: ' + campaign.status + ')');

  const remaining = readRows_('Recipients', function (r) { return r.campaign_id === campaignId && r.status === 'queued'; });
  const lastDue = scheduleRecipients_(campaign, remaining);

  updateRow_('Campaigns', campaignId, {
    status: 'running',
    canary_released_at: new Date(),
    projected_completion: lastDue ? lastDue.toISOString().slice(0, 10) : campaign.projected_completion,
  });
  logEvent_(admin, 'admin_action', { campaignId: campaignId, detail: { action: 'release_canary', count: remaining.length } });
}

/**
 * Exec self-approval — a named sender in the campaign's pool confirming they
 * stand behind this content going out under their name (README: "per-campaign
 * exec approval gate before first send"). Deliberately a separate guard from
 * requireAdmin_(), since the approving exec is very often not on the admin
 * allowlist. No dedicated exec-facing page yet — see docs/BUILD_ORDER.md Stage 6/7.
 */
function approveCampaignAsExec(campaignId) {
  const email = Session.getActiveUser().getEmail();
  const campaign = getCampaign_noAuth_(campaignId);
  const pool = (campaign.sender_pool || '').split(',').filter(Boolean);
  if (pool.indexOf(email) === -1) {
    throw new Error('Not authorized: ' + email + ' is not in this campaign\'s sender pool');
  }
  updateRow_('Campaigns', campaignId, { exec_approved_by: email, exec_approved_at: new Date() });
  logEvent_(email, 'admin_action', { campaignId: campaignId, detail: { action: 'exec_approve' } });
}

/** getCampaign() is admin-gated; exec approval needs the same read without requireAdmin_(). */
function getCampaign_noAuth_(campaignId) {
  const c = findRow_('Campaigns', campaignId);
  if (!c) throw new Error('No such campaign: ' + campaignId);
  return c;
}

/**
 * Complaint rate has no API — Google Postmaster Tools is the only source,
 * and it's a manual daily glance, not a webhook. An admin reads the number
 * off Postmaster and enters it here; the same GOVERNANCE.complaintRateHaltPct
 * threshold that governs bounce rate governs this too.
 */
function recordComplaintRate(senderEmail, dateStr, complaintRatePct) {
  const admin = requireAdmin_();
  const existing = readRows_('Health', function (h) { return h.date === dateStr && h.sender_email === senderEmail; })[0];
  upsertHealth_({
    date: dateStr, sender_email: senderEmail,
    sent: existing ? existing.sent : 0,
    bounced: existing ? existing.bounced : 0,
    replied: existing ? existing.replied : 0,
    unsubscribed: existing ? existing.unsubscribed : 0,
    bounce_rate: existing ? existing.bounce_rate : 0,
    complaint_rate: complaintRatePct,
  });
  logEvent_(admin, 'admin_action', { senderEmail: senderEmail, detail: { action: 'record_complaint_rate', dateStr: dateStr, complaintRatePct: complaintRatePct } });
  if (complaintRatePct > GOVERNANCE.complaintRateHaltPct) {
    setKillSwitch_(true, admin + ' (complaint_rate_breach:' + senderEmail + ')');
    logEvent_('system', 'halt', { senderEmail: senderEmail, detail: { reason: 'complaint_rate', rate: complaintRatePct } });
  }
}

/** Admin-facing kill switch controls — the one-click stop the exec dashboard and the admin console both need. */
function setKillSwitch(on) {
  const admin = requireAdmin_();
  setKillSwitch_(on, admin);
}

function getKillSwitchStatus() {
  requireAdmin_();
  return isKillSwitchOn_();
}
