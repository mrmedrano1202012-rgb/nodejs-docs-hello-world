'use strict';

/**
 * Timezone helpers — dependency-free conversion between a wall-clock time
 * in the business timezone (America/Los_Angeles) and UTC, using Intl.
 */

const dtfCache = new Map();

function getDtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
    );
  }
  return dtfCache.get(tz);
}

/** Offset (ms) of the timezone at a given UTC instant: local = utc + offset. */
function tzOffsetMs(tz, utcDate) {
  const parts = getDtf(tz).formatToParts(utcDate);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  return asUtc - Math.floor(utcDate.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock time ("YYYY-MM-DD" + minutes after midnight) in `tz`
 * into a UTC Date. Two-pass offset resolution handles DST edges.
 */
function zonedTimeToUtc(dateStr, minutesAfterMidnight, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const hh = Math.floor(minutesAfterMidnight / 60);
  const mm = minutesAfterMidnight % 60;
  const naiveUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  let utc = naiveUtc - tzOffsetMs(tz, new Date(naiveUtc));
  utc = naiveUtc - tzOffsetMs(tz, new Date(utc));
  return new Date(utc);
}

/** "YYYY-MM-DD" for a Date as seen in `tz`. */
function dateStrInTz(date, tz) {
  const parts = getDtf(tz).formatToParts(date);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Human label like "9:00 AM" for minutes after midnight. */
function minutesLabel(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** Pretty date label, e.g. "Friday, October 16, 2026" for a YYYY-MM-DD in tz. */
function prettyDate(dateStr, tz) {
  const utcNoon = zonedTimeToUtc(dateStr, 12 * 60, tz);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(utcNoon);
}

module.exports = { zonedTimeToUtc, dateStrInTz, minutesLabel, prettyDate, tzOffsetMs };
