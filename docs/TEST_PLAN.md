# Manual test plan

`node test/qa.mjs` covers what can be asserted without a live Google account —
merge, escaping, scheduling maths, MIME shape, and the structural rules. It
cannot prove that mail actually leaves the building, that a Sheet write lands,
or that a filter sorts anything. That is what this document is for.

Run **T1–T3** after any change to sending, merging, or scheduling. Run the rest
before widening the sender pool or raising volume.

---

## T0 — Agent health

**Do:** open the agent's `?diagnose=1`.

**Expect:** Identity, MailApp quota, gateway reachable, registered centrally,
trigger installed, secret provisioned all green. The two Gmail API rows are
expected to fail while the Cloud project constraint stands
(`docs/GCP_CONSTRAINT.md`); everything else failing is a real problem.

**Record:** effective transport, and whether reply detection is on.

---

## T1 — Two sends, five minutes apart *(the headline pilot test)*

**Setup**

1. Edit `test/fixtures/recipients-two-sends.csv` — replace both `REPLACE-ME-n@`
   addresses with two mailboxes you control. Use two *different* inboxes, not
   one address plus an alias, so per-recipient merge is genuinely proven.
2. Console → **Compose**:
   - Subject: `Quick question, {{firstName}}`
   - Preheader: `{{company}} — a quick thought`
   - Body: paste `test/fixtures/campaign-body.html`
   - **Gap between sends: `5`**
   - Send from: yourself
3. Save draft.

**Run**

4. **Preview** — confirm the subject shows the sample name, the preheader
   renders, and the byte count is far below the limit.
5. **Test send** → check your seed inbox → **mark passed**.
6. **Recipients** — upload the CSV. Expect `imported 2`.
7. **Preflight** — every check PASS, plus a NOTE about interval capacity.
8. **Approve as exec** → **Launch canary**.

**Expect**

- Both messages arrive, **about five minutes apart**.
- Each shows its own first name, company, title, and its own `intro_html`
  rendered as *actual formatting*, not visible tags.
- The preheader appears next to the subject in the inbox list, and is **not**
  visible when the message is opened.
- `Reply-To` is `<you>+o@moveinsync.com`, not your plain address.
- Sheet: two `Queue` rows `sent` with `sent_at` five minutes apart, two
  `Recipients` rows `sent`, matching `Events` rows.

**Timing caveat:** gaps are accurate to about one poll interval
(`AGENT_POLL_MINUTES`, currently 1). Five minutes may land as 5–6. If it lands
as 5–10, the agent is still on a 5-minute trigger — re-run `?onboard=1`, which
now rebuilds the trigger when the configured interval changes.

**Outside 09:00–17:00:** seed sends still arrive (they bypass the window by
design), but the two campaign sends will queue for 09:00 the next business day.
That is correct behaviour. To watch it end to end at another hour, widen
`SEND_WINDOW` in `shared/Config.gs`, redeploy, and **put it back afterwards**.

---

## T2 — Messy input

**Do:** new campaign, upload `test/fixtures/recipients-edge-cases.csv`.

**Expect** — import reports `imported 3`, `duplicates 1`, `invalid 2`:

| Row | Outcome | Why |
|---|---|---|
| `Smith, Jones & Co` | imported | quoted comma survives; `&` escapes to `&amp;` in HTML and reads as `&` in text |
| `José Müller` / `Ünicode Ltd` | imported | UTF-8 through subject, body, and headers |
| `<script>alert(1)</script>` company | imported | **must render as visible text, never execute** — this is the escaping guarantee |
| `not-an-email` | invalid | fails validation |
| duplicate `edge1@` | duplicate | deduped within a single import |
| blank `first_name` | invalid | a blank merge value is a hard failure, not a silent "Hi ," |

**Critical:** preview the `<script>` row. Seeing the tag as literal text is a
pass. Anything else is a stop-everything bug.

---

## T3 — The guards actually hold

Each of these should be *refused*. A guard that only exists in the UI is not a
guard — that is why they live server-side.

| Attempt | Expected refusal |
|---|---|
| Body without `{{unsubscribe}}` → preflight | BLOCKED on `unsubscribe_present` |
| `{{noSuchColumn}}` in the body → preview | "Missing merge value(s): noSuchColumn" |
| Launch before marking a seed pass | "Seed send has not been confirmed passed" |
| Launch without exec approval | "No exec has approved this campaign yet" |
| Edit the body after a seed pass, then launch | refused — editing clears `seed_passed_at` |
| Import an address already suppressed | counted as `suppressed`, never queued |
| Kill switch on → wait one poll | agent goes idle; nothing sends |
| An address in `Suppression` | never receives mail from any campaign |

---

## T4 — Suppression is real

1. Suppress one of your test addresses via **Opt-outs**.
2. Try to import it into a new campaign → counted `suppressed`, not imported.
3. Confirm the `Suppression` row exists and that pending queue rows for that
   address were cancelled.

Suppression is checked twice — at import and again at send — so a row
suppressed *after* being queued still must not go out.

---

## T5 — Rendering across clients

Add real Outlook desktop, Apple Mail, and mobile Gmail addresses to
`SEED_MAILBOXES`, then run a test send and open each.

Watch for: Outlook desktop (Word rendering engine — the usual culprit), dark
mode inversion on Gmail iOS, and the preheader leaking into the visible body on
any client.

---

## What to log after each run

Date, campaign id, transport used, what arrived, actual gap between sends, and
anything surprising. `Events` is the audit trail; this is the human note that
explains *why* a run happened.
