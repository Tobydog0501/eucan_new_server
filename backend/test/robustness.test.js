'use strict';

// Malformed input and background failures must produce an error response (or be
// logged), never terminate the backend process.

const test = require('node:test');
const assert = require('node:assert');
const { startServer, inWorkdir, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();

async function withServer(options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  const server = await startServer(options);
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

test('/request: malformed leave times are rejected without a valid session', async () => {
  await withServer(async (server) => {
    const res = await server.post('/request', {
      account: 'nobody', cookie: 'x', type: '事假', reason: 'r', start: 'not-a-time', end: 'not-a-time',
    });
    assert.ok(res.status >= 400 && res.status < 500, `unexpected status ${res.status}`);
    assert.equal(await server.alive(), true, server.output());
  });
});

test('/request: dates that do not exist, reversed and over-long ranges are rejected', async () => {
  await withServer(async (server) => {
    const ticketsBefore = server.withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM requestquery').get().n);
    const cases = [
      [`${YEAR}-99-99 08:30`, `${YEAR}-99-99 17:30`, 403],
      [`${YEAR}-02-30 08:30`, `${YEAR}-02-30 17:30`, 403],
      [`${YEAR}-03-05 08:30`, `${YEAR}-03-04 17:30`, 400],
      [`${YEAR - 1}-01-02 08:30`, `${YEAR + 1}-01-02 17:30`, 400],
      [`${YEAR + 5}-01-02 08:30`, `${YEAR + 5}-01-02 17:30`, 400],
    ];
    for (const [start, end, status] of cases) {
      for (const who of ['nobody', 'emp1']) {
        const creds = who === 'nobody' ? { account: 'nobody', cookie: 'x' } : session('emp1');
        const res = await server.post('/request', { ...creds, type: '事假', reason: 'r', start, end });
        assert.equal(res.status, status, `${who} ${start} .. ${end} -> ${res.status} ${res.text}`);
      }
    }
    const ticketsAfter = server.withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM requestquery').get().n);
    assert.equal(ticketsAfter, ticketsBefore);
    assert.equal(await server.alive(), true, server.output());
  });
});

test('/request: a well-formed request without a valid session is refused', async () => {
  await withServer(async (server) => {
    const res = await server.post('/request', {
      account: 'emp1', cookie: 'wrongcookie', type: '事假', reason: 'r', start: `${YEAR}-03-04 08:30`, end: `${YEAR}-03-04 17:30`,
    });
    assert.equal(res.status, 403);
  });
});

test('/batchrequest: dates that do not exist and reversed ranges are rejected', async () => {
  await withServer(async (server) => {
    const base = { ...session('admin1'), type: '事假', reason: 'r', users: ['emp1'] };
    assert.equal((await server.post('/batchrequest', { ...base, start: `${YEAR}-13-01 08:30`, end: `${YEAR}-13-01 17:30` })).status, 403);
    assert.equal((await server.post('/batchrequest', { ...base, start: `${YEAR}-03-05 08:30`, end: `${YEAR}-03-04 17:30` })).status, 400);
    assert.equal(await server.alive(), true, server.output());
  });
});

test('/request and /batchrequest: wrongly typed fields are rejected', async () => {
  await withServer(async (server) => {
    const base = { ...session('emp1'), type: '事假', start: `${YEAR}-03-04 08:30`, end: `${YEAR}-03-04 17:30` };
    assert.equal((await server.post('/request', { ...base, reason: ['r'] })).status, 400);
    assert.equal((await server.post('/request', { ...base, reason: 'r', start: 42 })).status, 403);
    assert.equal((await server.post('/batchrequest', { ...session('admin1'), ...base, reason: 'r', start: ['x'], users: ['emp1'] })).status, 403);
    assert.equal(await server.alive(), true, server.output());
  });
});

test('auth helpers: non-string credentials are refused, not crashed on', async () => {
  await withServer(async (server) => {
    assert.equal((await server.post('/clockin', { account: 123, cookie: 'x', type: 0 })).status, 403);
    assert.equal((await server.post('/session', { account: ['emp1'], cookie: 'x' })).status, 403);
    assert.equal((await server.post('/login', { account: 123, pwd: 'x' })).status, 403);
    // A user id with no session row yet must be treated as logged out.
    assert.equal((await server.post('/session', { account: 'ghost', cookie: 'abc' })).status, 403);
    assert.equal(await server.alive(), true, server.output());
  });
});

test('/clrecord: missing, malformed or non-scalar year/month is a 400', async () => {
  await withServer(async (server) => {
    for (const extra of [
      { year: YEAR },
      { year: YEAR, month: '13' },
      { year: '20x6', month: 3 },
      { year: [String(YEAR)], month: 3 },
      { year: YEAR, month: ['3'] },
    ]) {
      const res = await server.post('/clrecord', { ...session('admin1'), ...extra });
      assert.equal(res.status, 400, `${JSON.stringify(extra)} -> ${res.status}`);
    }
    assert.equal(await server.alive(), true, server.output());
  });
});

test('/request: the manager mail is sent, and a failing one is logged without a crash', async () => {
  const body = { ...session('emp1'), type: '事假', reason: 'doctor', start: `${YEAR}-03-04 08:30`, end: `${YEAR}-03-04 17:30` };
  await withServer(async (server) => {
    const res = await server.post('/request', body);
    assert.equal(res.status, 200, res.text);
    await server.smtp.waitForMessages(1);
  });
  await withServer({ smtp: 'reject' }, async (server) => {
    const res = await server.post('/request', body);
    assert.equal(res.status, 200, res.text);
    await server.waitForOutput(/Failed to send leave request mail for emp1/);
    assert.equal(await server.alive(), true, server.output());
  });
});

test('a handler that throws after auth answers 500 and the server keeps running', async () => {
  await withServer(async (server) => {
    // /empquery reads `year` without checking it, so leaving it out throws
    // inside the handler after the session check.
    const res = await server.post('/empquery', { ...session('emp1') });
    assert.equal(res.status, 500);
    await server.waitForOutput(/POST \/empquery failed/);
    assert.equal(await server.alive(), true, server.output());
  });
});

test('leave_input: parseLeaveTime / validTime / validRange', async () => {
  await inWorkdir(({ load }) => {
    const { parseLeaveTime, validTime, validRange } = load('plugins/leave_input.js');
    assert.equal(parseLeaveTime('2026-02-30 08:30'), null);
    assert.equal(parseLeaveTime('2026-99-99 08:30'), null);
    assert.equal(parseLeaveTime('2026-03-04 24:00'), null);
    assert.equal(parseLeaveTime(['2026-03-04 08:30']), null);
    assert.ok(parseLeaveTime('2024-02-29 08:30') instanceof Date);

    assert.equal(validTime('2026-03-04 08:30'), true);
    assert.equal(validTime('2026-03-04 08:00'), false);
    assert.equal(validTime('2026-03-04 09:15'), false);
    assert.equal(validTime('2026-13-04 09:00'), false);

    const now = new Date(2026, 5, 1);
    assert.deepEqual(validRange('2026-03-04 08:30', '2026-03-04 17:30', { nearYearsOnly: true, now }), { ok: true });
    assert.equal(validRange('2026-03-05 08:30', '2026-03-04 17:30').ok, false);
    assert.equal(validRange('2025-01-01 08:30', '2026-06-01 17:30').ok, false);
    assert.equal(validRange('2030-01-02 08:30', '2030-01-02 17:30', { nearYearsOnly: true, now }).ok, false);
    assert.equal(validRange('2030-01-02 08:30', '2030-01-02 17:30').ok, true);
  });
});
