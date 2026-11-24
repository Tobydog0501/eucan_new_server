'use strict';

// /modify (overwrite leave usage) and /tmodify (edit/delete a ticket):
// column names and leave types must come from the fixed whitelist.

const test = require('node:test');
const assert = require('node:assert');
const { startServer, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();
const PENDING = `${YEAR}0000`; // emp1, 事假
const APPROVED = `${YEAR}0001`; // emp2, 病假, approved

function usage(server, id) {
  return server.withDb((db) => db.prepare('SELECT * FROM dayoffinfo WHERE id = ? AND year = ?').get(id, String(YEAR)));
}

function ticket(server, num) {
  return server.withDb((db) => db.prepare('SELECT * FROM requestquery WHERE serialnum = ?').get(num));
}

test('/modify: admins can set whitelisted columns; values are bound', async () => {
  const server = await startServer();
  try {
    const res = await server.post('/modify', { ...session('admin1'), user: 'emp1', year: YEAR, data: { personal: 4, '病假': 2.5 } });
    assert.equal(res.status, 200, res.text);
    const row = usage(server, 'emp1');
    assert.equal(row.personal, 4);
    assert.equal(row.sick, 2.5);

    const missing = await server.post('/modify', { ...session('admin1'), user: 'emp1', year: YEAR - 5, data: { personal: 1 } });
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});

test('/modify: keys outside the whitelist and malformed bodies are rejected', async () => {
  const server = await startServer();
  try {
    const before = usage(server, 'emp1');
    const cases = [
      { data: { pwd: 1 } },
      { data: { 'personal, annual': 1 } },
      { data: { toString: 1 } },
      { data: { annual_special: 1 } },
      { data: { personal: '4' } },
      { data: { personal: -1 } },
      { data: {} },
      { data: [4] },
      { data: 'personal' },
      { year: 'this year', data: { personal: 1 } },
      { user: ['emp1'], data: { personal: 1 } },
    ];
    for (const extra of cases) {
      const res = await server.post('/modify', { ...session('admin1'), user: 'emp1', year: YEAR, ...extra });
      assert.equal(res.status, 400, `${JSON.stringify(extra)} -> ${res.status} ${res.text}`);
    }
    assert.deepEqual(usage(server, 'emp1'), before);

    const asEmployee = await server.post('/modify', { ...session('emp1'), user: 'emp1', year: YEAR, data: { personal: 0 } });
    assert.equal(asEmployee.status, 403);
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

function edit(extra) {
  return {
    ...session('admin1'), serialnum: APPROVED, action: 1, state: 1, type: '病假', reason: 'edited',
    start: `${YEAR}-03-03 08:30`, end: `${YEAR}-03-03 12:00`, ...extra,
  };
}

test('/tmodify: leave type must be on the whitelist', async () => {
  const server = await startServer();
  try {
    const before = ticket(server, APPROVED);
    for (const type of ['toString', '__proto__', 'unknown', ['病假']]) {
      const res = await server.post('/tmodify', edit({ type }));
      assert.equal(res.status, 400, `${JSON.stringify(type)} -> ${res.status} ${res.text}`);
    }
    assert.deepEqual(ticket(server, APPROVED), before);
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

test('/tmodify: dates that do not exist or are reversed are a 400, unknown tickets a 404', async () => {
  const server = await startServer();
  try {
    assert.equal((await server.post('/tmodify', edit({ start: `${YEAR}-02-30 08:30` }))).status, 400);
    assert.equal((await server.post('/tmodify', edit({ start: `${YEAR}-03-04 08:30`, end: `${YEAR}-03-03 17:30` }))).status, 400);
    assert.equal((await server.post('/tmodify', edit({ serialnum: '99999999' }))).status, 404);
    assert.equal((await server.post('/tmodify', edit({ action: 2 }))).status, 400);
    assert.equal((await server.post('/tmodify', { ...edit({}), ...session('emp2') })).status, 403);
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

test('/tmodify: a valid edit is saved and usage is re-synced; delete only needs the serial', async () => {
  const server = await startServer();
  try {
    const res = await server.post('/tmodify', edit({}));
    assert.equal(res.status, 200, res.text);
    const t = ticket(server, APPROVED);
    assert.equal(t.end, `${YEAR}-03-03 12:00`);
    assert.equal(t.reason, 'edited');
    assert.equal(usage(server, 'emp2').sick, t.totalTime);

    // The page echoes the stored ticket's fields on delete; they are not re-validated.
    const del = await server.post('/tmodify', edit({ serialnum: PENDING, action: 0, type: 'whatever', start: 'x', end: 'y' }));
    assert.equal(del.status, 200, del.text);
    assert.equal(ticket(server, PENDING), undefined);
  } finally {
    await server.stop();
  }
});
