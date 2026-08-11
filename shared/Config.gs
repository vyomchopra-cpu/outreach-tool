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

const SEED_MAILBOXES = [
  // 'seed-gmail-web@moveinsync.com',
  // 'seed-gmail-ios@moveinsync.com',
  // 'seed-gmail-android@moveinsync.com',
  // 'seed-outlook-desktop@...',
  // 'seed-outlook-web@...',
  // 'seed-apple-mail@...',
];

const REPLY_TO_DOMAIN = 'moveinsync.com';

// Defence in depth alongside the appsscript.json domain restriction (see
// docs/ARCHITECTURE.md §2) — the 2-3 admins who may build/launch campaigns.
const ADMIN_ALLOWLIST = [
  'vyom.chopra@moveinsync.com',
];

// The admin web app's /exec URL — set once the admin project is deployed.
// Agents call this directly; it never changes without a redeploy of the
// EXISTING deployment (README hard rule 7), which keeps this constant stable.
const CENTRAL_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzkVMxLpWszLRqL9ec9M3LNI0wRUtTAwadZ6eEoHxoQWuia_B6XEiObHlT5Smq3bsY/exec';

const AGENT_VERSION = '0.1.0';
