'use strict';

// Test-site switches: MAIL_DISABLED, LEAVE_MANAGER_MAILS and CALENDAR_DOWNLOAD_DISABLED.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, inWorkdir, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();
const PENDING = `${YEAR}0000`;

// A weekday in March of the current year (the fixture calendar marks only weekends as days off).
function weekday() {
  const d = new Date(YEAR, 2, 2);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${YEAR}-03-${String(d.getDate()).padStart(2, '0')}`;
}

function leave(id) {
  const day = weekday();
  return { ...session(id), type: '事假', start: `${day} 08:30`, end: `${day} 12:00`, reason: 'testenv' };
}

async function waitFor(cond, what, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('control: without MAIL_DISABLED the startup verify() connects to SMTP', async () => {
  const server = await startServer();
  try {
    await waitFor(() => server.smtp.connections() > 0, 'an SMTP connection');
  } finally {
    await server.stop();
  }
});

test('MAIL_DISABLED=1: startup, /permit, /request and /register open no SMTP connection', async () => {
  const server = await startServer({ env: { MAIL_DISABLED: '1' } });
  try {
    await server.waitForOutput(/Mailer disabled/);

    const permit = await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 1 });
    assert.equal(permit.status, 200, permit.text);
    const request = await server.post('/request', leave('emp1'));
    assert.equal(request.status, 200, request.text);
    assert.match(request.text, /已向主管提出請假申請/);
    const register = await server.post('/register', {
      ...session('admin1'), user: 'x200', pwd: 'fixture-new', mail: 'x200@example.invalid',
      name: 'Name x200', date: '2024-01-01', mgroup: '0', permit: '1',
    });
    assert.equal(register.status, 200, register.text);

    await waitFor(() => (server.output().match(/\[MAIL_DISABLED\] not sent/g) || []).length >= 3, 'three suppressed mails');
    await new Promise((r) => setTimeout(r, 500)); // give any stray connection time to show up
    assert.equal(server.smtp.connections(), 0);
    assert.equal(server.smtp.messages.length, 0);
  } finally {
    await server.stop();
  }
});

test('LEAVE_MANAGER_MAILS: the leave request mail goes to the address for the employee mgroup', async () => {
  const server = await startServer({ env: { LEAVE_MANAGER_MAILS: 'group0@example.invalid, group1@example.invalid' } });
  try {
    const res = await server.post('/request', leave('emp2')); // emp2 is in mgroup 1
    assert.equal(res.status, 200, res.text);
    const [mail] = await server.smtp.waitForMessages(1);
    assert.match(mail, /^To: group1@example\.invalid$/m);
  } finally {
    await server.stop();
  }
});

test('managerMail: unset keeps the built-in list; set overrides it; unknown groups get nothing', async () => {
  const prev = process.env.LEAVE_MANAGER_MAILS;
  try {
    await inWorkdir(async ({ load }) => {
      const { managerMail } = load('plugins/manager_mail.js');
      delete process.env.LEAVE_MANAGER_MAILS;
      const builtIn = [managerMail(0), managerMail(1)];
      assert.ok(builtIn.every((m) => typeof m === 'string' && m.includes('@')));
      assert.notEqual(builtIn[0], builtIn[1]);
      process.env.LEAVE_MANAGER_MAILS = '  ';
      assert.deepEqual([managerMail(0), managerMail('1')], builtIn);

      process.env.LEAVE_MANAGER_MAILS = 'a@example.invalid,b@example.invalid';
      assert.equal(managerMail(0), 'a@example.invalid');
      assert.equal(managerMail('1'), 'b@example.invalid');
      assert.equal(managerMail(2), undefined);
      assert.equal(managerMail(-1), undefined);
    });
  } finally {
    if (prev === undefined) delete process.env.LEAVE_MANAGER_MAILS;
    else process.env.LEAVE_MANAGER_MAILS = prev;
  }
});

test('CALENDAR_DOWNLOAD_DISABLED=1: downloadJSON refuses before touching data.gov.tw', async () => {
  const prev = process.env.CALENDAR_DOWNLOAD_DISABLED;
  process.env.CALENDAR_DOWNLOAD_DISABLED = '1';
  try {
    await inWorkdir(async ({ load }) => {
      const { downloadJSON } = load('plugins/dayoff_reader.js');
      await assert.rejects(downloadJSON('999'), /CALENDAR_DOWNLOAD_DISABLED=1/);
    });
  } finally {
    if (prev === undefined) delete process.env.CALENDAR_DOWNLOAD_DISABLED;
    else process.env.CALENDAR_DOWNLOAD_DISABLED = prev;
  }
});
