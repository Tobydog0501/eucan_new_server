'use strict';

// Checks for the dependency changes: `request` and `multer` are gone, root's
// 2FA check now uses the built-in fetch, and mail still goes out through the
// upgraded nodemailer with the existing transport settings.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { startServer, BUILD_DIR } = require('../testlib/harness');

const pkg = require('../package.json');

test('package.json no longer depends on request or multer; nodemailer is >= 10.6.1', () => {
  for (const name of ['request', '@types/request', 'multer', '@types/multer']) {
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/Validate.aspx` })));
}

test('root login: 2FA is checked over fetch and enforced', async () => {
  const validator = await fakeValidator('123456');
  const server = await startServer({ TOTP_VALIDATE_URL: validator.url });
  try {
    const creds = { account: 'root', pwd: 'fixture-root' };
    assert.equal((await server.post('/login', { ...creds })).status, 400);
    assert.equal((await server.post('/login', { ...creds, twoFA: '12ab56' })).status, 400);
    assert.equal((await server.post('/login', { ...creds, twoFA: '654321' })).status, 403);
    const ok = await server.post('/login', { ...creds, twoFA: '123456' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.msg, 'success');
    assert.deepEqual(validator.seen, ['654321', '123456']);

    // Ordinary accounts are unaffected.
    assert.equal((await server.post('/login', { account: 'emp1', pwd: 'fixture-emp1' })).status, 200);
  } finally {
    await server.stop();
    validator.server.close();
  }
});

test('root login: an unreachable validator means 403, not a crash', async () => {
  const server = await startServer({ TOTP_VALIDATE_URL: 'http://127.0.0.1:9/Validate.aspx' });
  try {
    assert.equal((await server.post('/login', { account: 'root', pwd: 'fixture-root', twoFA: '123456' })).status, 403);
    assert.equal(await server.alive(), true, server.output());
  } finally {
    await server.stop();
  }
});

// Just enough SMTP to accept one message. The mailer is hard-wired to port 25.
function fakeSmtp() {
  const messages = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let data = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; messages.push(data); data = ''; sock.write('250 queued\r\n'); }
          else data += line + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'AUTH') sock.write('235 ok\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(25, '127.0.0.1', () => resolve({ server, messages }));
  });
}

test('mailer: sends through the upgraded nodemailer with the existing settings', async (t) => {
  let smtp;
  try {
    smtp = await fakeSmtp();
  } catch (e) {
    t.skip(`cannot bind 127.0.0.1:25 here (${e.code})`);
    return;
  }
  const saved = { ...process.env };
  Object.assign(process.env, { SMTP_SERVER: '127.0.0.1', USER_MAIL: 'system@example.invalid', USER_PWD: 'fixture' });
  try {
    const { mailer } = require(path.join(BUILD_DIR, 'plugins', 'mailer.js'));
    const m = new mailer();
    const info = await m.send('someone@example.invalid', '測試主旨', '測試內容');
    assert.deepEqual(info.accepted, ['someone@example.invalid']);
    assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0], /To: someone@example\.invalid/);
  } finally {
    process.env = saved;
    smtp.server.close();
  }
});
