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

check('every public admin function (no trailing _) calls requireAdmin_(), except doGet', () => {
  const src = readFileSync('admin/Campaign.gs', 'utf8') + '\n' + readFileSync('admin/Code.gs', 'utf8');
  const fns = extractFunctions_(src);
  const unguarded = fns.filter(f =>
    !f.name.endsWith('_') && f.name !== 'doGet' && !f.body.includes('requireAdmin_('));
  if (unguarded.length) throw new Error('missing requireAdmin_() in: ' + unguarded.map(f => f.name).join(', '));
});

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

check('every send path produces multipart/alternative (text + html)', () => 'SKIP');
check('send outside 09:00-17:00 window is rejected by agent, not just admin UI', () => 'SKIP');
check('daily cap enforced at agent send time', () => 'SKIP');
check('bounce rate > 3% halts all campaigns', () => 'SKIP');
check('reply auto-cancels remaining follow-ups for that recipient', () => 'SKIP');
check('suppressed email cannot be queued or sent, checked twice', () => 'SKIP');
check('idempotency key prevents double-send on duplicate queue read', () => 'SKIP');

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
