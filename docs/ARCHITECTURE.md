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

### Admin Console — `admin/`
Apps Script web app. Deployed **Execute as: user accessing the web app**, access
**Anyone (with a Google account)** — deliberately not domain-restricted at the
deployment layer. A `DOMAIN`-restricted deployment rejects server-to-server
Bearer-token calls (the agent calling the admin web app, §3) at Google's front
door before the script runs, even for a same-domain, same-person token — this
was discovered the hard way during pilot setup. Since `executeAs` is
`USER_ACCESSING`, `Session.getActiveUser()` reflects the real caller regardless
of the access setting, so the actual gate is entirely in code:
`isAuthorizedAdmin_` + `ADMIN_ALLOWLIST` for the console (`doGet`), and
`requireSender_` for the agent API (`doPost`, `admin/AgentApi.gs`). The
deployment's `access` setting is not a security boundary here — it never was
meant to be one, since it can't distinguish "admin" from "agent" callers
anyway; both hit the same `/exec` URL.

- Campaign builder — subject, HTML body, merge tags, sender pool selection
- Recipient import — CSV → validate → dedupe → suppression check
- Preflight and seed-send gate
- Live queue view, canary gate, kill switch
- Read-only exec dashboards

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

### Central Store — `admin/Store.gs`
Google Sheet for v1. All reads and writes go through `Store.gs` — **no other file
touches the Sheet API**. That single constraint is what makes a later move to
Firestore a one-file change rather than a rewrite.

Concurrency: `LockService.getScriptLock()` around every queue mutation. Each queue
row carries an idempotency key; the agent will not send a row already marked sent,
even if it sees it twice.

---

## 3. Authentication between agent and central

The agent calls the central web app with
`Authorization: Bearer ScriptApp.getOAuthToken()`. Central resolves the caller via
`Session.getActiveUser().getEmail()` — reliable within the same Workspace domain —
and checks it against the registered sender list.

A per-exec shared secret, issued at onboarding, is sent alongside as defence in
depth. Identity comes from Google; the secret only guards against a
misconfigured deployment.

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
