'use strict';

// Make-up punch (補登) requests: form validation, who may see and review
// what, that only an approval creates a punch (flagged as make-up) which then
// counts in the views and the month sheet, the audit trail, and the migration.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, inWorkdir, session } = require('../testlib/harness');

const PAST_YEAR = new Date().getFullYear() - 1;
const MONTH = '04';
function weekday(year, month, nth) {
  let seen = 0;
  for (let day = 1; day <= 28; day++) {
    const dow = new Date(year, Number(month) - 1, day).getDay();
    if (dow >= 1 && dow <= 5 && ++seen === nth) return `${year}-${month}-${String(day).padStart(2, '0')}`;
  }
  throw new Error('unreachable');
}
const DATE = weekday(PAST_YEAR, MONTH, 2);
const OTHER_DATE = weekday(PAST_YEAR, MONTH, 3);
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
const punches = (server, id = 'emp1') => rows(server, 'SELECT * FROM clockinrecord WHERE id = ? ORDER BY date, num', id);
const audit = (server) => rows(server, 'SELECT request_id, action, actor_id, actor_name, reason, acted_at FROM makeup_audit ORDER BY audit_id');

const IN_FORM = { date: DATE, kind: 'in', clockin: '08:30', reason: '忘記打卡' };

test('makeup apply: fields are checked by category and nothing is stored on a bad form', async () => {
  await withServer(async (server) => {
    const bad = [
      [{ ...IN_FORM, reason: '' }, '原因'],
      [{ ...IN_FORM, reason: '   ' }, '原因'],
      [{ ...IN_FORM, reason: 'x'.repeat(201) }, '原因'],
      [{ ...IN_FORM, clockin: '' }, '上班時間'],
      [{ ...IN_FORM, clockin: '8:30' }, '上班時間'],
      [{ date: DATE, kind: 'out', clockin: '08:30', reason: 'x' }, '下班時間'],
      [{ date: DATE, kind: 'both', clockin: '08:30', reason: 'x' }, '下班時間'],
      [{ date: DATE, kind: 'both', clockout: '17:30', reason: 'x' }, '上班時間'],
      [{ date: DATE, kind: 'both', clockin: '17:30', clockout: '08:30', reason: 'x' }, '晚於'],
      [{ ...IN_FORM, kind: 'lunch' }, '類別'],
      [{ ...IN_FORM, date: `${PAST_YEAR}-02-30` }, '日期'],
      [{ ...IN_FORM, date: `${PAST_YEAR + 2}-01-05` }, '晚於今天'],
    ];
    for (const [form, word] of bad) {
      const res = await apply(server, 'emp1', form);
      assert.equal(res.status, 400, JSON.stringify(form));
      assert.ok(res.json && res.json.message.includes(word), `${JSON.stringify(form)} -> ${res.text}`);
    }
    assert.equal((await apply(server, 'emp1', { ...IN_FORM, cookie: 'bbbbbbbbbb' })).status, 403);
    assert.deepEqual(rows(server, 'SELECT * FROM makeup_request'), []);
    assert.deepEqual(audit(server), []);

    // A good one: name, department and application date are filled in by the server;
    // a time the category does not ask for is dropped.
    const res = await apply(server, 'emp1', { ...IN_FORM, clockout: '17:30', name: 'someone else' });
    assert.equal(res.status, 201, res.text);
    const r = res.json.request;
    assert.equal(r.state, 'pending');
    assert.equal(r.stateLabel, '待審');
    assert.equal(r.name, 'Employee One');
    assert.equal(r.department, 'JEFF');
    assert.equal(r.kindLabel, '上班未打卡');
    assert.equal(r.clockin, '08:30');
    assert.equal(r.clockout, null);
    assert.match(r.appliedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // The same half of the same day cannot be filed twice while pending; the other half can.
    assert.equal((await apply(server, 'emp1', IN_FORM)).status, 409);
    assert.equal((await apply(server, 'emp1', { date: DATE, kind: 'both', clockin: '08:30', clockout: '17:30', reason: 'x' })).status, 409);
    assert.equal((await apply(server, 'emp1', { date: DATE, kind: 'out', clockout: '17:45', reason: '忘記打下班' })).status, 201);

    // Pending requests create no punch.
    assert.deepEqual(punches(server), []);
  });
});

test('makeup: employees see only their own requests and cannot list or review', async () => {
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
    assert.deepEqual((await mine(server, 'emp2')).json.requests.map((r) => r.name), ['Employee Two']);
    assert.equal((await server.get('/api/makeup/mine', { account: 'emp1', cookie: 'bbbbbbbbbb' })).status, 403);

    // Admin endpoints are closed to employees.
    assert.equal((await server.get('/api/makeup/requests', session('emp1'))).status, 403);
    assert.equal((await server.get('/api/makeup/audit', { ...session('emp1'), requestId: 1 })).status, 403);
  });
});

test('makeup review: insufficient permission is refused and changes nothing', async () => {
  await withServer(async (server) => {
    const emp = (await apply(server, 'emp1', IN_FORM)).json.request.requestId;
    const adm = (await apply(server, 'admin2', IN_FORM)).json.request.requestId;
    const own = (await apply(server, 'admin1', IN_FORM)).json.request.requestId;
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
    assert.equal((await server.post('/clrecord', { ...session('admin1'), year: PAST_YEAR, month: Number(MONTH) })).status, 200, server.output());

    const rejected = (await apply(server, 'emp1', { date: OTHER_DATE, kind: 'both', clockin: '08:30', clockout: '17:30', reason: '出差' })).json.request.requestId;
    const approved = (await apply(server, 'emp1', IN_FORM)).json.request.requestId;

    // Reject needs a reason.
    assert.equal((await review(server, 'admin1', rejected, 'reject', '  ')).status, 400);
    const rej = await review(server, 'admin1', rejected, 'reject', '當日有請假');
    assert.equal(rej.status, 200, rej.text);
    assert.equal(rej.json.status, 'rejected');
    assert.equal(rej.json.request.stateLabel, '駁回');
    assert.equal(rej.json.request.reviewNote, '當日有請假');
    assert.deepEqual(punches(server).filter((p) => p.date === OTHER_DATE), []);
    // Decided requests cannot be decided again.
    assert.equal((await review(server, 'admin1', rejected, 'approve')).status, 409);
    assert.deepEqual(punches(server).filter((p) => p.date === OTHER_DATE), []);

    // Approve.
    const ok = await review(server, 'admin1', approved, 'approve');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.status, 'approved');
    assert.equal(ok.json.masterRefreshed, true);
    const day = punches(server).filter((p) => p.date === DATE);
    assert.deepEqual(day.map((p) => [p.num, p.clockin, p.clockout, p.makeup_request_id]), [[1, null, '17:40', null], [2, '08:30', null, approved]]);
    assert.equal((await review(server, 'admin1', approved, 'approve')).status, 409);
    assert.equal(punches(server).filter((p) => p.date === DATE).length, 2);

    // Views, the month sheet and the personal PDF all include it, flagged as make-up.
    const view = await server.get('/api/clockin/view', { ...session('admin1'), year: PAST_YEAR, month: Number(MONTH), day: Number(DATE.slice(8)) });
    const rec = view.json.records.find((r) => r.id === 'emp1');
    assert.deepEqual([rec.clockin, rec.clockout, rec.makeup], ['08:30', '17:40', true]);
    const month = await server.get('/api/clockin/employee', { ...session('admin1'), year: PAST_YEAR, month: Number(MONTH), id: 'emp1' });
    const d = month.json.days.find((x) => x.date === DATE);
    assert.deepEqual([d.clockin, d.clockout, d.makeup], ['08:30', '17:40', true]);
    assert.equal(month.json.days.find((x) => x.date === OTHER_DATE).hasRecord, false);
    assert.deepEqual(rows(server, 'SELECT clockin, clockout FROM clockin_master_row WHERE id = ? AND date = ?', 'emp1', DATE), [{ clockin: '08:30', clockout: '17:40' }]);
    const pdf = await server.get('/api/clockin/personal', { ...session('admin1'), year: PAST_YEAR, month: Number(MONTH), id: 'emp1' });
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
