# Release process

The mechanical steps for shipping a change. Nothing here needs judgment
calls — that's the point. If a step feels like it needs one, the process
has a gap; fix the process, don't route around it.

## The two version markers

Every release bumps both, together, to the same value:

- `package.json` → `"version"`
- `shared/Config.gs` → `AGENT_VERSION`

They drifted once already (`0.1.0` vs `0.2.0` while the real state was
`0.8.0`) — `test/qa.mjs` now pins them equal, so a mismatch fails the build
instead of sitting unnoticed. `AGENT_VERSION` is also what shows up in the
Health tab's per-sender row and in `Senders.agent_version` — it's how you
tell whether a given exec's agent actually picked up the latest push.

## Before every release

```bash
node test/qa.mjs
```

Must be 100% green. This is not a formality — every check exists because
something real broke and got pinned so it couldn't break silently again.
Read `test/qa.mjs`'s comments if you want the specific incident behind any
given check.

## Shipping

1. **Bump both version markers** (above) to the same value.
2. **Add a `CHANGELOG.md` entry** — newest at the top, under `## [x.y.z] —
   YYYY-MM-DD`. Write it for someone using the console, not someone reading
   the diff: "what changed for you," not "what changed in the code."
3. **Sync shared code into every project that needs it:**
   ```bash
   ./scripts/sync-shared.sh
   ```
   `shared/*.gs` and `admin/Store.gs` are canonical; this copies them into
   `admin/shared/`, `agent/shared/`, `gateway/shared/`, and
   `gateway/Store.gs`. Skipping this step is the single most common way a
   fix "doesn't show up" after a push.
4. **Push and redeploy each project that changed** — admin, gateway, agent,
   or all three:
   ```bash
   cd admin && npx clasp push --force && npx clasp deploy --deploymentId <admin-id> --description "vX.Y.Z — one line"
   cd ../gateway && npx clasp push --force && npx clasp deploy --deploymentId <gateway-id> --description "vX.Y.Z — one line"
   cd ../agent && npx clasp push --force && npx clasp deploy --deploymentId <agent-id> --description "vX.Y.Z — one line"
   ```
   **Always the existing `--deploymentId`.** A bare `clasp deploy` with no
   ID creates a brand-new deployment at a brand-new URL — the admin console
   would silently stop being the one anyone has bookmarked, and every
   agent's `CENTRAL_WEBAPP_URL` would point at a now-dead endpoint. This is
   README hard rule 7 for a reason: it already happened once during
   deployment, and finding it again cost real time.

   Current deployment IDs live in `docs/HANDOFF.md`.
5. **If the Sheet schema changed** (a new tab or column in
   `admin/Store.gs`'s `SCHEMA`), re-run `?bootstrap=1` on the admin URL once.
   Idempotent, safe to run even when nothing changed.
6. **Commit, then push:**
   ```bash
   git add -A
   git commit -m "vX.Y.Z — one line, same spirit as the changelog entry"
   git push
   ```

## Rollback

There's no single "undo." To revert a bad release:

1. `git log --oneline` to find the last-known-good commit.
2. `git checkout <good-commit> -- <affected-paths>` (or a full revert commit
   — never `git reset --hard` on shared history).
3. Re-run steps 3–4 above (sync, push, redeploy) for whichever project(s)
   regressed, same existing deployment IDs.
4. Add a `CHANGELOG.md` entry for the rollback itself — it's a real change
   from the user's perspective, document it like one.

## Commit message shape

Follow what's already in the log: a one-line summary starting with the
version, then paragraphs explaining **why**, not a restatement of the diff.
Name the specific incident or reasoning behind any non-obvious decision —
"why" is what a future reader (including future you) actually needs; the
diff already shows "what."

## What QA won't catch

`test/qa.mjs` runs entirely in Node, against source text and sandboxed
logic — it cannot open the real console or send real mail. After a release
that touches sending, scheduling, or the UI, run the relevant section of
`docs/TEST_PLAN.md` for real. QA passing means the code is internally
consistent; it does not mean a human has seen it work.
