# The Google Cloud constraint, and how the tool works around it

## What happened

Every Apps Script project has an auto-created Google Cloud project behind it.
Calling a Google API directly — the Gmail REST API, in our case — requires
that API to be **enabled** in that Cloud project.

During pilot deployment, agent onboarding failed at label creation with:

```
Gmail API has not been used in project 463752232913 before or it is disabled.
```

The standard fix is one click in Cloud Console. Attempting it produced:

```
You need additional access to the project: 463752232913
Missing: resourcemanager.projects.get
```

`vyom.chopra@moveinsync.com` cannot administer, or even view, the Cloud
project behind their own script. This is a moveinsync.com organisation policy
restricting Cloud Platform access for regular users. It is very likely the
same policy behind the other oddity this project hit — three separate
Bearer-token authentication approaches were rejected before a no-auth-header
design was found to work (see `docs/ARCHITECTURE.md` §2, "Agent-API Gateway").

**No amount of code can grant these permissions.** So the tool was rebuilt to
not need them.

## What actually needs the Cloud project

Only one file: `agent/GmailApi.gs`, which calls `gmail.googleapis.com`.

| Capability | Needs the Cloud project? |
|---|---|
| Sending mail | **No** — `MailApp`, scope `script.send_mail` |
| The 5-minute trigger | No — `ScriptApp` |
| Agent → gateway calls | No — plain HTTPS to `script.google.com` |
| Reading the Sheet | No — `SpreadsheetApp` |
| Creating labels + filters | **Yes** — Gmail API |
| Reply / bounce / unsubscribe detection | **Yes** — Gmail API |

Sending — the entire point of the tool — never needed it.

## The workarounds, by capability

### Sending → `MailApp` fallback transport

`agent/Transport.gs` picks a backend at runtime. `TRANSPORT_MODE = 'auto'`
probes the Gmail API once per execution, prefers it, and silently falls back
to `MailApp`.

`MailApp`'s scope is `script.send_mail`: **send-only**. It cannot read, list,
or search a single message. The promise to the exec ("we can send as you, we
can never read your mail") holds at least as strongly as it did under
`gmail.send`. Passing both `body` and `htmlBody` produces a genuine
`multipart/alternative` message, satisfying README hard rule 5.

What it costs:

- **No RFC `Message-ID` capture.** `reportSent` stores `''`, so a reply can
  never be matched back to the message that prompted it.
- No custom headers, no threading.

### Labels + filters → the exec creates them by hand, once

`agent/Onboard.gs` still tries automatically. If the Gmail API is unavailable,
onboarding **succeeds anyway** and points the exec at `?setup=1`, which renders
the exact filter criteria — generated from `manualFilterSpec_()`, using the
same functions that build the real `Reply-To` and unsubscribe addresses, so
the instructions cannot drift from what outgoing mail actually carries.

This is arguably the better arrangement: the tool never needs permission to
modify the exec's Gmail settings at all, and `gmail.settings.basic` could be
dropped from the manifest entirely once the manual path is the accepted one.

### Reply detection → single-touch campaigns

This is the real loss, and it is not worked around — it is designed around.

The original argument for Tier B was concrete: without reply detection,
follow-up #2 fires at someone who already replied "please stop." That
incident is only possible **if there are follow-ups**. With
`ALLOW_MULTI_TOUCH = false` (`shared/Config.gs`), every campaign is
single-touch, and the failure mode structurally cannot occur.

`agent/Sender.gs` skips signal scanning quietly when the API is unavailable,
rather than erroring every five minutes forever.

### Unsubscribe handling → mandatory footer + manual admin recording

Automatic unsubscribe detection is unavailable, which makes the *manual*
route load-bearing:

1. **`{{unsubscribe}}` is now a blocking preflight check.** A campaign whose
   body lacks it cannot launch (`admin/Preflight.gs`). It renders as the
   sending exec's own `+unsub@` alias.
2. The exec sees opt-out requests in their own inbox and forwards them.
3. An admin records them in the console (`admin/Manual.gs`) — permanent,
   global, and cancels anything still queued, writing exactly the same Store
   rows the automatic path would have.

Compliance is preserved; the human is the transport.

## Diagnostics

`agent/Web.gs?diagnose=1` probes every capability and prints each result with
the verbatim error. Built because the first deployment session was spent
guessing at opaque failures one round-trip at a time. Check it first, always.

Each agent also reports its capabilities on every heartbeat; they're stored in
`Senders.capabilities` and surfaced in the admin console's sender-fleet panel,
so a degraded agent is visible rather than inferred.

## If someone does get the permission later

Nothing needs rewriting. Enable the Gmail API on the Cloud project, and:

- `TRANSPORT_MODE = 'auto'` starts preferring the Gmail REST path on its own
- Signal scanning resumes automatically
- `ALLOW_MULTI_TOUCH` can be reconsidered once reply detection is confirmed
  working in `?diagnose=1`
- Filters can be created automatically again by re-running `?onboard=1`

The degraded path stays in place as a permanent fallback either way — an
outage or a revoked permission should never take sending down again.
