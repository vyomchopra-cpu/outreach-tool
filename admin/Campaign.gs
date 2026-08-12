/**
 * Campaign CRUD + preview, called from ui/Index.html via google.script.run.
 * Every function starts with requireAdmin_() — the web app auth gate in
 * Code.gs only covers doGet; google.script.run calls bypass it.
 */

function newCampaignId_() {
  return 'c' + Utilities.getUuid().split('-')[0];
}

/** input: { name, subject, bodySource, senderPool: [email,...], tzMode: 'sender'|'recipient' } */
function createCampaign(input) {
  const admin = requireAdmin_();
  if (!input.name || !input.subject || !input.bodySource) {
    throw new Error('name, subject, and bodySource are required');
  }
  const id = newCampaignId_();
  const campaign = {
    id: id,
    name: input.name,
    status: 'draft',
    subject: input.subject,
    body_source: input.bodySource,
    sender_pool: (input.senderPool || []).join(','),
    tz_mode: input.tzMode === 'recipient' ? 'recipient' : 'sender',
    send_window: (SEND_WINDOW.startHour + ':00-' + SEND_WINDOW.endHour + ':00'),
    created_by: admin,
    created_at: new Date(),
    exec_approved_by: '',
    exec_approved_at: '',
    seed_passed_at: '',
    canary_released_at: '',
    projected_completion: '',
  };
  appendRow_('Campaigns', campaign);
  logEvent_(admin, 'config_change', { campaignId: id, detail: { action: 'create' } });
  return id;
}

/** Draft-only edit — a campaign past 'draft' must be cloned, not mutated, to protect the audit trail. */
function saveCampaignDraft(campaignId, input) {
  const admin = requireAdmin_();
  const existing = findRow_('Campaigns', campaignId);
  if (!existing) throw new Error('No such campaign: ' + campaignId);
  if (existing.status !== 'draft') {
    throw new Error('Only draft campaigns can be edited in place (status is ' + existing.status + ')');
  }
  const patch = {
    name: input.name,
    subject: input.subject,
    body_source: input.bodySource,
    sender_pool: (input.senderPool || []).join(','),
    tz_mode: input.tzMode === 'recipient' ? 'recipient' : 'sender',
    // editing invalidates any prior seed pass — must re-seed before launch
    seed_passed_at: '',
  };
  updateRow_('Campaigns', campaignId, patch);
  logEvent_(admin, 'config_change', { campaignId: campaignId, detail: { action: 'edit_draft' } });
  return getCampaign(campaignId);
}

function getCampaign(campaignId) {
  requireAdmin_();
  const c = findRow_('Campaigns', campaignId);
  if (!c) throw new Error('No such campaign: ' + campaignId);
  return c;
}

function listCampaigns() {
  requireAdmin_();
  return readRows_('Campaigns').sort(function (a, b) {
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

/**
 * Renders the campaign body against a sample recipient (admin-supplied
 * overrides layered on defaults) using the one shared Renderer — exactly the
 * same render_() call the seed send and the live send will make.
 */
function previewCampaign(campaignId, sampleOverrides) {
  requireAdmin_();
  const campaign = getCampaign(campaignId);
  const sample = Object.assign({
    first_name: 'Sam',
    last_name: 'Prospect',
    company: 'Example Corp',
    title: 'VP Engineering',
    custom: {},
  }, sampleOverrides || {});

  const tokensInBody = extractMergeTokens_(campaign.subject + ' ' + campaign.body_source);
  // {{unsubscribe}} is supplied by the sending agent at send time; preview has
  // no agent, so it derives the same address from the campaign's sender pool.
  const extras = previewExtrasForSenderPool_(campaign.sender_pool);

  try {
    const rendered = render_(campaign.body_source, sample, extras);
    return {
      ok: true,
      subject: applyMerge_(campaign.subject, mergeDataForRecipient_(sample, extras)),
      html: rendered.html,
      text: rendered.text,
      bytes: rendered.bytes,
      maxBytes: MAX_HTML_BYTES,
      tokensInBody: tokensInBody,
    };
  } catch (e) {
    return { ok: false, error: e.message, tokensInBody: tokensInBody };
  }
}

/**
 * Queues a seed send: one Queue row per configured seed mailbox, due
 * immediately, assigned to the first sender in the campaign's pool. Actual
 * delivery happens once a Stage 4 sender agent polls and picks these up —
 * queuing here just makes the campaign's seed request visible and auditable.
 */
function enqueueSeedSend(campaignId) {
  const admin = requireAdmin_();
  const campaign = getCampaign(campaignId);
  const senderPool = (campaign.sender_pool || '').split(',').filter(Boolean);
  if (senderPool.length === 0) throw new Error('Campaign has no sender assigned yet');
  if (SEED_MAILBOXES.length === 0) throw new Error('SEED_MAILBOXES is empty — configure the seed matrix first');

  const preview = previewCampaign(campaignId, {});
  if (!preview.ok) throw new Error('Cannot seed-send: ' + preview.error);

  // Re-seeding after a body edit is the normal workflow, so the row id has to
  // be unique per run: a stable id would collide on the second seed, and
  // findRow_('Queue', id) then throws "Duplicate primary key" when the agent
  // reports the send — breaking reporting for every subsequent seed.
  const runTag = Utilities.getUuid().split('-')[0];
  SEED_MAILBOXES.forEach(function (seedEmail, i) {
    appendRow_('Queue', {
      id: campaignId + '-seed-' + runTag + '-' + i,
      campaign_id: campaignId,
      recipient_id: 'seed:' + seedEmail,
      sender_email: senderPool[0],
      due_at_utc: new Date(),
      status: 'pending',
      attempts: 0,
      idempotency_key: campaignId + '-seed-' + runTag + '-' + i,
      sent_message_id: '',
      sent_at: '',
      error: '',
    });
  });
  logEvent_(admin, 'admin_action', { campaignId: campaignId, detail: { action: 'enqueue_seed_send', count: SEED_MAILBOXES.length } });
}

/**
 * Admin confirms, after visually checking all seed mailboxes, that rendering
 * looked correct everywhere. This is the manual half of the seed gate —
 * README hard rule requires a seed pass within 24h before a campaign can launch.
 */
function markSeedPassed(campaignId) {
  const admin = requireAdmin_();
  updateRow_('Campaigns', campaignId, { seed_passed_at: new Date(), status: 'preflight_passed' });
  logEvent_(admin, 'admin_action', { campaignId: campaignId, detail: { action: 'mark_seed_passed' } });
}
