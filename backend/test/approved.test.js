'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer, inWorkdir, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();

test('/approved: filters work and return only approved tickets', async () => {
  const server = await startServer();
  try {
    const all = await server.post('/approved', { ...session('admin1') });
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.data.map((t) => t.serialnum), [`${YEAR}0001`]);

    const byUser = await server.post('/approved', { ...session('admin1'), user: 'emp2', year: String(YEAR) });
    assert.equal(byUser.status, 200);
    assert.equal(byUser.json.data.length, 1);

    const otherUser = await server.post('/approved', { ...session('admin1'), user: 'emp1' });
    assert.equal(otherUser.status, 200);
    assert.equal(otherUser.json.data.length, 0);

    const limited = await server.post('/approved', { ...session('admin1'), limit: 1 });
    assert.equal(limited.status, 200);
    assert.equal(limited.json.data.length, 1);

    const empty = await server.post('/approved', { ...session('admin1'), user: '', year: '' });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.data.length, 1);
  } finally {
    await server.stop();
  }
});

test('/approved: non-scalar or malformed filter values are rejected', async () => {
  const server = await startServer();
  try {
    for (const extra of [
      { user: ['emp2'] },
      { user: { id: 'emp2' } },
      { year: ['2026'] },
      { month: 'March' },
      { limit: '10 rows' },
      // A plain string that is not just a number must not reach the LIMIT clause.
      { limit: '1 OFFSET 1' },
    ]) {
      const res = await server.post('/approved', { ...session('emp1'), ...extra });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(extra)}, got ${res.status}: ${res.text}`);
    }
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

test('/approved: string filters are matched as data', async () => {
  const server = await startServer();
  try {
    // Values the request filter lets through (no quotes) are compared as whole
    // strings: a near miss or extra words match nothing.
    for (const user of ['emp', 'emp2 OR 1', 'emp2"']) {
      const res = await server.post('/approved', { ...session('admin1'), user });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.data, [], `user=${user}`);
    }
  } finally {
    await server.stop();
  }
});

test('sql.showQuery binds filter values instead of splicing them into SQL', async () => {
  await inWorkdir(({ load }) => {
    const { sql } = load('plugins/sql.js');
    const plugin = new sql();
    try {
      // A quote inside the value must be treated as data, not as SQL.
      assert.deepEqual(plugin.showQuery(1, { id: "emp2' --" }), []);
      assert.equal(plugin.showQuery(1, { id: 'emp2' }).length, 1);
    } finally {
      plugin.close();
    }
  });
});
