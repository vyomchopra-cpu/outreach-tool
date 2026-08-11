# Data retention

What this system stores, for how long, and — the part that matters most —
what it structurally cannot store at all.

## What is never stored, by design

- **Message bodies or snippets of any inbound mail.** The agent's OAuth scope
  (`gmail.metadata`) makes this a Google-enforced impossibility, not a policy
  choice — see `docs/ARCHITECTURE.md` §5. `docs/SCHEMA.md`'s `Signals` tab has
  no body-shaped column, and `test/qa.mjs` asserts that structurally on every run.
- **Exec OAuth tokens.** Minted and used inside the exec's own account,
  never transmitted to or stored by the central system (`docs/ARCHITECTURE.md` §1).
- **Plain-text per-sender secrets.** Only `secret_hash` (SHA-256) is stored
  centrally; the plain value lives solely in that agent's own `ScriptProperties`.

## What is stored, and for how long

| Data | Where | Retention |
|---|---|---|
| Campaign content (subject, body) | `Campaigns` tab | Indefinite — it's the record of what was sent under whose name |
| Recipient contact info + merge fields | `Recipients` tab | Indefinite while campaign is active; see purge policy below |
| Send history | `Queue`, `Events` tabs | Indefinite — the audit trail |
| Reply/bounce/unsub **headers only** | `Signals` tab | Indefinite — no body ever present to purge |
| Suppression list | `Suppression` tab | **Permanent, never deleted.** An unsubscribe is forever. |
| Daily health rollups | `Health` tab | Indefinite — small, aggregate, no PII beyond an email address |

## Purge policy

- A **recipient's raw contact data** (name, title, company, custom fields)
  should be purged 24 months after last campaign activity for that
  recipient, unless suppressed (suppression rows are exempt — they must
  survive a purge, or the same address could be re-contacted after a purge
  cycle, which would be worse than keeping it).
- Purging is **not yet automated in v1** — this is a known gap, tracked for
  Stage 6 hardening once real recipient volume exists to make the SLA concrete.
  Until then, a manual quarterly review is the interim control.
- `Events` (the audit log) is never purged — it's the record of who did what,
  and it contains no message content, only metadata (`docs/SCHEMA.md` `Events.detail`
  is JSON and is asserted to never contain message content, by convention —
  every call site in `admin/*.gs` passes only structured action metadata).

## Data subject requests

If a recipient asks to be forgotten (beyond unsubscribing from future
outreach): their `Recipients` rows can be deleted on request via a manual
admin action once built; their entry in `Suppression` is **not** deletable
even on request, since removing it would allow them to be re-contacted,
which is the opposite of what they asked for. This asymmetry should be
explained plainly if ever raised: "we can delete your contact record, we
cannot and will not delete the record that says never to email you again."
