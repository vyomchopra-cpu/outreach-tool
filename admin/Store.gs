/**
 * Only file in either project allowed to call SpreadsheetApp / Sheets API.
 * Column order here must match docs/SCHEMA.md exactly — test/qa.mjs asserts it.
 */

const SHEET_ID = ''; // TODO: set after creating the central Sheet (Stage 0)

const SCHEMA = {
  Senders: ['email', 'display_name', 'status', 'ramp_start_date', 'daily_cap_override',
    'timezone', 'agent_version', 'last_heartbeat', 'secret_hash', 'consent_recorded_at'],
  Campaigns: ['id', 'name', 'status', 'subject', 'body_source', 'sender_pool', 'tz_mode',
    'send_window', 'created_by', 'created_at', 'exec_approved_by', 'exec_approved_at',
    'seed_passed_at', 'canary_released_at', 'projected_completion'],
  Recipients: ['id', 'campaign_id', 'email', 'first_name', 'last_name', 'company', 'title',
    'recipient_tz', 'custom', 'assigned_sender', 'status', 'status_reason'],
  Queue: ['id', 'campaign_id', 'recipient_id', 'sender_email', 'due_at_utc', 'status',
    'attempts', 'idempotency_key', 'sent_message_id', 'sent_at', 'error'],
  Signals: ['ts', 'sender_email', 'kind', 'gmail_message_id', 'in_reply_to', 'from_header',
    'matched_recipient_id'],
  Suppression: ['email', 'reason', 'source', 'added_at'],
  Events: ['ts', 'actor', 'type', 'campaign_id', 'recipient_id', 'sender_email', 'detail'],
  Health: ['date', 'sender_email', 'sent', 'bounced', 'replied', 'unsubscribed',
    'bounce_rate', 'complaint_rate'],
};

/** Bootstraps any missing tab with its header row. Idempotent — safe to call every deploy. */
function ensureSchema_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  Object.keys(SCHEMA).forEach(function (tabName) {
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }
    const headers = SCHEMA[tabName];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  });
}

// TODO Stage 0: appendRow_(tab, obj), readRows_(tab, filterFn), updateRow_(tab, id, patch)
// All wrapped in LockService.getScriptLock() for Queue/Suppression mutations.
