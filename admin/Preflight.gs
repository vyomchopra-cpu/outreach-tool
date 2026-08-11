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

  const sample = { first_name: 'Sam', last_name: 'Prospect', company: 'Example Corp', title: 'VP Engineering', custom: {} };
  let rendered = null;
  try {
    rendered = render_(campaign.body_source, sample);
    applyMerge_(campaign.subject, mergeDataForRecipient_(sample));
    pass('merge_tokens_resolve');
  } catch (e) {
    fail('merge_tokens_resolve', e.message);
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
