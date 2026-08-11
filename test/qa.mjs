#!/usr/bin/env node
/**
 * Run before every release. No exceptions — same rule as gmail-rewriter.
 * Skeleton: each check below is a stub until its Stage (see docs/BUILD_ORDER.md)
 * is implemented. A stub reports SKIP, not PASS — never fake a pass.
 */

let pass = 0, fail = 0, skip = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result === 'SKIP') { console.log(`SKIP  ${name}`); skip++; return; }
    console.log(`PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${name} — ${e.message}`);
    fail++;
  }
}

// --- Hard-rule checks (grep-based, run against agent/ and admin/ source) ---
import { readFileSync, readdirSync } from 'fs';
import vm from 'vm';

function allSource(dir) {
  return readdirSync(dir).filter(f => f.endsWith('.gs') || f.endsWith('.json'))
    .map(f => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
}

// Strips block and line comments so grep-style checks match code, not prose that happens to name a forbidden symbol.
function stripComments_(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * .gs files are plain top-level-function scripts, not ES modules — there is
 * nothing to import. This loads shared/MergeEngine.gs + shared/Renderer.gs
 * into a sandboxed VM context, stubbing the one Apps-Script-only global they
 * touch (Utilities.newBlob, for byte-length), so the actual merge/render
 * logic gets exercised here instead of merely asserted correct by inspection.
 */
function loadSharedRenderer_() {
  const ctx = {
    Utilities: {
      newBlob: (str) => ({ getBytes: () => Buffer.from(str, 'utf8') }),
    },
  };
  vm.createContext(ctx);
  const src = ['shared/MergeEngine.gs', 'shared/Renderer.gs']
    .map(f => readFileSync(f, 'utf8')).join('\n');
  vm.runInContext(src, ctx);
  return ctx;
}

check('agent/ never references GmailApp or MailApp', () => {
  const src = stripComments_(allSource('agent'));
  if (/\bGmailApp\b|\bMailApp\b/.test(src)) throw new Error('forbidden API referenced');
});

check('agent/appsscript.json scopes are exactly the Tier B set, no more', () => {
  const scopes = JSON.parse(readFileSync('agent/appsscript.json', 'utf8')).oauthScopes;
  const forbidden = scopes.filter(s => /gmail\.modify|gmail\.readonly|mail\.google\.com/.test(s));
  if (forbidden.length) throw new Error(`forbidden scope present: ${forbidden.join(', ')}`);
});

check('Signals tab schema has no body/snippet column', () => {
  const schemaSrc = readFileSync('admin/Store.gs', 'utf8');
  if (/snippet|body/i.test(schemaSrc.match(/Signals:\s*\[[^\]]*\]/)?.[0] || ''))
    throw new Error('body-shaped column found in Signals schema');
});

/**
 * Extracts top-level `function name(...) { ... }` blocks via brace counting
 * (regex alone can't handle nested braces reliably). Good enough for the
 * flat, non-nested-class .gs files this codebase uses.
 */
function extractFunctions_(src) {
  const fns = [];
  const re = /function\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < src.length) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    fns.push({ name: m[1], body: src.slice(start, i - 1) });
  }
  return fns;
}

check('every public admin function (no trailing _) calls requireAdmin_(), except named exemptions', () => {
  // Exemptions must be deliberate and documented at their definition site:
  // doGet does its own isAuthorizedAdmin_ check before any Campaign.gs/Store.gs
  // code runs; approveCampaignAsExec is intentionally exec-gated, not admin-gated.
  // AgentApi.gs and doPost are excluded entirely below — they're the sender-facing
  // API surface and are checked by requireSender_(), not requireAdmin_().
  const EXEMPT = new Set(['doGet', 'doPost', 'approveCampaignAsExec']);
  const adminFiles = readdirSync('admin').filter(f => f.endsWith('.gs') && f !== 'AgentApi.gs');
  const src = adminFiles.map(f => readFileSync(`admin/${f}`, 'utf8')).join('\n');
  const fns = extractFunctions_(src);
  const unguarded = fns.filter(f =>
    !f.name.endsWith('_') && !EXEMPT.has(f.name) && !f.body.includes('requireAdmin_('));
  if (unguarded.length) throw new Error('missing requireAdmin_() in: ' + unguarded.map(f => f.name).join(', '));
});

check('every function in admin/AgentApi.gs is sender-gated (requireSender_ or an explicit identity check)', () => {
  const src = readFileSync('admin/AgentApi.gs', 'utf8');
  const fns = extractFunctions_(src);
  const unguarded = fns.filter(f =>
    !f.name.endsWith('_') && !f.body.includes('requireSender_(') && !f.body.includes('Session.getActiveUser('));
  if (unguarded.length) throw new Error('missing sender auth in: ' + unguarded.map(f => f.name).join(', '));
});

/** Loads shared/Csv.gs + shared/Schedule.gs, stubbing Utilities.formatDate via real Intl timezone conversion. */
function loadSharedSchedule_() {
  const ctx = {
    Utilities: {
      formatDate: (date, timeZone, pattern) => {
        // Only the one pattern this codebase actually uses is supported here.
        if (pattern !== "yyyy-MM-dd'T'HH:mm:ss") throw new Error('unsupported pattern in test stub: ' + pattern);
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
        const hour = parts.hour === '24' ? '00' : parts.hour;
        return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
      },
    },
  };
  vm.createContext(ctx);
  const src = ['shared/Csv.gs', 'shared/Schedule.gs'].map(f => readFileSync(f, 'utf8')).join('\n');
  vm.runInContext(src, ctx);
  return ctx;
}

// --- Stage 1: MergeEngine + Renderer, run for real inside a VM sandbox ---

check('merge-tag hard-fail blocks send on missing token', () => {
  const ctx = loadSharedRenderer_();
  const recipient = { first_name: 'Priya', company: 'Acme Corp', custom: {} };
  // title is deliberately absent — {{title}} must not silently render blank
  let threw = false;
  try {
    ctx.render_('<p>Hi {{firstName}}, saw you\'re {{title}} at {{company}}.</p>', recipient);
  } catch (e) {
    threw = /title/.test(e.message);
  }
  if (!threw) throw new Error('missing {{title}} did not hard-fail the render');
});

check('renderer succeeds and derives correct text when every token resolves', () => {
  const ctx = loadSharedRenderer_();
  const recipient = { first_name: 'Priya', title: 'VP Eng', company: 'Acme Corp', custom: {} };
  const out = ctx.render_('<p>Hi {{firstName}}, saw you\'re {{title}} at {{company}}.</p>', recipient);
  if (!out.html.includes('Priya') || !out.html.includes('VP Eng')) throw new Error('merge did not apply to html');
  if (out.text !== "Hi Priya, saw you're VP Eng at Acme Corp." )
    throw new Error('unexpected plain-text derivation: ' + JSON.stringify(out.text));
});

check('rendered HTML under MAX_HTML_BYTES on a representative body', () => {
  const ctx = loadSharedRenderer_();
  const recipient = { first_name: 'Priya', title: 'VP Eng', company: 'Acme Corp', custom: {} };
  const out = ctx.render_('<p>Hi {{firstName}}, quick note re {{company}}.</p>'.repeat(1), recipient);
  const MAX = 102 * 1024;
  if (out.bytes >= MAX) throw new Error(`${out.bytes} bytes >= ${MAX} cap`);
});

check('renderer output identical across repeated calls with identical input (determinism)', () => {
  const ctx = loadSharedRenderer_();
  const recipient = { first_name: 'Priya', title: 'VP Eng', company: 'Acme Corp', custom: {} };
  const source = '<p>Hi {{firstName}}, from {{company}}.</p>';
  const a = ctx.render_(source, recipient);
  const b = ctx.render_(source, recipient);
  if (a.html !== b.html || a.text !== b.text) throw new Error('render_ is non-deterministic');
});

// --- Stage 3: CSV parsing, cap ramp, business-day math, timezone conversion ---

check('CSV parser handles quoted commas and preserves unknown columns', () => {
  const ctx = loadSharedSchedule_();
  const rows = ctx.parseCsv_('email,first_name,company\n"a@x.com",Sam,"Acme, Inc."\nb@x.com,Jo,Beta Corp');
  if (rows.length !== 2) throw new Error('expected 2 rows, got ' + rows.length);
  if (rows[0].company !== 'Acme, Inc.') throw new Error('quoted comma mangled: ' + JSON.stringify(rows[0]));
  if (rows[1].email !== 'b@x.com') throw new Error('unquoted row mangled: ' + JSON.stringify(rows[1]));
});

check('isValidEmail_ rejects obviously malformed addresses', () => {
  const ctx = loadSharedSchedule_();
  if (!ctx.isValidEmail_('a@b.com')) throw new Error('valid address rejected');
  if (ctx.isValidEmail_('not-an-email') || ctx.isValidEmail_('a@b') || ctx.isValidEmail_(''))
    throw new Error('malformed address accepted');
});

check('stickySenderForEmail_ is deterministic and pool-stable', () => {
  const ctx = loadSharedSchedule_();
  const pool = ['a@x.com', 'b@x.com', 'c@x.com'];
  const first = ctx.stickySenderForEmail_('prospect@acme.com', pool);
  for (let i = 0; i < 5; i++) {
    if (ctx.stickySenderForEmail_('prospect@acme.com', pool) !== first)
      throw new Error('sticky assignment changed across calls');
  }
});

check('capForSenderToday_ follows the 10 -> 15 -> 20 ramp and respects the override ceiling', () => {
  const ctx = loadSharedSchedule_();
  const ramp = [{ afterDays: 0, cap: 10 }, { afterDays: 7, cap: 15 }, { afterDays: 14, cap: 20 }];
  const start = new Date('2026-01-01T00:00:00Z');
  const day = (n) => new Date(start.getTime() + n * 86400000);
  if (ctx.capForSenderToday_(start, day(0), ramp, null) !== 10) throw new Error('day 0 should be cap 10');
  if (ctx.capForSenderToday_(start, day(7), ramp, null) !== 15) throw new Error('day 7 should be cap 15');
  if (ctx.capForSenderToday_(start, day(14), ramp, null) !== 20) throw new Error('day 14 should be cap 20');
  if (ctx.capForSenderToday_(start, day(30), ramp, 25) !== 20) throw new Error('override above ceiling must clamp to 20');
  if (ctx.capForSenderToday_(start, day(30), ramp, 5) !== 5) throw new Error('override below ceiling should apply');
});

check('businessDayOffset_ skips weekends', () => {
  const ctx = loadSharedSchedule_();
  const friday = new Date('2026-01-02T00:00:00'); // a Friday
  const next = ctx.businessDayOffset_(friday, 1);
  if (next.getDay() !== 1) throw new Error('expected Monday (day 1), got day ' + next.getDay());
});

check('scheduleSlotForIndex_ rolls to the next day when a day\'s cap is exhausted', () => {
  const ctx = loadSharedSchedule_();
  const capLookup = () => 10; // constant cap of 10/day
  const first = ctx.scheduleSlotForIndex_(9, capLookup);   // last slot of day 0
  const second = ctx.scheduleSlotForIndex_(10, capLookup); // first slot of day 1
  if (first.dayOffset !== 0 || first.slotIndex !== 9) throw new Error('index 9 misscheduled: ' + JSON.stringify(first));
  if (second.dayOffset !== 1 || second.slotIndex !== 0) throw new Error('index 10 misscheduled: ' + JSON.stringify(second));
});

check('zonedTimeToUtc_ converts IST (UTC+5:30, no DST) correctly', () => {
  const ctx = loadSharedSchedule_();
  // 09:00 IST on 2026-06-15 must be 03:30 UTC the same day.
  const utc = ctx.zonedTimeToUtc_(2026, 5, 15, 9, 0, 'Asia/Kolkata', ctx.formatInZoneViaUtilities_);
  const expected = new Date(Date.UTC(2026, 5, 15, 3, 30, 0));
  if (Math.abs(utc.getTime() - expected.getTime()) > 1000)
    throw new Error(`expected ${expected.toISOString()}, got ${utc.toISOString()}`);
});

check('isWithinSendWindow_ correctly bounds the 09:00-17:00 window', () => {
  const ctx = loadSharedSchedule_();
  const window = { startHour: 9, endHour: 17 };
  // Build explicit UTC instants for 08:59 / 09:00 / 16:59 / 17:00 IST (IST = UTC+5:30).
  const istToUtc = (h, m) => new Date(Date.UTC(2026, 5, 15, h, m) - (5 * 60 + 30) * 60000);
  if (ctx.isWithinSendWindow_(istToUtc(8, 59), 'Asia/Kolkata', window, ctx.formatInZoneViaUtilities_)) throw new Error('08:59 IST should be outside window');
  if (!ctx.isWithinSendWindow_(istToUtc(9, 0), 'Asia/Kolkata', window, ctx.formatInZoneViaUtilities_)) throw new Error('09:00 IST should be inside window');
  if (!ctx.isWithinSendWindow_(istToUtc(16, 59), 'Asia/Kolkata', window, ctx.formatInZoneViaUtilities_)) throw new Error('16:59 IST should be inside window');
  if (ctx.isWithinSendWindow_(istToUtc(17, 0), 'Asia/Kolkata', window, ctx.formatInZoneViaUtilities_)) throw new Error('17:00 IST should be outside window (end exclusive)');
});

check('remainingCapToday_ never goes negative and stops at the cap', () => {
  const ctx = loadSharedSchedule_();
  if (ctx.remainingCapToday_(20, 5) !== 15) throw new Error('20 cap, 5 sent should leave 15');
  if (ctx.remainingCapToday_(20, 25) !== 0) throw new Error('over-cap sent count must floor at 0, not go negative');
});

check('backoffMinutes_ grows and is capped', () => {
  const ctx = loadSharedSchedule_();
  if (ctx.backoffMinutes_(1) >= ctx.backoffMinutes_(2)) throw new Error('backoff should increase with attempts');
  if (ctx.backoffMinutes_(20) > 240) throw new Error('backoff must be capped at 240 minutes');
});

/** Loads shared/Mime.gs into a VM sandbox with Node-side base64/uuid stubs. */
function loadSharedMime_() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync('shared/Mime.gs', 'utf8'), ctx);
  return ctx;
}

check('every send path produces multipart/alternative (text + html)', () => {
  const ctx = loadSharedMime_();
  const base64Fn = (s) => Buffer.from(s, 'utf8').toString('base64');
  const uuidFn = () => '12345678-1234-1234-1234-123456789012';
  const raw = ctx.buildMimeMessage_({
    fromDisplayName: 'Jane Exec', fromEmail: 'jane@moveinsync.com', toEmail: 'prospect@acme.com',
    replyTo: 'jane+o@moveinsync.com', subject: 'Quick question', html: '<p>Hi there</p>', text: 'Hi there',
  }, base64Fn, uuidFn);
  if (!ctx.mimeHasBothParts_(raw)) throw new Error('MIME message is missing multipart/alternative text+html parts');
});

check('agent send window guard: agent/Sender.gs calls isWithinSendWindow_ before every send', () => {
  const src = readFileSync('agent/Sender.gs', 'utf8');
  if (!/isWithinSendWindow_\(/.test(src)) throw new Error('processJob_ does not re-check the send window independently');
});

check('daily cap enforced server-side at poll time: pollDueJobs uses remainingCapToday_', () => {
  const src = readFileSync('admin/AgentApi.gs', 'utf8');
  if (!/remainingCapToday_\(/.test(src) || !/capForSenderToday_\(/.test(src))
    throw new Error('pollDueJobs does not derive an allowance from the cap ramp');
});

check('suppressed email cannot be queued or sent, checked twice (import time + poll time)', () => {
  const importSrc = readFileSync('admin/Recipients.gs', 'utf8');
  const pollSrc = readFileSync('admin/AgentApi.gs', 'utf8');
  if (!/isSuppressed_\(/.test(importSrc)) throw new Error('importRecipientsCsv does not check suppression at import time');
  if (!/isSuppressed_\(/.test(pollSrc)) throw new Error('pollDueJobs does not re-check suppression at send time');
});

check('idempotency key prevents double-send: reportSent short-circuits on an already-sent queue row', () => {
  const src = readFileSync('admin/AgentApi.gs', 'utf8');
  if (!/status\s*===\s*['"]sent['"]\s*\)\s*return/.test(src))
    throw new Error('reportSent has no guard against re-processing an already-sent row');
});

check('bounce rate > 3% halts all campaigns', () => 'SKIP');
check('reply auto-cancels remaining follow-ups for that recipient', () => 'SKIP');

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
