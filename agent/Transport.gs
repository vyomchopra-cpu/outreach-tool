/**
 * How a message actually leaves the building. Two backends, because the
 * richer one depends on a Google Cloud project this Workspace's regular
 * users cannot administer (see docs/GCP_CONSTRAINT.md).
 *
 *   'advanced' — Gmail REST API via agent/GmailApi.gs. Full fidelity:
 *                custom headers, real RFC Message-ID capture (needed for
 *                reply matching), threading. REQUIRES the Gmail API to be
 *                enabled in the script's underlying GCP project.
 *
 *   'mailapp'  — Apps Script's built-in MailApp. Requires NO GCP project,
 *                no API enablement, nothing an admin has to grant. Scope is
 *                `script.send_mail`, which is send-only — it cannot read,
 *                list, or search a single message, so the core promise to
 *                the exec ("we can send as you, we can never read your
 *                mail") holds at least as strongly as under gmail.send.
 *                Costs: no custom headers, and no way to learn the sent
 *                message's RFC Message-ID.
 *
 * TRANSPORT_MODE (shared/Config.gs) picks; 'auto' probes once per execution
 * and prefers 'advanced', silently falling back. Probing is cached in script
 * scope, not PropertiesService — a stale "unavailable" cached across days
 * would silently keep the agent on the degraded path long after an admin
 * enabled the API.
 */

let TRANSPORT_PROBE_CACHE_ = null;

/** True if the Gmail REST API answers at all. One cheap call, result cached per execution. */
function gmailApiAvailable_() {
  if (TRANSPORT_PROBE_CACHE_ !== null) return TRANSPORT_PROBE_CACHE_;
  try {
    gmailFetch_('/labels', 'get');
    TRANSPORT_PROBE_CACHE_ = true;
  } catch (e) {
    TRANSPORT_PROBE_CACHE_ = false;
  }
  return TRANSPORT_PROBE_CACHE_;
}

/** Classifies the specific "the Cloud project hasn't enabled this API" failure vs any other error. */
function isApiNotEnabledError_(err) {
  const m = String(err && err.message || err);
  return /has not been used in project|accessNotConfigured|SERVICE_DISABLED/i.test(m);
}

function activeTransport_() {
  if (TRANSPORT_MODE === 'mailapp') return 'mailapp';
  if (TRANSPORT_MODE === 'advanced') return 'advanced';
  return gmailApiAvailable_() ? 'advanced' : 'mailapp';
}

/**
 * Sends one message. opts: { fromDisplayName, fromEmail, toEmail, replyTo,
 * subject, html, text }.
 *
 * Returns { transport, rfcMessageId, gmailMessageId }. rfcMessageId is ''
 * under the mailapp transport — callers must treat an empty value as "reply
 * matching is not possible for this send" rather than as an error, and
 * gateway/AgentApi.gs's findRecipientByRfcMessageId_ already returns null
 * for an unmatched id, so a blank simply never matches anything.
 */
function sendMessage_(opts) {
  const transport = activeTransport_();
  if (transport === 'advanced') {
    const sent = sendMail_(opts);                       // agent/GmailApi.gs
    return {
      transport: 'advanced',
      gmailMessageId: sent.id,
      rfcMessageId: getRfcMessageId_(sent.id) || '',
    };
  }
  return sendViaMailApp_(opts);
}

/**
 * MailApp path. Passing BOTH `body` and `htmlBody` makes Apps Script emit a
 * genuine multipart/alternative message — the plain-text part is a real
 * alternative part, not a stripped-tags afterthought — which is what
 * README hard rule 5 is actually asking for. shared/Mime.gs's hand-built
 * MIME is unused here because MailApp owns message assembly.
 */
function sendViaMailApp_(opts) {
  if (!opts.text || !opts.text.trim()) {
    throw new Error('Refusing to send: no plain-text alternative part (hard rule 5)');
  }
  MailApp.sendEmail({
    to: opts.toEmail,
    subject: opts.subject,
    body: opts.text,
    htmlBody: opts.html,
    name: opts.fromDisplayName,
    replyTo: opts.replyTo,
  });
  return { transport: 'mailapp', gmailMessageId: '', rfcMessageId: '' };
}

/** Remaining sends allowed by Google today, independent of our own governance cap. */
function remainingProviderQuota_() {
  try {
    return MailApp.getRemainingDailyQuota();
  } catch (e) {
    return null;
  }
}
