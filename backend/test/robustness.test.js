'use strict';

// Malformed input and background failures must produce an error response (or be
// logged), never terminate the backend process.

const test = require('node:test');
const assert = require('node:assert');
const { startServer, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();

async function withServer(fn) {
  const server = await startServer();
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

test('/clrecord: missing or malformed month is a 400', async () => {
  await withServer(async (server) => {
    assert.equal((await server.post('/clrecord', { ...session('admin1'), year: YEAR })).status, 400);
    assert.equal((await server.post('/clrecord', { ...session('admin1'), year: YEAR, month: '13' })).status, 400);
    assert.equal((await server.post('/clrecord', { ...session('admin1'), year: '20x6', month: 3 })).status, 400);
    assert.equal(await server.alive(), true, server.output());
  });
});

test('/request: a failing notification mail does not take the server down', async () => {
  await withServer(async (server) => {
    // emp1 needs approval, so the endpoint e-mails the manager. SMTP is
    // unreachable in tests, so the send fails in the background.
    const res = await server.post('/request', {
      ...session('emp1'), type: '事假', reason: 'doctor', start: `${YEAR}-03-04 08:30`, end: `${YEAR}-03-04 17:30`,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(await server.alive(), true, server.output());
  });
});

test('an async handler that throws after auth answers 500 and the server keeps running', async () => {
  await withServer(async (server) => {
    // /tmodify is async and does not check that the ticket exists, so an
    // unknown serial number makes it throw after the session check.
    const res = await server.post('/tmodify', {
      ...session('admin1'), serialnum: '99999999', action: 1, state: 1, type: '事假',
      reason: 'r', start: `${YEAR}-03-04 08:30`, end: `${YEAR}-03-04 17:30`,
    });
    assert.equal(res.status, 500);
    assert.equal(await server.alive(), true, server.output());
  });
});
