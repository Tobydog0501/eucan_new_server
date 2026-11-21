'use strict';

// Test-site switches: MAIL_DISABLED and CALENDAR_DOWNLOAD_DISABLED.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, inWorkdir, session } = require('../testlib/harness');

const YEAR = new Date().getFullYear();
const PENDING = `${YEAR}0000`;

test('MAIL_DISABLED=1: approving a ticket opens no SMTP session and sends no mail', async () => {
  const server = await startServer({ env: { MAIL_DISABLED: '1' } });
  try {
    await server.waitForOutput(/Mailer disabled/);
    const res = await server.post('/permit', { ...session('admin1'), num: PENDING, permit: 1 });
    assert.equal(res.status, 200);
    await server.waitForOutput(/\[MAIL_DISABLED\] not sent/);
    assert.equal(server.smtp.messages.length, 0);
  } finally {
    await server.stop();
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
