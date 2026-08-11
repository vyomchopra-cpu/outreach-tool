/**
 * {{token}} substitution against a recipient's merge data. Hard-fails on any
 * unresolved token — a campaign with a typo'd merge tag must never send,
 * per README hard rule #6 (guards live at the point of action, not just the UI).
 */

const MERGE_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Builds the flat lookup a recipient row offers to the merge engine. */
function mergeDataForRecipient_(recipient) {
  const data = {
    firstName: recipient.first_name || '',
    lastName: recipient.last_name || '',
    company: recipient.company || '',
    title: recipient.title || '',
  };
  const custom = recipient.custom || {};
  Object.keys(custom).forEach(function (k) { data[k] = custom[k]; });
  return data;
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
