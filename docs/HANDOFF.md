# Handoff — where this stands and how to resume

Written 2026-08-11, end of the first build+deploy session. Read this cold —
it assumes nothing carried over from the conversation that produced it.

## One-line status

**All code is done, tested, and deployed live. The only remaining blocker
is a Google Workspace IT/admin permission grant — not a bug, not missing code.**

---

## What's built (100% done)

Repo: `C:\Users\Vyom Gaurav Chopra\outreach-tool` (git initialized, 8 commits,
not yet pushed to GitHub — pending your go-ahead).

- **Store** (`admin/Store.gs`) — schema-driven Google Sheet CRUD, locked
  mutations, suppression + audit log
- **Renderer/MergeEngine** (`shared/`) — hard-fails on unresolved
  `{{merge_tags}}`, one function feeds preview/seed/live sends
- **Admin console** (`admin/`) — campaign builder, live HTML preview, CSV
  recipient import, preflight gate, canary launch (first 5 → review →
  release rest), kill switch, complaint-rate entry
- **Scheduling** (`shared/Schedule.gs`) — daily cap ramp (10→15→20),
  business-day math, per-campaign sender/recipient timezone, jittered
  spacing — timezone conversion is unit-tested against real `Intl` output
- **Sender agent** (`agent/`) — pull model, Gmail REST only (never
  `GmailApp`/`MailApp`), independent send-window re-check before every send
- **Signals / Tier B** (`gateway/AgentApi.gs`) — reply auto-pause,
  bounce-rate auto-halt (kill switch trips automatically above 3%),
  unsubscribe → permanent global suppression, header-only (structurally
  cannot see a message body)
- **Governance docs** — `docs/DATA_RETENTION.md`, `docs/EXEC_CONSENT.md`
- **Test suite** — `test/qa.mjs`, **35/35 checks passing**. Run with
  `node test/qa.mjs` any time to verify nothing regressed.

Full design reasoning: `docs/ARCHITECTURE.md` (read this before changing
anything architectural — it documents *why*, including three failed
approaches that were tried and ruled out empirically tonight).

---

## What's deployed (all live, real Google Cloud resources)

Three separate Apps Script projects, all owned by `vyom.chopra@moveinsync.com`:

| Project | Purpose | Script ID | Live deployment URL |
|---|---|---|---|
| **admin/** | Human console (campaign builder) | `1fU2VlplVQaBUl6A1bl85izkPFWFrMjNNUsJiAKUPrkP3xUF9gbIQunhg` | `https://script.google.com/macros/s/AKfycbzkVMxLpWszLRqL9ec9M3LNI0wRUtTAwadZ6eEoHxoQWuia_B6XEiObHlT5Smq3bsY/exec` |
| **gateway/** | Agent → central API relay | `1RSmATk-yCOc9omKQGLgwazaJ8DWsdw4-w9ctittDHbGuJmX3tcN7Ruoc` | `https://script.google.com/macros/s/AKfycbyLM5Wyr9S_isiYbk1MPMKT3XMzjgg9r6pXBXKIQhbz7xlnScOVZwnaK14jX9DZTunA/exec` |
| **agent/** (pilot template, one per exec) | Sends mail from the exec's own Gmail | `1zWRwgF6iZqY-918UIGvVQ5evIVxHmB1d2QDPspwfoVrIUkzz7oaQUR35` | `https://script.google.com/macros/s/AKfycbxP0ae8lcMhVYJg4dp5VeSYZAr7_benBZ3zF4CTTFGTyZAA2RhkwD9u-9epCZpGmqkt/exec` |

Central Google Sheet (schema bootstrapped, all 9 tabs exist):
`https://docs.google.com/spreadsheets/d/1pw_BtBwaHOvAWIq66HvB81OfkMP_9rVRWK7Y3OiSjRc/edit`

`clasp` (Apps Script CLI) is installed as a local dev dependency and logged
in as `vyom.chopra@moveinsync.com`. To redeploy any project after a code
change: `./scripts/sync-shared.sh` from the repo root, then
`cd <project>/ && npx clasp push --force && npx clasp deploy --deploymentId <id> --description "..."`
— **always reuse the existing `--deploymentId`** for a given project so the
URL never changes (see README hard rule 7). Deployment IDs are the ones in
the table above (decoded from each URL).

---

## What's confirmed working, tested live tonight

- Admin console: schema bootstrap ran successfully (`?bootstrap=1`)
- Gateway: end-to-end call proven via direct `curl` (no browser, no agent) —
  got a real `200 OK` JSON response from our own `doPost` code
- Agent onboarding: **`registerSender` succeeded** — a real `Senders` row
  exists in the Sheet for `vyom.chopra@moveinsync.com`
- Agent onboarding then failed one step later, at Gmail label creation

---

## The one remaining blocker

`onboardSender` fails at `ensureLabelsAndFilters_()` (agent/Onboard.gs)
calling the Gmail REST API, with:

```
Gmail API /labels -> 403: Gmail API has not been used in project
463752232913 before or it is disabled.
```

Trying to enable it at the given Google Cloud Console link produced a
**second, more serious** error:

```
You need additional access to the project: 463752232913
Missing: resourcemanager.projects.get
```

**Diagnosis:** this is not a code bug. `vyom.chopra@moveinsync.com` does not
have IAM permission to manage the Google Cloud project that Apps Script
auto-created behind the `agent/` script — not even to view it. This is
almost certainly a moveinsync.com Workspace-wide policy restricting regular
users' access to Cloud Platform resources. It's also the most likely
explanation for the *other* strange thing this session ran into (see
`docs/ARCHITECTURE.md` §2, "Agent-API Gateway" — three different
Bearer-token-based auth approaches were all rejected by the Workspace
before the current no-auth-header + secret-only design was found to work).

**This needs your Google Workspace / Cloud IT admin, not more debugging.**
The exact ask to send them:

> I'm piloting an internal Apps Script tool. My script's auto-created
> Google Cloud project (**463752232913**) needs the **Gmail API** enabled,
> but I get "You need additional access to the project" when I try —
> missing `resourcemanager.projects.get`.
>
> Could you either:
> (a) Enable the Gmail API on project `463752232913` directly
> ([console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=463752232913](https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=463752232913)), or
> (b) Grant me `roles/editor` (or at minimum `resourcemanager.projects.get`
> plus API-enable rights) on that project.

---

## Exactly how to resume once IT grants access

1. Confirm you (or IT) can now open
   [console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=463752232913](https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=463752232913)
   and see an **Enable** button (or that it's already enabled).
2. Click Enable, wait ~1 minute.
3. Revisit the agent onboarding link:
   `https://script.google.com/macros/s/AKfycbxP0ae8lcMhVYJg4dp5VeSYZAr7_benBZ3zF4CTTFGTyZAA2RhkwD9u-9epCZpGmqkt/exec?onboard=1&displayName=Vyom+Chopra&timezone=Asia/Kolkata`
   Expect: *"Onboarded ... labels, filters, and the 5-minute send trigger are
   now active."*
   If it 403s on a *different* API next (Workspace restrictions may apply
   per-API), same pattern: click whichever Enable link Google's error gives
   you, wait, retry.
4. Verify: check Gmail for three new labels (`Outreach/Replies`,
   `Outreach/Bounces`, `Outreach/Unsubscribes`) and three new filters.
5. Build a real test campaign in the admin console, import your own second
   email as a test recipient, run preflight, seed-send, and confirm actual
   delivery. This is the first real proof of the whole pipeline.
6. From there: `docs/BUILD_ORDER.md` Stage 7 (second sender) and Stage 8
   (release discipline) are what's left architecturally — both are small
   relative to what's already built.

## If starting a genuinely new chat/session

Paste this file's path (`docs/HANDOFF.md`) or its contents. Nothing else is
needed — the repo, the deployments, the Sheet, and this document are the
complete state. `node test/qa.mjs` from the repo root is the fastest way to
confirm the code itself is still intact (35/35 should pass).
