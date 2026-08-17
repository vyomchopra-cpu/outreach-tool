# What is measured, and how much of it to believe

## The short version

Everything reported comes from two places: **our own records** — what we
queued, what the agents told us happened, what admins did — and, since
v0.16.0, **recipient behaviour** in the form of open and click tracking.

The first kind is exact. The second is not, and this document exists mostly to
say how inexact, because engagement metrics are unusually easy to report
flatteringly.

## Exact, from our own records

| Metric | Source | Accuracy |
|---|---|---|
| Sent, failed, per campaign and sender | `Queue`, agent reports | Exact |
| Delivery failures with verbatim error | `Queue.error` | Exact |
| Bounces | `Signals` (auto) or `Recipients.status` (manual) | Exact when detection works |
| Replies | `Signals` (auto) or manual entry | Exact when detection works |
| Opt-outs | `Suppression` | Exact |
| Cap utilisation, pacing, window compliance | `Queue.due_at_utc` vs `sent_at` | Exact |
| Agent health, transport, provider quota | `Senders.capabilities` heartbeat | Live, ~1 min old |
| Who did what, when | `Events`, append-only | Exact |

## Inexact, from recipient behaviour

| Metric | Source | Accuracy |
|---|---|---|
| Clicks | `Tracking` where `kind = click` | Good — a deliberate human action |
| Opens | `Tracking` where `kind = open` | Poor — see below |

### Why open rate is the weakest number on the dashboard

An open is measured by embedding a 1×1 image that phones home when the client
loads it. Three things break that inference:

**Apple Mail Privacy Protection.** Since 2021, Apple Mail fetches every image
in every message on the recipient's behalf, whether or not anyone reads it. It
is on by default and used by a large, unknowable share of recipients. Those
opens are machines.

**Image blocking.** Outlook and Gmail block images by default for unknown
senders. A person who reads the message carefully and never loads images
registers *no* open at all. So opens undercount real readers at the same time
as overcounting fake ones, and the two errors do not cancel.

**Retries.** Our pixel endpoint cannot return real image bytes (see below), so
a client that retries a failed image can log the same open twice.

### What we do about it

- **An open logged within 10 seconds of the send is flagged
  `machine_suspected`.** Humans rarely open that fast; prefetchers always do.
  The threshold is `OPEN_MACHINE_WINDOW_SEC` in `shared/Config.gs`.
- **Unique and total are never merged.** One person opening six times is one
  interested human. The dashboard reports unique recipients; raw event counts
  are available but are not the headline.
- **The dashboard leads with reply rate, then clicks, then opens** — with the
  machine-open count stated next to the open figure rather than in a footnote.
  Ordering is part of the argument.

**Manage to reply rate. Use clicks as the engagement signal. Treat open rate
as a weak directional hint and never report it to anyone as a result.**

## A real limitation of the pixel

Apps Script's `doGet` can only return `HtmlOutput` or `TextOutput` — there is
no way to serve image bytes with an `image/*` content type. The endpoint
therefore returns an empty text body.

Consequences, stated rather than discovered:

- the open **is** recorded; that half works exactly as intended
- the `<img>` resolves to nothing. At 1×1 with explicit dimensions this is
  invisible in practice, though a client that renders placeholders for broken
  images may show a tiny artefact
- a client that retries a failed image may log a second open — another reason
  unique-per-recipient is what gets reported

Serving a real GIF would mean hosting it somewhere that can return binary,
which is an external dependency this tool deliberately does not have.

## What tracking costs

Turning this on was a deliberate trade, and the downsides are real:

- A tracking pixel is one of the clearer signals that mail is bulk rather than
  personal, and some spam filters weight it.
- Rewritten links mean the recipient sees a `script.google.com` URL on hover
  rather than your actual destination. Some people find that off-putting; a
  few security-conscious recipients will not click it at all.

Both are switched off by a one-word change — `TRACK_OPENS` and `TRACK_CLICKS`
in `shared/Config.gs`. Existing data stays valid; the renderer simply stops
injecting.

## What is never tracked

- **No IP addresses.** The user agent is stored because it is what
  distinguishes a proxy prefetch from a person. An IP would add little and is
  personal data we have no reason to hold.
- **No recipient address in any tracking URL.** Query strings end up in
  mail-client logs, proxies and browser history. The URL carries an opaque id
  that resolves to a recipient only on our side.
- **The unsubscribe link is never rewritten.** An opt-out has to work even if
  the gateway is down. Trading a compliance guarantee for a click metric is
  not a trade worth making.

## Exports

`Results` tab → per-campaign CSV (one row per recipient, including send
status, error, opens, clicks) or all-campaigns CSV (one row per campaign).

Both are RFC-4180 quoted and carry a UTF-8 BOM, so a company name containing a
comma or a non-ASCII name opens correctly in Excel rather than silently
shifting columns.
