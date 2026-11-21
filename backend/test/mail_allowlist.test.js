'use strict';

// Test-site mail policy: SITE_ENV, MAIL_ALLOWED_RECIPIENTS and MAIL_SUBJECT_PREFIX,
// enforced inside mailer.send() for every mail the backend sends.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, inWorkdir, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();
const PENDING = `${YEAR}0000`; // emp1's pending ticket in the harness fixtures

function weekday() {
  const d = new Date(YEAR, 2, 2);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${YEAR}-03-${String(d.getDate()).padStart(2, '0')}`;
}

function leave(id) {
  const day = weekday();
  return { ...session(id), type: '事假', start: `${day} 08:30`, end: `${day} 12:00`, reason: 'allowlist' };
}

function register(user, mail) {
  return {
    ...session('admin1'), user, pwd: 'fixture-new', mail,
    name: `Name ${user}`, date: '2024-01-01', mgroup: '0', permit: '1',
  };
}

async function waitFor(cond, what, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 500)); // time for a stray send to show up

// The decoded value of one header (folded lines joined, RFC 2047 words decoded).
function header(raw, name) {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const line = head.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  if (!line) return undefined;
  return line.slice(name.length + 1).trim()
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, enc, text) => (enc.toLowerCase() === 'b'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')));
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

// ---- unit: mail_policy -------------------------------------------------------

test('isTestSite: unset/production/prod are production; anything else (typos included) is a test site', async () => {
  await inWorkdir(async ({ load }) => {
    const { isTestSite } = load('plugins/mail_policy.js');
    for (const v of [undefined, '', '  ', 'production', 'PROD', ' Production ']) {
      assert.equal(isTestSite({ SITE_ENV: v }), false, `SITE_ENV=${v}`);
    }
    for (const v of ['test', 'TEST', 'staging', 'tset']) {
      assert.equal(isTestSite({ SITE_ENV: v }), true, `SITE_ENV=${v}`);
    }
  });
});

test('parseAddresses: names, angle brackets, comma/semicolon lists and case', async () => {
  await inWorkdir(async ({ load }) => {
    const { parseAddresses } = load('plugins/mail_policy.js');
    assert.deepEqual(parseAddresses('"Name" <A@Example.Invalid>; b@example.invalid ,, c@example.invalid'),
      ['a@example.invalid', 'b@example.invalid', 'c@example.invalid']);
    assert.deepEqual(parseAddresses(''), []);
  });
});

test('filterRecipients: production without a list is unrestricted', async () => {
  await inWorkdir(async ({ load }) => {
    const { filterRecipients } = load('plugins/mail_policy.js');
    assert.deepEqual(filterRecipients('a@example.invalid', {}), { allowed: ['a@example.invalid'], dropped: 0, restricted: false });
  });
});

test('filterRecipients: a test site keeps only listed addresses and counts the rest', async () => {
  await inWorkdir(async ({ load }) => {
    const { filterRecipients } = load('plugins/mail_policy.js');
    const env = { SITE_ENV: 'test', MAIL_ALLOWED_RECIPIENTS: 'ok@example.invalid; Other@Example.Invalid' };
    assert.deepEqual(filterRecipients('OK@example.invalid, no@example.invalid, other@example.invalid', env),
      { allowed: ['ok@example.invalid', 'other@example.invalid'], dropped: 1, restricted: true });
    assert.deepEqual(filterRecipients('no@example.invalid', env), { allowed: [], dropped: 1, restricted: true });
  });
});

test('filterRecipients: a test site with an empty or missing list sends to nobody (fail-closed)', async () => {
  await inWorkdir(async ({ load }) => {
    const { filterRecipients } = load('plugins/mail_policy.js');
    for (const list of [undefined, '', ' , ; ']) {
      const r = filterRecipients('a@example.invalid, b@example.invalid', { SITE_ENV: 'test', MAIL_ALLOWED_RECIPIENTS: list });
      assert.deepEqual(r, { allowed: [], dropped: 2, restricted: true }, `list=${JSON.stringify(list)}`);
    }
  });
});

test('filterRecipients: a list set on production is enforced too', async () => {
  await inWorkdir(async ({ load }) => {
    const { filterRecipients } = load('plugins/mail_policy.js');
    const r = filterRecipients('a@example.invalid, b@example.invalid', { MAIL_ALLOWED_RECIPIENTS: 'a@example.invalid' });
    assert.deepEqual(r, { allowed: ['a@example.invalid'], dropped: 1, restricted: true });
  });
});

test('filterRecipients: "name+*@domain" admits plus-addresses; a plain entry does not', async () => {
  await inWorkdir(async ({ load }) => {
    const { filterRecipients } = load('plugins/mail_policy.js');
    const env = { SITE_ENV: 'test', MAIL_ALLOWED_RECIPIENTS: 'davidwubot@gmail.com, davidwubot+*@gmail.com, plain@example.invalid' };
    const ok = ['davidwubot@gmail.com', 'davidwubot+emp01@gmail.com', 'DavidWuBot+Admin.2@Gmail.com', 'davidwubot+a+b@gmail.com'];
    for (const addr of ok) {
      assert.equal(filterRecipients(addr, env).allowed.length, 1, addr);
    }
    const blocked = [
      'davidwubot+@gmail.com', // empty tag
      'xdavidwubot+emp@gmail.com', // different local part
      'davidwubot+emp@gmail.com.evil.invalid', // different domain
      'davidwubot+emp@evil.invalid',
      'davidwubotx@gmail.com',
      'plain+tag@example.invalid', // a plain entry admits only itself
    ];
    for (const addr of blocked) {
      assert.deepEqual(filterRecipients(addr, env).allowed, [], addr);
    }
    // Without the wildcard entry, plus-addresses are not admitted.
    assert.deepEqual(filterRecipients('davidwubot+emp01@gmail.com',
      { SITE_ENV: 'test', MAIL_ALLOWED_RECIPIENTS: 'davidwubot@gmail.com' }).allowed, []);
  });
});

test('prefixedSubject: "[TEST] " by default on a test site, custom or none when set, none on production', async () => {
  await inWorkdir(async ({ load }) => {
    const { prefixedSubject } = load('plugins/mail_policy.js');
    assert.equal(prefixedSubject('Hi', { SITE_ENV: 'test' }), '[TEST] Hi');
    assert.equal(prefixedSubject('[TEST] Hi', { SITE_ENV: 'test' }), '[TEST] Hi');
    assert.equal(prefixedSubject('Hi', { SITE_ENV: 'test', MAIL_SUBJECT_PREFIX: '[CT104] ' }), '[CT104] Hi');
    assert.equal(prefixedSubject('Hi', {}), 'Hi');
    assert.equal(prefixedSubject('Hi', { SITE_ENV: 'production' }), 'Hi');
  });
});

test('managerMail: a test site never falls back to the built-in manager addresses', async () => {
  await inWorkdir(async ({ load }) => {
    const { managerMail } = load('plugins/manager_mail.js');
    await withEnv({ SITE_ENV: 'test', LEAVE_MANAGER_MAILS: undefined }, () => {
      assert.equal(managerMail(0), undefined);
      assert.equal(managerMail(1), undefined);
    });
    await withEnv({ SITE_ENV: 'test', LEAVE_MANAGER_MAILS: 'm0@example.invalid,m1@example.invalid' }, () => {
      assert.equal(managerMail(1), 'm1@example.invalid');
    });
    await withEnv({ SITE_ENV: undefined, LEAVE_MANAGER_MAILS: undefined }, () => {
      assert.ok(String(managerMail(0)).includes('@'));
    });
  });
});

// ---- integration: the running backend ---------------------------------------

test('SITE_ENV=test: listed recipients get mail with the [TEST] prefix; others are dropped and logged by count only', async () => {
  const server = await startServer({ env: { SITE_ENV: 'test', MAIL_ALLOWED_RECIPIENTS: 'emp1@example.invalid, davidwubot+*@gmail.com' } });
  try {
    // /permit mails emp1 (listed).
    const permit = await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 1 });
    assert.equal(permit.status, 200, permit.text);
    const [mail] = await server.smtp.waitForMessages(1);
    assert.equal(header(mail, 'To'), 'emp1@example.invalid');
    assert.equal(header(mail, 'Subject'), '[TEST] 假單審核結果通過');

    // A plus-address matches the wildcard entry.
    const plus = await server.post('/register', register('x300', 'davidwubot+x300@gmail.com'));
    assert.equal(plus.status, 200, plus.text);
    const msgs = await server.smtp.waitForMessages(2);
    assert.equal(header(msgs[1], 'To'), 'davidwubot+x300@gmail.com');
    assert.match(header(msgs[1], 'Subject'), /^\[TEST\] /);

    // An unlisted address is dropped; the log shows the count, never the address.
    const other = await server.post('/register', register('x301', 'unlisted-x301@example.invalid'));
    assert.equal(other.status, 200, other.text);
    await server.waitForOutput(/\[MAIL_ALLOWLIST\] dropped 1 recipient\(s\)/);
    await settle();
    assert.equal(server.smtp.messages.length, 2);
    assert.ok(!server.output().includes('unlisted-x301'), 'the dropped address must not be logged');
  } finally {
    await server.stop();
  }
});

test('SITE_ENV=test with no MAIL_ALLOWED_RECIPIENTS: nothing is sent (fail-closed)', async () => {
  const server = await startServer({ env: { SITE_ENV: 'test' } });
  try {
    const permit = await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 0 });
    assert.equal(permit.status, 200, permit.text);
    const reg = await server.post('/register', register('x302', 'x302@example.invalid'));
    assert.equal(reg.status, 200, reg.text);
    await waitFor(() => (server.output().match(/\[MAIL_ALLOWLIST\] dropped 1/g) || []).length >= 2, 'two dropped mails');
    await settle();
    assert.equal(server.smtp.messages.length, 0);
  } finally {
    await server.stop();
  }
});

test('SITE_ENV=test without LEAVE_MANAGER_MAILS: the leave request mail goes to nobody, not the real managers', async () => {
  // The allowlist is wide open here on purpose, to show the manager fallback alone is gone.
  const server = await startServer({ env: { SITE_ENV: 'test', MAIL_ALLOWED_RECIPIENTS: 'jeff@eucan.com.tw,catherine@eucan.com.tw' } });
  try {
    const res = await server.post('/request', leave('emp2'));
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /已向主管提出請假申請/);
    await server.waitForOutput(/No manager mail configured for mgroup 1/);
    await settle();
    assert.equal(server.smtp.messages.length, 0);
  } finally {
    await server.stop();
  }
});

test('production (SITE_ENV unset): recipients and subject are unchanged', async () => {
  const server = await startServer();
  try {
    const reg = await server.post('/register', register('x303', 'x303@example.invalid'));
    assert.equal(reg.status, 200, reg.text);
    const [mail] = await server.smtp.waitForMessages(1);
    assert.equal(header(mail, 'To'), 'x303@example.invalid');
    assert.equal(header(mail, 'Subject'), '請假系統帳號註冊成功');
  } finally {
    await server.stop();
  }
});

test('MAIL_DISABLED=1 still wins over an allowlist on a test site', async () => {
  const server = await startServer({ env: { MAIL_DISABLED: '1', SITE_ENV: 'test', MAIL_ALLOWED_RECIPIENTS: 'x304@example.invalid' } });
  try {
    const reg = await server.post('/register', register('x304', 'x304@example.invalid'));
    assert.equal(reg.status, 200, reg.text);
    await server.waitForOutput(/\[MAIL_DISABLED\] not sent/);
    await settle();
    assert.equal(server.smtp.connections(), 0);
  } finally {
    await server.stop();
  }
});
