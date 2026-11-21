'use strict';

// Make-up punch requests (employee page 補打卡申請, admin page 補登審核): the
// missing-punch cards the page lists, filing from a card (the actual time and
// the reason are typed; date and half come from the card), who may see and review
// what, that only an approval creates a punch (flagged as make-up) which then
// counts in the views and the month sheet, the audit trail, and the migration.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, inWorkdir, session } = require('../testlib/harness');
const { recentWorkdays, daysBefore } = require('../testlib/workdays');

const DAY_MS = 24 * 60 * 60 * 1000;
/** The Taipei calendar date `back` days ago (YYYY-MM-DD); the backend runs on Taipei time. */
const taipeiDate = (back) => new Date(Date.now() + 8 * 60 * 60 * 1000 - back * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const isWeekend = (date) => [0, 6].includes(weekdayOf(date));
const TODAY = taipeiDate(0);

// Recent working days (the harness calendar: weekends off) inside the page's
// look-back window, newest first, all in one month, avoiding the harness's
// leave tickets on 03-02 / 03-03. See test/workdays.test.js for month and
// year boundaries.
const [DATE, OTHER_DATE, THIRD_DATE] = recentWorkdays(TODAY, 3, { skip: (date) => /-03-0[23]$/.test(date) });
const YEAR = Number(DATE.slice(0, 4));
const MONTH = Number(DATE.slice(5, 7));
const RECENT_WEEKEND = [1, 2, 3, 4, 5, 6, 7].map(taipeiDate).find(isWeekend);
const FONT = path.join(__dirname, '..', 'fonts', 'NotoSansTC-Regular.otf');

async function withServer(fn) {
  const server = await startServer({ env: { CLOCKIN_PDF_FONT: FONT, MISSED_PUNCH_CHECK: '0' } });
  try {
    await fn(server);
    assert.equal(await server.alive(), true, server.output());
  } finally {
    await server.stop();
  }
}

function apply(server, who, form) {
  return server.post('/api/makeup/apply', { ...session(who), ...form });
}
function review(server, who, requestId, decision, note) {
  return server.post('/api/makeup/review', { ...session(who), requestId, decision, note });
}
function mine(server, who) {
  return server.get('/api/makeup/mine', session(who));
}
function rows(server, sqlText, ...args) {
  return server.withDb((db) => db.prepare(sqlText).all(...args));
}
function write(server, sqlText, ...args) {
  return server.withDb((db) => db.prepare(sqlText).run(...args), { write: true });
}
const punch = (server, id, date, clockin, clockout, num = 1) =>
  write(server, 'INSERT INTO clockinrecord (id,name,date,num,clockin,clockout) VALUES (?,?,?,?,?,?)', id, id, date, num, clockin, clockout);
const leave = (server, id, start, end, state) =>
  write(server, 'INSERT INTO requestquery (serialnum,id,name,type,start,end,mgroup,state,year,month,totalTime,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    `T${start}${id}${state}`, id, id, '事假', start, end, 0, state, start.slice(0, 4), String(Number(start.slice(5, 7))), 8, 'fixture');
/** A request filed straight into the table (admins have no cards to file from). */
function fileDirect(server, id, name, date, kind) {
  return server.withDb((db) => {
    const r = db.prepare(`INSERT INTO makeup_request (id, name, department, missed_date, kind, clockin, clockout, reason, applied_at, state)
      VALUES (?, ?, '', ?, ?, ?, ?, '忘記打卡', '2026-01-01 09:00:00', 'pending')`).run(id, name, date, kind, kind === 'out' ? null : '08:30', kind === 'in' ? null : '17:30');
    db.prepare(`INSERT INTO makeup_audit (request_id, action, actor_id, actor_name, reason, acted_at) VALUES (?, 'submit', ?, ?, '忘記打卡', '2026-01-01 09:00:00')`).run(r.lastInsertRowid, id, name);
    return Number(r.lastInsertRowid);
  }, { write: true });
}
const punches = (server, id = 'emp1') => rows(server, 'SELECT * FROM clockinrecord WHERE id = ? ORDER BY date, num', id);
const audit = (server) => rows(server, 'SELECT request_id, action, actor_id, actor_name, reason, acted_at FROM makeup_audit ORDER BY audit_id');
const cardsOn = (res, date) => res.json.missing.filter((c) => c.date === date).map((c) => c.kind);

const IN_FORM = { date: DATE, kind: 'in', time: '08:45', reason: '忘記打卡' };

test('makeup mine: one card per missing half on recent working days, minus punches and leave', async () => {
  await withServer(async (server) => {
    // DATE: clock-in only -> 下班 card. OTHER_DATE: nothing -> both cards.
    // THIRD_DATE: pending full-day leave -> none (pending leave excuses too).
    punch(server, 'emp1', DATE, '08:20', null);
    leave(server, 'emp1', `${THIRD_DATE} 08:30`, `${THIRD_DATE} 17:30`, 0);
    // emp2: approved morning leave on OTHER_DATE, clock-out punch -> nothing that day.
    leave(server, 'emp2', `${OTHER_DATE} 08:30`, `${OTHER_DATE} 12:30`, 1);
    punch(server, 'emp2', OTHER_DATE, null, '17:35');
    // A rejected leave excuses nothing.
    leave(server, 'emp2', `${DATE} 08:30`, `${DATE} 17:30`, 2);

    const res = await mine(server, 'emp1');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.today, TODAY);
    assert.deepEqual(cardsOn(res, DATE), ['out']);
    assert.deepEqual(cardsOn(res, OTHER_DATE), ['in', 'out']);
    assert.deepEqual(cardsOn(res, THIRD_DATE), []);
    const card = res.json.missing.find((c) => c.date === OTHER_DATE && c.kind === 'in');
    assert.deepEqual(card, { date: OTHER_DATE, kind: 'in', kindLabel: '上班', time: '08:30', clockin: null, clockout: null });
    // The recorded other half comes along, for checking the entered time against it.
    assert.deepEqual(res.json.missing.find((c) => c.date === DATE), { date: DATE, kind: 'out', kindLabel: '下班', time: '17:30', clockin: '08:20', clockout: null });
    // Never today, a weekend or anything before the look-back window; newest first.
    const dates = res.json.missing.map((c) => c.date);
    assert.ok(!dates.includes(TODAY) && !dates.includes(RECENT_WEEKEND));
    assert.ok(dates.every((d) => d < TODAY && d >= taipeiDate(31)), dates.join());
    assert.deepEqual([...dates].sort().reverse(), dates);
    assert.ok(dates.every((d) => !isWeekend(d)));

    const two = await mine(server, 'emp2');
    assert.deepEqual(cardsOn(two, OTHER_DATE), []);
    assert.deepEqual(cardsOn(two, DATE), ['in', 'out']);
    // Admins are not checked by the notice mail and get no cards.
    assert.deepEqual((await mine(server, 'admin1')).json.missing, []);
  });
});

test('makeup apply: the actual time and reason come from the employee; date and half must be a card', async () => {
  await withServer(async (server) => {
    const bad = [
      [{ ...IN_FORM, time: undefined }, 400, '請填寫實際上班時間'],
      [{ ...IN_FORM, time: '' }, 400, '請填寫實際上班時間'],
      [{ ...IN_FORM, kind: 'out', time: '' }, 400, '請填寫實際下班時間'],
      [{ ...IN_FORM, time: 830 }, 400, '請填寫實際上班時間'],
      [{ ...IN_FORM, time: '8:45' }, 400, 'HH:MM'],
      [{ ...IN_FORM, time: '24:00' }, 400, 'HH:MM'],
      [{ ...IN_FORM, time: '08:60' }, 400, 'HH:MM'],
      [{ ...IN_FORM, time: '08:45:00' }, 400, 'HH:MM'],
      [{ ...IN_FORM, time: `${DATE} 08:45` }, 400, 'HH:MM'],
      [{ ...IN_FORM, time: `${OTHER_DATE}T08:45` }, 400, 'HH:MM'],
      // Plausibility with the other half missing too: a clock-in after the shift end, a clock-out before its start.
      [{ ...IN_FORM, time: '17:30' }, 400, '須早於 17:30'],
      [{ ...IN_FORM, time: '22:00' }, 400, '須早於 17:30'],
      [{ ...IN_FORM, kind: 'out', time: '08:30' }, 400, '須晚於 08:30'],
      [{ ...IN_FORM, kind: 'out', time: '03:00' }, 400, '須晚於 08:30'],
      [{ ...IN_FORM, reason: '' }, 400, '原因'],
      [{ ...IN_FORM, reason: '   ' }, 400, '原因'],
      [{ ...IN_FORM, reason: 'x'.repeat(201) }, 400, '原因'],
      [{ ...IN_FORM, kind: 'both' }, 400, '類別'],
      [{ ...IN_FORM, kind: 'lunch' }, 400, '類別'],
      [{ ...IN_FORM, date: `${YEAR}-02-30` }, 400, '日期'],
      [{ ...IN_FORM, date: TODAY }, 400, '日期'],
      [{ ...IN_FORM, date: `${YEAR + 2}-01-05` }, 400, '日期'],
      [{ ...IN_FORM, date: RECENT_WEEKEND }, 409, '沒有需要補打卡'],
      [{ ...IN_FORM, date: taipeiDate(45) }, 409, '沒有需要補打卡'],
    ];
    for (const [form, status, word] of bad) {
      const res = await apply(server, 'emp1', form);
      assert.equal(res.status, status, `${JSON.stringify(form)} -> ${res.text}`);
      assert.ok(res.json && res.json.message.includes(word), `${JSON.stringify(form)} -> ${res.text}`);
    }
    // A half that was punched is not a card.
    punch(server, 'emp1', OTHER_DATE, '08:25', null);
    assert.equal((await apply(server, 'emp1', { ...IN_FORM, date: OTHER_DATE })).status, 409);
    assert.equal((await apply(server, 'emp1', { ...IN_FORM, cookie: 'bbbbbbbbbb' })).status, 403);
    assert.equal((await apply(server, 'emp1', { date: DATE, kind: 'in' })).status, 400);
    assert.equal((await apply(server, 'emp1', { date: DATE, kind: 'in', reason: '忘記打卡' })).status, 400);
    // Against a recorded other half: OTHER_DATE has a clock-in at 08:25, so the clock-out must be later.
    for (const time of ['08:25', '08:00']) {
      const res = await apply(server, 'emp1', { date: OTHER_DATE, kind: 'out', time, reason: '忘記打卡' });
      assert.equal(res.status, 400, res.text);
      assert.match(res.json.message, /實際下班時間須晚於當日上班時間 08:25/);
    }
    // ...and a clock-in must be earlier than a recorded clock-out.
    punch(server, 'emp1', THIRD_DATE, null, '12:00');
    for (const time of ['12:00', '13:00']) {
      const res = await apply(server, 'emp1', { date: THIRD_DATE, kind: 'in', time, reason: '忘記打卡' });
      assert.equal(res.status, 400, res.text);
      assert.match(res.json.message, /實際上班時間須早於當日下班時間 12:00/);
    }
    assert.deepEqual(rows(server, 'SELECT * FROM makeup_request'), []);
    assert.deepEqual(audit(server), []);

    // A good one: name, department and date applied are the server's; the entered
    // time is stored for the card's half, and clockin/clockout fields are ignored.
    const res = await apply(server, 'emp1', { ...IN_FORM, time: ' 08:45 ', clockin: '06:00', clockout: '23:00', name: 'someone else', department: 'X' });
    assert.equal(res.status, 201, res.text);
    const r = res.json.request;
    assert.equal(r.state, 'pending');
    assert.equal(r.stateLabel, '待審');
    assert.equal(r.name, 'Employee One');
    assert.equal(r.department, 'JEFF');
    assert.equal(r.kindLabel, '上班未打卡');
    assert.equal(r.clockin, '08:45');
    assert.equal(r.clockout, null);
    assert.match(r.appliedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // The card is gone; the other half's card stays and can be filed.
    assert.deepEqual(cardsOn(await mine(server, 'emp1'), DATE), ['out']);
    const again = await apply(server, 'emp1', IN_FORM);
    assert.equal(again.status, 409);
    assert.match(again.json.message, /已有待審或已核准的同類補打卡申請/);
    // A late night clock-out is fine (any time after the start of the shift).
    const out = await apply(server, 'emp1', { date: DATE, kind: 'out', time: '21:15', reason: '忘記打下班' });
    assert.equal(out.status, 201, out.text);
    assert.equal(out.json.request.clockout, '21:15');
    assert.deepEqual(rows(server, 'SELECT kind, clockin, clockout FROM makeup_request ORDER BY request_id'),
      [{ kind: 'in', clockin: '08:45', clockout: null }, { kind: 'out', clockin: null, clockout: '21:15' }]);
    assert.deepEqual(cardsOn(await mine(server, 'emp1'), DATE), []);

    // Pending requests create no punch.
    assert.deepEqual(punches(server).filter((p) => p.date === DATE), []);
  });
});

test('makeup: employees see only their own requests and cards and cannot list or review', async () => {
  await withServer(async (server) => {
    assert.equal((await apply(server, 'emp1', IN_FORM)).status, 201);
    assert.equal((await apply(server, 'emp2', { ...IN_FORM, reason: '系統異常' })).status, 201);

    const one = await mine(server, 'emp1');
    assert.equal(one.status, 200);
    assert.deepEqual(one.json.applicant, { name: 'Employee One', department: 'JEFF' });
    assert.match(one.json.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(one.json.requests.map((r) => [r.name, r.reason]), [['Employee One', '忘記打卡']]);
    // Asking for someone else's makes no difference.
    const sneaky = await server.get('/api/makeup/mine', { ...session('emp1'), id: 'emp2', account2: 'emp2' });
    assert.deepEqual(sneaky.json.requests.map((r) => r.name), ['Employee One']);
    assert.deepEqual(sneaky.json.missing, one.json.missing);
    assert.deepEqual((await mine(server, 'emp2')).json.requests.map((r) => r.name), ['Employee Two']);
    assert.equal((await server.get('/api/makeup/mine', { account: 'emp1', cookie: 'bbbbbbbbbb' })).status, 403);
    assert.equal((await server.get('/api/makeup/mine', {})).status, 400);

    // Admin endpoints are closed to employees.
    assert.equal((await server.get('/api/makeup/requests', session('emp1'))).status, 403);
    assert.equal((await server.get('/api/makeup/audit', { ...session('emp1'), requestId: 1 })).status, 403);
  });
});

test('makeup review: insufficient permission is refused and changes nothing', async () => {
  await withServer(async (server) => {
    const emp = (await apply(server, 'emp1', IN_FORM)).json.request.requestId;
    const adm = fileDirect(server, 'admin2', 'Admin Two', DATE, 'in');
    const own = fileDirect(server, 'admin1', 'Admin One', DATE, 'in');
    const before = rows(server, 'SELECT * FROM makeup_request ORDER BY request_id');

    // Employees, including the applicant.
    assert.equal((await review(server, 'emp1', emp, 'approve')).status, 403);
    assert.equal((await review(server, 'emp2', emp, 'approve')).status, 403);
    // Bad session.
    assert.equal((await server.post('/api/makeup/review', { account: 'admin1', cookie: 'bbbbbbbbbb', requestId: emp, decision: 'approve' })).status, 403);
    // A non-root admin may not decide on an admin's request, nor on their own.
    assert.equal((await review(server, 'admin1', adm, 'approve')).status, 403);
    assert.equal((await review(server, 'admin1', own, 'approve')).status, 403);
    // Malformed input.
    for (const [id, decision] of [[0, 'approve'], ['x', 'approve'], [[emp], 'approve'], [emp, 'maybe'], [emp, undefined]]) {
      assert.equal((await review(server, 'admin1', id, decision)).status, 400, JSON.stringify([id, decision]));
    }
    assert.equal((await review(server, 'admin1', 9999, 'approve')).status, 404);

    assert.deepEqual(rows(server, 'SELECT * FROM makeup_request ORDER BY request_id'), before);
    assert.ok(audit(server).every((a) => a.action === 'submit'));
    for (const id of ['emp1', 'admin1', 'admin2']) assert.deepEqual(punches(server, id), []);

    // The admin list says who may decide what.
    const listed = await server.get('/api/makeup/requests', session('admin1'));
    assert.equal(listed.status, 200);
    const can = Object.fromEntries(listed.json.requests.map((r) => [r.account, r.canReview]));
    assert.deepEqual(can, { emp1: true, admin2: false, admin1: false });
    const rootList = await server.get('/api/makeup/requests', session('root'));
    assert.deepEqual(Object.fromEntries(rootList.json.requests.map((r) => [r.account, r.canReview])), { emp1: true, admin2: true, admin1: true });
    // root may decide on an admin's request.
    assert.equal((await review(server, 'root', adm, 'reject', '請改以人工補正')).status, 200);
  });
});

test('makeup review: rejecting creates no punch; approving creates a make-up punch that counts everywhere', async () => {
  await withServer(async (server) => {
    // emp1 actually clocked out that day but forgot to clock in.
    server.withDb((db) => db.prepare('INSERT INTO clockinrecord (id,name,date,num,clockin,clockout) VALUES (?,?,?,?,?,?)')
      .run('emp1', 'Employee One', DATE, 1, null, '17:40'), { write: true });
    // Generate the month sheet first, so the approval has to refresh it.
    assert.equal((await server.post('/clrecord', { ...session('admin1'), year: YEAR, month: MONTH })).status, 200, server.output());

    const rejected = (await apply(server, 'emp1', { date: OTHER_DATE, kind: 'in', time: '09:10', reason: '出差' })).json.request.requestId;
    const approved = (await apply(server, 'emp1', IN_FORM)).json.request.requestId;

    // Reject needs a reason.
    assert.equal((await review(server, 'admin1', rejected, 'reject', '  ')).status, 400);
    const rej = await review(server, 'admin1', rejected, 'reject', '當日有請假');
    assert.equal(rej.status, 200, rej.text);
    assert.equal(rej.json.status, 'rejected');
    assert.equal(rej.json.request.stateLabel, '駁回');
    assert.equal(rej.json.request.reviewNote, '當日有請假');
    assert.deepEqual(punches(server).filter((p) => p.date === OTHER_DATE), []);
    // A rejected request no longer hides its card.
    assert.deepEqual(cardsOn(await mine(server, 'emp1'), OTHER_DATE), ['in', 'out']);
    // Decided requests cannot be decided again.
    assert.equal((await review(server, 'admin1', rejected, 'approve')).status, 409);
    assert.deepEqual(punches(server).filter((p) => p.date === OTHER_DATE), []);

    // The review page shows the time the employee entered, not the shift time.
    const pendingList = await server.get('/api/makeup/requests', { ...session('admin1'), state: 'pending' });
    const shown = pendingList.json.requests.find((r) => r.requestId === approved);
    assert.deepEqual([shown.clockin, shown.clockout], ['08:45', null]);

    // Approve: the punch gets the entered time.
    const ok = await review(server, 'admin1', approved, 'approve');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.status, 'approved');
    assert.equal(ok.json.masterRefreshed, true);
    const day = punches(server).filter((p) => p.date === DATE);
    assert.deepEqual(day.map((p) => [p.num, p.clockin, p.clockout, p.makeup_request_id]), [[1, null, '17:40', null], [2, '08:45', null, approved]]);
    assert.equal((await review(server, 'admin1', approved, 'approve')).status, 409);
    assert.equal(punches(server).filter((p) => p.date === DATE).length, 2);
    // The approved punch fills the half: no card for DATE any more.
    assert.deepEqual(cardsOn(await mine(server, 'emp1'), DATE), []);

    // Views, the month sheet and the personal PDF all include it, flagged as make-up.
    const view = await server.get('/api/clockin/view', { ...session('admin1'), year: YEAR, month: MONTH, day: Number(DATE.slice(8)) });
    const rec = view.json.records.find((r) => r.id === 'emp1');
    assert.deepEqual([rec.clockin, rec.clockout, rec.makeup], ['08:45', '17:40', true]);
    const month = await server.get('/api/clockin/employee', { ...session('admin1'), year: YEAR, month: MONTH, id: 'emp1' });
    const d = month.json.days.find((x) => x.date === DATE);
    assert.deepEqual([d.clockin, d.clockout, d.makeup], ['08:45', '17:40', true]);
    assert.equal(month.json.days.find((x) => x.date === OTHER_DATE).hasRecord, false);
    assert.deepEqual(rows(server, 'SELECT clockin, clockout FROM clockin_master_row WHERE id = ? AND date = ?', 'emp1', DATE), [{ clockin: '08:45', clockout: '17:40' }]);
    const pdf = await server.get('/api/clockin/personal', { ...session('admin1'), year: YEAR, month: MONTH, id: 'emp1' });
    assert.equal(pdf.status, 200);
    const list = await server.get('/api/clockin/punches', { ...session('admin1'), id: 'emp1', date: DATE });
    assert.deepEqual(list.json.punches.map((p) => [p.num, p.makeup, p.makeupRequestId]), [[1, false, null], [2, true, approved]]);

    // The employee sees the outcome of both.
    const states = Object.fromEntries((await mine(server, 'emp1')).json.requests.map((r) => [r.requestId, r.stateLabel]));
    assert.deepEqual(states, { [rejected]: '駁回', [approved]: '核准' });

    // Audit: who, when, which request, what, why.
    const trail = audit(server);
    assert.deepEqual(trail.map((a) => [a.request_id, a.action, a.actor_id, a.reason]), [
      [rejected, 'submit', 'emp1', '出差'],
      [approved, 'submit', 'emp1', '忘記打卡'],
      [rejected, 'reject', 'admin1', '當日有請假'],
      [approved, 'approve', 'admin1', ''],
    ]);
    assert.ok(trail.every((a) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(a.acted_at)));
    assert.equal(trail[2].actor_name, 'Admin One');
    const api = await server.get('/api/makeup/audit', { ...session('admin1'), requestId: approved });
    assert.deepEqual(api.json.audit.map((a) => a.action), ['submit', 'approve']);
  });
});

test('makeup punch: a later live punch on the same day never fills the make-up row', async () => {
  await inWorkdir(({ load }) => {
    const { sql } = load('plugins/sql.js');
    const db = new sql();
    try {
      const today = new Date();
      const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const id = db.createMakeupRequest({ id: 'emp1', name: 'Employee One', department: 'JEFF' }, { date, kind: 'in', clockin: '08:30', clockout: null, reason: '忘記打卡' });
      assert.equal(db.reviewMakeupRequest(id, 'approve', { id: 'admin1', name: 'Admin One' }, '').result, 'done');
      const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 17, 35);
      db.clockinAction('emp1', -1, at);
      const rowsNow = db.clockinPunches('emp1', date, true);
      assert.deepEqual(rowsNow.map((p) => [p.num, p.clockin, p.clockout, p.makeup]), [[1, '08:30', null, true], [2, null, '17:35', false]]);
    } finally {
      db.close();
    }
  });
});

const NEW_STEPS = ['makeup_request table', 'makeup_audit table', 'clockinrecord makeup_request_id column', 'missed_punch_notice table'];

test('migration: make-up and notice steps run twice without error and keep old rows', async () => {
  await inWorkdir(({ cwd, load }) => {
    const file = path.join(cwd, 'databases', 'loginDatabase.db');
    const raw = new Database(file);
    try {
      const add = raw.prepare('INSERT INTO clockinrecord (id,name,date,num,clockin,clockout) VALUES (?,?,?,?,?,?)');
      add.run('emp1', 'Employee One', '2024-05-02', 1, '08:30', '17:30');
      add.run('emp2', 'Employee Two', '2024-05-03', 1, null, '17:31');
    } finally {
      raw.close();
    }
    const snapshot = () => {
      const db = new Database(file, { readonly: true });
      try {
        return {
          rows: db.prepare('SELECT id, name, date, num, clockin, clockout FROM clockinrecord ORDER BY rowid').all(),
          users: db.prepare('SELECT id, pwd, type, email, name, joinTime, mgroup, permit, status FROM userinfo ORDER BY id').all(),
          tickets: db.prepare('SELECT * FROM requestquery ORDER BY serialnum').all(),
        };
      } finally {
        db.close();
      }
    };
    const before = snapshot();
    const { runMigrations } = load('plugins/migrations.js');
    const db = new Database(file);
    try {
      const first = runMigrations(db);
      assert.deepEqual(first.applied.slice(3), NEW_STEPS);
      assert.deepEqual(runMigrations(db).applied, []);
      assert.deepEqual(runMigrations(db).applied, []);
      const cols = db.prepare('PRAGMA table_info(clockinrecord)').all().map((c) => c.name);
      assert.ok(cols.includes('makeup_request_id'));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clockinrecord WHERE makeup_request_id IS NOT NULL').get().n, 0);
      for (const t of ['makeup_request', 'makeup_audit', 'missed_punch_notice']) {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n, 0, t);
      }
    } finally {
      db.close();
    }
    assert.deepEqual(snapshot(), before);

    // A database that already has the soft-delete steps gets only the new ones.
    const partial = path.join(cwd, 'databases', 'partial.db');
    const p = new Database(partial);
    try {
      p.exec(`CREATE TABLE clockinrecord (id TEXT NOT NULL,name TEXT NOT NULL,date DATETIME,num INT DEFAULT 1,clockin DATETIME,clockout DATETIME,deleted_at TEXT,deleted_by TEXT,delete_reason TEXT);
        CREATE TABLE clockin_punch_audit (audit_id INTEGER PRIMARY KEY);
        CREATE INDEX idx_clockinrecord_id_date ON clockinrecord (id, date);`);
      assert.deepEqual(runMigrations(p).applied, NEW_STEPS);
      assert.deepEqual(runMigrations(p).applied, []);
    } finally {
      p.close();
    }

    // The backend migrates on start-up; twice is fine.
    const { sql } = load('plugins/sql.js');
    for (let i = 0; i < 2; i++) {
      const s = new sql();
      try {
        assert.equal(s.clockinPunches('emp1', '2024-05-02', false).length, 1);
      } finally {
        s.close();
      }
    }
    assert.deepEqual(snapshot(), before);
  });
});

test('makeup across a year boundary: early in January the cards reach back into December and can be filed and approved', async () => {
  // Dates relative to the current year, so the harness calendars (this year
  // and the next) cover them. Working days: weekends off.
  const nextWorkday = (date) => { let d = daysBefore(date, -1); while (isWeekend(d)) d = daysBefore(d, -1); return d; };
  const prevWorkday = (date) => { let d = daysBefore(date, 1); while (isWeekend(d)) d = daysBefore(d, 1); return d; };
  const year = Number(TODAY.slice(0, 4));
  const firstJan = nextWorkday(`${year}-12-31`); // first working day of next year
  const today = nextWorkday(firstJan); // the server's (fake) today
  const lastDec = prevWorkday(`${year + 1}-01-01`);
  const prevDec = prevWorkday(lastDec);
  const earlierDec = prevWorkday(prevDec);
  const windowStart = daysBefore(today, 31);
  const beforeWindow = prevWorkday(windowStart);

  const FAKECLOCK = path.join(__dirname, '..', 'testlib', 'fakeclock.js');
  const server = await startServer({
    env: {
      CLOCKIN_PDF_FONT: FONT, MISSED_PUNCH_CHECK: '0', CALENDAR_DOWNLOAD_DISABLED: '1',
      FAKE_NOW: `${today}T10:00:00+08:00`, NODE_OPTIONS: `--require=${JSON.stringify(FAKECLOCK)}`,
    },
  });
  try {
    // The fixture sessions are stamped with the real time, and every check re-stamps
    // them with it (SQLite now), so make them fresh at the fake time before each call.
    const fresh = (call) => {
      write(server, 'UPDATE logininfo SET createTime = ?', `${today} 09:55:00`);
      return call();
    };
    // Fully punched on the first January workday and prevDec; clock-in only on lastDec.
    for (const date of [firstJan, prevDec]) punch(server, 'emp1', date, '08:20', '17:40');
    punch(server, 'emp1', lastDec, '08:20', null);
    const res = await fresh(() => mine(server, 'emp1'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.today, today);
    const dates = res.json.missing.map((c) => c.date);
    assert.deepEqual(cardsOn(res, firstJan), []);
    assert.deepEqual(cardsOn(res, lastDec), ['out']);
    assert.deepEqual(cardsOn(res, prevDec), []);
    assert.deepEqual(cardsOn(res, earlierDec), ['in', 'out']);
    assert.ok(dates.every((d) => d < today && d >= windowStart && !isWeekend(d)), dates.join());
    assert.ok(!dates.includes(beforeWindow), dates.join());
    assert.deepEqual([...dates].sort().reverse(), dates, 'newest first across the year change');

    const filed = await fresh(() => apply(server, 'emp1', { date: lastDec, kind: 'out', time: '18:20', reason: '忘記打卡' }));
    assert.equal(filed.status, 201, filed.text);
    const outside = await fresh(() => apply(server, 'emp1', { date: beforeWindow, kind: 'in', time: '08:40', reason: '忘記打卡' }));
    assert.equal(outside.status, 409, 'outside the window');
    const approved = await fresh(() => review(server, 'admin1', filed.json.request.requestId, 'approve'));
    assert.equal(approved.status, 200, approved.text);
    assert.deepEqual(cardsOn(await fresh(() => mine(server, 'emp1')), lastDec), []);
    const made = punches(server).filter((p) => p.date === lastDec);
    assert.ok(made.some((p) => p.clockout === '18:20'), JSON.stringify(made));
    assert.equal(await server.alive(), true, server.output());
  } finally {
    await server.stop();
  }
});
