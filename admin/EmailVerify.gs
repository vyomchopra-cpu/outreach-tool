/**
 * Reoon Email Verifier integration — hard checks on a recipient list before
 * a campaign launches: syntax, disposable domains, role accounts (info@,
 * sales@ — deliverable but never the actual person), and MX existence.
 *
 * Deliberately separate from admin/Preflight.gs's checks: those are about
 * whether the CAMPAIGN is safe to send (merge tags resolve, unsubscribe
 * present, size under the limit). This is about whether the LIST is worth
 * sending to — different question, different failure mode, and one that
 * costs Reoon credits to answer, so it stays a deliberate admin action
 * rather than something that runs on every preview.
 *
 * Every function here is a safe no-op without a configured key — see
 * shared/Config.gs's REOON_API_KEY comment for why the key itself never
 * lives in that file.
 */

const REOON_API_BASE = 'https://emailverifier.reoon.com/api/v1/verify';
const REOON_BATCH_SIZE = 90; // stay well clear of Apps Script's per-request/UrlFetchApp limits

function reoonApiKey_() {
  // Script Properties over the shared constant — see shared/Config.gs for why
  // the constant itself must never hold a real key.
  return PropertiesService.getScriptProperties().getProperty('REOON_API_KEY') || REOON_API_KEY || '';
}

function reoonConfigured_() {
  return !!reoonApiKey_();
}

/** What the console shows before anyone clicks verify — never leaks the key itself. */
function getReoonStatus() {
  requireAdmin_();
  return { configured: reoonConfigured_(), mode: REOON_MODE };
}

/**
 * The ONLY place a real Reoon key should ever be typed. Goes straight into
 * this project's private Script Properties via google.script.run — never a
 * URL parameter (would sit in browser history / server logs), never a file
 * this repo commits. See shared/Config.gs's REOON_API_KEY comment.
 */
function setReoonApiKey(key) {
  const admin = requireAdmin_();
  const clean = String(key || '').trim();
  if (!clean) throw new Error('Key was empty');
  if (clean.length < 10) throw new Error('That does not look like a real API key');
  PropertiesService.getScriptProperties().setProperty('REOON_API_KEY', clean);
  logEvent_(admin, 'config_change', { detail: { action: 'set_reoon_key', keyLength: clean.length } }); // length only — never the value
  return { configured: true };
}

/** For an admin who wants to rotate or pull a key back out. */
function clearReoonApiKey() {
  const admin = requireAdmin_();
  PropertiesService.getScriptProperties().deleteProperty('REOON_API_KEY');
  logEvent_(admin, 'config_change', { detail: { action: 'clear_reoon_key' } });
  return { configured: false };
}

function reoonUrlFor_(email, apiKey) {
  return REOON_API_BASE + '?email=' + encodeURIComponent(email)
    + '&key=' + encodeURIComponent(apiKey) + '&mode=' + encodeURIComponent(REOON_MODE);
}

/**
 * One bucket per verdict, derived from Reoon's `status` field. Their
 * vocabulary (safe/valid/invalid/disposable/role_account/spamtrap/unknown)
 * isn't guaranteed stable across API versions, so anything unrecognised
 * lands in 'unknown' rather than throwing — a classification service being
 * imprecise about one address must never be able to block an entire import.
 */
function reoonClassify_(status) {
  const known = ['safe', 'valid', 'invalid', 'disposable', 'role_account', 'spamtrap', 'catch_all', 'unknown'];
  const s = String(status || '').toLowerCase();
  return known.indexOf(s) !== -1 ? s : 'unknown';
}

/**
 * Verifies every 'queued' recipient on a campaign that hasn't already been
 * verified. Batches via UrlFetchApp.fetchAll — true parallel requests, not a
 * loop of sequential ones — chunked to REOON_BATCH_SIZE to stay inside
 * Apps Script's per-execution limits on a large list.
 *
 * Writes Recipients.verify_status per row and returns counts by bucket.
 * Never suppresses or removes anyone by itself — see removeUnverifiable,
 * a distinct, explicit, confirmable action.
 */
function verifyRecipientsWithReoon(campaignId) {
  const admin = requireAdmin_();
  const apiKey = reoonApiKey_();
  if (!apiKey) throw new Error('Reoon is not configured — set REOON_API_KEY in Script Properties (Project Settings) first.');

  const recipients = readRows_('Recipients', function (r) {
    return r.campaign_id === campaignId && r.status === 'queued' && !r.verify_status;
  });
  if (recipients.length === 0) return { checked: 0, buckets: {} };

  const buckets = {};
  for (let i = 0; i < recipients.length; i += REOON_BATCH_SIZE) {
    const chunk = recipients.slice(i, i + REOON_BATCH_SIZE);
    const requests = chunk.map(function (r) {
      return { url: reoonUrlFor_(r.email, apiKey), muteHttpExceptions: true };
    });
    const responses = UrlFetchApp.fetchAll(requests);

    chunk.forEach(function (r, idx) {
      let bucket = 'unknown';
      try {
        const code = responses[idx].getResponseCode();
        if (code === 200) {
          const body = JSON.parse(responses[idx].getContentText());
          bucket = reoonClassify_(body.status);
        } else {
          bucket = 'error_http_' + code;
        }
      } catch (e) {
        bucket = 'error_parse';
      }
      updateRow_('Recipients', r.id, { verify_status: bucket });
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    });
  }

  logEvent_(admin, 'admin_action', { campaignId: campaignId, detail: { action: 'reoon_verify', checked: recipients.length, buckets: buckets } });
  return { checked: recipients.length, buckets: buckets };
}

/**
 * The explicit, confirmable follow-up to verifyRecipientsWithReoon: removes
 * (cancels, does not suppress) every recipient whose verify_status is in the
 * caller-supplied bucket list. Not automatic — an admin reviews the counts
 * first, then decides which buckets are worth acting on. 'invalid' and
 * 'disposable' are the obvious candidates; 'role_account' and 'unknown' are
 * judgment calls this deliberately leaves to the admin rather than assuming.
 *
 * "Removed", not suppressed — a bad address on THIS list says nothing about
 * whether it deserves the permanent, global, cross-campaign consequence
 * Suppression carries (see admin/Manual.gs manuallySuppress for that).
 */
function removeUnverifiable(campaignId, buckets) {
  const admin = requireAdmin_();
  const targets = new Set(buckets || []);
  const recipients = readRows_('Recipients', function (r) {
    return r.campaign_id === campaignId && r.status === 'queued' && targets.has(r.verify_status);
  });
  recipients.forEach(function (r) {
    updateRow_('Recipients', r.id, { status: 'failed', status_reason: 'removed: Reoon verify_status=' + r.verify_status });
  });
  logEvent_(admin, 'admin_action', { campaignId: campaignId, detail: { action: 'remove_unverifiable', buckets: buckets, count: recipients.length } });
  return { removed: recipients.length };
}
