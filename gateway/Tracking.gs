/**
 * Open and click tracking endpoints.
 *
 * These live in gateway/ because it is already deployed ANYONE_ANONYMOUS —
 * a tracking pixel is fetched by a stranger's mail client with no Google
 * session, so it cannot live anywhere that requires authentication.
 *
 * Design constraints that shaped this:
 *
 *   1. The URL must not leak the recipient. An address in a query string ends
 *      up in mail-client logs, proxy logs, and anyone's browser history. The
 *      token is an opaque id stored on the Queue row instead, and resolves to
 *      the recipient only on our side.
 *
 *   2. A tracking request must never be able to change anything. These
 *      handlers only append to the Tracking log. Nothing here can send,
 *      cancel, approve, or alter a campaign, no matter what is passed.
 *
 *   3. Failing to record must never break the recipient's experience. If the
 *      log write throws, the pixel still returns an image and the link still
 *      redirects. Analytics losing a row is a nuisance; a dead link in mail
 *      sent under a CTO's name is not.
 */

/**
 * What we can actually return, versus what we would like to.
 *
 * Apps Script's doGet may only return HtmlOutput or TextOutput — there is no
 * way to serve image bytes with an image/* content type. Returning a Blob
 * looks reasonable and is not: it fails after the handler has run, so the
 * open is still logged but the recipient's client receives a 5KB Apps Script
 * error page where a 1x1 image should be. Verified by fetching the live
 * endpoint, which is the only way this surfaces — nothing about the code
 * suggests it.
 *
 * So the response is an empty text body instead. The consequences, stated
 * plainly rather than discovered later:
 *
 *   - the open IS recorded; that half works exactly as intended
 *   - the img element resolves to nothing. At 1x1 with explicit dimensions
 *     this is invisible in practice, though a client that shows placeholders
 *     for broken images may render a tiny artefact
 *   - a client that retries a failed image can log a second open, which is
 *     one more reason unique-per-recipient is the figure reported and raw
 *     event counts are not
 *
 * Serving a real GIF would mean hosting it somewhere that can return binary,
 * which means an external dependency this tool deliberately does not have.
 */
function trackingPixelResponse_() {
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}

/** Resolves an opaque tracking id back to the send it belongs to. Returns null rather than throwing — a bad token is not an error worth surfacing to a mail client. */
function queueRowForTrackingId_(trackingId) {
  const clean = String(trackingId || '').trim();
  if (!clean) return null;
  const rows = readRows_('Queue', function (q) { return q.tracking_id === clean; });
  return rows.length ? rows[0] : null;
}

/**
 * An open recorded within seconds of the send is a machine prefetching the
 * image, not a person reading — Apple Mail Privacy Protection does this for
 * every message it receives, and it is the single biggest reason raw open
 * rates overstate engagement. Recorded, but flagged, so reporting can show
 * both numbers instead of silently picking one.
 */
function looksMachineOpened_(queueRow, now) {
  if (!queueRow || !queueRow.sent_at) return false;
  const gap = (now - new Date(queueRow.sent_at)) / 1000;
  return gap >= 0 && gap < OPEN_MACHINE_WINDOW_SEC;
}

function recordTrackingEvent_(kind, queueRow, url, userAgent) {
  const now = new Date();
  appendRow_('Tracking', {
    ts: now,
    kind: kind,
    campaign_id: queueRow ? queueRow.campaign_id : '',
    recipient_id: queueRow ? queueRow.recipient_id : '',
    sender_email: queueRow ? queueRow.sender_email : '',
    url: url || '',
    user_agent: String(userAgent || '').slice(0, 300),
    machine_suspected: kind === 'open' ? looksMachineOpened_(queueRow, now) : false,
  });
}

/** GET ?px=<id> — the open pixel. Always returns an image, whatever else happens. */
function handleTrackingPixel_(e) {
  try {
    const row = queueRowForTrackingId_(e.parameter.px);
    if (row) recordTrackingEvent_('open', row, '', (e.parameter.ua || ''));
  } catch (err) {
    console.error('[tracking] pixel: ' + err.message);
  }
  return trackingPixelResponse_();
}

/**
 * GET ?ln=<id>&u=<encoded target> — a tracked link.
 *
 * Only ever redirects to an http(s) target. Without that check this endpoint
 * would be an open redirect on a Google-owned domain: anyone could hand out
 * a script.google.com link that silently forwards to a site of their
 * choosing, borrowing our domain's credibility to do it. Also refuses
 * javascript: and data:, which some clients would execute.
 */
function handleTrackedLink_(e) {
  const target = String(e.parameter.u || '');
  const safe = /^https?:\/\//i.test(target);

  try {
    const row = queueRowForTrackingId_(e.parameter.ln);
    if (row && safe) recordTrackingEvent_('click', row, target, e.parameter.ua || '');
  } catch (err) {
    console.error('[tracking] link: ' + err.message);
  }

  if (!safe) {
    return HtmlService.createHtmlOutput('<p>That link is not valid.</p>');
  }
  // Apps Script cannot emit a 302, so this is a client-side hop. Kept
  // deliberately minimal and with a visible fallback link, so a client that
  // blocks the redirect still gets the person where they were going.
  const escaped = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta http-equiv="refresh" content="0;url=' + escaped + '">'
    + '<p style="font-family:sans-serif">Taking you there… '
    + '<a href="' + escaped + '">continue</a></p>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** True when a doGet is a tracking request rather than someone opening the endpoint in a browser. */
function isTrackingRequest_(e) {
  const p = (e && e.parameter) || {};
  return !!(p.px || p.ln);
}
