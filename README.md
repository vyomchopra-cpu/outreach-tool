# MIS Outreach — internal email outreach tool

Schedule and send marketing outreach **from senior leaders' own Gmail accounts**, run by
2–3 admins, without the tool or the admins ever gaining read access to those inboxes.

Status: **v0.1.0 — spec + scaffold. Not yet implemented.**
Design by Opus, implementation by Sonnet. Read `docs/BUILD_ORDER.md` first.

---

## The promise, and why it is structural

> "We can send as you. We can never read your mail."

This is enforced by **OAuth scope**, not by policy. The sender agent holds
`gmail.send`, `gmail.settings.basic` and `gmail.metadata`. Message bodies and
snippets are not merely un-fetched — they are unavailable to the granted token.
An exec can verify this on the consent screen before clicking Allow.

If that promise ever weakens, the product is dead. Hence the hard rules below.

---

## Hard rules

These are the equivalent of the Gmail Rewriter's "never redeploy as Anyone" rule.
Breaking any of them is a release blocker, and `test/qa.mjs` fails the build.

1. **Never use `GmailApp` or `MailApp`.** `GmailApp` silently pulls the full
   `https://mail.google.com/` scope — read, compose, send *and permanently delete
   all your email* — which destroys the entire trust proposition on the consent
   screen. All sending goes through the Gmail REST API via `UrlFetchApp` +
   `ScriptApp.getOAuthToken()`, with scopes pinned in `appsscript.json`.
2. **Never add `gmail.modify`, `gmail.readonly`, or `https://mail.google.com/`.**
   No feature is worth it. If a feature seems to need it, the feature is wrong.
3. **No exec OAuth token is ever transmitted to, or stored by, the central system.**
   The token is minted inside the exec's account and used inside the exec's account.
   There is no credential of theirs for us to leak.
4. **Reply and message bodies are never fetched, stored, logged, or displayed.**
   Tier B sees envelope headers only.
5. **Every send is `multipart/alternative`** — a real `text/plain` part alongside
   the HTML, both generated from one source by one renderer.
6. **Sends outside the window or over cap are impossible, not discouraged.** The
   guard lives in the agent, at the moment of send, not only in the admin UI.
7. **Redeploy the existing Apps Script deployment.** A new deployment gets a new
   URL and reaches nobody.

---

## Architecture in one picture

```
Admin Console  (Apps Script web app, domain-locked + admin allowlist)
      │
      ▼
Central Sheet  campaigns · recipients · queue · events · suppression · senders
      ▲                                    │
      │ POST status, signals               │ GET due jobs  (5-min poll)
      │                                    ▼
Sender Agent  ── one per exec, runs INSIDE their Google account ──
      │        gmail.send · gmail.settings.basic · gmail.metadata
      ▼
  Gmail REST API
```

Pull, never push. The central system cannot send — it can only publish work that
an exec's own agent chooses to pick up. Full rationale, including why
domain-wide delegation was rejected, is in `docs/ARCHITECTURE.md`.

---

## Layout

```
admin/     Apps Script — console, campaign builder, preflight, store
agent/     Apps Script — per-exec sender agent, deployed via private Marketplace
shared/    Config, renderer, merge engine — synced into both projects
test/      qa.mjs — run before every release, same rule as gmail-rewriter
docs/      Architecture, schema, governance, deploy, exec consent
```

## Governing decisions (locked)

| Decision | Choice |
|---|---|
| Scope tier | **B** — `gmail.send` + `settings.basic` + `metadata` |
| Sending domain | **Primary corporate domain**, strict governance + auto-halt |
| Send window | 09:00–17:00, business days, sender- or recipient-local — chosen per campaign |
| Daily cap per mailbox | 10 → 15 → 20 ramp |
| Content | HTML + plain-text alternative, lightweight semantic HTML |
| Sender pool | 1–2 execs for pilot, config array — grows without code changes |
| Central store | Google Sheet behind `Store.gs`, swappable |

## QA

```bash
node test/qa.mjs
```

Must pass before every release. No exceptions, same as the rewriter.
