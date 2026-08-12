/**
 * Shared config, synced verbatim into both admin/ and agent/ Apps Script projects.
 * There is no build step yet — copy-paste on change, and grep both projects
 * before assuming they still match. (Revisit once clasp multi-project push is set up.)
 */

// Pilot pool. Grows by adding rows here — no code changes elsewhere should be needed.
const SENDER_POOL = [
  { email: 'vyom.chopra@moveinsync.com', displayName: 'Vyom Chopra' },
];

const SEND_WINDOW = { startHour: 9, endHour: 17 }; // sender/recipient-local per Campaigns.tz_mode

// Daily cap ramp, keyed by days since Senders.ramp_start_date. Never exceeds 20.
const DAILY_CAP_RAMP = [
  { afterDays: 0, cap: 10 },
  { afterDays: 7, cap: 15 },
  { afterDays: 14, cap: 20 },
];

const GOVERNANCE = {
  bounceRateHaltPct: 3.0,
  complaintRateHaltPct: 0.1,
  agentStaleMinutes: 30,
  seedSendMaxAgeHours: 24,
  maxSendAttempts: 3,
};

const MAX_HTML_BYTES = 102 * 1024; // Gmail clips above this — hard preflight fail

/**
 * Where seed (pre-launch render check) sends go. Pilot starts with the admin's
 * own mailbox; the point of a matrix is catching client-specific rendering
 * breakage, so add real Outlook desktop / Apple Mail / mobile addresses before
 * any campaign whose look actually matters. Seed sends bypass the daily cap
 * and the send window (gateway/AgentApi.gs) — they go to us, not to prospects.
 */
const SEED_MAILBOXES = [
  'vyom.chopra@moveinsync.com',
  // 'seed-outlook-desktop@...',   // the Word rendering engine — the usual culprit
  // 'seed-apple-mail@...',
  // 'seed-gmail-mobile@...',
];

const REPLY_TO_DOMAIN = 'moveinsync.com';

// Defence in depth alongside the appsscript.json domain restriction (see
// docs/ARCHITECTURE.md §2) — the 2-3 admins who may build/launch campaigns.
const ADMIN_ALLOWLIST = [
  'vyom.chopra@moveinsync.com',
];

// The gateway web app's /exec URL — NOT admin's. Agents call gateway/, never
// admin/, directly (see docs/ARCHITECTURE.md §2 "Agent-API Gateway" for why
// they're separate projects). Never changes without a redeploy of the
// EXISTING deployment (README hard rule 7), which keeps this constant stable.
const CENTRAL_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyLM5Wyr9S_isiYbk1MPMKT3XMzjgg9r6pXBXKIQhbz7xlnScOVZwnaK14jX9DZTunA/exec';

const AGENT_VERSION = '0.2.0';

/**
 * Which send path the agent uses — see agent/Transport.gs.
 *   'auto'     probe the Gmail API once per run, prefer it, fall back to MailApp
 *   'advanced' force the Gmail REST path (fails if the API isn't enabled)
 *   'mailapp'  force the built-in MailApp path (needs no Google Cloud access)
 * Leave on 'auto' unless deliberately testing one path.
 */
const TRANSPORT_MODE = 'auto';

/**
 * Multi-touch sequences require reply detection, which requires the Gmail API
 * (docs/GCP_CONSTRAINT.md). With it unavailable, a follow-up could fire at
 * someone who already replied "please stop" — the exact incident the whole
 * Tier B argument was built to prevent. Until reply detection is confirmed
 * working, campaigns are single-touch and this stays false. Enforced in
 * admin/Preflight.gs, not merely documented here.
 */
const ALLOW_MULTI_TOUCH = false;
