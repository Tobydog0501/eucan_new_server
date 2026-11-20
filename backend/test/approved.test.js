'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { startServer, makeWorkdir, session, BUILD_DIR } = require('../testlib/harness');

test('/approved: filters work and return only approved tickets', async () => {
  const server = await startServer();
  try {
    const all = await server.post('/approved', { ...session('admin1') });
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.data.map((t) => t.serialnum), [`${new Date().getFullYear()}0001`]);

    const byUser = await server.post('/approved', { ...session('admin1'), user: 'emp2', year: String(new Date().getFullYear()) });
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
    ]) {
      const res = await server.post('/approved', { ...session('emp1'), ...extra });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(extra)}, got ${res.status}: ${res.text}`);
    }
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});

test('sql.showQuery binds filter values instead of splicing them into SQL', () => {
  const cwd = makeWorkdir();
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    const { sql } = require(path.join(BUILD_DIR, 'plugins', 'sql.js'));
    const plugin = new sql();
    // A quote inside the value must be treated as data, not as SQL.
    assert.deepEqual(plugin.showQuery(1, { id: "emp2' --" }), []);
    assert.equal(plugin.showQuery(1, { id: 'emp2' }).length, 1);
  } finally {
    process.chdir(prev);
  }
});
