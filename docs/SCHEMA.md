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
