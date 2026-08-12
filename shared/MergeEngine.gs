/**
 * {{token}} substitution against a recipient's merge data. Hard-fails on any
 * unresolved token — a campaign with a typo'd merge tag must never send,
 * per README hard rule #6 (guards live at the point of action, not just the UI).
 */

/**
 * Two token forms, and the difference matters:
 *
 *   {{token}}    escaped   — the value is treated as TEXT. `Smith & Sons` becomes
 *                            `Smith &amp; Sons`; a stray `<` can't break the
 *                            document or inject markup.
 *   {{{token}}}  raw       — the value is treated as HTML and inserted verbatim.
 *                            For CSV columns that deliberately carry markup
 *                            (a formatted intro paragraph, a signature block).
 *
 * Escaping is the default because merge values come from an uploaded CSV, which
 * is untrusted input: an unescaped `<` in a company name would otherwise
 * silently corrupt every message, and anything worse would be injected straight
 * into mail sent under an executive's name. Raw insertion has to be asked for
 * explicitly, per token, and is visible in the campaign body when reviewing it.
 */
const MERGE_RAW_TOKEN_RE = /\{\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}\}/g;
const MERGE_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds the flat lookup a recipient row offers to the merge engine.
 * `extras` carries values that come from the sending context rather than the
 * recipient — currently {{unsubscribe}}, which is the sender's own plus-alias
 * and therefore unknowable until we know which exec is sending.
 */
function mergeDataForRecipient_(recipient, extras) {
  const data = {
    firstName: recipient.first_name || '',
    lastName: recipient.last_name || '',
    company: recipient.company || '',
    title: recipient.title || '',
  };
  const custom = recipient.custom || {};
  Object.keys(custom).forEach(function (k) { data[k] = custom[k]; });
  Object.keys(extras || {}).forEach(function (k) { data[k] = extras[k]; });
  return data;
}

/**
 * Send-time extras for a preview or preflight, where no real sending agent
 * exists to supply them. Derived from the campaign's first assigned sender so
 * the preview shows the same opt-out address a recipient would actually
 * receive, rather than a placeholder that hides a misconfiguration.
 *
 * Every caller of render_/applyMerge_ must supply extras from somewhere —
 * {{unsubscribe}} is a blocking preflight requirement, so a call site that
 * forgets them fails hard on every real campaign body. test/qa.mjs pins this.
 */
function previewExtrasForSenderPool_(senderPoolCsv) {
  const first = String(senderPoolCsv || '').split(',').filter(Boolean)[0];
  const localPart = first ? first.split('@')[0] : 'sender';
  return { unsubscribe: localPart + '+unsub@' + REPLY_TO_DOMAIN };
}

/** Every token referenced in a source string, both forms, deduped, first-seen order. */
function extractMergeTokens_(source) {
  const seen = {};
  const tokens = [];
  [MERGE_RAW_TOKEN_RE, MERGE_TOKEN_RE].forEach(function (re) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(source)) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = true; tokens.push(m[1]); }
    }
  });
  return tokens;
}

/**
 * Substitutes every token in source using data. Throws on the first token with
 * no matching key, or a matching key that is empty/blank — a blank "Hi ," is
 * exactly as broken as an unresolved token and must fail the same way.
 *
 * options.escape defaults to true (HTML context). Pass { escape: false } for
 * plain-text contexts such as the subject line, where `&amp;` would be shown
 * to the recipient literally rather than rendered.
 *
 * Raw {{{tokens}}} are substituted first, so their inserted markup can never be
 * re-scanned and partially matched by the escaped pass.
 */
function applyMerge_(source, data, options) {
  const escape = !(options && options.escape === false);
  // Keyed, not a list: an unresolved {{{token}}} is left in place by the raw
  // pass and then matched again by the escaped pass, so a plain array reported
  // every missing raw token twice.
  const missing = {};

  function resolve(token) {
    const value = data[token];
    if (value === undefined || value === null || String(value).trim() === '') {
      missing[token] = true;
      return null;
    }
    return String(value);
  }

  let result = source.replace(MERGE_RAW_TOKEN_RE, function (whole, token) {
    const value = resolve(token);
    return value === null ? whole : value; // raw: inserted verbatim, by request
  });

  result = result.replace(MERGE_TOKEN_RE, function (whole, token) {
    const value = resolve(token);
    if (value === null) return whole;
    return escape ? escapeHtml_(value) : value;
  });

  const missingList = Object.keys(missing);
  if (missingList.length > 0) {
    throw new Error('Missing merge value(s): ' + missingList.join(', '));
  }
  return result;
}

/** Preflight-time check: does every token in the source resolve for this recipient? */
function mergeWillSucceed_(source, recipient, extras) {
  try {
    applyMerge_(source, mergeDataForRecipient_(recipient, extras));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
