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
function render_(bodySource, recipient, extras, options) {
  const data = mergeDataForRecipient_(recipient, extras);
  const merged = applyMerge_(bodySource, data);

  // The preheader is its own template (Campaigns.preheader) and may carry its
  // own merge tags — commonly {{preheader}} straight from a CSV column, but
  // anything else works too. Merged in a text context: it is never rendered as
  // markup, only escaped into a hidden block by wrapHtml_.
  const preheaderSource = (options && options.preheader) || '';
  const preheader = preheaderSource ? applyMerge_(preheaderSource, data, { escape: false }) : '';

  const html = wrapHtml_(merged, preheader);
  // Deliberately derived from the body only. The preheader is inbox-preview
  // chrome; repeating it as the first line of the plain-text part would read
  // as a duplicated sentence to anyone whose client shows text.
  const text = htmlToText_(merged);
  const bytes = htmlByteLength_(html);
  return { html: html, text: text, bytes: bytes, preheader: preheader };
}

/**
 * Wraps a merged fragment in a minimal, dark-mode-safe shell.
 * Explicit bgcolor/color on the outer table cell — relying on inherited
 * defaults is what causes white-text-on-white / black-on-black under Gmail
 * iOS's forced dark-mode inversion.
 */
function wrapHtml_(fragment, preheader) {
  return (
    '<!doctype html>' +
    '<html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    '</head>' +
    '<body style="margin:0;padding:0;background-color:#ffffff;">' +
    preheaderBlock_(preheader) +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
    'style="background-color:#ffffff;">' +
    '<tr><td style="padding:16px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif;' +
    'font-size:14px;line-height:1.5;">' +
    fragment +
    '</td></tr></table></body></html>'
  );
}

/**
 * The preview line an inbox shows next to the subject. Hidden in the rendered
 * message by every mainstream client, so it must be the first thing in <body>.
 *
 * The trailing run of zero-width non-joiners is not decoration: without it the
 * client pads the preview by pulling in the opening words of the actual body,
 * so the recipient sees "Preheader text Hi Sam, I noticed that…". The
 * invisible characters absorb that padding. `mso-hide:all` covers Outlook,
 * which ignores `display:none` in this position.
 *
 * Escaped, never raw — this is the one place a stray tag would leak visible
 * markup into the inbox preview of a message sent under an exec's name.
 */
function preheaderBlock_(preheader) {
  if (!preheader) return '';
  const padding = new Array(60).join('&zwnj;&nbsp;');
  return '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;'
    + 'font-size:1px;line-height:1px;color:#ffffff;opacity:0;">'
    + escapeHtml_(preheader) + padding
    + '</div>';
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
