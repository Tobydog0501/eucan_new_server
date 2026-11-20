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
  return server.withDb((db) => db.prepare('SELECT id, type FROM userinfo WHERE id = ?').get(id));
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
    // The welcome mail actually goes out.
    const [mail] = await server.smtp.waitForMessages(1);
    assert.match(mail, /To: x200@example\.invalid/);

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

test('/register: unknown types, reserved ids, non-scalar flags and bad dates are rejected', async () => {
  const server = await startServer();
  try {
    const cases = [
      [newAccount('x300', { type: 'superuser' }), 400],
      [newAccount('monitor'), 403],
      [newAccount('x301', { mgroup: ['0'] }), 400],
      [newAccount('x302', { permit: ['1'] }), 400],
      [newAccount('x303', { date: '2024/01/01' }), 400],
      [newAccount('x304', { date: '2024-02-30' }), 400],
    ];
    for (const [body, status] of cases) {
      const res = await server.post('/register', { ...session('root'), ...body });
      assert.equal(res.status, status, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
      assert.equal(userRow(server, body.user), undefined);
    }
  } finally {
    await server.stop();
  }
});

test('/register: a failing welcome mail is logged and the server keeps running', async () => {
  const server = await startServer({ smtp: 'reject' });
  try {
    const res = await server.post('/register', { ...session('admin1'), ...newAccount('x400') });
    assert.equal(res.status, 200);
    await server.waitForOutput(/Failed to send registration mail for x400/);
    assert.equal(await server.alive(), true, server.output());
  } finally {
    await server.stop();
  }
});
