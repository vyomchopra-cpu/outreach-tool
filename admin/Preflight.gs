/**
 * Mechanical gate a campaign must clear before it can leave draft. Every
 * check here is a hard block, not a lint suggestion — a campaign that fails
 * any of these cannot be launched, full stop (README hard rule: guards live
 * at the point of action, not only in the UI).
 */

// Small representative set, not exhaustive — a real spam-word list is a
// standing maintenance item, not a one-time build task.
const SPAM_PHRASES = [
  'act now', 'buy now', 'click here', 'limited time', 'guarantee', 'guaranteed',
  '100% free', 'risk-free', 'no cost', 'winner', 'cash bonus', 'cashback',
  'congratulations', 'as seen on', 'dear friend', 'urgent', 'this is not spam',
];

function countTagOccurrences_(html, tag) {
  const re = new RegExp('<' + tag + '(\\s|>)', 'gi');
  return (html.match(re) || []).length;
}

function countLinks_(html) {
  return (html.match(/<a\s+[^>]*href=/gi) || []).length;
}

/**
 * Runs every check for a campaign against a sample recipient (preview data)
 * standing in for a real one — same shape checks apply either way, since the
 * merge/size/link/image properties of the rendered output don't depend on
 * which recipient's values filled the tokens.
 */
function runPreflight_(campaign) {
  const checks = [];
  const fail = function (name, detail) { checks.push({ name: name, ok: false, detail: detail }); };
  const pass = function (name, detail) { checks.push({ name: name, ok: true, detail: detail }); };

  if (!campaign.sender_pool) {
    fail('sender_pool_assigned', 'Campaign has no sender assigned');
  } else {
    pass('sender_pool_assigned');
  }

  if (campaign.interval_minutes) {
    const interval = Number(campaign.interval_minutes);
    const windowMinutes = (SEND_WINDOW.endHour - SEND_WINDOW.startHour) * 60;
    const perDay = slotsPerWindow_(interval, windowMinutes);
    // Not an error — the scheduler already rolls the overflow to the next
    // business day — but an admin asking for 60-minute spacing should be told
    // the campaign now spans a week rather than discovering it afterwards.
    checks.push({
      name: 'interval_capacity', ok: true, blocking: false,
      detail: interval + ' min spacing fits ' + perDay + ' send(s) per sender per day',
    });
    if (interval < AGENT_POLL_MINUTES) {
      checks.push({
        name: 'interval_below_poll_resolution', ok: false, blocking: false,
        detail: 'Interval of ' + interval + ' min is finer than the ' + AGENT_POLL_MINUTES
          + ' min agent poll — actual gaps will vary by up to ' + AGENT_POLL_MINUTES + ' min',
      });
    }
  }

  const sample = { first_name: 'Sam', last_name: 'Prospect', company: 'Example Corp', title: 'VP Engineering', custom: {} };
  // {{unsubscribe}} is supplied by the sending agent, not the recipient row.
  // Derived from the campaign's own sender pool so preflight validates against
  // the address that will really be sent (same helper the preview uses).
  const sampleExtras = previewExtrasForSenderPool_(campaign.sender_pool);
  let rendered = null;
  try {
    rendered = render_(campaign.body_source, sample, sampleExtras);
    applyMerge_(campaign.subject, mergeDataForRecipient_(sample, sampleExtras));
    pass('merge_tokens_resolve');
  } catch (e) {
    fail('merge_tokens_resolve', e.message);
  }

  /**
   * A working unsubscribe path is a legal requirement (CAN-SPAM and friends),
   * and it matters more, not less, while automatic unsubscribe handling is
   * degraded: if the Gmail API is unavailable the agent cannot detect an
   * unsubscribe request itself, so the address in the footer is the only route
   * a recipient has. Blocking, never a warning.
   */
  if ((campaign.body_source || '').indexOf('{{unsubscribe}}') === -1) {
    fail('unsubscribe_present', 'Body must contain {{unsubscribe}} — it renders as the sending exec\'s opt-out address');
  } else {
    pass('unsubscribe_present');
  }

  if (rendered) {
    if (rendered.bytes >= MAX_HTML_BYTES) {
      fail('under_size_limit', rendered.bytes + ' bytes >= ' + MAX_HTML_BYTES);
    } else {
      pass('under_size_limit', rendered.bytes + ' bytes');
    }

    const images = countTagOccurrences_(campaign.body_source, 'img');
    if (images > 0) {
      fail('no_images_first_touch', images + ' <img> tag(s) found — first-touch content must be image-free');
    } else {
      pass('no_images_first_touch');
    }

    const links = countLinks_(campaign.body_source);
    if (links > 1) {
      fail('link_limit', links + ' links found, max 1 for first-touch content');
    } else {
      pass('link_limit', links + ' link(s)');
    }

    if (rendered.text.trim().length === 0) {
      fail('plain_text_nonempty', 'Derived plain-text part is empty');
    } else {
      pass('plain_text_nonempty');
    }

    const lowerSubjectAndBody = (campaign.subject + ' ' + rendered.text).toLowerCase();
    const hits = SPAM_PHRASES.filter(function (p) { return lowerSubjectAndBody.indexOf(p) !== -1; });
    // Soft signal: flagged, not blocking — spam-word lists are heuristic and
    // false-positive prone (e.g. "guarantee" is fine in a product sentence).
    checks.push({ name: 'spam_word_lint', ok: hits.length === 0, detail: hits.join(', '), blocking: false });
  }

  const blockingFailures = checks.filter(function (c) { return c.ok === false && c.blocking !== false; });
  return { ok: blockingFailures.length === 0, checks: checks };
}

/** Called from the UI before enabling the seed-send / launch buttons. */
function checkPreflight(campaignId) {
  requireAdmin_();
  const campaign = getCampaign(campaignId);
  return runPreflight_(campaign);
}
