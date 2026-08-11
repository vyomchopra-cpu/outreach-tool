# Architecture

## 1. Why pull, not push

Three ways to send mail as someone else in a Google Workspace:

### Rejected — Domain-wide delegation
One service account, impersonating any user. Fastest to build; wrong.
It grants the central service the standing ability to impersonate **any mailbox in
the domain**, needs a super-admin to install, and there is no technical answer to
"what stops your service from reading my mail?" other than "our word." The whole
product is the answer to that question. Rejected on trust grounds, not effort.

### Rejected — Central token vault
Execs OAuth into a central service which stores refresh tokens with `gmail.send`.
Scope-wise honest, but it creates a single high-value credential store: one breach
compromises every exec's send capability, and someone must be trusted to hold it.
Also drags in external hosting, a secrets manager, and a real pen-test surface.

### Chosen — Per-account pull agent
Each exec installs a small Apps Script that runs **inside their own account** on a
5-minute time trigger. It asks the central system "anything due for me?", sends,
and reports status back.

- The token is minted in their account and never leaves it. Nothing to steal centrally.
- Scopes are visible and verifiable by the exec at install time.
- Revocation is instant and unilateral — they disable the trigger or revoke access,
  and the tool is powerless. No admin involvement, no negotiation.
- Everything stays inside Workspace: no external hosting, no data egress, trivial
  IT review.

**Trade-off, stated:** send times are accurate to ±5 minutes. Since spacing is
~24 minutes with deliberate jitter, this is invisible — and the jitter is a
deliverability asset, not a defect.

**Pilot scale:** v1 launches with 1–2 exec mailboxes, not five. At a 20/day
steady-state cap that means 100 recipients takes 3–5 business days to clear
per exec, not one. `SENDER_POOL` is a config array from day one specifically
so growing the pool later is a config change, not a rebuild — but the pilot
admin UI must show projected multi-day completion honestly rather than implying
same-day delivery.

---

## 2. Components

Three Apps Script projects, not two — the split described in "Agent-API Gateway" below was forced
by something discovered empirically during pilot deployment, not planned
from the start. Read §3 before assuming the original two-project design
still holds.

### Admin Console — `admin/`
Apps Script web app. Deployed **Execute as: user accessing the web app**
(`USER_ACCESSING`), access **Anyone within moveinsync.com** (`DOMAIN`).
`Session.getActiveUser()` reflects the real human visiting the console, so
the actual gate is entirely in code — `isAuthorizedAdmin_` + `ADMIN_ALLOWLIST`
in `doGet` — but `DOMAIN` restriction is a real second layer on top of that,
not just decoration, and there's no longer any reason to loosen it: this
deployment handles **only** human browser traffic. It has no `doPost` and
never talks to agents directly (see "Agent-API Gateway" below) — that traffic
was the one thing `DOMAIN` broke, and it no longer lands here.

- Campaign builder — subject, HTML body, merge tags, sender pool selection
- Recipient import — CSV → validate → dedupe → suppression check
- Preflight and seed-send gate
- Live queue view, canary gate, kill switch
- Read-only exec dashboards

### Agent-API Gateway — `gateway/`
A small, second Apps Script web app whose only job is receiving `doPost`
calls from sender agents ("Sender Agent" below) and relaying them to the
Store. Deployed **Execute as: Me** (`USER_DEPLOYING` in the manifest —
Apps Script's raw enum name for what the UI calls "Me"), access
**Anyone, even anonymous** (`ANYONE_ANONYMOUS`).

This project, and its unusually open access setting, exist because of a
real failure mode diagnosed empirically against the live deployed
projects — not a preference. Three things were tried, in order, each
confirmed or ruled out by direct `curl` testing (bypassing the agent
entirely) rather than guesswork:

1. **`admin/` deployed `USER_ACCESSING` + `DOMAIN`, agent sends a Bearer
   token.** Rejected — a bare `WWW-Authenticate: Bearer` 401 from Google's
   own front door, before the script ever ran, even for a token belonging
   to the same person who owns both projects.
2. **Loosened to `ANYONE`, still `USER_ACCESSING`, still a Bearer token.**
   Same rejection. The same exact call, replayed with a token from a
   verified, widely-trusted OAuth client (`clasp`'s own) instead of the
   agent's auto-generated one, succeeded end-to-end — proving the admin
   side of the pipe was fine, and the problem was specific to the agent's
   token itself, not the receiving deployment's settings.
3. **Split into `gateway/`, `USER_DEPLOYING`, still a Bearer token.** Same
   rejection again — ruling out `USER_ACCESSING` vs `USER_DEPLOYING` as the
   variable. This pointed at the token itself: it carries
   `gmail.send`/`gmail.settings.basic`/`gmail.metadata`, scopes Google
   classifies as sensitive/restricted, and a token holding restricted
   scopes appears to be rejected outright when used to authenticate to a
   *different* Google service, regardless of that service's own settings.
   (Plausible Workspace-policy explanation, not independently confirmed —
   diagnosing further needs super-admin access to Workspace API Controls,
   which wasn't available.)

**The actual fix, confirmed working:** `agent/CentralClient.gs` sends no
Authorization header at all. `gateway/` is deployed `ANYONE_ANONYMOUS` so no
Google auth layer is required to reach `doPost` in the first place. Verified
directly: a plain, unauthenticated `curl` POST reached `doPost` and got a
real `200 OK` JSON response.

**The honest trade-off:** with zero Google auth layer, authentication for
this surface is **entirely secret-based** — a 144-bit random value generated
at onboarding, hashed at rest (`Senders.secret_hash`), checked by
`requireSender_` in `gateway/AgentApi.gs`. `Session.getActiveUser()` inside
a `USER_DEPLOYING` script also always returns the deploying admin, never the
real caller, so identity cross-checking was never available here either way.
Because *anyone on the internet* can now reach `registerSender` (the one
function with no existing secret to check yet), `registerSender` additionally
requires the claimed email to appear in `SENDER_POOL` (`shared/Config.gs`,
admin-controlled) — this doesn't verify the caller, but narrows "squat an
arbitrary email" down to "squat one of a small, admin-chosen set." Accepted
because: (a) this surface can only poll for pre-approved work and report
status/signals — it cannot create, edit, or launch a campaign, that stays
entirely behind the admin console's own untouched, fully identity-gated
`DOMAIN`-restricted deployment; (b) the secret is high-entropy, transmitted
only over HTTPS to one endpoint, never logged; (c) the alternative (giving
up on machine-to-machine calls entirely, or reverting to domain-wide
delegation) was worse on every other axis.

`gateway/Store.gs` and `gateway/AgentApi.gs` are synced copies —
`admin/Store.gs` and (canonically) `gateway/AgentApi.gs` itself are the
sources of truth; see `scripts/sync-shared.sh`.

### Sender Agent — `agent/`
Standalone Apps Script, distributed as a **private Google Workspace Marketplace
app** (internal only). Same distribution discipline as the rewriter: install via
the official link, never a manual copy, so updates actually reach people.

Onboarding, on first authorisation:
1. Creates labels `Outreach/Replies`, `Outreach/Bounces`, `Outreach/Unsubscribes`
2. Creates the three Gmail filters (see §4)
3. Creates the 5-minute time trigger
4. Registers itself with the central system

Every tick:
1. Check kill switch → if set, do nothing
2. Check window, business day, daily cap → if any fails, do nothing
3. Fetch due jobs → render → send via Gmail REST → report status
4. Scan `Outreach/*` label IDs for new message headers → report reply/bounce/unsub

### Central Store — `admin/Store.gs` (canonical), synced into `gateway/Store.gs`
Google Sheet for v1. All reads and writes go through `Store.gs` — **no other file
touches the Sheet API**. That single constraint is what makes a later move to
Firestore a one-file change (times the number of projects with a synced copy)
rather than a rewrite.

Concurrency: `LockService.getScriptLock()` around every queue mutation. Each queue
row carries an idempotency key; the agent will not send a row already marked sent,
even if it sees it twice.

---

## 3. Authentication between agent and central

The agent calls `gateway/`, not `admin/`, and sends **no Authorization
header at all** — see "Agent-API Gateway" above for the full empirical
diagnosis of why (short version: a Bearer token carrying the agent's
restricted Gmail scopes was rejected authenticating to any other Google
service in this Workspace, regardless of the receiving deployment's
settings; removing the header and deploying `gateway/` as
`ANYONE_ANONYMOUS` was the combination that actually worked, confirmed via
direct `curl` testing against the live projects).

The consequence: authentication for this surface is **secret-only**, not
identity + secret as originally designed. A per-exec shared secret, issued
at onboarding (`registerSender`), hashed at rest, is the entire authentication
factor for `gateway/AgentApi.gs`'s `requireSender_`, plus the `SENDER_POOL`
allowlist guard on `registerSender` specifically (see "Agent-API Gateway"
above). This is a genuine, documented trade-off — not the two-factor design
this section originally described before the gateway split.

---

## 4. Reply routing without read access

Handled entirely by Gmail, using `gmail.settings.basic`. We never read anything.

Every campaign message carries a single, **fixed** `Reply-To: <exec>+o@moveinsync.com` —
not a per-campaign tag. Gmail filter criteria match a literal `to:` string,
not a wildcard/prefix, so a per-campaign suffix (`+o<campaignId>@`) would need
one filter created per campaign, which doesn't scale and isn't how the
onboarding filters (created once, at agent install) are built. Campaign
attribution for a reply comes from matching its `In-Reply-To` header against
`Queue.sent_message_id` (see `docs/SCHEMA.md` `Signals.in_reply_to`) — that
match is exact and per-message already, so the plus-tag doesn't need to carry
the campaign id too.

**Timezone mode is chosen per campaign** (`Campaigns.tz_mode`, see
`docs/SCHEMA.md`) — `sender` runs the whole campaign on the exec's own 9–5;
`recipient` schedules each recipient inside their own 9–5 using
`Recipients.recipient_tz`, required on import when this mode is selected.
Scheduling math always happens once, at queue-build time, producing a UTC
`due_at_utc` — never recomputed at read time.

| Filter | Criterion | Action |
|---|---|---|
| Replies | `to: exec+o@moveinsync.com` | Label `Outreach/Replies` |
| Bounces | `from: mailer-daemon@googlemail.com` | Label `Outreach/Bounces` |
| Unsubs | `to: exec+unsub@moveinsync.com` | Label `Outreach/Unsubscribes`, skip inbox |

Replies arrive pre-sorted into the exec's sidebar. Gmail did the sorting.

**Known limits, accepted:**
- Gmail filters cannot match custom headers — plus-addressing is the only
  mechanism. It works, and it gives free per-campaign routing as a bonus.
- **Filters never apply to the Sent folder.** Campaign sends will appear in the
  exec's Sent. Unavoidable at minimal scope, and arguably correct: it is
  genuinely their mail, sent in their name, and they should see it.

---

## 5. What Tier B (`gmail.metadata`) does and does not allow

**Allowed:** `users.messages.list` by `labelIds`, and `users.messages.get` with
`format=metadata` returning `From`, `To`, `Subject`, `Message-ID`, `In-Reply-To`,
`References`, `Date`, label IDs, thread IDs.

**Not allowed, by Google, not by us:** message body, `snippet`, attachments — and
**the `q` search parameter is rejected under this scope**. The agent must page by
`labelIds` and a stored `historyId` watermark. Any implementation that reaches for
`q` will fail at runtime; this is the most likely Sonnet mistake in the build.

This buys exactly four things, which are the four that make outreach viable:

1. **Auto-pause on reply** — matches `In-Reply-To` against sent `Message-ID`,
   halts every remaining follow-up for that recipient. Without this, follow-up #2
   fires at someone who already said "please stop." That is the incident Tier A
   could not prevent, and the whole reason Tier B is worth one more scope line.
2. **Bounce detection** — feeds the 3% auto-halt circuit breaker.
3. **Unsubscribe honouring** — `From` header out of the Unsubscribes label →
   permanent global suppression. Compliant unsubscribe with zero read access.
4. **Honest dashboard numbers** — reply and bounce *counts*, never content.

---

## 6. Failure behaviour

| Failure | Behaviour |
|---|---|
| Exec revokes access | Agent auth fails → sender marked offline → admin alerted → queue reassigns to pool |
| Agent trigger deleted | Central sees no heartbeat for 30 min → sender marked stale → alert |
| Central Sheet unreachable | Agent sends nothing. Fails closed, always. |
| Send returns 4xx | Row marked failed with reason, no retry (bad address stays bad) |
| Send returns 5xx / quota | Exponential backoff, max 3 attempts, then failed |
| Bounce rate > 3% | **All campaigns halt**, all senders, admin alert. Manual release only. |
| Kill switch set | Every agent stops at its next tick, within 5 minutes |

The bias everywhere is **fail closed**. An outreach tool that sends when confused
is worse than one that stops.
