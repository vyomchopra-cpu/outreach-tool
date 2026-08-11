# Build order

Read `README.md` (hard rules) and `docs/ARCHITECTURE.md` before touching code.
Each stage should be independently testable before moving on — do not build
the sender agent against a store that hasn't been exercised by hand first.

## Stage 0 — Store
- `admin/Store.gs`: bootstrap all tabs from `docs/SCHEMA.md` column order
- Manual test: create a campaign row, a recipient row, read them back
- Nothing else may touch `SpreadsheetApp` — enforce by only importing `Store.gs`

## Stage 1 — Renderer + merge engine
- `shared/Renderer.gs`: single `render(bodySource, mergeData) -> {html, text}`
- `shared/MergeEngine.gs`: `{{firstName}}` substitution, hard-fails on missing token
- Test against the 6-client seed matrix by hand before wiring anything else to it

## Stage 2 — Admin console skeleton
- `admin/Code.gs`: `doGet`/`doPost`, domain + allowlist check
- `admin/Campaign.gs`: create/edit campaign, uses Stage 0 + Stage 1
- Preview pane renders via the *same* `Renderer.gs` — no second implementation

## Stage 3 — Preflight + seed send
- `admin/Preflight.gs`: merge-tag check, spam-word lint, link check, size check
- Seed send to the 6-mailbox matrix (Gmail web/iOS/Android, Outlook desktop/web, Apple Mail)
- Campaign cannot leave draft without a seed pass within 24h

## Stage 4 — Sender agent, one exec
- `agent/appsscript.json`: scopes pinned to `gmail.send`, `gmail.settings.basic`,
  `gmail.metadata` — nothing else
- `agent/Onboard.gs`: labels, filters, trigger, registration
- `agent/Sender.gs`: poll → window/cap check → send via REST → report
- Pilot with one real exec mailbox, canary of 5, before anything else

## Stage 5 — Signals (Tier B)
- `agent/Signals.gs`: scan `Outreach/*` labels, metadata-only fetch, report
- Reply auto-pause, bounce feed into `Health`
- Verify by hand: reply from a seed account, confirm follow-up is cancelled
  and confirm no body ever appears in `Signals` or in logs

## Stage 6 — Governance
- Daily cap ramp, auto-halt on bounce/complaint rate, kill switch
- `docs/DATA_RETENTION.md`, `docs/EXEC_CONSENT.md`

## Stage 7 — Second sender, scheduling modes
- Add a second exec to `SENDER_POOL`, confirm round-robin + sticky assignment
- Exercise both `tz_mode` paths against real recipient data

## Stage 8 — QA harness + release discipline
- `test/qa.mjs` codifies every check above as an assertion
- Version bump in 3 places, staging deploy, `clasp push`, redeploy existing
  deployment (never a new one)

Do not skip stages to get to a demo faster. The store and renderer are shared
by everything downstream — a shortcut there gets rebuilt twice.
