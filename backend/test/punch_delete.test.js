'use strict';

// Soft delete of single clock-in punches (issue #30): who may delete or
// restore, what the views and exports count afterwards, the audit trail, and
// the schema migration that adds the columns.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { startServer, inWorkdir, session, BUILD_DIR } = require('../testlib/harness');

const YEAR = new Date().getFullYear();
// A past month whose master sheet the start-up archive job never writes.
const PAST_YEAR = YEAR - 1;
const MONTH = '03';
const FONT = path.join(__dirname, '..', 'fonts', 'NotoSansTC-Regular.otf');

function weekday(year, month) {
  for (let day = 2; day <= 28; day++) {
    const d = new Date(year, Number(month) - 1, day);
    if (d.getDay() >= 1 && d.getDay() <= 5) return `${year}-${month}-${String(day).padStart(2, '0')}`;
  }
  throw new Error('unreachable');
}
const DATE = weekday(PAST_YEAR, MONTH);
const DAY = Number(DATE.slice(8, 10));

/** emp1: a stray early clock-in (#1) and the real day (#2). admin2: one punch. */
function seedPunches(server) {
  server.withDb((db) => {
    const add = db.prepare('INSERT INTO clockinrecord (id,name,date,num,clockin,clockout) VALUES (?,?,?,?,?,?)');
    add.run('emp1', 'Employee One', DATE, 1, '07:05', null);
    add.run('emp1', 'Employee One', DATE, 2, '08:25', '17:40');
    add.run('admin2', 'Admin Two', DATE, 1, '08:30', '17:30');
  }, { write: true });
}

function punchRows(server, id = 'emp1') {
  return server.withDb((db) => db.prepare('SELECT * FROM clockinrecord WHERE id = ? AND date = ? ORDER BY num').all(id, DATE));
}

function auditRows(server) {
  return server.withDb((db) => db.prepare('SELECT * FROM clockin_punch_audit ORDER BY audit_id').all());
}

function get(server, route, who, query) {
  return server.get(route, { ...session(who), ...query });
}

function del(server, who, extra = {}) {
  return server.post('/api/clockin/punch/delete', { ...session(who), id: 'emp1', date: DATE, num: 1, reason: '誤打', ...extra });
}

function restore(server, who, extra = {}) {
  return server.post('/api/clockin/punch/restore', { ...session(who), id: 'emp1', date: DATE, num: 1, reason: '刪錯了', ...extra });
}

async function dayView(server) {
  const res = await get(server, '/api/clockin/view', 'admin1', { year: PAST_YEAR, month: Number(MONTH), day: DAY });
  assert.equal(res.status, 200, res.text);
  return res.json.records.find((r) => r.id === 'emp1');
}

async function monthDay(server) {
  const res = await get(server, '/api/clockin/employee', 'admin1', { year: PAST_YEAR, month: Number(MONTH), id: 'emp1' });
  assert.equal(res.status, 200, res.text);
  return res.json.days.find((d) => d.date === DATE);
}

function masterRow(server) {
  return server.withDb((db) => db.prepare('SELECT clockin, clockout FROM clockin_master_row WHERE year = ? AND month = ? AND id = ? AND date = ?')
    .get(String(PAST_YEAR), MONTH, 'emp1', DATE));
}

async function withServer(fn) {
  const server = await startServer({ env: { CLOCKIN_PDF_FONT: FONT } });
  try {
    seedPunches(server);
    await fn(server);
    assert.equal(await server.alive(), true, server.output());
  } finally {
    await server.stop();
  }
}

test('punch delete/restore: employees, other admins and bad input are refused and change nothing', async () => {
  await withServer(async (server) => {
    const before = [punchRows(server), punchRows(server, 'admin2')];

    // Employees may not delete, not even their own punch.
    assert.equal((await del(server, 'emp1')).status, 403);
    // Bad or missing session.
    assert.equal((await del(server, 'emp1', { cookie: 'bbbbbbbbbb' })).status, 403);
    assert.equal((await server.post('/api/clockin/punch/delete', { id: 'emp1', date: DATE, num: 1, reason: 'x' })).status, 400);
    // Only root may delete an admin's punch (same rule as deleting accounts).
    assert.equal((await del(server, 'admin1', { id: 'admin2' })).status, 403);
    // Reason is required.
    for (const reason of [undefined, '', '   ', 5]) {
      const res = await del(server, 'admin1', { reason });
      assert.equal(res.status, 400, `reason ${JSON.stringify(reason)}`);
    }
    assert.equal((await del(server, 'admin1', { reason: 'x'.repeat(201) })).status, 400);
    // Malformed keys.
    for (const extra of [{ num: 0 }, { num: 'a' }, { num: [1] }, { date: '2026-02-30' }, { date: `${PAST_YEAR}-3-2` }, { id: '' }, { id: ['emp1'] }]) {
      assert.equal((await del(server, 'admin1', extra)).status, 400, JSON.stringify(extra));
    }
    // Only root may restore; nobody may list punches without being an admin.
    assert.equal((await restore(server, 'admin1')).status, 403);
    assert.equal((await restore(server, 'emp1')).status, 403);
    assert.equal((await get(server, '/api/clockin/punches', 'emp1', { id: 'emp1', date: DATE })).status, 403);

    assert.deepEqual([punchRows(server), punchRows(server, 'admin2')], before);
    assert.deepEqual(auditRows(server), []);

    // A punch that does not exist is a 404, not a silent success.
    assert.equal((await del(server, 'admin1', { num: 9 })).status, 404);
    assert.deepEqual(auditRows(server), []);
  });
});

test('punch delete: views, month sheet and exports stop counting the punch; audit is written', async () => {
  await withServer(async (server) => {
    const clr = await server.post('/clrecord', { ...session('admin1'), year: PAST_YEAR, month: Number(MONTH) });
    assert.equal(clr.status, 200, server.output());
    assert.equal((await dayView(server)).clockin, '07:05');
    assert.deepEqual(masterRow(server), { clockin: '07:05', clockout: '17:40' });

    const res = await del(server, 'admin1', { reason: '  多按了一次上班  ' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, 'deleted');
    assert.equal(res.json.masterRefreshed, true);

    // Row is kept and marked, not removed.
    const [first, second] = punchRows(server);
    assert.equal(first.clockin, '07:05');
    assert.match(first.deleted_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(first.deleted_by, 'admin1');
    assert.equal(first.delete_reason, '多按了一次上班');
    assert.equal(second.deleted_at, null);

    // Day view, employee month view and the stored month sheet.
    const view = await dayView(server);
    assert.equal(view.clockin, '08:25');
    assert.equal(view.clockout, '17:40');
    const day = await monthDay(server);
    assert.equal(day.clockin, '08:25');
    assert.deepEqual(masterRow(server), { clockin: '08:25', clockout: '17:40' });
    // Regenerating by hand gives the same sheet, and the personal PDF exports.
    assert.equal((await server.post('/clrecord', { ...session('admin1'), year: PAST_YEAR, month: Number(MONTH) })).status, 200);
    assert.deepEqual(masterRow(server), { clockin: '08:25', clockout: '17:40' });
    const pdf = await get(server, '/api/clockin/personal', 'admin1', { year: PAST_YEAR, month: Number(MONTH), id: 'emp1' });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');

    // Admins see only live punches and no audit trail.
    const listed = await get(server, '/api/clockin/punches', 'admin1', { id: 'emp1', date: DATE });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.canRestore, false);
    assert.deepEqual(listed.json.punches.map((p) => p.num), [2]);
    assert.deepEqual(listed.json.audit, []);

    // Deleting it again is a 404 and writes no second audit row.
    assert.equal((await del(server, 'admin1')).status, 404);

    const audit = auditRows(server);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'delete');
    assert.equal(audit[0].punch_id, 'emp1');
    assert.equal(audit[0].punch_date, DATE);
    assert.equal(audit[0].punch_num, 1);
    assert.equal(audit[0].clockin, '07:05');
    assert.equal(audit[0].clockout, null);
    assert.equal(audit[0].actor_id, 'admin1');
    assert.equal(audit[0].actor_name, 'Admin One');
    assert.equal(audit[0].reason, '多按了一次上班');
    assert.match(audit[0].acted_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

test('punch delete: a year whose only punch was deleted drops out of the year list', async () => {
  await withServer(async (server) => {
    const old = `${YEAR - 5}-06-03`;
    server.withDb((db) => db.prepare('INSERT INTO clockinrecord (id,name,date,num,clockin) VALUES (?,?,?,?,?)').run('emp2', 'Employee Two', old, 1, '08:30'), { write: true });
    const years = async () => (await get(server, '/api/clockin/years', 'admin1', {})).json.years;
    assert.ok((await years()).includes(YEAR - 5));
    const res = await del(server, 'admin1', { id: 'emp2', date: old });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.masterRefreshed, false);
    assert.ok(!(await years()).includes(YEAR - 5));
  });
});

test('punch restore: root sees deleted punches and the audit trail, and can restore', async () => {
  await withServer(async (server) => {
    assert.equal((await del(server, 'admin1')).status, 200);
    // root may also delete an admin's punch.
    assert.equal((await del(server, 'root', { id: 'admin2', reason: 'test' })).status, 200);

    const listed = await get(server, '/api/clockin/punches', 'root', { id: 'emp1', date: DATE });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.canRestore, true);
    const deleted = listed.json.punches.find((p) => p.num === 1);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.deletedBy, 'admin1');
    assert.equal(deleted.deleteReason, '誤打');
    assert.equal(listed.json.audit.length, 1);

    // Reason is required for a restore as well.
    assert.equal((await restore(server, 'root', { reason: '' })).status, 400);
    const res = await restore(server, 'root');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, 'restored');
    const [first] = punchRows(server);
    assert.equal(first.deleted_at, null);
    assert.equal(first.deleted_by, null);
    assert.equal(first.delete_reason, null);
    assert.equal((await dayView(server)).clockin, '07:05');

    // Nothing left to restore.
    assert.equal((await restore(server, 'root')).status, 404);

    const audit = auditRows(server).filter((a) => a.punch_id === 'emp1');
    assert.deepEqual(audit.map((a) => [a.action, a.actor_id, a.reason]), [['delete', 'admin1', '誤打'], ['restore', 'root', '刪錯了']]);
  });
});

test('clockinAction: deleted punches are hidden and their number is never reused', async () => {
  await inWorkdir(({ load }) => {
    const { sql } = load('plugins/sql.js');
    const db = new sql();
    try {
      const at = (hh, mm) => new Date(PAST_YEAR, Number(MONTH) - 1, DAY, hh, mm);
      db.clockinAction('emp1', 1, at(7, 5));
      assert.equal(db.softDeletePunch({ id: 'emp1', date: DATE, num: 1 }, { id: 'admin1', name: 'Admin One' }, '誤打'), 'done');
      assert.deepEqual(db.clockinAction('emp1', 0, at(9, 0)), []);

      // The next clock-in must not fill the deleted row; it gets #2.
      db.clockinAction('emp1', 1, at(8, 25));
      db.clockinAction('emp1', -1, at(17, 40));
      const live = db.clockinAction('emp1', 0, at(18, 0));
      assert.deepEqual(live.map((r) => [r.num, r.clockin, r.clockout]), [[2, '08:25', '17:40']]);
      assert.ok(live.every((r) => !('deleted_at' in r)));
      assert.equal(db.clockinPunches('emp1', DATE, true).length, 2);
      // Restoring brings #1 back next to #2 without a clash.
      assert.equal(db.restorePunch({ id: 'emp1', date: DATE, num: 1 }, { id: 'root', name: 'Root' }, 'ok'), 'done');
      assert.deepEqual(db.clockinAction('emp1', 0, at(18, 0)).map((r) => r.num), [1, 2]);
    } finally {
      db.close();
    }
  });
});

test('clockin punches: legacy duplicate rows are refused instead of deleted together', async () => {
  await inWorkdir(({ load }) => {
    const { sql } = load('plugins/sql.js');
    const db = new sql();
    try {
      const raw = new Database(path.join(process.cwd(), 'databases', 'loginDatabase.db'));
      try {
        const add = raw.prepare('INSERT INTO clockinrecord (id,name,date,num,clockin) VALUES (?,?,?,?,?)');
        add.run('emp2', 'Employee Two', DATE, 1, '08:00');
        add.run('emp2', 'Employee Two', DATE, 1, '08:01');
      } finally {
        raw.close();
      }
      assert.equal(db.softDeletePunch({ id: 'emp2', date: DATE, num: 1 }, { id: 'admin1', name: 'A' }, 'x'), 'ambiguous');
      assert.equal(db.clockinPunches('emp2', DATE, true).filter((p) => p.deleted).length, 0);
      assert.deepEqual(db.punchAudit(), []);
    } finally {
      db.close();
    }
  });
});

const LEGACY_COLUMNS = 'id, name, date, num, clockin, clockout';

test('migration: runs twice without error and keeps legacy rows intact', async () => {
  await inWorkdir(({ cwd, load }) => {
    const file = path.join(cwd, 'databases', 'loginDatabase.db');
    // The seeded database has the pre-#30 clockinrecord table; add legacy rows.
    const legacy = new Database(file);
    try {
      const cols = legacy.prepare('PRAGMA table_info(clockinrecord)').all().map((c) => c.name);
      assert.ok(!cols.includes('deleted_at'), 'fixture should start without the new columns');
      const add = legacy.prepare('INSERT INTO clockinrecord (id,name,date,num,clockin,clockout) VALUES (?,?,?,?,?,?)');
      add.run('emp1', 'Employee One', '2024-05-02', 1, '08:30', '17:30');
      add.run('emp1', 'Employee One', '2024-05-02', 2, '18:00', null);
      add.run('emp2', 'Employee Two', '2024-05-03', 1, null, '17:31');
    } finally {
      legacy.close();
    }
    const snapshot = () => {
      const db = new Database(file, { readonly: true });
      try {
        return {
          rows: db.prepare(`SELECT ${LEGACY_COLUMNS} FROM clockinrecord ORDER BY rowid`).all(),
          // Fixed columns: the backend's own start-up adds userinfo.leaveDate.
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
      assert.deepEqual(first.applied, ['clockinrecord soft-delete columns', 'clockin_punch_audit table', 'clockinrecord (id, date) index']);
      const second = runMigrations(db);
      assert.deepEqual(second.applied, []);
      const cols = db.prepare('PRAGMA table_info(clockinrecord)').all().map((c) => c.name);
      for (const c of ['deleted_at', 'deleted_by', 'delete_reason']) assert.ok(cols.includes(c), c);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clockinrecord WHERE deleted_at IS NOT NULL OR deleted_by IS NOT NULL OR delete_reason IS NOT NULL').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clockin_punch_audit').get().n, 0);
    } finally {
      db.close();
    }
    assert.deepEqual(snapshot(), before);

    // Starting the backend (which migrates in the constructor) twice on the
    // migrated file is fine too, and legacy rows are still all live.
    const { sql } = load('plugins/sql.js');
    for (let i = 0; i < 2; i++) {
      const s = new sql();
      try {
        assert.equal(s.clockinPunches('emp1', '2024-05-02', false).length, 2);
      } finally {
        s.close();
      }
    }
    assert.deepEqual(snapshot(), before);
  });
});

test('migration CLI: `migrate.js <file>` upgrades a database and is a no-op the second time', async () => {
  await inWorkdir(({ cwd }) => {
    const file = path.join(cwd, 'databases', 'loginDatabase.db');
    const cli = path.join(BUILD_DIR, 'migrate.js');
    const run = () => execFileSync(process.execPath, [cli, file], { cwd, encoding: 'utf8' });
    assert.match(run(), /applied clockinrecord soft-delete columns/);
    assert.match(run(), /schema already up to date/);
    assert.throws(() => execFileSync(process.execPath, [cli, path.join(cwd, 'nope.db')], { cwd, stdio: 'pipe' }));
    assert.ok(!fs.existsSync(path.join(cwd, 'nope.db')), 'must not create a missing database');
  });
});
