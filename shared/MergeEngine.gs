/**
 * {{token}} substitution against a recipient's merge data. Hard-fails on any
 * unresolved token — a campaign with a typo'd merge tag must never send,
 * per README hard rule #6 (guards live at the point of action, not just the UI).
 */

const MERGE_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

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

/** Returns every {{token}} referenced in a source string, deduped, in first-seen order. */
function extractMergeTokens_(source) {
  const seen = {};
  const tokens = [];
  let m;
  MERGE_TOKEN_RE.lastIndex = 0;
  while ((m = MERGE_TOKEN_RE.exec(source)) !== null) {
    if (!seen[m[1]]) { seen[m[1]] = true; tokens.push(m[1]); }
  }
  return tokens;
}

/**
 * Substitutes every {{token}} in source using data. Throws on the first token
 * with no matching key, or a matching key that is empty/blank — a blank
 * "Hi ," is exactly as broken as an unresolved token and must fail the same way.
 */
function applyMerge_(source, data) {
  const missing = [];
  const result = source.replace(MERGE_TOKEN_RE, function (whole, token) {
    const value = data[token];
    if (value === undefined || value === null || String(value).trim() === '') {
      missing.push(token);
      return whole;
    }
    return String(value);
  });
  if (missing.length > 0) {
    throw new Error('Missing merge value(s): ' + missing.join(', '));
  }
  return result;
}

/** Preflight-time check: does every token in the source resolve for this recipient? */
function mergeWillSucceed_(source, recipient) {
  try {
    applyMerge_(source, mergeDataForRecipient_(recipient));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
