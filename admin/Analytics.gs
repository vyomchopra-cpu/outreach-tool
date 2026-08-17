/**
 * Campaign results, and getting them out of here.
 *
 * Two principles the numbers below stick to, because engagement metrics are
 * unusually easy to report flatteringly:
 *
 *   1. Unique and total are never merged. One person opening a message six
 *      times is one interested human, not six.
 *
 *   2. Machine-suspected opens are separated, never quietly folded in. Apple
 *      Mail Privacy Protection prefetches images for a large share of
 *      recipients, and a headline open rate that counts those is not measuring
 *      people. Both figures are shown; the honest one is labelled.
 *
 * Reply rate remains the number worth managing to. Click rate is second. Open
 * rate is included because it is asked for, with enough context to stop it
 * being read as truth.
 */

/** Denominator for every rate: nothing can be opened that was never delivered. */
function sentCountFor_(queueRows) {
  return queueRows.filter(function (q) { return q.status === 'sent'; }).length;
}

function pct_(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

/**
 * Everything about one campaign, per recipient and in aggregate. One pass over
 * each tab rather than a lookup per recipient — at a few thousand rows the
 * difference between this and the naive version is the difference between a
 * dashboard that loads and one that times out.
 */
function campaignResults(campaignId) {
  requireAdmin_();
  const campaign = findRow_('Campaigns', campaignId);
  if (!campaign) throw new Error('No such campaign: ' + campaignId);

  const recipients = readRows_('Recipients', function (r) { return r.campaign_id === campaignId; });
  const queue = readRows_('Queue', function (q) { return q.campaign_id === campaignId; });
  const tracking = readRows_('Tracking', function (t) { return t.campaign_id === campaignId; });

  const queueByRecipient = {};
  queue.forEach(function (q) { queueByRecipient[q.recipient_id] = q; });

  // recipient_id -> { opens, humanOpens, clicks, firstOpen, lastClick, urls }
  const events = {};
  tracking.forEach(function (t) {
    const e = events[t.recipient_id] || (events[t.recipient_id] = {
      opens: 0, humanOpens: 0, clicks: 0, firstOpen: null, lastClick: null, urls: {},
    });
    if (t.kind === 'open') {
      e.opens++;
      // machine_suspected round-trips through a Sheet cell, so it can come
      // back as the string "TRUE" rather than a boolean.
      const machine = t.machine_suspected === true || String(t.machine_suspected).toUpperCase() === 'TRUE';
      if (!machine) e.humanOpens++;
      if (!e.firstOpen || new Date(t.ts) < new Date(e.firstOpen)) e.firstOpen = t.ts;
    } else if (t.kind === 'click') {
      e.clicks++;
      e.lastClick = t.ts;
      if (t.url) e.urls[t.url] = (e.urls[t.url] || 0) + 1;
    }
  });

  const rows = recipients.map(function (r) {
    const q = queueByRecipient[r.id] || {};
    const e = events[r.id] || { opens: 0, humanOpens: 0, clicks: 0, firstOpen: null, lastClick: null };
    return {
      email: r.email,
      firstName: r.first_name || '',
      lastName: r.last_name || '',
      company: r.company || '',
      title: r.title || '',
      status: r.status,
      statusReason: r.status_reason || '',
      verifyStatus: r.verify_status || '',
      sender: q.sender_email || r.assigned_sender || '',
      sentAt: q.sent_at || null,
      sendStatus: q.status || 'not queued',
      error: q.error || '',
      opens: e.opens,
      humanOpens: e.humanOpens,
      firstOpenAt: e.firstOpen,
      clicks: e.clicks,
      lastClickAt: e.lastClick,
    };
  });

  const sent = sentCountFor_(queue);
  const openedUnique = rows.filter(function (x) { return x.opens > 0; }).length;
  const openedHumanUnique = rows.filter(function (x) { return x.humanOpens > 0; }).length;
  const clickedUnique = rows.filter(function (x) { return x.clicks > 0; }).length;
  const replied = recipients.filter(function (r) { return r.status === 'replied'; }).length;
  const bounced = recipients.filter(function (r) { return r.status === 'bounced'; }).length;
  const unsubscribed = recipients.filter(function (r) { return r.status === 'unsubscribed'; }).length;

  // Which links actually got clicked, across the whole campaign.
  const urlTotals = {};
  tracking.forEach(function (t) {
    if (t.kind === 'click' && t.url) urlTotals[t.url] = (urlTotals[t.url] || 0) + 1;
  });

  return {
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, subject: campaign.subject },
    totals: {
      recipients: recipients.length,
      sent: sent,
      pending: queue.filter(function (q) { return q.status === 'pending'; }).length,
      failed: queue.filter(function (q) { return q.status === 'failed'; }).length,
      openedUnique: openedUnique,
      openedHumanUnique: openedHumanUnique,
      openEvents: tracking.filter(function (t) { return t.kind === 'open'; }).length,
      clickedUnique: clickedUnique,
      clickEvents: tracking.filter(function (t) { return t.kind === 'click'; }).length,
      replied: replied,
      bounced: bounced,
      unsubscribed: unsubscribed,
    },
    rates: {
      // Every rate is against DELIVERED, not against the imported list —
      // otherwise an unsent backlog silently depresses everything.
      openRate: pct_(openedUnique, sent),
      humanOpenRate: pct_(openedHumanUnique, sent),
      clickRate: pct_(clickedUnique, sent),
      replyRate: pct_(replied, sent),
      bounceRate: pct_(bounced, sent),
      unsubscribeRate: pct_(unsubscribed, sent),
    },
    trackingOn: { opens: TRACK_OPENS, clicks: TRACK_CLICKS },
    topLinks: Object.keys(urlTotals)
      .map(function (u) { return { url: u, clicks: urlTotals[u] }; })
      .sort(function (a, b) { return b.clicks - a.clicks; })
      .slice(0, 10),
    rows: rows,
  };
}

/** Every campaign's headline numbers, for the overview table. */
function allCampaignResults() {
  requireAdmin_();
  const queue = readRows_('Queue');
  const recipients = readRows_('Recipients');
  const tracking = readRows_('Tracking');

  const byCampaign = {};
  function bucket_(id) {
    return byCampaign[id] || (byCampaign[id] = {
      sent: 0, recipients: 0, replied: 0, bounced: 0, unsubscribed: 0,
      openers: {}, humanOpeners: {}, clickers: {},
    });
  }
  queue.forEach(function (q) { if (q.status === 'sent') bucket_(q.campaign_id).sent++; });
  recipients.forEach(function (r) {
    const b = bucket_(r.campaign_id);
    b.recipients++;
    if (r.status === 'replied') b.replied++;
    if (r.status === 'bounced') b.bounced++;
    if (r.status === 'unsubscribed') b.unsubscribed++;
  });
  tracking.forEach(function (t) {
    const b = bucket_(t.campaign_id);
    if (t.kind === 'open') {
      b.openers[t.recipient_id] = true;
      const machine = t.machine_suspected === true || String(t.machine_suspected).toUpperCase() === 'TRUE';
      if (!machine) b.humanOpeners[t.recipient_id] = true;
    } else if (t.kind === 'click') {
      b.clickers[t.recipient_id] = true;
    }
  });

  return readRows_('Campaigns', function (c) { return c.status !== TEST_CAMPAIGN_STATUS; })
    .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })
    .map(function (c) {
      const b = bucket_(c.id);
      return {
        id: c.id, name: c.name, status: c.status, createdAt: c.created_at,
        recipients: b.recipients, sent: b.sent,
        openedUnique: Object.keys(b.openers).length,
        openedHumanUnique: Object.keys(b.humanOpeners).length,
        clickedUnique: Object.keys(b.clickers).length,
        replied: b.replied, bounced: b.bounced, unsubscribed: b.unsubscribed,
        replyRate: pct_(b.replied, b.sent),
        humanOpenRate: pct_(Object.keys(b.humanOpeners).length, b.sent),
        clickRate: pct_(Object.keys(b.clickers).length, b.sent),
      };
    });
}

// ─── Export ─────────────────────────────────────────────────────────────────

/**
 * Proper RFC-4180 quoting. Naive CSV building is the classic way to produce a
 * file that opens fine in one tool and is silently corrupt in another — a
 * company name containing a comma, or a status reason containing a newline,
 * is enough to shift every subsequent column.
 */
function csvCell_(value) {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv_(headers, rows) {
  const lines = [headers.map(csvCell_).join(',')];
  rows.forEach(function (r) { lines.push(r.map(csvCell_).join(',')); });
  // CRLF and a UTF-8 BOM: without the BOM, Excel mis-decodes non-ASCII names
  // in exactly the markets this list is most likely to contain.
  return '﻿' + lines.join('\r\n');
}

/**
 * Per-recipient results as CSV. Returned as a string for the browser to save
 * rather than written to Drive — an export should not silently create files
 * in someone's Drive, and this keeps the data inside the session that asked
 * for it.
 */
function exportCampaignCsv(campaignId) {
  const results = campaignResults(campaignId); // does its own requireAdmin_
  const headers = [
    'email', 'first_name', 'last_name', 'company', 'title',
    'sender', 'send_status', 'sent_at', 'error',
    'recipient_status', 'status_reason', 'verify_status',
    'opens_total', 'opens_human', 'first_open_at',
    'clicks_total', 'last_click_at',
  ];
  const rows = results.rows.map(function (r) {
    return [
      r.email, r.firstName, r.lastName, r.company, r.title,
      r.sender, r.sendStatus, r.sentAt, r.error,
      r.status, r.statusReason, r.verifyStatus,
      r.opens, r.humanOpens, r.firstOpenAt,
      r.clicks, r.lastClickAt,
    ];
  });
  logEvent_(requireAdmin_(), 'admin_action', {
    campaignId: campaignId,
    detail: { action: 'export_csv', rows: rows.length },
  });
  return {
    filename: (results.campaign.name || campaignId).replace(/[^A-Za-z0-9_-]+/g, '_')
      + '_' + new Date().toISOString().slice(0, 10) + '.csv',
    csv: toCsv_(headers, rows),
    rowCount: rows.length,
  };
}

/** Headline numbers for every campaign, one row each. */
function exportAllCampaignsCsv() {
  requireAdmin_(); // also enforced by allCampaignResults; stated here so the gate is visible at the entry point
  const all = allCampaignResults();
  const headers = [
    'campaign_id', 'name', 'status', 'created_at', 'recipients', 'sent',
    'opened_unique', 'opened_human_unique', 'clicked_unique',
    'replied', 'bounced', 'unsubscribed',
    'human_open_rate_pct', 'click_rate_pct', 'reply_rate_pct',
  ];
  const rows = all.map(function (c) {
    return [
      c.id, c.name, c.status, c.createdAt, c.recipients, c.sent,
      c.openedUnique, c.openedHumanUnique, c.clickedUnique,
      c.replied, c.bounced, c.unsubscribed,
      c.humanOpenRate, c.clickRate, c.replyRate,
    ];
  });
  return {
    filename: 'campaigns_' + new Date().toISOString().slice(0, 10) + '.csv',
    csv: toCsv_(headers, rows),
    rowCount: rows.length,
  };
}
