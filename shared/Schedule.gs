/**
 * Pure scheduling math — no SpreadsheetApp, no Session, nothing Apps-Script-only
 * except where explicitly noted. Kept separate from admin/Schedule.gs (which
 * does the Store reads/writes) so it can be exercised directly in test/qa.mjs,
 * the same pattern as shared/Renderer.gs.
 */

/** Deterministic sender assignment: same prospect always gets the same sender, across campaigns. */
function stickySenderForEmail_(email, senderPool) {
  if (!senderPool || senderPool.length === 0) throw new Error('senderPool is empty');
  let hash = 0;
  const s = (email || '').toLowerCase().trim();
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % senderPool.length;
  return senderPool[idx];
}

/**
 * Ramp cap per docs/SCHEMA.md Senders.ramp_start_date: 10 -> 15 -> 20 by day
 * offsets in DAILY_CAP_RAMP (shared/Config.gs). override, if set, wins but is
 * still clamped to the ramp's max — the ramp ceiling is a hard governance
 * rule, not a suggestion (README strict-governance decision).
 */
function capForSenderToday_(rampStartDate, now, ramp, override) {
  const daysSince = Math.floor((now - new Date(rampStartDate)) / (24 * 60 * 60 * 1000));
  let cap = ramp[0].cap;
  ramp.forEach(function (tier) { if (daysSince >= tier.afterDays) cap = tier.cap; });
  const ceiling = ramp[ramp.length - 1].cap;
  if (override != null) cap = Math.min(override, ceiling);
  return cap;
}

/** True for Mon-Fri. Holiday calendar is a known gap — see docs/BUILD_ORDER.md Stage 6. */
function isBusinessDay_(date) {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

/** Advances from startDate by offsetDays *business* days (offsetDays=0 returns startDate itself if it's a business day, else the next one). */
function businessDayOffset_(startDate, offsetDays) {
  let d = new Date(startDate.getTime());
  d.setHours(0, 0, 0, 0);
  while (!isBusinessDay_(d)) d = addDays_(d, 1);
  let remaining = offsetDays;
  while (remaining > 0) {
    d = addDays_(d, 1);
    if (isBusinessDay_(d)) remaining--;
  }
  return d;
}

function addDays_(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * Minute offset for the nth send within a sender's daily window, spaced
 * evenly across the window with jitter so spacing doesn't look metronomic.
 * randomFn is injected (defaults to Math.random) purely for deterministic tests.
 */
function jitteredSlotMinutes_(slotIndex, windowMinutes, dailyCap, jitterFraction, randomFn) {
  const rand = randomFn || Math.random;
  const spacing = windowMinutes / dailyCap;
  const base = slotIndex * spacing + spacing / 2; // center of its slot, not the edge
  const jitter = (rand() * 2 - 1) * jitterFraction * spacing;
  const minutes = base + jitter;
  return Math.max(0, Math.min(windowMinutes - 1, minutes));
}

/**
 * Builds { dayOffset, slotIndex, minuteOffset } for the i-th recipient (0-indexed)
 * assigned to one sender, given that sender's cap-for-that-day. Cap can differ
 * by day under the ramp, so this walks day by day rather than doing simple division.
 */
function scheduleSlotForIndex_(i, capLookupFn) {
  let remaining = i;
  let dayOffset = 0;
  for (;;) {
    const capThatDay = capLookupFn(dayOffset);
    if (remaining < capThatDay) return { dayOffset: dayOffset, slotIndex: remaining, capThatDay: capThatDay };
    remaining -= capThatDay;
    dayOffset++;
    if (dayOffset > 3650) throw new Error('scheduleSlotForIndex_ did not converge — capLookupFn likely returns 0');
  }
}

/**
 * Converts a wall-clock time in an arbitrary IANA zone to a UTC Date.
 * Apps Script's V8 runtime has no direct "construct Date from zoned wall
 * time" API, so this uses the standard round-trip idiom: format a naive-UTC
 * instant as if it were `timeZone`'s wall clock, diff against the original,
 * and apply that offset. Accurate outside DST-transition instants; the
 * agent's ±5-minute poll tolerance (docs/ARCHITECTURE.md §1) absorbs the
 * rare edge-of-transition error.
 *
 * formatInZone is injected so this is testable in plain Node (via
 * Intl.DateTimeFormat in test/qa.mjs) without a real Apps Script runtime;
 * in production, agent/admin code passes a wrapper around
 * Utilities.formatDate(date, timeZone, "yyyy-MM-dd'T'HH:mm:ss").
 */
function zonedTimeToUtc_(year, month, day, hour, minute, timeZone, formatInZone) {
  const naiveUtc = new Date(Date.UTC(year, month, day, hour, minute, 0));
  const zonedString = formatInZone(naiveUtc, timeZone); // "yyyy-MM-ddTHH:mm:ss", zone's wall-clock reading of naiveUtc
  const asIfUtc = new Date(zonedString + 'Z');
  const offsetMs = naiveUtc.getTime() - asIfUtc.getTime();
  return new Date(naiveUtc.getTime() + offsetMs);
}

/** dateOnly supplies Y/M/D (from businessDayOffset_); startHour+minuteOffset supply the wall-clock time. */
function dueAtUtcForSlot_(dateOnly, startHour, minuteOffset, timeZone, formatInZone) {
  const totalMinutes = startHour * 60 + minuteOffset;
  const hour = Math.floor(totalMinutes / 60);
  const minute = Math.round(totalMinutes % 60);
  return zonedTimeToUtc_(dateOnly.getFullYear(), dateOnly.getMonth(), dateOnly.getDate(), hour, minute, timeZone, formatInZone);
}

/** Production formatInZone implementation — lives here so admin/Schedule.gs just passes it through. */
function formatInZoneViaUtilities_(date, timeZone) {
  return Utilities.formatDate(date, timeZone, "yyyy-MM-dd'T'HH:mm:ss");
}
