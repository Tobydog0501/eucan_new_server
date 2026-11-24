'use strict';

// Picks fixture dates for tests that need recent working days relative to the
// real clock (the backend under test runs on it), so the choice must work on
// any day of the year, including the first days of a month or of a year.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar date `days` days before `date` (both YYYY-MM-DD). */
function daysBefore(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

const isWeekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

/**
 * `count` working days (weekends off, minus `skip`) before `today`, newest
 * first, all in one calendar month and at most `window` days back. When the
 * newest month has too few of them (early in a month), the whole set moves to
 * the month before, so a set never straddles a month or a year boundary.
 */
function recentWorkdays(today, count, { window = 28, skip = () => false } = {}) {
  let out = [];
  for (let back = 1; back <= window && out.length < count; back++) {
    const date = daysBefore(today, back);
    if (isWeekend(date) || skip(date)) continue;
    if (out.length && date.slice(0, 7) !== out[0].slice(0, 7)) out = [];
    out.push(date);
  }
  if (out.length < count) throw new Error(`not enough recent workdays before ${today}`);
  return out;
}

module.exports = { daysBefore, isWeekend, recentWorkdays };
