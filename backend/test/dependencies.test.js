'use strict';

// Checks for the dependency changes: `request` and `multer` are gone, root's
// 2FA check uses the built-in fetch (and runs before any session is issued),
// and mail goes out through nodemailer 10 with the existing transport settings.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { startServer, startFakeSmtp, inWorkdir, session } = require('../testlib/harness');

const pkg = require('../package.json');

test('package.json: request, multer and @types/nodemailer removed; nodemailer >= 10.6.1', () => {
  for (const name of ['request', '@types/request', 'multer', '@types/multer', '@types/nodemailer']) {
    assert.equal(pkg.dependencies[name], undefined, `${name} should be removed`);
  }
  const installed = require('nodemailer/package.json').version.split('.').map(Number);
  assert.ok(installed[0] > 10 || (installed[0] === 10 && installed[1] >= 6), `nodemailer ${installed.join('.')}`);
});

// Minimal stand-in for the remote one-time-code validator.
function fakeValidator(goodPin) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    seen.push(url.searchParams.get('Pin'));
    res.end(url.searchParams.get('Pin') === goodPin ? 'True' : 'False');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    seen,
    url: `http://127.0.0.1:${server.address().port}/Validate.aspx`,
    close: () => new Promise((r) => server.close(() => r())),
  })));
}

test('root login: 2FA is checked over fetch and enforced', async () => {
  const validator = await fakeValidator('123456');
  const server = await startServer({ env: { TOTP_VALIDATE_URL: validator.url } });
  try {
    const creds = { account: 'root', pwd: 'fixture-root' };
    assert.equal((await server.post('/login', { ...creds })).status, 400);
    assert.equal((await server.post('/login', { ...creds, twoFA: '12ab56' })).status, 400);
    assert.equal((await server.post('/login', { ...creds, twoFA: ['123456'] })).status, 400);
    assert.equal((await server.post('/login', { ...creds, twoFA: '654321' })).status, 403);
    // A wrong password is refused before the validator is even asked.
    assert.equal((await server.post('/login', { account: 'root', pwd: 'wrong', twoFA: '123456' })).status, 403);
    const ok = await server.post('/login', { ...creds, twoFA: '123456' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.msg, 'success');
    assert.deepEqual(validator.seen, ['654321', '123456']);

    // Ordinary accounts are unaffected.
    assert.equal((await server.post('/login', { account: 'emp1', pwd: 'fixture-emp1' })).status, 200);
  } finally {
    await server.stop();
    await validator.close();
  }
});

test('root login: a failed second factor leaves the existing root session valid', async () => {
  const validator = await fakeValidator('123456');
  const server = await startServer({ env: { TOTP_VALIDATE_URL: validator.url } });
  try {
    const rootSession = session('root');
    assert.equal((await server.post('/session', rootSession)).status, 200);

    assert.equal((await server.post('/login', { account: 'root', pwd: 'fixture-root' })).status, 400);
    assert.equal((await server.post('/login', { account: 'root', pwd: 'fixture-root', twoFA: '000000' })).status, 403);

    assert.equal((await server.post('/session', rootSession)).status, 200, 'existing root session was replaced');
  } finally {
    await server.stop();
    await validator.close();
  }
});

test('root login: an unreachable validator means 403, not a crash', async () => {
  // Port 9 (discard) is not listening locally; fetch fails fast.
  const server = await startServer({ env: { TOTP_VALIDATE_URL: 'http://127.0.0.1:9/Validate.aspx' } });
  try {
    assert.equal((await server.post('/login', { account: 'root', pwd: 'fixture-root', twoFA: '123456' })).status, 403);
    await server.waitForOutput(/2FA validation request failed/);
    assert.equal(await server.alive(), true, server.output());
  } finally {
    await server.stop();
  }
});

test('mailer: sends through nodemailer 10 with the existing settings (random port, temp cwd)', async () => {
  const smtp = await startFakeSmtp('accept');
  const keys = ['SMTP_SERVER', 'SMTP_PORT', 'USER_MAIL', 'USER_PWD'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { SMTP_SERVER: '127.0.0.1', SMTP_PORT: String(smtp.port), USER_MAIL: 'system@example.invalid', USER_PWD: 'fixture' });
  try {
    // inWorkdir switches cwd first, so the mailer's dotenv.config() looks for
    // a .env in the empty temp directory, never in backend/.
    await inWorkdir(async ({ load }) => {
      const { mailer } = load('plugins/mailer.js');
      const info = await new mailer().send('someone@example.invalid', '測試主旨', '測試內容');
      assert.deepEqual(info.accepted, ['someone@example.invalid']);
    });
    assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0], /To: someone@example\.invalid/);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await smtp.close();
  }
});
