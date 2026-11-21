'use strict';

// The cards on the employee page 補打卡申請 (missingPunchCards): same
// detection as the missed-punch notice mail, one card per missing half, with
// pending leave also excusing and halves already filed (pending or approved)
// hidden. Plus the card validation helpers. In-process, fixture data only.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { inWorkdir } = require('../testlib/harness');

const TODAY = '2026-03-16'; // a Monday
// Injected calendar: weekends off, 2026-03-11 a holiday.
const isWorkingDay = async (date) => {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && date !== '2026-03-11';
};

/**
 * emp1  nothing on 03-13 (Fri), clock-in only on 03-12      -> 03-13 in+out, 03-12 out
 * emp3  joined 03-12                                         -> 03-13 in+out, 03-12 in+out
 * emp4  resigned (status 0)                                  -> none
 * emp5  pending full-day leave 03-13, approved morning 03-12 -> 03-12 out
 */
function seed(file) {
  const db = new Database(file);
  try {
    const addUser = db.prepare('INSERT INTO userinfo (id,pwd,type,email,name,joinTime,mgroup,permit,status) VALUES (?,?,?,?,?,?,?,?,?)');
    addUser.run('emp3', 'fixture', 'employee', 'emp3@example.invalid', 'Fixture emp3', '2026-03-12', 0, 1, 1);
    addUser.run('emp4', 'fixture', 'employee', 'emp4@example.invalid', 'Fixture emp4', '2020-01-01', 0, 1, 0);
    addUser.run('emp5', 'fixture', 'employee', 'emp5@example.invalid', 'Fixture emp5', '2020-01-01', 0, 1, 1);
    const punch = db.prepare('INSERT INTO clockinrecord (id,name,date,num,clockin,clockout) VALUES (?,?,?,?,?,?)');
    punch.run('emp1', 'Employee One', '2026-03-12', 1, '08:20', null);
    // Everybody punched fully on the other workdays of the window, so only the dates above show.
    for (const date of ['2026-03-09', '2026-03-10']) {
      for (const id of ['emp1', 'emp5']) punch.run(id, id, date, 1, '08:20', '17:40');
    }
    punch.run('emp5', 'emp5', '2026-03-12', 1, null, null);
    // emp6, for the month and year boundaries (2026-11/12, 2026-12/2027-01):
    // 11-30 clock-out only; 12-30 and 2027-01-04 full; 12-31 clock-in only.
    addUser.run('emp6', 'fixture', 'employee', 'emp6@example.invalid', 'Fixture emp6', '2020-01-01', 0, 1, 1);
    punch.run('emp6', 'emp6', '2026-11-30', 1, null, '17:40');
    for (const date of ['2026-12-30', '2027-01-04']) punch.run('emp6', 'emp6', date, 1, '08:20', '17:40');
    punch.run('emp6', 'emp6', '2026-12-31', 1, '08:20', null);
    const ticket = db.prepare('INSERT INTO requestquery (serialnum,id,name,type,start,end,mgroup,state,year,month,totalTime,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    ticket.run('t1', 'emp5', 'emp5', '事假', '2026-03-13 08:30', '2026-03-13 17:30', 0, 0, '2026', '3', 8, 'fixture');
    ticket.run('t2', 'emp5', 'emp5', '事假', '2026-03-12 08:30', '2026-03-12 12:30', 0, 1, '2026', '3', 4, 'fixture');
    ticket.run('t3', 'emp1', 'emp1', '事假', '2026-03-13 08:30', '2026-03-13 17:30', 0, 2, '2026', '3', 8, 'rejected');
  } finally {
    db.close();
  }
}

async function withCards(fn) {
  await inWorkdir(async ({ cwd, load }) => {
    seed(path.join(cwd, 'databases', 'loginDatabase.db'));
    const { sql } = load('plugins/sql.js');
    const job = load('plugins/missed_punch.js');
    const makeup = load('plugins/makeup.js');
    const db = new sql();
    try {
      const cards = (id, extra = {}) => job.missingPunchCards(db, id, { today: TODAY, isWorkingDay, lookbackDays: 7, ...extra });
      await fn({ db, job, makeup, cards });
    } finally {
      db.close();
    }
  });
}

const flat = (cards) => cards.map((c) => `${c.date} ${c.kind}`);

test('missing-punch cards: one per missing half, newest first, only working days in the window', async () => {
  await withCards(async ({ cards }) => {
    assert.deepEqual(flat(await cards('emp1')), ['2026-03-13 in', '2026-03-13 out', '2026-03-12 out']);
    // Joined on 03-12: nothing before that (03-10 and 03-09 are not listed).
    assert.deepEqual(flat(await cards('emp3')), ['2026-03-13 in', '2026-03-13 out', '2026-03-12 in', '2026-03-12 out']);
    assert.deepEqual(await cards('emp4'), [], 'resigned');
    // Pending full-day leave excuses 03-13; approved morning leave excuses the 03-12 clock-in.
    assert.deepEqual(flat(await cards('emp5')), ['2026-03-12 out']);
    assert.deepEqual(await cards('admin1'), [], 'admins are not checked');
    assert.deepEqual(await cards('nobody'), []);
    // A shorter window; a calendar that cannot tell leaves the day out.
    assert.deepEqual(flat(await cards('emp1', { lookbackDays: 3 })), ['2026-03-13 in', '2026-03-13 out']);
    const broken = async (date) => { if (date === '2026-03-13') throw new Error('no calendar'); return isWorkingDay(date); };
    assert.deepEqual(flat(await cards('emp1', { isWorkingDay: broken })), ['2026-03-12 out']);
  });
});

test('missing-punch cards: halves with a pending or approved request are hidden, rejected ones come back', async () => {
  await withCards(async ({ db, cards }) => {
    const who = { id: 'emp1', name: 'Employee One', department: 'JEFF' };
    const filed = db.createMakeupRequest(who, { date: '2026-03-13', kind: 'in', clockin: '08:30', clockout: null, reason: 'x' });
    assert.deepEqual(flat(await cards('emp1')), ['2026-03-13 out', '2026-03-12 out']);
    db.reviewMakeupRequest(filed, 'reject', { id: 'admin1', name: 'Admin One' }, 'no');
    assert.deepEqual(flat(await cards('emp1')), ['2026-03-13 in', '2026-03-13 out', '2026-03-12 out']);
    // An older 'both' request (filed before cards existed) hides both halves.
    db.createMakeupRequest(who, { date: '2026-03-13', kind: 'both', clockin: '08:30', clockout: '17:30', reason: 'x' });
    assert.deepEqual(flat(await cards('emp1')), ['2026-03-12 out']);
    const out = db.createMakeupRequest(who, { date: '2026-03-12', kind: 'out', clockin: null, clockout: '17:30', reason: 'x' });
    db.reviewMakeupRequest(out, 'approve', { id: 'admin1', name: 'Admin One' }, '');
    assert.deepEqual(await cards('emp1'), []);
  });
});

test('missing-punch cards match the notice mail for the same day', async () => {
  await withCards(async ({ db, job, cards }) => {
    for (const date of ['2026-03-12', '2026-03-13']) {
      const mailed = Object.fromEntries((await job.findMissedPunches(db, date)).map((m) => [m.id, m.kind]));
      for (const id of ['emp1', 'emp3', 'emp4']) {
        const kinds = (await cards(id)).filter((c) => c.date === date).map((c) => c.kind);
        const expected = kinds.length === 2 ? 'both' : kinds[0];
        assert.equal(mailed[id], expected, `${id} ${date}`);
      }
    }
    // The one deliberate difference: pending leave excuses on the page, not in the mail.
    assert.equal((await job.findMissedPunches(db, '2026-03-13')).find((m) => m.id === 'emp5').kind, 'both');
    assert.deepEqual((await cards('emp5')).filter((c) => c.date === '2026-03-13'), []);
  });
});

test('card validation: only date, in/out and a reason; times come from the shift slot', async () => {
  await withCards(async ({ makeup, job }) => {
    const ok = makeup.validateMakeupCard({ date: '2026-03-13', kind: 'out', reason: '  忘記  ', clockout: '23:59' }, TODAY);
    assert.deepEqual(ok, { ok: true, value: { date: '2026-03-13', kind: 'out', reason: '忘記' } });
    for (const body of [
      { date: '2026-03-16', kind: 'in', reason: 'x' },
      { date: '2026-02-30', kind: 'in', reason: 'x' },
      { date: 20260313, kind: 'in', reason: 'x' },
      { date: '2026-03-13', kind: 'both', reason: 'x' },
      { date: '2026-03-13', kind: 'in', reason: '' },
      { date: '2026-03-13', kind: 'in', reason: 'x'.repeat(makeup.MAKEUP_REASON_MAX + 1) },
    ]) {
      assert.equal(makeup.validateMakeupCard(body, TODAY).ok, false, JSON.stringify(body));
    }
    const slot = { start: job.WORK_START, end: job.WORK_END };
    assert.deepEqual(makeup.makeupFromCard({ date: '2026-03-13', kind: 'in', reason: 'r' }, slot), { date: '2026-03-13', kind: 'in', clockin: '08:30', clockout: null, reason: 'r' });
    assert.deepEqual(makeup.makeupFromCard({ date: '2026-03-13', kind: 'out', reason: 'r' }, slot), { date: '2026-03-13', kind: 'out', clockin: null, clockout: '17:30', reason: 'r' });
  });
});

test('missing-punch cards across a month boundary (window 2026-11-29 .. 2026-12-01)', async () => {
  await withCards(async ({ cards }) => {
    assert.deepEqual(flat(await cards('emp6', { today: '2026-12-02', lookbackDays: 3 })), ['2026-12-01 in', '2026-12-01 out', '2026-11-30 in']);
  });
});

test('missing-punch cards across a year boundary: same as the mail, punches loaded once per month', async () => {
  await withCards(async ({ db, job, cards }) => {
    const calls = [];
    const real = db.clockinRecord.bind(db);
    db.clockinRecord = (year, month) => { calls.push(`${year}-${month}`); return real(year, month); };
    // Window 2027-01-04 .. 2026-12-29; 01-02 / 01-03 are a weekend.
    const got = await cards('emp6', { today: '2027-01-05', lookbackDays: 7 });
    assert.deepEqual(flat(got), ['2027-01-01 in', '2027-01-01 out', '2026-12-31 out', '2026-12-29 in', '2026-12-29 out']);
    assert.deepEqual(calls, ['2027-01', '2026-12']);
    for (const date of ['2027-01-04', '2027-01-01', '2026-12-31', '2026-12-30', '2026-12-29']) {
      const kinds = got.filter((c) => c.date === date).map((c) => c.kind);
      const mailed = (await job.findMissedPunches(db, date)).find((m) => m.id === 'emp6');
      assert.equal(mailed && mailed.kind, kinds.length === 2 ? 'both' : kinds[0], date);
    }
  });
});

test('card validation: the reason may hold line breaks and tabs but no other control characters', async () => {
  await withCards(async ({ makeup }) => {
    const card = { date: '2026-03-13', kind: 'in' };
    assert.equal(makeup.validateMakeupCard({ ...card, reason: '忘記\n打卡\t了\r\n說明' }, TODAY).ok, true);
    for (const bad of ['\u0000', '\u0007', '\u001b[31m', '\u000b', '\u000c', '\u007f']) {
      const res = makeup.validateMakeupCard({ ...card, reason: `忘記${bad}打卡` }, TODAY);
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.match(res.message, /控制字元/);
    }
  });
});
