'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();
const PENDING = `${YEAR}0000`; // emp1, 事假, 8h, state 0
const APPROVED = `${YEAR}0001`; // emp2, already approved

function ticketState(server, num) {
  const db = server.db();
  try {
    return db.prepare('SELECT state FROM requestquery WHERE serialnum = ?').get(num).state;
  } finally {
    db.close();
  }
}

test('/permit: employees cannot approve or reject tickets', async () => {
  const server = await startServer();
  try {
    const own = await server.post('/permit', { ...session('emp1'), num: PENDING, permit: 1 });
    assert.equal(own.status, 403);
    const other = await server.post('/permit', { ...session('emp2'), num: PENDING, permit: 0 });
    assert.equal(other.status, 403);
    assert.equal(ticketState(server, PENDING), 0);
  } finally {
    await server.stop();
  }
});

test('/permit: admin can approve a pending ticket exactly once', async () => {
  const server = await startServer();
  try {
    const res = await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 1 });
    assert.equal(res.status, 200);
    assert.equal(ticketState(server, PENDING), 1);

    const db = server.db();
    const used = db.prepare('SELECT personal FROM dayoffinfo WHERE id = ? AND year = ?').get('emp1', String(YEAR));
    db.close();
    assert.equal(used.personal, 8);

    const again = await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 1 });
    assert.equal(again.status, 409);
    const already = await server.post('/permit', { ...session('admin1'), num: APPROVED, permit: 0 });
    assert.equal(already.status, 409);

    // The notification mail fails in the test environment; the server must survive it.
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

test('/permit: malformed or unknown tickets are rejected', async () => {
  const server = await startServer();
  try {
    assert.equal((await server.post('/permit', { ...session('admin1'), num: [PENDING], permit: 1 })).status, 400);
    assert.equal((await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 'yes' })).status, 400);
    assert.equal((await server.post('/permit', { ...session('admin1'), num: '99999999', permit: 1 })).status, 404);
    assert.equal(ticketState(server, PENDING), 0);
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});
