'use strict';

// testlib/workdays.js picks the fixture dates of makeup.test.js from the real
// clock, so it must work on every day of the year: in particular on the first
// days of a month (the newest month has too few working days) and of a year.

const test = require('node:test');
const assert = require('node:assert');
const { recentWorkdays, isWeekend, daysBefore } = require('../testlib/workdays');

const SKIP = { skip: (date) => /-03-0[23]$/.test(date) };

test('recent workdays: mid-month stays in the current month', () => {
  assert.deepEqual(recentWorkdays('2026-11-21', 3, SKIP), ['2026-11-20', '2026-11-19', '2026-11-18']);
});

test('recent workdays: early in a month the set moves to the previous month', () => {
  // 2026-12-01 alone is not enough, so all three come from November.
  assert.deepEqual(recentWorkdays('2026-12-02', 3, SKIP), ['2026-11-30', '2026-11-27', '2026-11-26']);
  assert.deepEqual(recentWorkdays('2026-12-04', 3, SKIP), ['2026-12-03', '2026-12-02', '2026-12-01']);
  // On the 1st nothing of the month is past yet.
  assert.deepEqual(recentWorkdays('2026-12-01', 3, SKIP), ['2026-11-30', '2026-11-27', '2026-11-26']);
  // The skipped 03-02 / 03-03 push early March back into February.
  assert.deepEqual(recentWorkdays('2026-03-05', 3, SKIP), ['2026-02-27', '2026-02-26', '2026-02-25']);
});

test('recent workdays: early in a year the set moves to the previous December', () => {
  assert.deepEqual(recentWorkdays('2027-01-04', 3, SKIP), ['2026-12-31', '2026-12-30', '2026-12-29']);
  assert.deepEqual(recentWorkdays('2027-01-01', 3, SKIP), ['2026-12-31', '2026-12-30', '2026-12-29']);
  assert.deepEqual(recentWorkdays('2028-01-01', 3, SKIP), ['2027-12-31', '2027-12-30', '2027-12-29']);
});

test('recent workdays: every day of 2026-2028 gets three workdays of one month in the window', () => {
  for (let today = '2026-01-01'; today < '2029-01-01'; today = daysBefore(today, -1)) {
    const days = recentWorkdays(today, 3, SKIP);
    assert.equal(days.length, 3, today);
    assert.equal(new Set(days.map((d) => d.slice(0, 7))).size, 1, `${today}: one month`);
    assert.deepEqual([...days].sort().reverse(), days, `${today}: newest first`);
    for (const d of days) {
      assert.ok(d < today && d >= daysBefore(today, 28), `${today}: ${d} in the window`);
      assert.ok(!isWeekend(d) && !SKIP.skip(d), `${today}: ${d} is a workday`);
    }
  }
});
