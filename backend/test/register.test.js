'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer, session } = require('../testlib/harness');

function newAccount(id, extra = {}) {
  return {
    user: id,
    pwd: 'fixture-new',
    mail: `${id}@example.invalid`,
    name: `Name ${id}`,
    date: '2024-01-01',
    mgroup: '0',
    permit: '1',
    ...extra,
  };
}

function userRow(server, id) {
  const db = server.db();
  try {
    return db.prepare('SELECT id, type FROM userinfo WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

test('/register: employees cannot create accounts', async () => {
  const server = await startServer();
  try {
    const asEmployee = await server.post('/register', { ...session('emp1'), ...newAccount('x100') });
    assert.equal(asEmployee.status, 403);
    assert.equal(userRow(server, 'x100'), undefined);

    const adminByEmployee = await server.post('/register', { ...session('emp1'), ...newAccount('x101', { type: 'admin' }) });
    assert.equal(adminByEmployee.status, 403);
    assert.equal(userRow(server, 'x101'), undefined);
  } finally {
    await server.stop();
  }
});

test('/register: admin can create employees but not admins; root can create admins', async () => {
  const server = await startServer();
  try {
    const employee = await server.post('/register', { ...session('admin1'), ...newAccount('x200') });
    assert.equal(employee.status, 200);
    assert.equal(employee.json.success, 1);
    assert.deepEqual(userRow(server, 'x200'), { id: 'x200', type: 'employee' });

    const adminByAdmin = await server.post('/register', { ...session('admin1'), ...newAccount('x201', { type: 'admin' }) });
    assert.equal(adminByAdmin.status, 403);
    assert.equal(userRow(server, 'x201'), undefined);

    const adminByRoot = await server.post('/register', { ...session('root'), ...newAccount('x202', { type: 'admin' }) });
    assert.equal(adminByRoot.status, 200);
    assert.deepEqual(userRow(server, 'x202'), { id: 'x202', type: 'admin' });

    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

test('/register: unknown account types and reserved ids are rejected', async () => {
  const server = await startServer();
  try {
    const weird = await server.post('/register', { ...session('root'), ...newAccount('x300', { type: 'superuser' }) });
    assert.equal(weird.status, 400);
    assert.equal(userRow(server, 'x300'), undefined);

    const reserved = await server.post('/register', { ...session('root'), ...newAccount('monitor') });
    assert.equal(reserved.status, 403);
    assert.equal(userRow(server, 'monitor'), undefined);
  } finally {
    await server.stop();
  }
});
