/**
 * Injects the open pixel and rewrites links, at send time.
 *
 * Shared rather than agent-only because the admin console's preview must show
 * exactly what will be sent — a preview that quietly omits the tracking
 * rewrite would be a preview of a different email, and link rewriting is
 * precisely the sort of thing that breaks a layout or a URL without anyone
 * noticing until it has gone to real prospects.
 *
 * Applied last, after merge and rendering, so it operates on the final HTML
 * and can never have its own markup mangled by a merge tag.
 */

/** Opaque per-send id. Unguessable so tracking URLs cannot be enumerated to discover who was mailed. */
function newTrackingId_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
}

function trackingPixelUrl_(baseUrl, trackingId) {
  return baseUrl + '?px=' + encodeURIComponent(trackingId);
}

function trackedLinkUrl_(baseUrl, trackingId, target) {
  return baseUrl + '?ln=' + encodeURIComponent(trackingId) + '&u=' + encodeURIComponent(target);
}

/**
 * Links deliberately left alone:
 *
 *   mailto:/tel:      not web links; rewriting them breaks the client handler
 *   unsubscribe       must work even if tracking is down or the gateway is
 *                     unreachable. An opt-out that fails is a compliance
 *                     problem, and routing it through our own infrastructure
 *                     to count a click is not worth that risk.
 *   already-tracked   re-wrapping produces a redirect to a redirect
 *   anchors           #fragments go nowhere external
 */
function shouldTrackLink_(href) {
  const h = String(href || '').trim();
  if (!/^https?:\/\//i.test(h)) return false;      // covers mailto:, tel:, #, relative
  if (/[?&](px|ln)=/.test(h)) return false;         // already a tracking URL
  if (/unsub/i.test(h)) return false;               // opt-out must never depend on us
  return true;
}

/**
 * Rewrites every eligible href and appends the pixel.
 *
 * Returns the html unchanged when tracking is off or no id was supplied, so
 * callers never need to branch — and so turning tracking off is genuinely a
 * config change rather than a code path with its own behaviour.
 */
function applyTracking_(html, trackingId, baseUrl, options) {
  const o = options || {};
  const trackOpens = o.trackOpens !== undefined ? o.trackOpens : TRACK_OPENS;
  const trackClicks = o.trackClicks !== undefined ? o.trackClicks : TRACK_CLICKS;
  if (!trackingId || !baseUrl) return html;

  let out = String(html);

  if (trackClicks) {
    out = out.replace(/(<a\b[^>]*\bhref\s*=\s*)("([^"]*)"|'([^']*)')/gi,
      function (match, prefix, quoted, dq, sq) {
        const href = dq !== undefined ? dq : sq;
        if (!shouldTrackLink_(href)) return match;
        return prefix + '"' + trackedLinkUrl_(baseUrl, trackingId, href) + '"';
      });
  }

  if (trackOpens) {
    // Last thing before </body> where there is one, otherwise appended. Some
    // clients drop trailing content after </body>, so placing it inside
    // matters more than it looks.
    const img = '<img src="' + trackingPixelUrl_(baseUrl, trackingId)
      + '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />';
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, img + '</body>') : out + img;
  }

  return out;
}
