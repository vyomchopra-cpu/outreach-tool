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

// Primary key per tab. null = append-only log, no update/delete by design.
const PRIMARY_KEY = {
  Senders: 'email',
  Campaigns: 'id',
  Recipients: 'id',
  Queue: 'id',
  Signals: null,
  Suppression: 'email',
  Events: null,
  Health: null, // composite (date, sender_email) — see upsertHealth_
};

// Columns holding structured data — JSON-stringified on write, parsed on read.
const JSON_COLUMNS = {
  Recipients: ['custom'],
  Events: ['detail'],
};

function sheet_(tabName) {
  if (!SCHEMA[tabName]) throw new Error('Unknown tab: ' + tabName);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found, run ensureSchema_() first: ' + tabName);
  return sheet;
}

function encodeCell_(tabName, col, value) {
  if ((JSON_COLUMNS[tabName] || []).indexOf(col) !== -1) {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (value instanceof Date) return value.toISOString();
  return value === undefined || value === null ? '' : value;
}

function decodeCell_(tabName, col, raw) {
  if ((JSON_COLUMNS[tabName] || []).indexOf(col) !== -1) {
    if (raw === '' || raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  // Sheets auto-converts ISO-looking strings to Date cells; normalize back to ISO string
  // so every caller gets a consistent type regardless of how the cell was entered.
  if (raw instanceof Date) return raw.toISOString();
  return raw;
}

function rowToObj_(tabName, headers, rowArray) {
  const obj = {};
  headers.forEach(function (col, i) {
    obj[col] = decodeCell_(tabName, col, rowArray[i]);
  });
  return obj;
}

function objToRow_(tabName, headers, obj) {
  return headers.map(function (col) {
    return encodeCell_(tabName, col, obj[col]);
  });
}

/**
 * Appends one row. Caller supplies all schema columns it cares about;
 * omitted columns are written blank. Not locked by itself — callers doing
 * read-check-then-append (e.g. dedupe, idempotency) must wrap in withLock_.
 */
function appendRow_(tabName, obj) {
  const sheet = sheet_(tabName);
  const headers = SCHEMA[tabName];
  sheet.appendRow(objToRow_(tabName, headers, obj));
}

/**
 * Returns every row as an object, each carrying a non-schema `_row` field
 * (1-indexed sheet row number) so updateRowAt_ can target it directly.
 * filterFn is optional: (obj) => boolean, applied after decoding.
 */
function readRows_(tabName, filterFn) {
  const sheet = sheet_(tabName);
  const headers = SCHEMA[tabName];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const obj = rowToObj_(tabName, headers, values[i]);
    obj._row = i + 2;
    if (!filterFn || filterFn(obj)) out.push(obj);
  }
  return out;
}

function findRow_(tabName, pkValue) {
  const pk = PRIMARY_KEY[tabName];
  if (!pk) throw new Error(tabName + ' is append-only, has no primary key');
  const matches = readRows_(tabName, function (obj) { return obj[pk] === pkValue; });
  if (matches.length > 1) throw new Error('Duplicate primary key in ' + tabName + ': ' + pkValue);
  return matches[0] || null;
}

/** Writes a single row in place at a known sheet row number (from readRows_'s _row). */
function updateRowAt_(tabName, rowNumber, patch) {
  const sheet = sheet_(tabName);
  const headers = SCHEMA[tabName];
  const current = rowToObj_(tabName, headers, sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0]);
  const merged = Object.assign({}, current, patch);
  delete merged._row;
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([objToRow_(tabName, headers, merged)]);
  return merged;
}

/** Locked find-by-primary-key-then-patch. Use for anything Queue/Suppression/Senders related. */
function updateRow_(tabName, pkValue, patch) {
  return withLock_(function () {
    const existing = findRow_(tabName, pkValue);
    if (!existing) throw new Error('No row in ' + tabName + ' with key ' + pkValue);
    return updateRowAt_(tabName, existing._row, patch);
  });
}

/** Update if the primary key exists, otherwise append. Locked. */
function upsertRow_(tabName, obj) {
  const pk = PRIMARY_KEY[tabName];
  if (!pk) throw new Error(tabName + ' is append-only, use appendRow_');
  return withLock_(function () {
    const existing = findRow_(tabName, obj[pk]);
    if (existing) return updateRowAt_(tabName, existing._row, obj);
    appendRow_(tabName, obj);
    return obj;
  });
}

/**
 * Health has a composite key (date, sender_email) rather than a single PK column,
 * so it gets its own upsert instead of using PRIMARY_KEY/upsertRow_.
 */
function upsertHealth_(obj) {
  return withLock_(function () {
    const existing = readRows_('Health', function (r) {
      return r.date === obj.date && r.sender_email === obj.sender_email;
    })[0];
    if (existing) return updateRowAt_('Health', existing._row, obj);
    appendRow_('Health', obj);
    return obj;
  });
}

/** Every mutation that reads-then-writes must go through this. 30s wait, then fails loud. */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Could not acquire store lock within 30s — another operation is stuck');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Convenience wrapper — every admin/agent action that isn't a raw send should log one of these. */
function logEvent_(actor, type, opts) {
  opts = opts || {};
  appendRow_('Events', {
    ts: new Date(),
    actor: actor,
    type: type,
    campaign_id: opts.campaignId || '',
    recipient_id: opts.recipientId || '',
    sender_email: opts.senderEmail || '',
    detail: opts.detail || null,
  });
}

/**
 * Suppression check — the "checked twice" half that lives at write time.
 * The other half (checked again immediately before send) lives in agent/Sender.gs.
 */
function isSuppressed_(email) {
  return !!findRow_('Suppression', email);
}

function addSuppression_(email, reason, source) {
  return withLock_(function () {
    if (findRow_('Suppression', email)) return; // permanent — never re-added, never overwritten
    appendRow_('Suppression', {
      email: email,
      reason: reason,
      source: source,
      added_at: new Date(),
    });
  });
}
