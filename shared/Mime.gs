/**
 * Builds a multipart/alternative raw MIME message for the Gmail API's
 * messages.send `raw` field. Kept in shared/ (not agent/) because it's pure
 * string construction plus base64 — the same testability rationale as
 * shared/Renderer.gs. Encoding functions are injected so this runs both
 * inside Apps Script (via Utilities) and inside test/qa.mjs (via a Buffer stub).
 */

function mimeEncodeHeaderWord_(text, base64Fn) {
  // RFC 2047 — needed for any non-ASCII subject (e.g. a prospect's name with diacritics).
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return '=?UTF-8?B?' + base64Fn(text) + '?=';
}

/**
 * opts: { fromDisplayName, fromEmail, toEmail, replyTo, subject, html, text }
 * Returns the raw MIME string (not yet base64url-encoded — see buildGmailRawMessage_).
 */
function buildMimeMessage_(opts, base64Fn, uuidFn) {
  const boundary = 'mis_outreach_' + uuidFn().replace(/-/g, '');
  const subjectHeader = mimeEncodeHeaderWord_(opts.subject, base64Fn);
  const lines = [
    'From: "' + opts.fromDisplayName.replace(/"/g, '') + '" <' + opts.fromEmail + '>',
    'To: ' + opts.toEmail,
    'Reply-To: ' + opts.replyTo,
    'Subject: ' + subjectHeader,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Fn(opts.text),
    '',
    '--' + boundary,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Fn(opts.html),
    '',
    '--' + boundary + '--',
    '',
  ];
  return lines.join('\r\n');
}

/** True if the raw MIME actually contains both an HTML and a plain-text alternative part — README hard rule 5. */
function mimeHasBothParts_(rawMime) {
  return /Content-Type:\s*text\/plain/i.test(rawMime) && /Content-Type:\s*text\/html/i.test(rawMime)
    && /multipart\/alternative/i.test(rawMime);
}
