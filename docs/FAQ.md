# FAQ

Real questions — either asked while building this, or the ones a new admin
predictably asks in their first week. If you have one this doesn't answer,
that's a gap worth filing, not a reason to guess.

---

## For anyone using the console

**Can you (the tool, or an admin) read my email?**
No — structurally, not just by policy. The account sending your mail runs on
a scope that can send but cannot read, list, or search a single message.
Ask IT to show you the consent screen you'll click through when you install
your own sender agent; it will say "send email," never "read email."

**How do I get access to the console?**
An existing admin grants it from the **Access** tab — your email, a number of
days. You then sign in at the console URL with your own `@moveinsync.com`
Google account. No password, no separate account to set up.

**My access expired / I got removed — what happened?**
Either the days ran out, or an admin revoked it. Both take effect
immediately, on your next click, not your next login. Ask whoever granted
you access to extend or re-grant it if you still need it.

**Why can I build a campaign but not send from my own account?**
Those are two different things. **Console access** (Access tab) lets you use
the dashboard — build campaigns, import lists, launch. **Sending capability**
is a separate, per-person install: each exec whose name mail goes out under
runs their own small program inside their own Google account (Operations
tab → Agent links → Onboard). You can have one without the other.

**Why does a test send arrive in seconds but a real campaign send takes
until tomorrow morning?**
Test sends go to your own inbox to check rendering — there's no reason to
make you wait until business hours to see if a link is broken. Real sends to
actual prospects only go out **09:00–17:00 on business days**, on purpose.
That's not a bug you can work around from the console; it's enforced on the
sending side regardless of what the console shows.

**I asked for a 5-minute gap between two sends and got 6.**
Expected. The sender checks for new work about once a minute, so timing is
accurate to roughly that, not to the second. If gaps are consistently much
larger than requested, that's worth reporting.

**Why can't I see who opened my email, or who clicked the link?**
On purpose — there's no tracking pixel and no link rewriting. Full reasoning
in `docs/ANALYTICS.md`, short version: it's the clearest bulk-mail signal
there is, the data is unreliable anyway, and it doesn't square with telling
people we can't read their mail. Reply rate is what's tracked, and it's the
number that actually correlates with outcomes.

**Someone replied asking to be removed — what do I do?**
Audience tab → Opt-outs & replies → paste their address → Suppress.
Permanent, and it applies to every campaign, not just this one — checked
again at the moment of send, not only when you add them.

**A recipient bounced — will they get emailed again?**
Not by this campaign; a bounce marks that recipient's row and nothing more
is queued to them. Reply/bounce *detection* itself is currently manual (see
below) — the exec sees the bounce in their own inbox and someone records it.

**Why is reply detection sometimes automatic and sometimes manual?**
Automatic detection needs one Google Cloud permission that isn't available
right now for internal reasons outside this tool's control
(`docs/GCP_CONSTRAINT.md`). Until that changes, campaigns stay single-touch
on purpose — the exact failure automatic detection exists to prevent (a
follow-up firing at someone who already said stop) can't happen if there's
no follow-up to fire.

**What's the "hard checks" thing on the Audience tab?**
Optional pre-send list quality check via a third-party service (Reoon) —
catches invalid syntax, disposable domains, and role accounts (info@,
sales@) before you send, not after you find out from a bounce. Shows "not
configured" if nobody's set it up yet; nothing else about the console is
affected either way.

---

## For whoever's actually deploying changes

**I changed code — why doesn't the console show it?**
Three separate Apps Script projects, each needs its own push + redeploy.
`docs/RELEASE_PROCESS.md` has the exact sequence. Missing gateway/ or
agent/ is the most common way "I deployed it" and "nothing changed" both
end up true at once.

**Why does the console suddenly show a raw error instead of "not
authorized" or a normal message?**
Usually a Sheet schema mismatch — a column or tab was added in code but
`?bootstrap=1` hasn't been re-run. Safe to re-run any time; it only adds
what's missing, never touches existing data.

**Can I just edit the Apps Script code directly in the browser editor?**
You can, but don't, except to chase a live bug with the editor's Executions
log open. Anything that should persist goes through this repo — `clasp
push` and a real deployment — or the next `sync-shared.sh` run silently
overwrites it with what's on disk here.

**A build I pushed made things worse — how do I roll back?**
`clasp deploy --deploymentId <id> --description "rollback"` after checking
out the last-known-good commit, for each affected project. There is no
single "undo" — see `docs/RELEASE_PROCESS.md`.

---

## Things people assume that aren't true

- **"The admin can read anyone's sent mail from the console."** No —
  the console never touches a mailbox. It only sees what agents report:
  send status, and (only if the Gmail API is available) reply/bounce
  headers — never content.
- **"Access grants and sender agents are the same permission."** They're
  not — see the console-access-vs-sending-capability answer above.
- **"A campaign sends the moment I click Launch."** No — canary first (5
  recipients), and even those queue for the next valid send-window slot,
  which might be tomorrow morning.
- **"Removing a bad address via Reoon suppresses it everywhere."** No —
  that removes them from the current campaign only. Suppression (the
  permanent, global kind) is a separate, explicit action.
