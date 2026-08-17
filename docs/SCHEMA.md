# Data model

Google Sheet, one tab per table. **Only `admin/Store.gs` may touch the Sheet API.**
Every other file goes through it. That single rule is what makes a later move to
Firestore a one-file change.

Column order below is authoritative — `Store.gs` bootstraps headers from it and
`test/qa.mjs` asserts they match.

---

## `Senders`

| Column | Type | Notes |
|---|---|---|
| `email` | string | Primary key. The exec's Workspace address. |
| `display_name` | string | Shown as the From name |
| `status` | enum | `active` · `paused` · `offline` · `revoked` |
| `ramp_start_date` | date | Drives the 10 → 15 → 20 cap ramp |
| `daily_cap_override` | int? | Admin escape hatch; may never exceed 20 |
| `timezone` | string | IANA, e.g. `Asia/Kolkata`. Used when campaign is sender-clock |
| `agent_version` | string | Reported each heartbeat; stale versions get flagged |
| `last_heartbeat` | datetime | No beat for 30 min → `offline` + alert |
| `secret_hash` | string | SHA-256 of the onboarding shared secret. Never the secret itself. |
| `consent_recorded_at` | datetime | See `docs/EXEC_CONSENT.md` |
| `capabilities` | json | Reported by the agent every heartbeat: transport in use, whether the Gmail API (and so reply detection) is reachable, remaining provider quota. Makes a degraded agent visible instead of inferred from missing `Signals` rows. |
| `sends_expire_at` | datetime? | When the window this person granted runs out. Set **only** by `gateway/AgentApi.gs` `approveDelegation`, from the delegator's own approval. No admin-side code may write a future value here — `test/qa.mjs` fails the build if any does. Blank = permanent, which only ever comes from self-onboarding. Checked live on every `pollDueJobs`/`heartbeat`, not cached. |
| `sends_granted_by` | string | Always the delegator themselves. It exists to make the audit trail state plainly that the person whose name is being used is the one who authorized it — never the operator who asked. |

## `Campaigns`

| Column | Type | Notes |
|---|---|---|
| `id` | string | `c47` style |
| `name` | string | |
| `status` | enum | `draft` · `preflight_passed` · `canary` · `running` · `paused` · `completed` · `halted` |
| `subject` | string | Merge tags allowed. Merged **unescaped** — it is plain text, so `&amp;` would be shown literally. |
| `preheader` | string | The grey preview line beside the subject. Own template, own merge tags. Rendered into a hidden, escaped, padded block; excluded from the plain-text part. |
| `body_source` | text | Single source of truth. Renderer produces both HTML and plain text from this. `{{token}}` is HTML-escaped; `{{{token}}}` inserts raw HTML. |
| `interval_minutes` | int? | Blank = auto-space the day's cap across the window with jitter. A number forces a fixed gap, anchored at launch time on day one. Capped by what the window physically fits. |
| `sender_pool` | csv | Sender emails assigned to this campaign |
| `tz_mode` | enum | `sender` · `recipient` — per-campaign, chosen in the builder |
| `send_window` | string | Default `09:00-17:00` |
| `created_by` / `created_at` | | |
| `exec_approved_by` / `exec_approved_at` | | Every named sender must approve before first send |
| `seed_passed_at` | datetime | Must be within 24h of launch or preflight fails |
| `canary_released_at` | datetime | Null until an admin releases the first 5 |
| `projected_completion` | date | Computed at launch, shown to the admin, stored for honesty |

## `Recipients`

| Column | Type | Notes |
|---|---|---|
| `id` | string | |
| `campaign_id` | string | |
| `email` | string | Lowercased, trimmed, validated at import |
| `first_name`, `last_name`, `company`, `title` | string | Merge sources |
| `recipient_tz` | string | IANA. Required when `tz_mode = recipient`. |
| `custom` | json | Extra merge fields |
| `assigned_sender` | string | Sticky — a prospect always hears from the same person |
| `status` | enum | `queued` · `scheduled` · `sent` · `replied` · `bounced` · `unsubscribed` · `suppressed` · `failed` |
| `status_reason` | string | |
| `verify_status` | string? | Reoon's classification (`safe`/`invalid`/`disposable`/…), set by `verifyRecipientsWithReoon`. Blank until checked — the feature is optional, unconfigured by default. |

## `Queue`

| Column | Type | Notes |
|---|---|---|
| `id` | string | |
| `campaign_id`, `recipient_id`, `sender_email` | | |
| `due_at_utc` | datetime | Always UTC in storage. Timezone maths happens at schedule time, never at read time. |
| `status` | enum | `pending` · `claimed` · `sent` · `failed` · `cancelled` |
| `attempts` | int | Max 3, exponential backoff, 5xx only |
| `idempotency_key` | string | Agent refuses to send a key already marked `sent` |
| `sent_message_id` | string | RFC `Message-ID`. Joined against `In-Reply-To` for reply matching. |
| `sent_at`, `error` | | |
| `tracking_id` | string? | Opaque per-send id for open/click tracking, minted at poll time and persisted so an open weeks later still resolves. Blank when tracking is off, and for seed and test sends. Never contains or encodes the recipient address. |

## `Signals`

Tier B output. **Headers only. A body value must never appear in this tab.**

| Column | Type | Notes |
|---|---|---|
| `ts`, `sender_email` | | |
| `kind` | enum | `reply` · `bounce` · `unsubscribe` |
| `gmail_message_id` | string | |
| `in_reply_to` | string | Matched against `Queue.sent_message_id` |
| `from_header` | string | The prospect's own address — already ours. Nothing new is learned. |
| `matched_recipient_id` | string? | Null when unmatchable |

## `Suppression`

Global and permanent. Checked at queue time **and again at send time**.

| Column | Type | Notes |
|---|---|---|
| `email` | string | Primary key |
| `reason` | enum | `unsubscribe` · `bounce_hard` · `manual` · `complaint` |
| `source` | string | Campaign id or admin email |
| `added_at` | datetime | |

Rows are never deleted. An unsubscribe is forever, across every campaign and
every sender.

## `Events`

Append-only. Never updated, never deleted. This is the audit log.

| Column | Notes |
|---|---|
| `ts` | |
| `actor` | Admin email, sender email, or `system` |
| `type` | `send` · `admin_action` · `config_change` · `halt` · `consent` · `onboard` · `revoke` |
| `campaign_id`, `recipient_id`, `sender_email` | Nullable |
| `detail` | JSON. **Never message content.** |

## `Health`

Daily rollup driven by a nightly trigger, plus manual Postmaster entry.

| Column | Notes |
|---|---|
| `date`, `sender_email` | |
| `sent`, `bounced`, `replied`, `unsubscribed` | |
| `bounce_rate` | Auto-halt above 3% rolling |
| `complaint_rate` | Entered from Google Postmaster Tools; auto-halt above 0.1% |

## `AccessGrants`

Time-boxed console access, granted from the Access tab rather than a code
change. `ADMIN_ALLOWLIST` (`shared/Config.gs`) is the separate, permanent list.

| Column | Type | Notes |
|---|---|---|
| `email` | string | Primary key. Must be `@REPLY_TO_DOMAIN` — enforced at grant time. |
| `display_name` | string | Derived from the local part; cosmetic only |
| `granted_by` | string | The admin who issued it |
| `granted_at` / `expires_at` | datetime | `expires_at` is checked on every request, not cached at sign-in |
| `revoked` | boolean | Set by `revokeAccess` — takes effect on the next request, not next login |
| `note` | string | Free text, why the grant was made |

## `Incidents`

Append-only detector output — see `admin/Monitor.gs`. Same file every other
tab goes through (`Store.gs`); nothing else may call `SpreadsheetApp` directly.

| Column | Type | Notes |
|---|---|---|
| `ts` | datetime | |
| `severity` | enum | `critical` · `warn` · `info` |
| `detector` | string | Which check fired — `kill_switch_on`, `stale_senders`, `queue_backlog`, `bounce_rate`, `unverified_risk`, `gcp_available` |
| `summary` / `detail` | string | Detail always names the specific next action, not just the symptom |
| `notified` | string | `chat` · `no channel configured` · `suppressed (cooldown)` |

## `Delegations`

"Let me send mail from your account for N days." The record of the tool's
central transaction — see `admin/Delegation.gs`. An operator raises the ask
here; the delegator decides it on their own agent page, signed in as
themselves (`agent/Approve.gs`). The live capability it produces lives on the
`Senders` row; this tab is the audit trail of how it got there.

| Column | Type | Notes |
|---|---|---|
| `id` | string | Primary key. `dg_` + short UUID. |
| `claim_token` | string | Unguessable, single-use, delivered only to the delegator. Overwritten with `used:<id>` the moment it is approved or denied — the link cannot be replayed. This is what lets the anonymous gateway trust an approval without a Google auth layer of its own. |
| `requested_by` | string | The operator asking. Never gains any authority from this row. |
| `delegator_email` | string | Whose name is being asked for. Must be `@REPLY_TO_DOMAIN` and must not equal `requested_by`. |
| `days_requested` | int | What was asked for, 1–365. Advisory only. |
| `reason` | string | Shown verbatim to the delegator when they decide. |
| `status` | enum | `pending` · `approved` · `denied` · `revoked` · `superseded` (a newer ask replaced it) |
| `created_at` | datetime | |
| `days_approved` | int? | What the delegator **actually** granted. May be fewer than requested; that is the normal case, not an error. |
| `approval_mode` | enum? | `blanket` · `per_campaign` — the delegator's own choice of how much oversight they want. |
| `decided_at` | datetime | |
| `revoked_by` / `revoked_at` | | Either an admin (`revokeDelegation`) or the delegator themselves (`revokeOwnDelegation`). Both only ever shorten access. |

## `Tracking`

Append-only open/click log — see `gateway/Tracking.gs`. Written by an
anonymously-reachable endpoint, so by design nothing here can do anything but
append a row.

Every row is one HTTP request from a mail client, **not** one human action:
image prefetching means a delivered message can produce several rows, or one
from a machine nobody ever read. Raw events are stored and interpretation is
left to `admin/Analytics.gs`, so a later change of mind about what counts as
an "open" applies to history rather than only to new data.

| Column | Type | Notes |
|---|---|---|
| `ts` | datetime | |
| `kind` | enum | `open` · `click` |
| `campaign_id`, `recipient_id`, `sender_email` | string | Resolved from `Queue.tracking_id`; never passed in the URL |
| `url` | string | Click destination. Blank for opens. |
| `user_agent` | string | Kept because it distinguishes a proxy prefetch from a person. Truncated to 300 chars. |
| `machine_suspected` | boolean | Open arrived within `OPEN_MACHINE_WINDOW_SEC` of the send, i.e. almost certainly a prefetch. Reported separately, never folded into the headline. |

No IP address is stored, by choice — it would add little and is personal data
we have no reason to hold.
