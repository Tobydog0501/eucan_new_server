'use strict';

// Routes that had no test before: POST /users /dayoff /init /quota /sync
// /calendar, GET /api/calendar/years|view|export, /api/clockin/day|directory|
// master and POST /api/clockin/edit. Plus clock-in against the working-day
// calendar (with a fake clock) and leave hours across a year boundary.
//
// Each route gets its access rules (missing fields, bad session, employee vs
// admin) and one check that the data it returns or writes is right.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();
const FAKECLOCK = path.join(__dirname, '..', 'testlib', 'fakeclock.js');
const BAD = { account: 'emp1', cookie: 'not-a-session' };
// Never launch the headless-browser calendar scraper from a test.
const NO_DOWNLOAD = { CALENDAR_DOWNLOAD_DISABLED: '1' };

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// The harness calendar: Saturdays and Sundays off, every other day a working day.
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

/** First date in year/month (1-based) whose weekday is one of `days` (0 = Sunday). */
function firstDay(year, month, days) {
  for (let day = 1; day <= 28; day++) {
    const d = new Date(year, month - 1, day);
    if (days.includes(d.getDay())) return d;
  }
  throw new Error('unreachable');
}

/**
 * The most recent day before today whose weekday is one of `days`. Fake clocks
 * must not run ahead of the real one: sessions expire one hour after the
 * database's real-time createTime.
 */
function lastDay(days) {
  const now = new Date();
  for (let back = 1; back <= 7; back++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (days.includes(d.getDay())) return d;
  }
  throw new Error('unreachable');
}

/** A server whose clock reads `when` (a Date-parsable string in Taipei time). */
function serverAt(when, env = {}) {
  return startServer({ env: { ...NO_DOWNLOAD, ...env, FAKE_NOW: when, NODE_OPTIONS: `--require=${JSON.stringify(FAKECLOCK)}` } });
}

/** Access rules shared by the admin-only routes: 400 without fields, 403 for a bad session or an employee. */
async function assertAdminOnly(call, fields) {
  assert.equal((await call({})).status, 400, 'no fields');
  assert.equal((await call({ ...BAD, ...fields })).status, 403, 'bad session');
  assert.equal((await call({ ...session('emp1'), ...fields })).status, 403, 'employee');
}

test('POST /users: admins get every account, employees and bad sessions are refused', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    await assertAdminOnly((b) => server.post('/users', b), {});
    const res = await server.post('/users', session('admin1'));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.data.map((u) => u.id).sort(), ['admin1', 'admin2', 'emp1', 'emp2', 'root']);
  } finally {
    await server.stop();
  }
});

test('POST /dayoff: own usage for anyone signed in, another user only for admins', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    assert.equal((await server.post('/dayoff', {})).status, 400);
    assert.equal((await server.post('/dayoff', { ...BAD, year: YEAR })).status, 403);
    assert.equal((await server.post('/dayoff', { ...session('emp1'), user: 'emp2', year: YEAR })).status, 403, 'employee asking for someone else');

    const own = await server.post('/dayoff', { ...session('emp1'), year: YEAR });
    assert.equal(own.status, 200, own.text);
    assert.ok(own.json && typeof own.json === 'object');

    const other = await server.post('/dayoff', { ...session('admin1'), user: 'emp2', year: YEAR });
    assert.equal(other.status, 200, other.text);
  } finally {
    await server.stop();
  }
});

test('POST /init: only root may reset a usage row', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    const next = String(YEAR + 1);
    assert.equal((await server.post('/init', {})).status, 400);
    assert.equal((await server.post('/init', { ...session('admin1'), user: 'emp1', year: next })).status, 403, 'admin is not root');
    assert.equal((await server.post('/init', { ...BAD, user: 'emp1', year: next })).status, 403);

    const rows = () => server.withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM dayoffinfo WHERE id = ? AND year = ?').get('emp1', next).n);
    assert.equal(rows(), 0);
    const res = await server.post('/init', { ...session('root'), user: 'emp1', year: next });
    assert.equal(res.status, 200, res.text);
    assert.equal(rows(), 1);
  } finally {
    await server.stop();
  }
});

test('POST /quota: annual quota from the join date; employees only see their own', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    assert.equal((await server.post('/quota', {})).status, 400);
    assert.equal((await server.post('/quota', { ...BAD, year: YEAR })).status, 403);
    assert.equal((await server.post('/quota', { ...session('emp1'), user: 'emp2', year: YEAR })).status, 403);

    // Fixture users joined on 2020-01-01.
    const years = YEAR - 2020;
    const days = years >= 10 ? Math.min(years + 6, 30) : years >= 5 ? 15 : years >= 3 ? 14 : years >= 2 ? 10 : years >= 1 ? 7 : 0;
    const res = await server.post('/quota', { ...session('admin1'), user: 'emp1', year: YEAR });
    assert.equal(res.status, 200, res.text);
    if (years >= 1) {
      assert.equal(res.json.separate, false);
      assert.equal(res.json.data[0].quota, days * 8);
    }
  } finally {
    await server.stop();
  }
});

test('POST /sync: admins rebuild the usage row from approved tickets', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    assert.equal((await server.post('/sync', {})).status, 400);
    assert.equal((await server.post('/sync', { ...session('emp1'), user: 'emp2', year: YEAR })).status, 403);

    // Seed: emp2 has one approved 8-hour sick-leave ticket this year.
    const sick = () => server.withDb((db) => db.prepare('SELECT sick FROM dayoffinfo WHERE id = ? AND year = ?').get('emp2', String(YEAR)));
    assert.equal(sick().sick, 0);
    const res = await server.post('/sync', { ...session('admin1'), user: 'emp2', year: YEAR });
    assert.equal(res.status, 200, res.text);
    assert.equal(sick().sick, 8);
  } finally {
    await server.stop();
  }
});

test('POST /calendar and GET /api/calendar/export: admin only', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    await assertAdminOnly((b) => server.post('/calendar', b), { year: YEAR, month: 3 });
    await assertAdminOnly((q) => server.get('/api/calendar/export', q), { year: YEAR, month: 3 });
    // The file itself goes to /app/calendars, which only exists in the image,
    // so the success path is not exercised here.
    assert.ok(await server.alive());
  } finally {
    await server.stop();
  }
});

test('GET /api/calendar/years: the years that have a calendar file', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    assert.equal((await server.get('/api/calendar/years', {})).status, 400);
    assert.equal((await server.get('/api/calendar/years', BAD)).status, 403);
    const res = await server.get('/api/calendar/years', session('emp1'));
    assert.equal(res.status, 200, res.text);
    // The harness writes calendars for last year, this year and next year.
    assert.deepEqual(res.json.years, [YEAR - 1, YEAR, YEAR + 1]);
  } finally {
    await server.stop();
  }
});

test('GET /api/calendar/view: approved leave appears on working days only', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    assert.equal((await server.get('/api/calendar/view', { ...session('emp1') })).status, 400, 'no year/month');
    assert.equal((await server.get('/api/calendar/view', { ...BAD, year: YEAR, month: 3 })).status, 403);

    const res = await server.get('/api/calendar/view', { ...session('emp1'), year: YEAR, month: 3 });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.year, YEAR);
    assert.equal(res.json.month, 3);
    const days = res.json.weeks.flat().filter(Boolean);
    assert.equal(days.length, 31);

    // Seed: emp2's approved sick leave on 03-03, 08:30-17:30 (a full day, so
    // no time range is appended); emp1's ticket on 03-02 is pending.
    const third = days.find((d) => d.day === 3).reminders;
    if (isWeekend(new Date(YEAR, 2, 3))) {
      assert.deepEqual(third, []);
    } else {
      assert.deepEqual(third, ['Employee Two(病)']);
    }
    assert.doesNotMatch(days.find((d) => d.day === 2).reminders.join(' '), /Employee One/, 'pending leave is not shown');
  } finally {
    await server.stop();
  }
});

test('GET /api/clockin/directory and /api/clockin/day: active employees with that day\'s punches', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    const date = ymd(firstDay(YEAR - 1, 6, [1, 2, 3, 4, 5]));
    const [y, m, d] = date.split('-').map(Number);
    server.withDb((db) => db.prepare('INSERT INTO clockinrecord (id,name,date,num,clockin,clockout) VALUES (?,?,?,?,?,?)')
      .run('emp1', 'Employee One', date, 1, '08:31', '17:35'), { write: true });

    await assertAdminOnly((q) => server.get('/api/clockin/directory', q), { year: y, month: m });
    assert.equal((await server.get('/api/clockin/directory', { ...session('admin1'), year: y, month: 13 })).status, 400);
    const dir = await server.get('/api/clockin/directory', { ...session('admin1'), year: y, month: m });
    assert.equal(dir.status, 200, dir.text);
    assert.deepEqual(dir.json.employees.map((e) => e.id), ['emp1', 'emp2']);

    await assertAdminOnly((q) => server.get('/api/clockin/day', q), { year: y, month: m, day: d });
    const day = await server.get('/api/clockin/day', { ...session('admin1'), year: y, month: m, day: d });
    assert.equal(day.status, 200, day.text);
    const byId = Object.fromEntries(day.json.records.map((r) => [r.id, r]));
    assert.deepEqual(Object.keys(byId).sort(), ['emp1', 'emp2']);
    assert.equal(byId.emp1.clockin, '08:31');
    assert.equal(byId.emp1.clockout, '17:35');
    assert.equal(byId.emp1.hasRecord, true);
    assert.equal(byId.emp2.hasRecord, false);
  } finally {
    await server.stop();
  }
});

test('POST /api/clockin/edit: admins correct a past day; the day view shows the correction', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    const date = ymd(firstDay(YEAR - 1, 6, [1, 2, 3, 4, 5]));
    const [y, m, d] = date.split('-').map(Number);
    const body = { id: 'emp1', date, clockin: '08:30', clockout: '17:30', reason: 'forgot to punch' };

    await assertAdminOnly((b) => server.post('/api/clockin/edit', b), body);
    assert.equal((await server.post('/api/clockin/edit', { ...session('admin1'), ...body, id: 'nobody' })).status, 404);
    assert.equal((await server.post('/api/clockin/edit', { ...session('admin1'), ...body, reason: '' })).status, 400, 'reason required');
    assert.equal((await server.post('/api/clockin/edit', { ...session('admin1'), ...body, clockin: '18:00' })).status, 400, 'clock-out before clock-in');
    assert.equal((await server.post('/api/clockin/edit', { ...session('admin1'), ...body, date: `${YEAR + 1}-06-01` })).status, 400, 'future date');

    const saved = await server.post('/api/clockin/edit', { ...session('admin1'), ...body });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.status, 'saved');

    const day = await server.get('/api/clockin/day', { ...session('admin1'), year: y, month: m, day: d });
    const emp1 = day.json.records.find((r) => r.id === 'emp1');
    assert.equal(emp1.clockin, '08:30');
    assert.equal(emp1.clockout, '17:30');
    assert.equal(emp1.modified, true);
    assert.equal(emp1.reason, 'forgot to punch');
    assert.equal(emp1.editorName, 'Admin One');

    const again = await server.post('/api/clockin/edit', { ...session('admin1'), ...body });
    assert.equal(again.json.status, 'unchanged');
  } finally {
    await server.stop();
  }
});

test('GET /api/clockin/master: 409 until the month sheet exists', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    await assertAdminOnly((q) => server.get('/api/clockin/master', q), { year: YEAR - 1, month: 3 });
    assert.equal((await server.get('/api/clockin/master', { ...session('admin1'), year: 'x', month: 3 })).status, 400);
    const res = await server.get('/api/clockin/master', { ...session('admin1'), year: YEAR - 1, month: 3 });
    assert.equal(res.status, 409, res.text);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Clock-in reads the wall clock and the working-day calendar.

test('POST /clockin: clock-in and clock-out on a working day', async () => {
  const day = ymd(lastDay([3]));
  const server = await serverAt(`${day}T09:05:00+08:00`);
  try {
    const login = session('emp1');
    const inRes = await server.post('/clockin', { ...login, type: 1 });
    assert.equal(inRes.status, 200, inRes.text);
    const outRes = await server.post('/clockin', { ...login, type: -1 });
    assert.equal(outRes.status, 200, outRes.text);
    const rows = server.withDb((db) => db.prepare('SELECT date, clockin, clockout FROM clockinrecord WHERE id = ?').all('emp1'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, day);
    assert.match(rows[0].clockin, /^09:0[5-9]$/);
    assert.ok(rows[0].clockout);
  } finally {
    await server.stop();
  }
});

test('POST /clockin: refused on a day off', async () => {
  const saturday = ymd(lastDay([6]));
  const server = await serverAt(`${saturday}T10:00:00+08:00`);
  try {
    const res = await server.post('/clockin', { ...session('emp1'), type: 1 });
    assert.equal(res.status, 403, res.text);
    assert.equal(server.withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM clockinrecord').get().n), 0);
  } finally {
    await server.stop();
  }
});

test('POST /clockin: refused before 08:30 on a working day', async () => {
  const day = ymd(lastDay([3]));
  const server = await serverAt(`${day}T08:15:00+08:00`);
  try {
    const res = await server.post('/clockin', { ...session('emp1'), type: 1 });
    assert.equal(res.status, 403, res.text);
  } finally {
    await server.stop();
  }
});

test('POST /clockin: earlier hours are refused too', { todo: 'clockin.ts checks hours<=8 && minutes<30, so 07:45 is accepted' }, async () => {
  const day = ymd(lastDay([3]));
  const server = await serverAt(`${day}T07:45:00+08:00`);
  try {
    const res = await server.post('/clockin', { ...session('emp1'), type: 1 });
    assert.equal(res.status, 403, res.text);
  } finally {
    await server.stop();
  }
});

test('POST /clockin: without this year\'s calendar file it answers 500 and the server keeps running', async () => {
  // What a test site without office_calendar_<year>.json does (downloads are off).
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    fs.rmSync(path.join(server.cwd, 'api', `office_calendar_${YEAR - 1911}.json`));
    const res = await server.post('/clockin', { ...session('emp1'), type: 1 });
    assert.equal(res.status, 500, res.text);
    assert.ok(await server.alive());
    // Looking up history does not need the calendar.
    assert.equal((await server.post('/clockin', { ...session('emp1'), type: 0 })).status, 200);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Leave hours

test('POST /request: leave hours skip days off', async () => {
  const server = await startServer({ env: NO_DOWNLOAD });
  try {
    // Friday 08:30 to the following Monday 17:30: two working days.
    const fri = firstDay(YEAR, 9, [5]);
    const mon = new Date(fri.getFullYear(), fri.getMonth(), fri.getDate() + 3);
    const res = await server.post('/request', { ...session('emp1'), type: '事假', reason: 'x', start: `${ymd(fri)} 08:30`, end: `${ymd(mon)} 17:30` });
    assert.equal(res.status, 200, res.text);
    const row = server.withDb((db) => db.prepare('SELECT totalTime FROM requestquery WHERE id = ? AND start = ?').get('emp1', `${ymd(fri)} 08:30`));
    assert.equal(row.totalTime, 16);
  } finally {
    await server.stop();
  }
});

test('POST /request: leave across New Year counts each year\'s own days off',
  { todo: 'dayoff_calculate keys days off by MM-DD, so the two years\' days off are merged' }, async () => {
    const server = await startServer({ env: NO_DOWNLOAD });
    try {
      const start = new Date(YEAR, 11, 29);
      const end = new Date(YEAR + 1, 0, 5);
      let expected = 0;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) if (!isWeekend(d)) expected += 8;
      const res = await server.post('/request', { ...session('emp1'), type: '事假', reason: 'x', start: `${ymd(start)} 08:30`, end: `${ymd(end)} 17:30` });
      assert.equal(res.status, 200, res.text);
      const row = server.withDb((db) => db.prepare('SELECT totalTime FROM requestquery WHERE id = ? AND start = ?').get('emp1', `${ymd(start)} 08:30`));
      assert.equal(row.totalTime, expected);
    } finally {
      await server.stop();
    }
  });
