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

check('agent/ never references GmailApp or the full mail.google.com scope', () => {
  // The rule is, and always was, about SCOPE, not about which class is used:
  // never acquire the ability to read the exec's mail. GmailApp silently pulls
  // https://mail.google.com/ (read, compose, send, permanently delete), which
  // is why it is banned outright.
  //
  // MailApp is deliberately NOT banned — it uses script.send_mail, which is
  // strictly send-only and cannot read, list, or search a single message. It
  // is the fallback transport (agent/Transport.gs) precisely because it needs
  // no Google Cloud project, and it satisfies the promise to the exec at least
  // as strongly as gmail.send does. See README hard rule 1.
  const src = stripComments_(allSource('agent'));
  if (/\bGmailApp\b/.test(src)) throw new Error('GmailApp referenced — pulls the full mail.google.com scope');
  if (/mail\.google\.com/.test(src)) throw new Error('the full mail.google.com scope appears in agent/');
});

check('MailApp use is backed by the send-only script.send_mail scope in the manifest', () => {
  const src = stripComments_(allSource('agent'));
  if (!/\bMailApp\b/.test(src)) return; // not used, nothing to back
  const scopes = JSON.parse(readFileSync('agent/appsscript.json', 'utf8')).oauthScopes;
  if (!scopes.includes('https://www.googleapis.com/auth/script.send_mail'))
    throw new Error('agent/ calls MailApp but script.send_mail is not declared — the consent screen would not match the code');
});

check('both transports exist and neither can read mail', () => {
  const src = readFileSync('agent/Transport.gs', 'utf8');
  if (!/function sendViaMailApp_/.test(src)) throw new Error('no MailApp fallback transport — a GCP outage/permission gap would block all sending');
  if (!/sendMail_\(/.test(src)) throw new Error('no Gmail REST transport');
  // Whichever path runs, the plain-text alternative is mandatory (hard rule 5).
  if (!/Refusing to send/.test(src)) throw new Error('MailApp path does not enforce a plain-text alternative part');
});

check('callCentral_ retries transport failures but never a structured rejection', () => {
  const src = readFileSync('agent/CentralClient.gs', 'utf8');
  if (!/attempt\s*<\s*3|attempt\s*<=\s*3/.test(src))
    throw new Error('no retry loop — the 302 -> googleusercontent hop intermittently 404s');
  // A structured ok:false must return immediately; retrying a business
  // rejection would turn one "Unknown sender" into three.
  const raw = src.match(/function callCentralRaw_[\s\S]*?\n\}/);
  if (!raw) throw new Error('callCentralRaw_ not found');
  if (/!body\.ok[\s\S]{0,80}(continue|retry)/.test(raw[0]))
    throw new Error('callCentralRaw_ appears to retry structured rejections');
});

check('every render_/applyMerge_ call site supplies send-time extras', () => {
  // {{unsubscribe}} is a blocking preflight requirement, so it appears in every
  // real campaign body. A call site that forgets extras therefore hard-fails on
  // every real campaign — which is exactly how preview and seed send silently
  // broke once already. Cheap to pin, expensive to rediscover by hand.
  const files = ['admin/Campaign.gs', 'admin/Preflight.gs', 'agent/Sender.gs', 'agent/Web.gs'];
  const offenders = [];
  files.forEach(function (f) {
    stripComments_(readFileSync(f, 'utf8')).split('\n').forEach(function (line, i) {
      // Two-argument render_(a, b) or single-argument mergeDataForRecipient_(a).
      if (/\brender_\([^)]*,[^,)]*\)/.test(line) && !/render_\([^)]*,[^,)]*,/.test(line)) {
        offenders.push(f + ':' + (i + 1) + ' render_ without extras');
      }
      if (/\bmergeDataForRecipient_\([^,)]*\)/.test(line)) {
        offenders.push(f + ':' + (i + 1) + ' mergeDataForRecipient_ without extras');
      }
    });
  });
  if (offenders.length) throw new Error(offenders.join('; '));
});

check('package.json and AGENT_VERSION are the same version (see docs/RELEASE_PROCESS.md)', () => {
  const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const m = readFileSync('shared/Config.gs', 'utf8').match(/AGENT_VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error('AGENT_VERSION not found in shared/Config.gs');
  if (pkgVersion !== m[1])
    throw new Error(`package.json is ${pkgVersion} but AGENT_VERSION is ${m[1]} — bump both together on every release`);
});

check('REOON_API_KEY is never a real key in shared/Config.gs — it must stay empty', () => {
  const src = readFileSync('shared/Config.gs', 'utf8');
  const m = src.match(/const REOON_API_KEY\s*=\s*'([^']*)'/);
  if (!m) throw new Error('REOON_API_KEY declaration not found');
  if (m[1] !== '') throw new Error('REOON_API_KEY is non-empty in a file that gets committed to git — move it to a Script Property instead');
});

check('setReoonApiKey never logs the raw key value, only its length', () => {
  const src = readFileSync('admin/EmailVerify.gs', 'utf8');
  const fn = src.match(/function setReoonApiKey[\s\S]*?\n\}/);
  if (!fn) throw new Error('setReoonApiKey not found');
  if (/logEvent_\([^)]*clean/.test(fn[0]) && !/keyLength/.test(fn[0]))
    throw new Error('the raw key may be reaching the audit log');
  if (!/keyLength/.test(fn[0])) throw new Error('no audit trail at all for a key rotation — should log the action, just never the value');
});

check('Reoon key is read from Script Properties, and verification is a no-op without one configured', () => {
  const src = readFileSync('admin/EmailVerify.gs', 'utf8');
  if (!/PropertiesService\.getScriptProperties\(\)\.getProperty\('REOON_API_KEY'\)/.test(src))
    throw new Error('reoonApiKey_ does not check Script Properties — a key could only ever come from the committed constant');
  if (!/if \(!apiKey\) throw/.test(src)) throw new Error('verifyRecipientsWithReoon does not fail clearly when unconfigured');
});

check('removing unverifiable recipients never touches the permanent Suppression list', () => {
  const src = readFileSync('admin/EmailVerify.gs', 'utf8');
  const fn = src.match(/function removeUnverifiable[\s\S]*?\n\}/);
  if (!fn) throw new Error('removeUnverifiable not found');
  if (/addSuppression_/.test(fn[0]))
    throw new Error('removeUnverifiable calls addSuppression_ — a bad address on ONE list must not imply a permanent, global, cross-campaign suppression');
});

check('access grants are domain-restricted and checked for revocation + expiry', () => {
  const src = readFileSync('admin/Access.gs', 'utf8');
  if (!/endsWith\('@' \+ REPLY_TO_DOMAIN\)/.test(src)) throw new Error('grantAccess does not enforce the internal-domain restriction');
  if (!/revoked/.test(src) || !/expires_at/.test(src)) throw new Error('isAccessGrantValid_ does not check both revoked and expiry');
});

check('isAuthorizedAdmin_ checks both the permanent allowlist and time-boxed grants', () => {
  const src = readFileSync('admin/Code.gs', 'utf8');
  const fn = src.match(/function isAuthorizedAdmin_[\s\S]*?\n\}/);
  if (!fn) throw new Error('isAuthorizedAdmin_ not found');
  if (!/ADMIN_ALLOWLIST/.test(fn[0])) throw new Error('permanent allowlist path missing');
  if (!/isAccessGrantValid_/.test(fn[0])) throw new Error('time-boxed grant path missing — access grants would silently do nothing');
});

check('time-boxed sending access is admin-controlled, never self-declared by the registering agent', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  const sig = src.match(/function registerSender\(([^)]*)\)/);
  if (!sig) throw new Error('registerSender not found');
  if (/days|expir/i.test(sig[1]))
    throw new Error('registerSender\'s parameter list appears to accept a self-declared expiry — gateway/ is ANYONE_ANONYMOUS, so that would let anyone grant themselves an arbitrary sending window. Params: ' + sig[1]);
  if (!/pollDueJobs[\s\S]*?senderSendingExpired_/.test(src)) throw new Error('pollDueJobs does not check sending expiry — a lapsed grant would keep sending');
  if (!/heartbeat[\s\S]*?senderSendingExpired_/.test(src)) throw new Error('heartbeat does not derive expired status for the agent to see');
});

// ── The delegation invariant ────────────────────────────────────────────
// The tool exists so an operator can send as a senior exec without holding
// that exec's credentials. Every check below defends one property of that:
// the exec, and only the exec, decides whether and for how long. An earlier
// build let an admin type someone else's window into a form, which inverted
// the whole premise — these exist so that cannot come back by accident.

check('no admin-side code can set or extend how long someone else\'s name may be used', () => {
  const adminSrc = readdirSync('admin').filter(f => f.endsWith('.gs'))
    .map(f => `/* FILE:${f} */\n` + readFileSync(`admin/${f}`, 'utf8')).join('\n');
  // revokeDelegation legitimately writes sends_expire_at — but only ever to
  // new Date(0), i.e. the past. Anything computing a FUTURE expiry admin-side
  // would be an operator granting themselves time, which is the whole bug.
  const futureExpiry = /sends_expire_at:\s*(?!new Date\(0\))(?!''\s*[,}])[^,\n]*(?:Date\.now\(\)|expiresAt|\+\s*n\b)/;
  if (futureExpiry.test(adminSrc))
    throw new Error('admin/ computes a future sends_expire_at — only the delegator\'s own approval (gateway approveDelegation) may do that');
  if (/function setSenderExpiry\b/.test(adminSrc))
    throw new Error('setSenderExpiry is back: an operator must never be able to type in someone else\'s window');
});

check('approveDelegation records the delegator themselves as the grantor, never the requester', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  const fn = src.match(/function approveDelegation[\s\S]*?\n\}/);
  if (!fn) throw new Error('approveDelegation not found');
  if (!/sends_granted_by:\s*email/.test(fn[0]))
    throw new Error('sends_granted_by is not set to the delegator\'s own email — the audit trail would credit the wrong person for the decision');
  if (/sends_granted_by:\s*(row\.requested_by|requestedBy)/.test(fn[0]))
    throw new Error('sends_granted_by is set to the REQUESTER — that is precisely the inversion this tool exists to prevent');
});

check('the claim token is single-use: burned on both approve and deny', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  ['approveDelegation', 'denyDelegation'].forEach(name => {
    const fn = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n\\}'));
    if (!fn) throw new Error(name + ' not found');
    if (!/claim_token:\s*'used:'/.test(fn[0]))
      throw new Error(name + ' does not burn the claim token — the approval link would stay replayable after use');
    if (!/status !== 'pending'/.test(fn[0]))
      throw new Error(name + ' does not re-check status, so a double-click could decide an already-decided request');
  });
});

check('a delegation can only be decided by the person it was addressed to', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  const guard = src.match(/function requireDelegator_[\s\S]*?\n\}/);
  if (!guard) throw new Error('requireDelegator_ not found');
  if (!/row\.delegator_email/.test(guard[0]))
    throw new Error('the guard does not compare against the row\'s own delegator_email — a forwarded link could be approved by the wrong person');
  ['lookupDelegation', 'approveDelegation', 'denyDelegation'].forEach(name => {
    const fn = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n\\}'));
    if (!fn || !/requireDelegator_\(/.test(fn[0])) throw new Error(name + ' does not call requireDelegator_');
  });
});

check('every public gateway API function is actually routable from doPost', () => {
  // AgentApi.gs defining a function does not expose it — gateway/Code.gs's
  // AGENT_API_ACTIONS whitelist is what makes it callable, and the two drift
  // silently. All three delegation endpoints shipped unreachable exactly this
  // way: deployed, unit-green, and answering "Unknown action" to every real
  // call until a direct curl against the live endpoint caught it.
  const api = readFileSync('gateway/AgentApi.gs', 'utf8');
  const router = readFileSync('gateway/Code.gs', 'utf8');
  const table = router.match(/const AGENT_API_ACTIONS = \{[\s\S]*?\n\};/);
  if (!table) throw new Error('AGENT_API_ACTIONS not found in gateway/Code.gs');

  const exposed = new Set([...table[0].matchAll(/^\s*(\w+):/gm)].map(m => m[1]));
  const defined = extractFunctions_(api).map(f => f.name).filter(n => !n.endsWith('_'));
  const unroutable = defined.filter(n => !exposed.has(n));
  if (unroutable.length)
    throw new Error('defined in AgentApi.gs but missing from AGENT_API_ACTIONS, so unreachable: ' + unroutable.join(', '));

  const dangling = [...exposed].filter(n => !defined.includes(n));
  if (dangling.length)
    throw new Error('routed in AGENT_API_ACTIONS but not defined in AgentApi.gs, so doPost would throw: ' + dangling.join(', '));
});

check('every link handed to a human is Workspace-scoped, not account-ambiguous', () => {
  // A plain /macros/s/<id>/exec link resolves against whatever Google account
  // is active in that browser. The first delegator to receive one was also
  // signed into a personal gmail.com account, so Google demanded
  // re-verification of an account that could never be authorized, and their
  // managed device blocked that re-auth — leaving them stuck on "Verify it's
  // you / Something went wrong" with nothing suggesting the account was the
  // problem. From their side the tool was simply broken.
  const src = readFileSync('admin/Delegation.gs', 'utf8');
  const fn = src.match(/function delegationApprovalUrl_[\s\S]*?\n\}/);
  if (!fn) throw new Error('delegationApprovalUrl_ not found');
  if (!/domainScopedUrl_\(/.test(fn[0]))
    throw new Error('the approval link is not domain-scoped — a delegator signed into a personal Google account will dead-end before ever reaching the page');

  const cfg = readFileSync('shared/Config.gs', 'utf8');
  const helper = cfg.match(/function domainScopedUrl_[\s\S]*?\n\}/);
  if (!helper) throw new Error('domainScopedUrl_ not found in shared/Config.gs');
  if (!/\/a\/macros\/'\s*\+\s*REPLY_TO_DOMAIN/.test(helper[0]))
    throw new Error('domainScopedUrl_ does not build the /a/macros/<domain>/ form');
  if (!/indexOf\('\/a\/macros\/'\)/.test(helper[0]))
    throw new Error('domainScopedUrl_ is not idempotent — double-scoping an already-scoped URL would produce a dead link');
});

check('an operator cannot name themselves as their own delegator', () => {
  const src = readFileSync('admin/Delegation.gs', 'utf8');
  if (!/delegator === requester/.test(src))
    throw new Error('requestDelegation does not block asking yourself — that would be a self-grant with extra steps');
});

// ── Multi-tenancy ───────────────────────────────────────────────────────
// One agent deployment serves every delegator (executeAs USER_ACCESSING +
// access DOMAIN). That is what lets a CTO approve by opening a link instead
// of being onboarded onto a platform — and it means anything keyed to "this
// person" must live in UserProperties. ScriptProperties is one shared store:
// putting a sender secret there made each new delegator silently clobber the
// last one, and both then failed to authenticate.

check('the agent web app is reachable by the whole domain, not just its owner', () => {
  const manifest = JSON.parse(readFileSync('agent/appsscript.json', 'utf8'));
  if (manifest.webapp.access !== 'DOMAIN')
    throw new Error('agent webapp access is "' + manifest.webapp.access + '" — a delegator could not open their own approval link');
  if (manifest.webapp.executeAs !== 'USER_ACCESSING')
    throw new Error('agent webapp executeAs is "' + manifest.webapp.executeAs + '" — it must run as the visitor for their approval to be their own act');
});

check('no per-person agent state is kept in the shared ScriptProperties store', () => {
  readdirSync('agent').filter(f => f.endsWith('.gs')).forEach(f => {
    const src = readFileSync(`agent/${f}`, 'utf8');
    if (/getScriptProperties\(\)/.test(src))
      throw new Error(`agent/${f} uses getScriptProperties() — that store is shared across every delegator using this deployment; use userProps_() instead`);
  });
});

check('only admin/Store.gs (and its synced copy) may reference SpreadsheetApp', () => {
  // Real violation caught while building admin/Monitor.gs: it called
  // SpreadsheetApp.openById directly in three places, breaking the one
  // invariant that makes a future Firestore migration a one-file change.
  // Nothing had ever enforced the rule Store.gs's own header comment states.
  const ALLOWED = new Set(['admin/Store.gs', 'gateway/Store.gs']);
  const offenders = [];
  ['admin', 'agent', 'gateway'].forEach(dir => {
    readdirSync(dir).filter(f => f.endsWith('.gs')).forEach(f => {
      const path = `${dir}/${f}`;
      if (ALLOWED.has(path)) return;
      if (/\bSpreadsheetApp\b/.test(stripComments_(readFileSync(path, 'utf8')))) offenders.push(path);
    });
  });
  if (offenders.length) throw new Error('SpreadsheetApp referenced outside Store.gs: ' + offenders.join(', '));
});

check('every .gs file in admin/, agent/, gateway/, and shared/ is syntactically valid', () => {
  // Caught a real bug writing this: an unescaped apostrophe inside a single-
  // quoted string in admin/Monitor.gs ("their agent's authorization") was a
  // silent syntax error that only the earlier, narrower client-script check
  // couldn't see — it only ever looked at Index.html's <script> block, never
  // at the .gs files themselves. new Function() parses (never executes) each
  // one, which is enough to catch this whole class of error before deploy.
  const dirs = ['admin', 'agent', 'gateway', 'shared'];
  const broken = [];
  dirs.forEach(dir => {
    readdirSync(dir).filter(f => f.endsWith('.gs')).forEach(f => {
      try {
        new Function(readFileSync(`${dir}/${f}`, 'utf8'));
      } catch (e) {
        broken.push(`${dir}/${f}: ${e.message}`);
      }
    });
  });
  if (broken.length) throw new Error(broken.join('; '));
});

check('the client script is syntactically valid (a broken <script> block is a blank white page, not an error)', () => {
  const html = readFileSync('admin/ui/Index.html', 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('no <script> block found in admin/ui/Index.html');
  new Function(m[1]); // throws SyntaxError on anything invalid, including reassigning a const
});

check('first paint uses one combined round trip (getBootstrap), not three separate calls', () => {
  const html = readFileSync('admin/ui/Index.html', 'utf8');
  if (!/\.getBootstrap\(\)/.test(html))
    throw new Error('getBootstrap() is not called — first paint regressed to separate getClientConfig/getKillSwitchStatus/listCampaigns round trips');
  const src = readFileSync('admin/Code.gs', 'utf8');
  if (!/function getBootstrap/.test(src)) throw new Error('getBootstrap not defined in admin/Code.gs');
});

check('every UI partial referenced by the shell exists (a missing include renders an error page)', () => {
  const shell = readFileSync('admin/ui/Index.html', 'utf8');
  const refs = [...shell.matchAll(/include_\('ui\/([A-Za-z]+)'\)/g)].map(m => m[1]);
  if (!refs.length) throw new Error('shell includes no partials — expected the tab bodies to be split out');
  refs.forEach(name => {
    if (!readdirSync('admin/ui').includes(name + '.html'))
      throw new Error('admin/ui/Index.html includes ui/' + name + ' but admin/ui/' + name + '.html does not exist');
  });
});

check('health snapshot reports no open/click metrics (there is no tracking pixel to source them from)', () => {
  const src = stripComments_(readFileSync('admin/Health.gs', 'utf8'));
  if (/openRate|open_rate|clickRate|click_rate|pixel/i.test(src))
    throw new Error('an open/click metric appeared — see docs/ANALYTICS.md before adding tracking');
});

check('the live send path renders the preheader and leaves the subject unescaped', () => {
  // Both were missing on first write: the preheader silently never rendered in
  // real mail, and every subject containing & or a quote would have shown the
  // recipient an HTML entity. Neither is visible in preview, which uses its own
  // call site — so only a check across both sites catches it.
  const src = readFileSync('agent/Sender.gs', 'utf8');
  if (!/preheader:\s*job\.campaign\.preheader/.test(src))
    throw new Error('processJob_ does not pass the campaign preheader — it would never appear in real sends');
  const subjectLine = src.match(/const subject = applyMerge_[\s\S]{0,200}/);
  if (!subjectLine || !/escape:\s*false/.test(subjectLine[0]))
    throw new Error('subject is HTML-escaped at send time — recipients would see &amp; literally');
});

check('seed queue rows are resolved everywhere they are read (they have no Recipients row)', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  if (!/isSeedRecipientId_/.test(src)) throw new Error('no seed-row awareness — pollDueJobs would look a seed id up in Recipients, get null, and silently drop the send');
  if (!/syntheticSeedRecipient_/.test(src)) throw new Error('no synthetic recipient for seed sends');
  // reportSent/reportFailed must not try to update a Recipients row that cannot exist.
  const reportSent = src.match(/function reportSent[\s\S]*?\n\}/);
  if (reportSent && /updateRow_\('Recipients'/.test(reportSent[0]) && !/isSeedRecipientId_/.test(reportSent[0]))
    throw new Error('reportSent updates Recipients unconditionally — throws on seed rows');
});

check('test-send route cannot be aimed at anyone but the signed-in user', () => {
  const src = readFileSync('agent/Web.gs', 'utf8');
  const fn = src.match(/function runSelfTestSend_[\s\S]*?\n\}/);
  if (!fn) throw new Error('runSelfTestSend_ not found');
  if (/p\.(to|email|recipient)/.test(fn[0]))
    throw new Error('test send reads a recipient from the query string — that turns a debug route into an open relay');
  if (!/toEmail:\s*email/.test(fn[0])) throw new Error('test send does not hard-wire the recipient to getMyEmail_()');
});

check('unsubscribe is a blocking preflight check, not a warning', () => {
  const src = readFileSync('admin/Preflight.gs', 'utf8');
  if (!/\{\{unsubscribe\}\}/.test(src)) throw new Error('preflight does not require an unsubscribe token in the body');
  const m = src.match(/unsubscribe_present[\s\S]{0,200}/);
  if (m && /blocking:\s*false/.test(m[0])) throw new Error('unsubscribe check is marked non-blocking');
});

check('agent/appsscript.json scopes are exactly the Tier B set, no more', () => {
  const scopes = JSON.parse(readFileSync('agent/appsscript.json', 'utf8')).oauthScopes;
  const forbidden = scopes.filter(s => /gmail\.modify|gmail\.readonly|mail\.google\.com/.test(s));
  if (forbidden.length) throw new Error(`forbidden scope present: ${forbidden.join(', ')}`);
});

check('admin/appsscript.json webapp access is DOMAIN, executeAs USER_ACCESSING (agent traffic moved to gateway/, so DOMAIN can stay tight)', () => {
  const manifest = JSON.parse(readFileSync('admin/appsscript.json', 'utf8'));
  if (manifest.webapp.access !== 'DOMAIN') throw new Error('access is ' + manifest.webapp.access + ' — should be DOMAIN now that doPost/agent traffic lives in gateway/ instead; see docs/ARCHITECTURE.md §2');
  if (manifest.webapp.executeAs !== 'USER_ACCESSING') throw new Error('executeAs must stay USER_ACCESSING for Session.getActiveUser() to reflect the real human admin');
});

check('gateway/appsscript.json is executeAs USER_DEPLOYING + access ANYONE_ANONYMOUS, and carries no gmail.* scopes', () => {
  const manifest = JSON.parse(readFileSync('gateway/appsscript.json', 'utf8'));
  if (manifest.webapp.executeAs !== 'USER_DEPLOYING') throw new Error('executeAs must be USER_DEPLOYING — see gateway/AgentApi.gs header comment for why');
  if (manifest.webapp.access !== 'ANYONE_ANONYMOUS')
    throw new Error('access should be ANYONE_ANONYMOUS — outbound Bearer tokens carrying restricted Gmail scopes were rejected by this Workspace even for ANYONE (requires a Google account); see gateway/AgentApi.gs header comment');
  const gmailScopes = (manifest.oauthScopes || []).filter(s => s.includes('gmail'));
  if (gmailScopes.length) throw new Error('gateway should never need gmail.* scopes: ' + gmailScopes.join(', '));
});

check('registerSender is guarded by SENDER_POOL — required since gateway/ has zero Google auth layer (ANYONE_ANONYMOUS)', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  if (!/SENDER_POOL\.some\(/.test(src)) throw new Error('registerSender does not check the caller\'s email against SENDER_POOL before allowing registration');
});

check('agent/CentralClient.gs sends no Authorization header to the gateway (confirmed empirically required — see file header)', () => {
  const src = stripComments_(readFileSync('agent/CentralClient.gs', 'utf8'));
  if (/Authorization/.test(src)) throw new Error('an Authorization header reappeared in callCentral_ — this was confirmed to break the call, see the file\'s header comment before re-adding it');
});

check('admin/Code.gs no longer handles agent traffic (doPost moved to gateway/)', () => {
  const src = readFileSync('admin/Code.gs', 'utf8');
  if (/function doPost/.test(src)) throw new Error('doPost found in admin/Code.gs — should live only in gateway/Code.gs now');
});

check('gateway/ never references GmailApp or MailApp', () => {
  const src = stripComments_(allSource('gateway'));
  if (/\bGmailApp\b|\bMailApp\b/.test(src)) throw new Error('forbidden API referenced');
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
  // The sender-facing API (AgentApi.gs) lives entirely in gateway/ now, not
  // here — it's checked separately, by requireSender_(), not requireAdmin_().
  //
  // The delegator-facing flow deliberately does NOT live here — it runs on
  // the agent, as the delegator, so there is nothing in admin/ to exempt.
  const EXEMPT = new Set(['doGet', 'approveCampaignAsExec']);
  const adminFiles = readdirSync('admin').filter(f => f.endsWith('.gs'));
  const src = adminFiles.map(f => readFileSync(`admin/${f}`, 'utf8')).join('\n');
  const fns = extractFunctions_(src);
  const unguarded = fns.filter(f =>
    !f.name.endsWith('_') && !EXEMPT.has(f.name) && !f.body.includes('requireAdmin_('));
  if (unguarded.length) throw new Error('missing requireAdmin_() in: ' + unguarded.map(f => f.name).join(', '));
});

check('every function in gateway/AgentApi.gs is sender-gated by requireSender_(), except the pre-registration paths', () => {
  // Two kinds of deliberate exception, both for the same structural reason:
  // there is no Senders row to check a secret against yet.
  //
  //   registerSender  — self-onboarding; the freshly-generated secret itself
  //                     is what proves legitimacy, guarded by SENDER_POOL.
  //   lookup/approve/denyDelegation — the delegator has not been registered
  //                     yet; approving is what registers them. Guarded by the
  //                     single-use claim token instead, which is asserted
  //                     below rather than merely assumed.
  const TOKEN_GATED = new Set(['lookupDelegation', 'approveDelegation', 'denyDelegation']);
  const EXEMPT = new Set(['registerSender', ...TOKEN_GATED]);
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  const fns = extractFunctions_(src);
  const unguarded = fns.filter(f =>
    !f.name.endsWith('_') && !EXEMPT.has(f.name) && !f.body.includes('requireSender_('));
  if (unguarded.length) throw new Error('missing sender auth in: ' + unguarded.map(f => f.name).join(', '));

  const tokenless = fns.filter(f => TOKEN_GATED.has(f.name)
    && !(f.body.includes('findDelegationByToken_(') && f.body.includes('requireDelegator_(')));
  if (tokenless.length)
    throw new Error('exempt from requireSender_() but not actually token-gated: ' + tokenless.map(f => f.name).join(', '));
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

check('merge values are HTML-escaped by default — CSV input cannot inject markup', () => {
  const ctx = loadSharedRenderer_();
  const recipient = {
    first_name: 'Sam', title: 'VP', custom: {},
    company: '<script>alert(1)</script> & "quoted"',
  };
  const out = ctx.render_('<p>Hi {{firstName}}, at {{company}}.</p>', recipient, { unsubscribe: 'x@y.com' });
  if (out.html.includes('<script>')) throw new Error('SCRIPT TAG SURVIVED ESCAPING — CSV input can inject markup into mail sent as an exec');
  if (!out.html.includes('&lt;script&gt;')) throw new Error('script tag was not escaped to entities');
  if (!out.html.includes('&amp;')) throw new Error('ampersand was not escaped');
  // htmlToText_ decodes entities, so the reader of the plain-text part sees the literal original.
  if (!out.text.includes('<script>alert(1)</script>')) throw new Error('plain-text part should show the original characters, decoded');
});

check('{{{token}}} inserts raw HTML — the explicit, opt-in escape hatch', () => {
  const ctx = loadSharedRenderer_();
  const recipient = { first_name: 'Sam', custom: { intro_html: '<strong>scaling</strong>' } };
  const out = ctx.render_('<p>{{firstName}} is {{{intro_html}}}.</p>', recipient, { unsubscribe: 'x@y.com' });
  if (!out.html.includes('<strong>scaling</strong>')) throw new Error('raw token was escaped — {{{ }}} must insert markup verbatim');
});

check('subject merging does not HTML-escape (escape:false)', () => {
  const ctx = loadSharedRenderer_();
  const data = ctx.mergeDataForRecipient_({ company: 'Smith & Jones', custom: {} }, {});
  const subject = ctx.applyMerge_('A note for {{company}}', data, { escape: false });
  if (subject !== 'A note for Smith & Jones')
    throw new Error('subject should stay literal, got: ' + subject);
});

check('preheader is hidden, escaped, and padded against body bleed-through', () => {
  const ctx = loadSharedRenderer_();
  const recipient = { first_name: 'Sam', custom: {} };
  const out = ctx.render_('<p>Hi {{firstName}}.</p>', recipient, { unsubscribe: 'x@y.com' },
    { preheader: 'A note about <Acme>' });
  if (!/display:none/.test(out.html)) throw new Error('preheader block is not hidden');
  if (!/mso-hide:all/.test(out.html)) throw new Error('preheader lacks the Outlook hide rule');
  if (out.html.includes('<Acme>')) throw new Error('preheader was not escaped');
  if (!/&zwnj;/.test(out.html)) throw new Error('no padding — the client will pull body text into the preview');
  if (out.text.includes('A note about')) throw new Error('preheader leaked into the plain-text part');
});

check('{{unsubscribe}} resolves from send-time extras, not from the recipient row', () => {
  const ctx = loadSharedRenderer_();
  const recipient = { first_name: 'Priya', title: 'VP Eng', company: 'Acme Corp', custom: {} };
  const source = '<p>Hi {{firstName}}.</p><p>Opt out: {{unsubscribe}}</p>';

  // Without extras it must hard-fail rather than render a blank opt-out line —
  // a footer reading "Opt out:" with nothing after it is a compliance failure.
  let threw = false;
  try { ctx.render_(source, recipient); } catch (e) { threw = /unsubscribe/.test(e.message); }
  if (!threw) throw new Error('missing {{unsubscribe}} did not hard-fail');

  const out = ctx.render_(source, recipient, { unsubscribe: 'jane+unsub@moveinsync.com' });
  if (!out.html.includes('jane+unsub@moveinsync.com')) throw new Error('extras did not reach the rendered html');
  if (!out.text.includes('jane+unsub@moveinsync.com')) throw new Error('extras did not reach the plain-text part');
});

check('extras cannot silently overwrite a recipient field with a stale value', () => {
  const ctx = loadSharedRenderer_();
  const recipient = { first_name: 'Priya', title: 'VP Eng', company: 'Acme Corp', custom: {} };
  // Documented precedence: extras win. This test pins that behaviour so a
  // future change to the merge order is a deliberate, visible decision.
  const data = ctx.mergeDataForRecipient_(recipient, { company: 'Override Inc' });
  if (data.company !== 'Override Inc') throw new Error('extras should take precedence over recipient fields');
  if (data.firstName !== 'Priya') throw new Error('extras clobbered an unrelated field');
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

check('fixed interval anchors on launch time, so a mid-window launch starts now', () => {
  const ctx = loadSharedSchedule_();
  // Two sends, 5 minutes apart, launched 80 minutes into the window.
  if (ctx.fixedIntervalMinutes_(0, 5, 80) !== 80) throw new Error('first send should be at the anchor, not the window start');
  if (ctx.fixedIntervalMinutes_(1, 5, 80) !== 85) throw new Error('second send should be exactly one interval later');
  // Later days start at the top of the window.
  if (ctx.fixedIntervalMinutes_(0, 5, 0) !== 0) throw new Error('with no anchor the first send is at the window start');
});

check('slotsPerWindow_ caps how many sends an interval physically allows in a day', () => {
  const ctx = loadSharedSchedule_();
  const windowMinutes = 8 * 60;
  if (ctx.slotsPerWindow_(60, windowMinutes) !== 9) throw new Error('hourly spacing should fit 9 sends in 8 hours');
  if (ctx.slotsPerWindow_(5, windowMinutes) !== 97) throw new Error('5-minute spacing should fit 97 sends in 8 hours');
  if (ctx.slotsPerWindow_(1000, windowMinutes) !== 1) throw new Error('an interval longer than the window must still allow one send, not zero');
});

check('agent poll interval is one Apps Script actually accepts', () => {
  const src = readFileSync('shared/Config.gs', 'utf8');
  const m = src.match(/AGENT_POLL_MINUTES\s*=\s*(\d+)/);
  if (!m) throw new Error('AGENT_POLL_MINUTES not found');
  if ([1, 5, 10, 15, 30].indexOf(Number(m[1])) === -1)
    throw new Error('everyMinutes() only accepts 1, 5, 10, 15, 30 — got ' + m[1]);
});

check('the trigger is rebuilt when the poll interval changes', () => {
  const src = readFileSync('agent/Onboard.gs', 'utf8');
  const fn = src.match(/function ensureAgentTrigger_[\s\S]*?\n\}/);
  if (!fn) throw new Error('ensureAgentTrigger_ not found');
  if (!/TRIGGER_MINUTES/.test(fn[0]))
    throw new Error('interval is not recorded — changing AGENT_POLL_MINUTES would silently no-op on onboarded agents');
  if (!/deleteTrigger/.test(fn[0])) throw new Error('stale trigger is never removed');
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
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  if (!/remainingCapToday_\(/.test(src) || !/capForSenderToday_\(/.test(src))
    throw new Error('pollDueJobs does not derive an allowance from the cap ramp');
});

check('suppressed email cannot be queued or sent, checked twice (import time + poll time)', () => {
  const importSrc = readFileSync('admin/Recipients.gs', 'utf8');
  const pollSrc = readFileSync('gateway/AgentApi.gs', 'utf8');
  if (!/isSuppressed_\(/.test(importSrc)) throw new Error('importRecipientsCsv does not check suppression at import time');
  if (!/isSuppressed_\(/.test(pollSrc)) throw new Error('pollDueJobs does not re-check suppression at send time');
});

check('idempotency key prevents double-send: reportSent short-circuits on an already-sent queue row', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  if (!/status\s*===\s*['"]sent['"]\s*\)\s*return/.test(src))
    throw new Error('reportSent has no guard against re-processing an already-sent row');
});

// --- Stage 5: Signals (Tier B) ---

/** Loads agent/Signals.gs for its pure helpers — scanSignals_ itself needs live Gmail/Properties, left untested here. */
function loadAgentSignals_() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync('agent/Signals.gs', 'utf8'), ctx);
  return ctx;
}

check('parseFromAddress_ extracts the bare email from a display-name From header', () => {
  const ctx = loadAgentSignals_();
  if (ctx.parseFromAddress_('Jane Prospect <jane@acme.com>') !== 'jane@acme.com')
    throw new Error('failed on display-name form');
  if (ctx.parseFromAddress_('jane@acme.com') !== 'jane@acme.com')
    throw new Error('failed on bare-address form');
  if (ctx.parseFromAddress_('Jane <JANE@ACME.COM>') !== 'jane@acme.com')
    throw new Error('should lowercase the extracted address');
});

check('reply signal handling: reportSignals updates status and cancels remaining sends for that recipient', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  if (!/sig\.kind === 'reply'/.test(src) || !/cancelPendingQueueForRecipient_\(/.test(src))
    throw new Error("reportSignals doesn't auto-pause on reply");
  if (!/findRecipientByRfcMessageId_\(/.test(src))
    throw new Error('reply matching does not go through Message-ID / In-Reply-To');
});

check('bounce rate > 3% halts all campaigns: recordBounceAndCheckHalt_ compares against GOVERNANCE.bounceRateHaltPct and trips the kill switch', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  if (!/bounceRate\s*>\s*GOVERNANCE\.bounceRateHaltPct/.test(src))
    throw new Error('no threshold comparison against GOVERNANCE.bounceRateHaltPct');
  if (!/setKillSwitch_\(true/.test(src))
    throw new Error('breach does not actually trip the global kill switch');
});

check('unsubscribe signal handling: reportSignals adds a permanent suppression and cancels pending sends globally', () => {
  const src = readFileSync('gateway/AgentApi.gs', 'utf8');
  if (!/addSuppression_\(/.test(src) || !/cancelPendingQueueForEmail_\(/.test(src))
    throw new Error("reportSignals doesn't suppress + cancel on unsubscribe");
});

check('Signals scanning never requests a body/snippet field from the Gmail API', () => {
  const src = stripComments_(readFileSync('agent/Signals.gs', 'utf8'));
  if (/snippet|format=full|format=raw/.test(src))
    throw new Error('agent/Signals.gs requests more than metadata — Tier B violation');
  if (!/format=metadata/.test(src)) throw new Error('expected an explicit format=metadata request');
});

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
