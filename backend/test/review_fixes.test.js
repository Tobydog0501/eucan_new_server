'use strict';

// Follow-ups from the PR #28 review: timestamp shape on leave input, role
// checks on /delete, /approved and /query, and /tmodify's quota / year sync.

const test = require('node:test');
const assert = require('node:assert');
const { startServer, inWorkdir, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();
const PENDING = `${YEAR}0000`; // emp1, 事假, pending
const APPROVED = `${YEAR}0001`; // emp2, 病假, approved

function usage(server, id, year = YEAR) {
  return server.withDb((db) => db.prepare('SELECT * FROM dayoffinfo WHERE id = ? AND year = ?').get(id, String(year)));
}

function ticket(server, num) {
  return server.withDb((db) => db.prepare('SELECT * FROM requestquery WHERE serialnum = ?').get(num));
}

function userExists(server, id) {
  return server.withDb((db) => db.prepare('SELECT id FROM userinfo WHERE id = ?').get(id)) !== undefined;
}

/** First Monday-to-Friday day of March in `year`, as "YYYY-MM-DD". */
function weekdayInMarch(year) {
  for (let day = 2; day <= 31; day++) {
    const d = new Date(year, 2, day);
    if (d.getDay() >= 1 && d.getDay() <= 5) return `${year}-03-${String(day).padStart(2, '0')}`;
  }
  throw new Error('unreachable');
}

function edit(extra) {
  return {
    ...session('admin1'), serialnum: APPROVED, action: 1, state: 1, type: '病假', reason: 'edited',
    start: `${YEAR}-03-03 08:30`, end: `${YEAR}-03-03 12:00`, ...extra,
  };
}

test('leave_input: only zero-padded timestamps with valid seconds are accepted', async () => {
  await inWorkdir(({ load }) => {
    const { parseLeaveTime, validTime, validRange, normalizeLeaveTime } = load('plugins/leave_input.js');
    for (const bad of ['2026-3-4 08:30', '2026-03-4 08:30', '2026-03-04 8:30', '2026-03-04 08:30:99', '2026-03-04 08:30:60', '2026-03-04 08:30:5']) {
      assert.equal(parseLeaveTime(bad), null, bad);
      assert.equal(validTime(bad), false, bad);
      assert.equal(normalizeLeaveTime(bad), null, bad);
    }
    assert.equal(validRange('2026-3-4 08:30', '2026-03-04 17:30').ok, false);
    assert.ok(parseLeaveTime('2026-03-04 08:30:59') instanceof Date);
    assert.equal(normalizeLeaveTime('2026-03-04 08:30:59'), '2026-03-04 08:30');
    assert.equal(normalizeLeaveTime('2026-03-04 08:30'), '2026-03-04 08:30');
  });
});

test('/request and /tmodify: non-padded or out-of-range timestamps are refused, seconds are dropped', async () => {
  const server = await startServer();
  try {
    const req = await server.post('/request', {
      ...session('emp1'), type: '事假', start: `${YEAR}-3-4 08:30`, end: `${YEAR}-3-4 17:30`, reason: 'x',
    });
    // /request has always answered 403 for a boundary it does not accept.
    assert.equal(req.status, 403, req.text);
    assert.equal(server.withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM requestquery').get()).n, 2);

    const before = ticket(server, APPROVED);
    for (const start of [`${YEAR}-3-3 08:30`, `${YEAR}-03-03 08:30:99`]) {
      const res = await server.post('/tmodify', edit({ start }));
      assert.equal(res.status, 400, `${start} -> ${res.status} ${res.text}`);
    }
    assert.deepEqual(ticket(server, APPROVED), before);

    const ok = await server.post('/tmodify', edit({ start: `${YEAR}-03-03 08:30:00`, end: `${YEAR}-03-03 12:00:30` }));
    assert.equal(ok.status, 200, ok.text);
    const t = ticket(server, APPROVED);
    assert.equal(t.start, `${YEAR}-03-03 08:30`);
    assert.equal(t.end, `${YEAR}-03-03 12:00`);
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

test('/delete: built-in accounts are protected and only root may delete admins', async () => {
  const server = await startServer();
  try {
    const del = (actor, user) => server.post('/delete', { ...session(actor), user });

    assert.equal((await del('emp1', 'emp2')).status, 403);
    assert.equal((await del('admin1', 'admin2')).status, 403);
    assert.equal((await del('admin1', 'root')).status, 403);
    assert.equal((await del('root', 'root')).status, 403);
    assert.equal((await del('admin1', 'nobody')).status, 404);
    assert.equal((await server.post('/delete', { ...session('admin1'), user: ['emp1'] })).status, 400);
    assert.ok(userExists(server, 'admin2'));
    assert.ok(userExists(server, 'root'));
    assert.ok(userExists(server, 'emp2'));

    assert.equal((await del('admin1', 'emp1')).status, 200);
    assert.equal(userExists(server, 'emp1'), false);
    assert.equal((await del('root', 'admin2')).status, 200);
    assert.equal(userExists(server, 'admin2'), false);
  } finally {
    await server.stop();
  }
});

test('/approved and /query: admin only', async () => {
  const server = await startServer();
  try {
    for (const route of ['/approved', '/query']) {
      const asEmployee = await server.post(route, { ...session('emp1') });
      assert.equal(asEmployee.status, 403, `${route} as employee -> ${asEmployee.status}`);
      const asAdmin = await server.post(route, { ...session('admin1') });
      assert.equal(asAdmin.status, 200, `${route} as admin -> ${asAdmin.status} ${asAdmin.text}`);
      assert.ok(Array.isArray(asAdmin.json.data));
    }
    // limit 0 is not "no limit"; month must be 1-12.
    assert.equal((await server.post('/approved', { ...session('admin1'), limit: '0' })).status, 400);
    assert.equal((await server.post('/approved', { ...session('admin1'), month: '13' })).status, 400);
  } finally {
    await server.stop();
  }
});

test('/tmodify: editing into a year with no usage row does not crash', async () => {
  const server = await startServer();
  try {
    server.withDb((db) => db.prepare('DELETE FROM dayoffinfo WHERE id = ?').run('emp2'), { write: true });

    const sick = await server.post('/tmodify', edit({}));
    assert.equal(sick.status, 200, sick.text);
    assert.equal(usage(server, 'emp2').sick, ticket(server, APPROVED).totalTime);

    server.withDb((db) => db.prepare('DELETE FROM dayoffinfo WHERE id = ?').run('emp2'), { write: true });
    const annual = await server.post('/tmodify', edit({ type: '特休假' }));
    assert.equal(annual.status, 200, annual.text);
    const row = usage(server, 'emp2');
    assert.equal(row.annual, ticket(server, APPROVED).totalTime);
    assert.equal(row.sick, 0);
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

test('/tmodify: annual quota is only checked for 特休假 and counts the old copy only once', async () => {
  const server = await startServer();
  try {
    // emp2 has used a lot of annual leave: a sick-leave edit must still pass.
    server.withDb((db) => db.prepare('UPDATE dayoffinfo SET annual = 1000 WHERE id = ?').run('emp2'), { write: true });
    const sick = await server.post('/tmodify', edit({}));
    assert.equal(sick.status, 200, sick.text);

    // ...but switching the ticket to annual leave exceeds the quota.
    server.withDb((db) => db.prepare('UPDATE dayoffinfo SET annual = 1000 WHERE id = ?').run('emp2'), { write: true });
    const before = ticket(server, APPROVED);
    const annual = await server.post('/tmodify', edit({ type: '特休假' }));
    assert.equal(annual.status, 403, annual.text);
    assert.deepEqual(ticket(server, APPROVED), before);
  } finally {
    await server.stop();
  }
});

test('/tmodify: moving a ticket to another leave year re-syncs both years', async () => {
  const server = await startServer();
  try {
    const day = weekdayInMarch(YEAR - 1);
    const res = await server.post('/tmodify', edit({ start: `${day} 08:30`, end: `${day} 12:00` }));
    assert.equal(res.status, 200, res.text);
    const t = ticket(server, APPROVED);
    assert.equal(t.year, String(YEAR - 1));
    assert.equal(String(t.month), '3');
    assert.ok(t.totalTime > 0);
    assert.equal(usage(server, 'emp2', YEAR - 1).sick, t.totalTime);
    assert.equal(usage(server, 'emp2', YEAR).sick, 0);
  } finally {
    await server.stop();
  }
});
