'use strict';

// Credential handling: stored passwords are scrypt hashes, rows that still
// hold the password itself are upgraded on the next successful login (nobody
// has to reset anything), comparisons are constant-time, and no response or
// log line ever carries a password or its hash.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer, session, USERS, BUILD_DIR } = require('../testlib/harness');

const pw = require(path.join(BUILD_DIR, 'plugins', 'password.js'));

const storedPwd = (server, id) => server.withDb((db) => db.prepare('SELECT pwd FROM userinfo WHERE id = ?').get(id)).pwd;
const fixturePwd = (id) => USERS.find((u) => u.id === id).pwd;

/** Everything the backend wrote to its log files and console so far. */
function allLogs(server) {
  const dir = path.join(server.cwd, 'logs');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')) : [];
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') + '\n' + server.output();
}

/** Log lines are appended asynchronously; wait until `pattern` shows up (or time out). */
async function waitForLog(server, pattern, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pattern.test(allLogs(server))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`log never matched ${pattern}`);
}

// ---------------------------------------------------------------------------
// password.ts

test('hashPassword: self-describing scrypt hash with a random salt', async () => {
  const a = await pw.hashPassword('correct horse');
  const b = await pw.hashPassword('correct horse');
  assert.match(a, /^scrypt\$32768\$8\$3\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
  assert.notEqual(a, b, 'same password, different salt');
  assert.ok(!a.includes('correct horse'));
  assert.ok(pw.isPasswordHash(a));
  assert.equal(pw.isPasswordHash('correct horse'), false);
  await assert.rejects(pw.hashPassword(''));
});

test('verifyPassword: hashes', async () => {
  const stored = await pw.hashPassword('s3cret');
  assert.deepEqual(await pw.verifyPassword('s3cret', stored), { ok: true, needsRehash: false });
  assert.deepEqual(await pw.verifyPassword('s3cret ', stored), { ok: false, needsRehash: false });
  assert.deepEqual(await pw.verifyPassword('', stored), { ok: false, needsRehash: false });
  assert.deepEqual(await pw.verifyPassword(null, stored), { ok: false, needsRehash: false });
  assert.deepEqual(await pw.verifyPassword(['s3cret'], stored), { ok: false, needsRehash: false });
});

test('verifyPassword: legacy plain values match exactly and ask for a rehash', async () => {
  assert.deepEqual(await pw.verifyPassword('A123456789', 'A123456789'), { ok: true, needsRehash: true });
  assert.deepEqual(await pw.verifyPassword('a123456789', 'A123456789'), { ok: false, needsRehash: false });
  assert.deepEqual(await pw.verifyPassword('A12345678', 'A123456789'), { ok: false, needsRehash: false });
  assert.deepEqual(await pw.verifyPassword('', ''), { ok: false, needsRehash: false });
  // Something that only looks like a hash is compared as a plain value.
  assert.deepEqual(await pw.verifyPassword('x', 'scrypt$1$1$1$AA$AA'), { ok: false, needsRehash: false });
});

test('verifyPassword: a hash with older cost parameters still verifies and asks for a rehash', async () => {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('old-cost', salt, 32, { N: 16384, r: 8, p: 1 });
  const stored = `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
  assert.ok(pw.isPasswordHash(stored));
  assert.deepEqual(await pw.verifyPassword('old-cost', stored), { ok: true, needsRehash: true });
  assert.deepEqual(await pw.verifyPassword('other', stored), { ok: false, needsRehash: false });
});

test('verifyPassword: every comparison goes through crypto.timingSafeEqual', async () => {
  const stored = await pw.hashPassword('s3cret');
  const original = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (a, b) => { calls++; return original(a, b); };
  try {
    for (const [given, against] of [['s3cret', stored], ['wrong', stored], ['plain', 'plain'], ['plain', 'other']]) {
      const before = calls;
      await pw.verifyPassword(given, against);
      assert.equal(calls, before + 1, `${given} vs ${against === stored ? 'hash' : against}`);
    }
  } finally {
    crypto.timingSafeEqual = original;
  }
});

// ---------------------------------------------------------------------------
// Login and the transparent upgrade of plain rows

test('login: a plain stored password still works and is replaced by a hash on success', async () => {
  const server = await startServer();
  try {
    const plain = fixturePwd('emp1');
    assert.equal(storedPwd(server, 'emp1'), plain, 'fixture starts as a legacy plain value');

    // A failed attempt changes nothing.
    assert.equal((await server.post('/login', { account: 'emp1', pwd: 'not-it' })).status, 403);
    assert.equal(storedPwd(server, 'emp1'), plain);

    const first = await server.post('/login', { account: 'emp1', pwd: plain });
    assert.equal(first.status, 200, first.text);
    const stored = storedPwd(server, 'emp1');
    assert.ok(pw.isPasswordHash(stored), 'upgraded to a hash');
    assert.equal((await pw.verifyPassword(plain, stored)).ok, true);

    // The same password keeps working against the hash; the hash is not rewritten again.
    const second = await server.post('/login', { account: 'emp1', pwd: plain });
    assert.equal(second.status, 200, second.text);
    assert.equal(storedPwd(server, 'emp1'), stored);
    assert.equal((await server.post('/login', { account: 'emp1', pwd: 'not-it' })).status, 403);

    // Other accounts are untouched until they log in themselves.
    assert.equal(storedPwd(server, 'emp2'), fixturePwd('emp2'));
  } finally {
    await server.stop();
  }
});

test('login: an old-cost hash is upgraded to the current parameters', async () => {
  const server = await startServer();
  try {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync('legacy-cost', salt, 32, { N: 16384, r: 8, p: 1 });
    const old = `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    server.withDb((db) => db.prepare('UPDATE userinfo SET pwd = ? WHERE id = ?').run(old, 'emp2'), { write: true });

    assert.equal((await server.post('/login', { account: 'emp2', pwd: 'legacy-cost' })).status, 200);
    const stored = storedPwd(server, 'emp2');
    assert.match(stored, /^scrypt\$32768\$8\$3\$/);
    assert.equal((await pw.verifyPassword('legacy-cost', stored)).ok, true);
  } finally {
    await server.stop();
  }
});

test('login: no password (attempted or real) appears in the logs', async () => {
  const server = await startServer();
  try {
    const attempt = 'Typo-Attempt-7f3a91';
    assert.equal((await server.post('/login', { account: 'emp1', pwd: attempt })).status, 403);
    assert.equal((await server.post('/login', { account: 'emp1', pwd: fixturePwd('emp1') })).status, 200);
    await waitForLog(server, /emp1 has logined with password successfully/);
    await waitForLog(server, /emp1 failed to log in: wrong password/);
    const logs = allLogs(server);
    assert.ok(!logs.includes(attempt), 'attempted password logged');
    assert.ok(!logs.includes(fixturePwd('emp1')), 'real password logged');
    assert.ok(!logs.includes(storedPwd(server, 'emp1')), 'hash logged');
  } finally {
    await server.stop();
  }
});

// Minimal stand-in for the remote one-time-code validator (see dependencies.test.js).
function fakeValidator(goodPin) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.end(url.searchParams.get('Pin') === goodPin ? 'True' : 'False');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/Validate.aspx`,
    close: () => new Promise((r) => server.close(() => r())),
  })));
}

test('root login: the password check before 2FA works with plain and hashed values', async () => {
  const validator = await fakeValidator('123456');
  const server = await startServer({ env: { TOTP_VALIDATE_URL: validator.url } });
  try {
    const plain = fixturePwd('root');
    assert.equal((await server.post('/login', { account: 'root', pwd: 'wrong', twoFA: '123456' })).status, 403);
    assert.equal((await server.post('/login', { account: 'root', pwd: plain, twoFA: '123456' })).status, 200);
    assert.ok(pw.isPasswordHash(storedPwd(server, 'root')));
    // Against the hash now.
    assert.equal((await server.post('/login', { account: 'root', pwd: 'wrong', twoFA: '123456' })).status, 403);
    assert.equal((await server.post('/login', { account: 'root', pwd: plain, twoFA: '654321' })).status, 403);
    assert.equal((await server.post('/login', { account: 'root', pwd: plain, twoFA: '123456' })).status, 200);
  } finally {
    await server.stop();
    await validator.close();
  }
});

// ---------------------------------------------------------------------------
// New and changed passwords

test('/register stores a hash, and the new account can log in', async () => {
  const server = await startServer();
  try {
    const res = await server.post('/register', {
      ...session('admin1'), user: 'x300', pwd: 'Initial-Pass-1', mail: 'x300@example.invalid',
      name: 'Name x300', date: '2024-01-01', mgroup: '0', permit: '1',
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.success, 1);
    const stored = storedPwd(server, 'x300');
    assert.ok(pw.isPasswordHash(stored));
    assert.ok(!stored.includes('Initial-Pass-1'));
    assert.equal((await server.post('/login', { account: 'x300', pwd: 'Initial-Pass-1' })).status, 200);
    assert.equal((await server.post('/login', { account: 'x300', pwd: 'initial-pass-1' })).status, 403);
  } finally {
    await server.stop();
  }
});

function profile(id, extra = {}) {
  return {
    user: id, email: `${id}@example.invalid`, name: `Name ${id}`,
    date: '2020-01-01', type: 'employee', mgroup: 0, permit: 1, status: 1, ...extra,
  };
}

test('/modemp: a new password is stored hashed; an empty or missing one keeps the current password', async () => {
  const server = await startServer();
  try {
    const original = storedPwd(server, 'emp1');
    for (const extra of [{}, { pwd: '' }, { pwd: null }]) {
      const res = await server.post('/modemp', { ...session('admin1'), ...profile('emp1', { name: 'Renamed', ...extra }) });
      assert.equal(res.status, 200, `${JSON.stringify(extra)} -> ${res.status} ${res.text}`);
      assert.equal(storedPwd(server, 'emp1'), original, `${JSON.stringify(extra)} changed the password`);
    }
    assert.equal(server.withDb((db) => db.prepare('SELECT name FROM userinfo WHERE id = ?').get('emp1')).name, 'Renamed');
    assert.equal((await server.post('/login', { account: 'emp1', pwd: fixturePwd('emp1') })).status, 200);

    const changed = await server.post('/modemp', { ...session('admin1'), ...profile('emp1', { pwd: 'Changed-Pass-2' }) });
    assert.equal(changed.status, 200, changed.text);
    const stored = storedPwd(server, 'emp1');
    assert.ok(pw.isPasswordHash(stored));
    assert.equal((await server.post('/login', { account: 'emp1', pwd: 'Changed-Pass-2' })).status, 200);
    assert.equal((await server.post('/login', { account: 'emp1', pwd: fixturePwd('emp1') })).status, 403);

    for (const bad of [['x'], { a: 1 }, 5]) {
      assert.equal((await server.post('/modemp', { ...session('admin1'), ...profile('emp1', { pwd: bad }) })).status, 400, JSON.stringify(bad));
    }
    assert.equal(storedPwd(server, 'emp1'), stored);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Nothing sends a password or its hash to the browser

test('no API response carries a stored password, plain or hashed', async () => {
  const server = await startServer();
  try {
    // emp2 keeps a plain value; emp1 gets a hash by logging in.
    assert.equal((await server.post('/login', { account: 'emp1', pwd: fixturePwd('emp1') })).status, 200);
    const secrets = [...USERS.map((u) => u.pwd), storedPwd(server, 'emp1')];
    const year = new Date().getFullYear();
    const admin = session('admin1');
    const employee = { ...session('emp1') };
    // The login above replaced emp1's session key.
    employee.cookie = server.withDb((db) => db.prepare('SELECT sKey FROM logininfo WHERE id = ?').get('emp1')).sKey;

    const responses = [
      await server.post('/users', admin),
      await server.post('/session', admin),
      await server.post('/login', { account: 'emp2', pwd: fixturePwd('emp2') }),
      await server.post('/empquery', { ...employee, year }),
      await server.post('/query', admin),
      await server.post('/approved', admin),
      await server.post('/dayoff', { ...admin, user: 'emp1', year }),
      await server.post('/quota', { ...admin, user: 'emp1', year }),
      await server.get('/api/clockin/directory', { ...admin, year, month: 3 }),
      await server.get('/api/clockin/employee', { ...admin, id: 'emp1', year, month: 3 }),
      await server.get('/api/clockin/day', { ...admin, year, month: 3, day: 2 }),
      await server.get('/api/makeup/requests', admin),
    ];
    assert.equal(responses[0].status, 200, responses[0].text);
    assert.ok(responses[0].json.data.length === USERS.length);
    for (const user of responses[0].json.data) {
      assert.ok(!('pwd' in user), `/users returned pwd for ${user.id}`);
    }
    for (const res of responses) {
      assert.ok(!/"pwd"\s*:/.test(res.text), `a response has a pwd field: ${res.text.slice(0, 200)}`);
      assert.ok(!res.text.includes('scrypt$'), 'a response contains a password hash');
      for (const s of secrets) assert.ok(!res.text.includes(s), 'a response contains a stored password');
    }
  } finally {
    await server.stop();
  }
});

test('the admin pages no longer show or prefill the stored password', () => {
  const root = path.join(__dirname, '..', '..', 'frontend');
  const personnel = fs.readFileSync(path.join(root, 'js', 'adminPersonnel.js'), 'utf8');
  const detail = fs.readFileSync(path.join(root, 'js', 'adminEmployeeDetail.js'), 'utf8');
  assert.doesNotMatch(personnel, /\bd\.pwd\b/);
  assert.doesNotMatch(detail, /employee\.pwd/);
  const detailHtml = fs.readFileSync(path.join(root, 'admin', 'employeeDetail.html'), 'utf8');
  assert.match(detailHtml, /<input id="pwd" type="password"[^>]*>/);
  assert.doesNotMatch(detailHtml.match(/<input id="pwd"[^>]*>/)[0], /\brequired\b/);
});
