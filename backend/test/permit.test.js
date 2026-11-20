'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();
const PENDING = `${YEAR}0000`; // emp1, 事假, 8h, state 0
const APPROVED = `${YEAR}0001`; // emp2, already approved

function ticketState(server, num) {
  return server.withDb((db) => db.prepare('SELECT state FROM requestquery WHERE serialnum = ?').get(num).state);
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

    const used = server.withDb((db) => db.prepare('SELECT personal FROM dayoffinfo WHERE id = ? AND year = ?').get('emp1', String(YEAR)));
    assert.equal(used.personal, 8);

    const [mail] = await server.smtp.waitForMessages(1);
    assert.match(mail, /To: emp1@example\.invalid/);

    const again = await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 1 });
    assert.equal(again.status, 409);
    const already = await server.post('/permit', { ...session('admin1'), num: APPROVED, permit: 0 });
    assert.equal(already.status, 409);
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

test('/permit: a ticket with an unknown leave type is not applied', async () => {
  const server = await startServer();
  try {
    server.withDb((db) => db.prepare('UPDATE requestquery SET type = ? WHERE serialnum = ?').run('toString', PENDING), { write: true });
    const res = await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 1 });
    assert.equal(res.status, 500);
    assert.equal(ticketState(server, PENDING), 0);
    await server.waitForOutput(/unknown leave type/);
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

test('/permit: a failing notification mail is logged and the server keeps running', async () => {
  const server = await startServer({ smtp: 'reject' });
  try {
    const res = await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 0 });
    assert.equal(res.status, 200);
    await server.waitForOutput(new RegExp(`Failed to send permit mail for ticket #${PENDING}`));
    assert.equal(await server.alive(), true, server.output());
  } finally {
    await server.stop();
  }
});
