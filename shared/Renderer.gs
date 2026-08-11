/**
 * The single renderer. Preview pane, seed send, and live send all call render()
 * — never a second implementation, per README hard rule #5 and the Gmail
 * Rewriter's mdToHtml() precedent (same divergence bug, same fix).
 *
 * bodySource is authored HTML: a lightweight semantic fragment (p, a, table,
 * strong, em, ul/ol/li, img) with inline styles only — no <style>, no class-
 * dependent layout, since Gmail strips <style> and most webmail clients strip
 * classes. admin/Preflight.gs (Stage 3) is what actually enforces the subset
 * at campaign-save time; this file assumes clean input and focuses on merge +
 * wrap + plain-text derivation + size accounting.
 */

/**
 * render(bodySource, recipient) -> { html, text, bytes }
 * Throws (via applyMerge_) if any {{token}} in bodySource has no value on
 * this recipient — callers must treat that as a hard send-block, not a warning.
 */
function render_(bodySource, recipient) {
  const merged = applyMerge_(bodySource, mergeDataForRecipient_(recipient));
  const html = wrapHtml_(merged);
  const text = htmlToText_(merged);
  const bytes = htmlByteLength_(html);
  return { html: html, text: text, bytes: bytes };
}

/**
 * Wraps a merged fragment in a minimal, dark-mode-safe shell.
 * Explicit bgcolor/color on the outer table cell — relying on inherited
 * defaults is what causes white-text-on-white / black-on-black under Gmail
 * iOS's forced dark-mode inversion.
 */
function wrapHtml_(fragment) {
  return (
    '<!doctype html>' +
    '<html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    '</head>' +
    '<body style="margin:0;padding:0;background-color:#ffffff;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
    'style="background-color:#ffffff;">' +
    '<tr><td style="padding:16px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif;' +
    'font-size:14px;line-height:1.5;">' +
    fragment +
    '</td></tr></table></body></html>'
  );
}

/**
 * Deterministic HTML -> plain text, for the multipart/alternative text part
 * (README hard rule #5). Not a general-purpose HTML parser — it only has to
 * handle the constrained tag subset Preflight allows through.
 */
function htmlToText_(html) {
  let text = html;
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, function (m, href, label) {
    const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
    return cleanLabel && cleanLabel !== href ? cleanLabel + ' (' + href + ')' : href;
  });
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/** UTF-8 byte length, since MAX_HTML_BYTES (Gmail's clip threshold) is byte-based, not char-based. */
function htmlByteLength_(html) {
  return Utilities.newBlob(html).getBytes().length;
}
