/**
 * Scans the three Outreach/* labels for new messages and reports header-only
 * signals to central. This is the entire Tier B surface — format=metadata
 * with a fixed header allowlist, never a body or snippet field, so there is
 * no code path here that could pull message content even by accident.
 */

const SIGNAL_LABELS = [
  { name: 'Outreach/Replies', kind: 'reply' },
  { name: 'Outreach/Bounces', kind: 'bounce' },
  { name: 'Outreach/Unsubscribes', kind: 'unsubscribe' },
];

const SEEN_IDS_PROPERTY = 'SEEN_SIGNAL_IDS';
const SEEN_IDS_MAX = 1000; // keeps well under PropertiesService's 9KB-per-value limit

function extractHeader_(headers, name) {
  const h = (headers || []).find(function (x) { return x.name === name; });
  return h ? h.value : '';
}

/** "Jane Prospect <jane@acme.com>" -> "jane@acme.com". Falls back to the raw header if no angle brackets. */
function parseFromAddress_(fromHeader) {
  const m = (fromHeader || '').match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

function scanSignals_() {
  const props = userProps_(); // seen-message IDs are from this exec's own mailbox
  const seen = JSON.parse(props.getProperty(SEEN_IDS_PROPERTY) || '[]');
  const seenSet = {};
  seen.forEach(function (id) { seenSet[id] = true; });

  const newSignals = [];

  SIGNAL_LABELS.forEach(function (labelDef) {
    const labelId = getOrCreateLabelId_(labelDef.name);
    const list = gmailFetch_('/messages?labelIds=' + labelId + '&maxResults=25', 'get');
    (list.messages || []).forEach(function (m) {
      if (seenSet[m.id]) return;
      seenSet[m.id] = true;

      const meta = gmailFetch_(
        '/messages/' + m.id + '?format=metadata'
        + '&metadataHeaders=From&metadataHeaders=In-Reply-To&metadataHeaders=Message-ID',
        'get'
      );
      const headers = meta.payload && meta.payload.headers;
      newSignals.push({
        kind: labelDef.kind,
        gmail_message_id: m.id,
        in_reply_to: extractHeader_(headers, 'In-Reply-To'),
        from_header: parseFromAddress_(extractHeader_(headers, 'From')),
      });
    });
  });

  if (newSignals.length > 0) {
    callCentral_('reportSignals', [getMyEmail_(), getOrCreateSecret_(), newSignals]);
  }

  const capped = Object.keys(seenSet).slice(-SEEN_IDS_MAX);
  props.setProperty(SEEN_IDS_PROPERTY, JSON.stringify(capped));
}
