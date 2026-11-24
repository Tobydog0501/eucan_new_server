'use strict';

// /modemp must follow the same account rules as /register.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { startServer, session, BUILD_DIR } = require('../testlib/harness');
const { verifyPassword, isPasswordHash } = require(path.join(BUILD_DIR, 'plugins', 'password.js'));

/** The stored value is a hash (never the password itself) and matches `password`. */
async function assertStoredPassword(server, id, password) {
  const stored = server.withDb((db) => db.prepare('SELECT pwd FROM userinfo WHERE id = ?').get(id)).pwd;
  assert.ok(isPasswordHash(stored), `${id}: stored password is not a hash`);
  assert.notEqual(stored, password);
  assert.equal((await verifyPassword(password, stored)).ok, true, `${id}: stored hash does not match`);
}

function profile(id, extra = {}) {
  return {
    user: id, pwd: `fixture-${id}`, email: `${id}@example.invalid`, name: `Name ${id}`,
    date: '2020-01-01', type: 'employee', mgroup: 0, permit: 1, status: 1, ...extra,
  };
}

function row(server, id) {
  return server.withDb((db) => db.prepare('SELECT id, pwd, type, status FROM userinfo WHERE id = ?').get(id));
}

test('/modemp: a non-root admin cannot grant admin or touch admin/built-in accounts', async () => {
  const server = await startServer();
  try {
    const snapshot = ['emp1', 'root', 'admin2', 'admin1'].map((id) => row(server, id));
    const cases = [
      profile('emp1', { type: 'admin' }),
      profile('root', { type: 'admin', pwd: 'changed' }),
      profile('root', { type: 'admin', status: 0, leaveDate: '2026-01-01' }),
      profile('admin2', { type: 'admin', pwd: 'changed' }),
      profile('admin2', { type: 'employee' }),
      profile('admin1', { type: 'admin', pwd: 'changed' }),
    ];
    for (const body of cases) {
      const res = await server.post('/modemp', { ...session('admin1'), ...body });
      assert.equal(res.status, 403, `${JSON.stringify(body)} -> ${res.status}`);
    }
    assert.deepEqual(['emp1', 'root', 'admin2', 'admin1'].map((id) => row(server, id)), snapshot);
  } finally {
    await server.stop();
  }
});

test('/modemp: a non-root admin can still edit employees', async () => {
  const server = await startServer();
  try {
    const res = await server.post('/modemp', { ...session('admin1'), ...profile('emp1', { pwd: 'new-emp1', name: 'Renamed' }) });
    assert.equal(res.status, 200, res.text);
    const { pwd, ...rest } = row(server, 'emp1');
    assert.deepEqual(rest, { id: 'emp1', type: 'employee', status: 1 });
    await assertStoredPassword(server, 'emp1', 'new-emp1');
    assert.equal((await server.post('/login', { account: 'emp1', pwd: 'new-emp1' })).status, 200);
    assert.equal((await server.post('/login', { account: 'emp1', pwd: 'fixture-emp1' })).status, 403);
  } finally {
    await server.stop();
  }
});

test('/modemp: root can grant admin, but cannot demote or deactivate root', async () => {
  const server = await startServer();
  try {
    assert.equal((await server.post('/modemp', { ...session('root'), ...profile('emp1', { type: 'admin' }) })).status, 200);
    assert.equal(row(server, 'emp1').type, 'admin');

    assert.equal((await server.post('/modemp', { ...session('root'), ...profile('root', { type: 'employee' }) })).status, 400);
    assert.equal((await server.post('/modemp', { ...session('root'), ...profile('root', { type: 'admin', status: 0, leaveDate: '2026-01-01' }) })).status, 400);
    assert.deepEqual(row(server, 'root'), { id: 'root', pwd: 'fixture-root', type: 'admin', status: 1 });

    assert.equal((await server.post('/modemp', { ...session('root'), ...profile('root', { type: 'admin', pwd: 'new-root' }) })).status, 200);
    await assertStoredPassword(server, 'root', 'new-root');
  } finally {
    await server.stop();
  }
});

test('/modemp: unknown types, unknown users and non-scalar fields are rejected', async () => {
  const server = await startServer();
  try {
    assert.equal((await server.post('/modemp', { ...session('root'), ...profile('emp1', { type: 'superuser' }) })).status, 400);
    assert.equal((await server.post('/modemp', { ...session('root'), ...profile('nobody') })).status, 404);
    assert.equal((await server.post('/modemp', { ...session('root'), ...profile('emp1', { status: [1] }) })).status, 400);
    assert.equal((await server.post('/modemp', { ...session('root'), ...profile('emp1', { pwd: ['x'] }) })).status, 400);
    assert.equal((await server.post('/modemp', { ...session('emp2'), ...profile('emp1') })).status, 403);
    assert.equal(row(server, 'emp1').type, 'employee');
  } finally {
    await server.stop();
  }
});
