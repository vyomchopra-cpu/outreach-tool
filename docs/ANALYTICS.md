# What is measured, and what deliberately is not

## The short version

Everything reported comes from **our own records** — what we queued, what the
agents told us happened, and what admins did. Nothing is inferred from
recipient behaviour, because nothing observes recipient behaviour.

There is **no open rate and no click rate**, and their absence is a decision,
not an unfinished feature.

## What you get

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

That is a real funnel — **sent → delivered → replied → opted out** — with an
audit trail underneath it.

## Why no open tracking

An "open" is measured by embedding a 1×1 image that phones home when the
message renders. Four reasons that is the wrong trade here:

1. **It is the clearest bulk-mail signal there is.** A tracking pixel is
   exactly what filters look for. It works directly against the reputation the
   daily caps, ramp, and warm-up exist to protect — on the primary corporate
   domain, no less.
2. **The data is bad anyway.** Image proxying (Gmail caches every image) and
   privacy-protection features fire pixels without a human ever seeing the
   message, and block them for people who did. Open rates have been unreliable
   for years; acting on them means acting on noise.
3. **Consent.** Silently recording when a named person opened a message is
   processing personal data. For cold prospects under GDPR/DPDP, the lawful
   basis for that is not comfortable.
4. **It contradicts what the exec was told.** "We can send as you, we can never
   read your mail" sits badly beside "we log when each of your recipients
   opened it." The credibility of the first sentence is the reason anyone
   agreed to this at all.

Click tracking has the same problems plus one more: it rewrites your links
through a redirect domain, which recipients can see, and which becomes one more
thing that can be blocklisted.

## What to use instead

**Reply rate is the metric that matters.** For outreach at 20 sends a day, a
reply is the only signal that correlates with the outcome you want. Opens
measure whether an image loaded.

If reply attribution ever needs to be automatic rather than manual, the fix is
restoring Gmail API access (`docs/GCP_CONSTRAINT.md`) — which reads envelope
headers only and never a message body — not adding a pixel.

## If someone insists on open tracking

Have the argument explicitly rather than sliding into it, and write down:

- who accepted the deliverability risk to the primary domain
- what the lawful basis for the processing is, and where it is recorded
- what the execs sending under their own names were told
- whether a separate sending domain should be used first

It is buildable. It should not be built quietly.
