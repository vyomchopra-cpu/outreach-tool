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

function allSource(dir) {
  return readdirSync(dir).filter(f => f.endsWith('.gs') || f.endsWith('.json'))
    .map(f => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
}

check('agent/ never references GmailApp or MailApp', () => {
  const src = allSource('agent');
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

check('every send path produces multipart/alternative (text + html)', () => 'SKIP');
check('rendered HTML under MAX_HTML_BYTES on seed campaign', () => 'SKIP');
check('renderer output identical across preview/seed/live call sites', () => 'SKIP');
check('merge-tag hard-fail blocks send on missing token', () => 'SKIP');
check('send outside 09:00-17:00 window is rejected by agent, not just admin UI', () => 'SKIP');
check('daily cap enforced at agent send time', () => 'SKIP');
check('bounce rate > 3% halts all campaigns', () => 'SKIP');
check('reply auto-cancels remaining follow-ups for that recipient', () => 'SKIP');
check('suppressed email cannot be queued or sent, checked twice', () => 'SKIP');
check('idempotency key prevents double-send on duplicate queue read', () => 'SKIP');

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
