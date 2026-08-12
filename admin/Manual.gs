/**
 * Admin actions that stand in for automatic signal handling while the Gmail
 * API — and therefore reply/bounce/unsubscribe detection — is unavailable
 * (docs/GCP_CONSTRAINT.md).
 *
 * The exec can see replies and opt-out requests perfectly well in their own
 * inbox; what's missing is our ability to observe them. So the fallback is
 * the exec telling an admin, and an admin recording it here. Every action
 * writes the same Store rows the automatic path would have written, so
 * suppression, status, and the audit log stay consistent regardless of which
 * path produced them — nothing downstream needs to know the difference.
 */

/**
 * Permanently suppress an address. Same effect as an automatic unsubscribe
 * signal: global, irreversible, and cancels anything still queued to them
 * across every campaign.
 */
function manuallySuppress(email, reason) {
  const admin = requireAdmin_();
  const clean = String(email || '').toLowerCase().trim();
  if (!isValidEmail_(clean)) throw new Error('Not a valid email: ' + email);

  addSuppression_(clean, reason === 'complaint' ? 'complaint' : 'manual', 'admin:' + admin);

  const recipients = readRows_('Recipients', function (r) { return r.email === clean; });
  recipients.forEach(function (r) {
    updateRow_('Recipients', r.id, { status: 'unsubscribed', status_reason: 'manual: ' + (reason || 'admin request') });
    readRows_('Queue', function (q) { return q.recipient_id === r.id && q.status === 'pending'; })
      .forEach(function (q) { updateRowAt_('Queue', q._row, { status: 'cancelled', error: 'manually suppressed' }); });
  });

  logEvent_(admin, 'admin_action', { detail: { action: 'manual_suppress', email: clean, reason: reason || '', cancelled: recipients.length } });
  return { suppressed: clean, recipientsUpdated: recipients.length };
}

/**
 * Record that someone replied. Under a single-touch campaign this is
 * bookkeeping rather than a safety mechanism — there is no follow-up queued
 * to stop — but it keeps reply-rate reporting honest and cancels anything
 * pending if multi-touch is ever enabled.
 */
function manuallyMarkReplied(campaignId, email) {
  const admin = requireAdmin_();
  const clean = String(email || '').toLowerCase().trim();
  const recipients = readRows_('Recipients', function (r) {
    return r.email === clean && (!campaignId || r.campaign_id === campaignId);
  });
  if (recipients.length === 0) throw new Error('No recipient found for ' + clean);

  recipients.forEach(function (r) {
    updateRow_('Recipients', r.id, { status: 'replied' });
    readRows_('Queue', function (q) { return q.recipient_id === r.id && q.status === 'pending'; })
      .forEach(function (q) { updateRowAt_('Queue', q._row, { status: 'cancelled', error: 'recipient replied (manual)' }); });
    appendRow_('Signals', {
      ts: new Date(),
      sender_email: r.assigned_sender,
      kind: 'reply',
      gmail_message_id: '',
      in_reply_to: '',
      from_header: clean,
      matched_recipient_id: r.id,
    });
  });

  logEvent_(admin, 'admin_action', { detail: { action: 'manual_mark_replied', email: clean, count: recipients.length } });
  return { updated: recipients.length };
}

/** Bulk paste-in, one address per line — realistically how an exec forwards a batch of opt-outs. */
function manuallySuppressBulk(text, reason) {
  requireAdmin_();
  const lines = String(text || '').split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  const result = { suppressed: 0, invalid: [] };
  lines.forEach(function (line) {
    try {
      manuallySuppress(line, reason);
      result.suppressed++;
    } catch (e) {
      result.invalid.push(line);
    }
  });
  return result;
}

/**
 * Fleet health for the admin console: who's registered, when they last checked
 * in, and — the point of this — whether each agent currently has working reply
 * detection or is running degraded.
 */
function senderStatus() {
  requireAdmin_();
  const staleMs = GOVERNANCE.agentStaleMinutes * 60 * 1000;
  return readRows_('Senders').map(function (s) {
    const caps = s.capabilities || {};
    const lastBeat = s.last_heartbeat ? new Date(s.last_heartbeat) : null;
    return {
      email: s.email,
      displayName: s.display_name,
      status: s.status,
      agentVersion: s.agent_version,
      lastHeartbeat: s.last_heartbeat,
      stale: !lastBeat || (new Date() - lastBeat) > staleMs,
      transport: caps.transport || 'unknown',
      signalsWorking: caps.signals === true,
      providerQuota: caps.providerQuota == null ? 'unknown' : caps.providerQuota,
    };
  });
}
