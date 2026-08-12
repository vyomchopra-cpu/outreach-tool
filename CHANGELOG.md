# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/). Versions:
[Semantic-ish](https://semver.org) — a MAJOR bump is reserved for a change to
what the tool fundamentally does; MINOR is a new capability; PATCH is a fix
with no new surface. Given the pace of the pilot, MINOR has covered most of
what would strictly be PATCH elsewhere — precision can tighten post-pilot.

Every entry here should answer one question: **what changed for someone
using the console**, not what changed in the code. Implementation detail
belongs in the commit message and the file it touched, not here.

---

## [0.8.0] — 2026-08-13

### Added
- Reoon Email Verifier integration for pre-send list quality (syntax,
  disposable domains, role accounts, MX existence). **Off by default** —
  needs a Reoon API key in Script Properties to activate; see
  `docs/RELEASE_PROCESS.md` if you're the one configuring it.
- Audience tab: "Verify imported recipients" button, results by category,
  one-click removal of invalid/disposable addresses (from that campaign
  only — never a permanent suppression on its own).

## [0.7.0] — 2026-08-13

### Added
- **Access tab** — grant another `@moveinsync.com` colleague full console
  access for a set number of days, straight from the dashboard. No code
  change, no redeploy. Revoke takes effect on their next click, not their
  next login.

## [0.6.0] — 2026-08-13

### Changed
- Full visual redesign: light/dark aware, card-based layout, a "readiness
  rail" on the Launch tab that says *why* a step is blocked instead of just
  greying a button out.
- First page load now costs one round trip instead of three.
- A progress indicator now appears the instant any button is clicked,
  before the network request even starts.

### Fixed
- Three tabs (Audience, Health, Operations) were rendering unstyled after
  an earlier redesign pass — a class-naming mismatch, now consistent
  everywhere.

## [0.5.0] — 2026-08-12

### Added
- **Health tab** — live send/reply/bounce counts, per-sender daily cap
  usage, a campaign funnel table, recent failures, and the full audit trail,
  all from one refresh.
- **Operations tab** — the agent's diagnostic/onboarding/pause links, the
  system's current rules (send window, caps, poll interval), and a
  troubleshooting order.

## [0.4.0] — 2026-08-12

### Added
- Drag-and-drop CSV upload with a downloadable template and a preview
  before import.
- Preheader field (the grey inbox-preview line beside the subject).
- Explicit send-interval option — a fixed gap between messages, for
  controlled tests, alongside the default auto-spaced pacing.
- `{{{column}}}` — insert a CSV column's raw HTML, for content that's
  deliberately formatted, distinct from plain `{{column}}` which is always
  escaped.

### Fixed
- **Security:** merge values from an uploaded CSV were being inserted into
  outgoing HTML completely unescaped. A stray `<` (or worse) in any column
  would have corrupted the message or, in principle, injected markup into
  mail sent under an executive's name. Escaping is now the default;
  `{{{ }}}` is the explicit opt-in for raw HTML.
- Preview and test-send were hard-failing on every real campaign once the
  unsubscribe address became mandatory in the body — fixed before it
  reached anyone.

## [0.3.0] — 2026-08-12

### Fixed
- Test/seed sends were being queued but never actually delivered — the
  pre-launch render check silently did nothing.

## [0.2.0] — 2026-08-12

### Added
- A fallback send path that needs no special Google Cloud permission — see
  `docs/GCP_CONSTRAINT.md`. Sending, the actual point of the tool, works
  either way; only automatic reply-detection and one-click Gmail-filter
  setup depend on the permission that's currently unavailable.
- Manual reply/opt-out recording, to stand in for automatic detection.

## [0.1.0] — 2026-08-11 to 2026-08-12

### Added
- First working pilot: campaign builder, CSV recipient import, preflight
  checks, seeded test sends, canary launch (first 5, then the rest),
  per-sender daily send caps with a ramp-up schedule, a kill switch, and the
  underlying pull-based architecture where each sender's own Google account
  does the actual sending — the tool never holds their mailbox credentials.

---

## How to read this if you're new

Skim newest-to-oldest for *what exists today*, not history. If you only
want the current state of a feature, `docs/FAQ.md` and the Operations tab's
"Current rules" panel are more direct than reconstructing it from entries
here.
