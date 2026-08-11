/**
 * CSV import -> validate -> dedupe -> suppression check -> sticky sender
 * assignment. Expected columns: email, first_name, last_name, company, title,
 * recipient_tz (required only when the campaign's tz_mode is 'recipient').
 * Any other column is preserved as a merge-tag source in Recipients.custom.
 */

const RECIPIENT_KNOWN_COLUMNS = ['email', 'first_name', 'last_name', 'company', 'title', 'recipient_tz'];

function importRecipientsCsv(campaignId, csvText) {
  const admin = requireAdmin_();
  const campaign = getCampaign(campaignId);
  if (campaign.status !== 'draft' && campaign.status !== 'preflight_passed') {
    throw new Error('Cannot import recipients into a campaign that has already launched (status: ' + campaign.status + ')');
  }

  const senderPool = (campaign.sender_pool || '').split(',').filter(Boolean);
  if (senderPool.length === 0) throw new Error('Assign a sender pool before importing recipients');

  const rows = parseCsv_(csvText);
  const existing = readRows_('Recipients', function (r) { return r.campaign_id === campaignId; });
  const existingEmails = {};
  existing.forEach(function (r) { existingEmails[r.email.toLowerCase()] = true; });

  const result = { imported: 0, duplicates: 0, suppressed: 0, invalid: 0, invalidRows: [] };
  const seenThisImport = {};

  rows.forEach(function (row, i) {
    const email = (row.email || '').toLowerCase().trim();
    if (!isValidEmail_(email)) {
      result.invalid++; result.invalidRows.push({ row: i + 2, email: row.email });
      return;
    }
    if (existingEmails[email] || seenThisImport[email]) { result.duplicates++; return; }
    if (isSuppressed_(email)) { result.suppressed++; return; }

    seenThisImport[email] = true;
    const custom = {};
    Object.keys(row).forEach(function (col) {
      if (RECIPIENT_KNOWN_COLUMNS.indexOf(col) === -1) custom[col] = row[col];
    });

    if (campaign.tz_mode === 'recipient' && !row.recipient_tz) {
      result.invalid++;
      result.invalidRows.push({ row: i + 2, email: email, reason: 'missing recipient_tz (required: campaign tz_mode=recipient)' });
      return;
    }

    appendRow_('Recipients', {
      id: campaignId + '-r' + Utilities.getUuid().split('-')[0],
      campaign_id: campaignId,
      email: email,
      first_name: row.first_name || '',
      last_name: row.last_name || '',
      company: row.company || '',
      title: row.title || '',
      recipient_tz: row.recipient_tz || '',
      custom: custom,
      assigned_sender: stickySenderForEmail_(email, senderPool),
      status: 'queued',
      status_reason: '',
    });
    result.imported++;
  });

  logEvent_(admin, 'admin_action', { campaignId: campaignId, detail: { action: 'import_recipients', result: result } });
  return result;
}

function listRecipients(campaignId) {
  requireAdmin_();
  return readRows_('Recipients', function (r) { return r.campaign_id === campaignId; });
}
