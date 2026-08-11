# Exec consent

What a leader is agreeing to when they install the sender agent, and what
they're told before they click Allow. This document is the source an
onboarding email/deck should be built from — it is not itself that deck.

## What we tell them, before they authorize anything

1. **What we can do:** send email as you, from your account, on a schedule
   you and an admin agree to. Nothing else.
2. **What we structurally cannot do:** read your inbox, read anyone's reply,
   see attachments, or see anything beyond the fact that a reply or bounce
   arrived. This isn't a promise we're asking you to trust — it's enforced
   by the Google permission scopes on the consent screen you're about to see.
   Read them; they say `gmail.send`, not `gmail.readonly`.
3. **What we see on our side:** send counts, reply/bounce counts (never
   content), and the campaign content itself (since you approve every
   campaign before it sends under your name).
4. **What you control:** every campaign requires your explicit approval
   before it sends (`approveCampaignAsExec` — `docs/ARCHITECTURE.md` §2). You
   can pause or fully disconnect at any time, unilaterally, with no admin
   involvement (`disconnectSender` in `agent/Onboard.gs`) — this takes effect
   within one poll cycle (~5 minutes).
5. **What happens to your Sent folder:** campaign sends appear there,
   because they are genuinely your mail, sent in your name
   (`docs/ARCHITECTURE.md` §4).
6. **What happens to replies:** they land in `Outreach/Replies` in your own
   inbox, sorted by a Gmail filter we set up once at install — we never see
   them.

## What we need from them

- Explicit sign-off to be a named sender in the pilot pool (this is a
  reputational act — mail goes out under their name and title).
- Agreement to the daily send cap and window (10 → 15 → 20/day, 09:00–17:00
  business days) — theirs to adjust downward, never upward, without a
  documented governance change.
- Acknowledgment that they, not the admin team, are the one clicking
  "approve" on campaign content before it sends (`exec_approved_by` in
  `docs/SCHEMA.md` `Campaigns` is the audit record of this).

## Recording consent

`Senders.consent_recorded_at` (`docs/SCHEMA.md`) is set automatically at
`registerSender` — i.e., consent is recorded the moment they complete OAuth
and the agent's first onboarding call succeeds. This is a *technical*
consent timestamp (they clicked Allow on the scopes), not a substitute for
the plain-language conversation this document is meant to drive before that
click happens.

## Revocation

Two independent ways to stop, on purpose:

- **Soft, reversible:** `disconnectSender()` removes the 5-minute trigger.
  The agent goes idle; re-running `onboardSender()` resumes it.
- **Hard, complete:** the exec removes the app at
  `myaccount.google.com/permissions`. This revokes the OAuth grant outright —
  even if every other safeguard here somehow failed, this one instantly ends
  the agent's ability to do anything, because it no longer has a token.
