/**
 * Thin wrapper over the Gmail REST API — deliberately not the built-in
 * high-level Gmail service (see README's hard rule against it, which pulls
 * full mailbox access). Every call authenticates with ScriptApp.getOAuthToken(),
 * scoped by appsscript.json to exactly gmail.send + gmail.settings.basic +
 * gmail.metadata. There is no code path here that can read a message body.
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function gmailFetch_(path, method, payload) {
  const options = {
    method: method || 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType: 'application/json',
    muteHttpExceptions: true,
  };
  if (payload) options.payload = JSON.stringify(payload);
  const response = UrlFetchApp.fetch(GMAIL_API_BASE + path, options);
  const code = response.getResponseCode();
  const body = response.getContentText() ? JSON.parse(response.getContentText()) : {};
  if (code >= 300) throw new Error('Gmail API ' + path + ' -> ' + code + ': ' + (body.error ? body.error.message : response.getContentText()));
  return body;
}

/** Builds and sends one email. Returns the Gmail message id and RFC Message-ID header value. */
function sendMail_(opts) {
  const raw = buildMimeMessage_(opts, Utilities.base64Encode, Utilities.getUuid);
  if (!mimeHasBothParts_(raw)) throw new Error('Refusing to send: MIME message is missing a multipart/alternative part (hard rule 5)');
  const rawUrlSafe = Utilities.base64EncodeWebSafe(Utilities.newBlob(raw).getBytes()).replace(/=+$/, '');
  const sent = gmailFetch_('/messages/send', 'post', { raw: rawUrlSafe });
  return sent; // { id, threadId, labelIds } — id is the Gmail message id, not the RFC Message-ID
}

/** Fetches just the RFC Message-ID header for a just-sent message, needed to match future replies (In-Reply-To). */
function getRfcMessageId_(gmailMessageId) {
  const msg = gmailFetch_('/messages/' + gmailMessageId + '?format=metadata&metadataHeaders=Message-ID', 'get');
  const header = (msg.payload && msg.payload.headers || []).find(function (h) { return h.name === 'Message-ID'; });
  return header ? header.value : '';
}

// --- Labels & filters (gmail.settings.basic + a read-only label list, both Tier B) ---

function getOrCreateLabelId_(name) {
  const existing = gmailFetch_('/labels', 'get');
  const found = (existing.labels || []).find(function (l) { return l.name === name; });
  if (found) return found.id;
  const created = gmailFetch_('/labels', 'post', {
    name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show',
  });
  return created.id;
}

function ensureFilter_(criteria, labelName, opts) {
  opts = opts || {};
  const labelId = getOrCreateLabelId_(labelName);
  const existing = gmailFetch_('/settings/filters', 'get');
  const already = (existing.filter || []).some(function (f) {
    return f.criteria && JSON.stringify(f.criteria) === JSON.stringify(criteria);
  });
  if (already) return;
  gmailFetch_('/settings/filters', 'post', {
    criteria: criteria,
    action: {
      addLabelIds: [labelId],
      removeLabelIds: opts.skipInbox ? ['INBOX'] : [],
    },
  });
}
