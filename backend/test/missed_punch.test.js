'use strict';

// Missed-punch notice: who gets one, de-duplication, the outbox used while
// sending is off (no SMTP connection at all), the exact text, and the real
// SMTP path against the local fake server. All people and addresses are
// fixtures in a throw-away database.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, startFakeSmtp, inWorkdir } = require('../testlib/harness');

const PAST_YEAR = new Date().getFullYear() - 1;

function firstDow(year, month, dow) {
  for (let day = 1; day <= 7; day++) {
    if (new Date(year, month - 1, day).getDay() === dow) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  throw new Error('unreachable');
}
// The fixture calendar marks weekends as days off and every other day as a workday.
const MONDAY = firstDow(PAST_YEAR, 3, 1);
const TUESDAY = firstDow(PAST_YEAR, 3, 2);
const SATURDAY = firstDow(PAST_YEAR, 3, 6);

const SUBJECT = '祐肯企業上下班未打卡系統通知';
function expectedBody(name, date, link) {
  const [y, m, d] = date.split('-');
  return `員工 ${name}您好：
經系統查核，發現您於 ${y}年${m}月${d}日 有未打卡紀錄，請確認當日出勤狀況。
如因忘記打卡、系統異常或其他特殊原因而未完成打卡，請儘速填寫補登申請，並註明實際上班或下班時間及未打卡原因，由人資單位協助辦理補登作業。
請同仁確實落實每日上下班打卡，以維護出勤紀錄之正確性。
感謝您的配合！
<此信為系統自動發送，請勿回覆>

補登申請頁：${link}`;
}

const LINK = 'https://test.example.invalid/employee/makeup.html';

/**
 * Extra fixture people on top of the harness users (emp1, emp2 are employees;
 * root, admin1, admin2 are admins and never checked):
 *  emp1  clock-in only                         -> notice (out)
 *  emp2  approved full-day leave               -> none
 *  emp3  nothing at all                        -> notice (both)
 *  emp4  resigned (status 0)                   -> none
 *  emp5  joins after the day                   -> none
 *  emp6  both punches                          -> none
 *  emp7  morning leave, clock-out only         -> none (clock-in excused)
 *  emp8  clock-out punch soft-deleted          -> notice (out)
 *  emp9  nothing, but a pending make-up request -> none
 */
function seedDay(file, date) {
  const db = new Database(file);
  try {
    const addUser = db.prepare(`INSERT OR IGNORE INTO userinfo (id,pwd,type,email,name,joinTime,mgroup,permit,status) VALUES (?,?,?,?,?,?,?,?,?)`);
    const people = [
      ['emp3', '2020-01-01', 1], ['emp4', '2020-01-01', 0], ['emp5', `${PAST_YEAR + 1}-01-01`, 1],
      ['emp6', '2020-01-01', 1], ['emp7', '2020-01-01', 1], ['emp8', '2020-01-01', 1], ['emp9', '2020-01-01', 1],
    ];
    for (const [id, join, status] of people) addUser.run(id, 'fixture', 'employee', `${id}@example.invalid`, `Fixture ${id}`, join, 0, 1, status);
    const punch = db.prepare(`INSERT INTO clockinrecord (id,name,date,num,clockin,clockout) VALUES (?,?,?,?,?,?)`);
    punch.run('emp1', 'Employee One', date, 1, '08:20', null);
    punch.run('emp6', 'Fixture emp6', date, 1, '08:25', '17:35');
    punch.run('emp7', 'Fixture emp7', date, 1, null, '17:35');
    punch.run('emp8', 'Fixture emp8', date, 1, '08:10', null);
    punch.run('emp8', 'Fixture emp8', date, 2, null, '17:40');
    const ticket = db.prepare(`INSERT INTO requestquery (serialnum,id,name,type,start,end,mgroup,state,year,month,totalTime,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    ticket.run(`${date}-a`, 'emp2', 'Employee Two', '病假', `${date} 08:30`, `${date} 17:30`, 1, 1, `${PAST_YEAR}`, '3', 8, 'fixture');
    ticket.run(`${date}-b`, 'emp7', 'Fixture emp7', '事假', `${date} 08:30`, `${date} 12:30`, 0, 1, `${PAST_YEAR}`, '3', 4, 'fixture');
  } finally {
    db.close();
  }
}

function capture() {
  const lines = [];
  return { lines, logFormat: (m) => { lines.push(String(m)); } };
}

async function withJob(fn) {
  await inWorkdir(async ({ cwd, load }) => {
    const file = path.join(cwd, 'databases', 'loginDatabase.db');
    const { sql } = load('plugins/sql.js');
    const job = load('plugins/missed_punch.js');
    const db = new sql();
    try {
      await fn({ cwd, file, db, job });
    } finally {
      db.close();
    }
  });
}

function notices(file) {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT id, date, kind, channel, status FROM missed_punch_notice ORDER BY id').all();
  } finally {
    db.close();
  }
}

test('missed-punch notice: text is exactly the given wording; config is off by default', async () => {
  await withJob(async ({ job }) => {
    assert.equal(job.MISSED_PUNCH_SUBJECT, SUBJECT);
    assert.equal(job.missedPunchBody('王小明', '2026-03-02', LINK), expectedBody('王小明', '2026-03-02', LINK));
    assert.equal(job.noticeDateText('2026-03-02'), '2026年03月02日');

    const off = job.noticeConfig({});
    assert.equal(off.realSend, false);
    assert.equal(off.link, '/employee/makeup.html');
    assert.equal(job.noticeConfig({ MISSED_PUNCH_MAIL_ENABLED: '1' }).realSend, true);
    assert.equal(job.noticeConfig({ MISSED_PUNCH_MAIL_ENABLED: 'true', MAIL_TEST_MODE: '1' }).realSend, false);
    assert.equal(job.noticeConfig({ MISSED_PUNCH_MAIL_ENABLED: '0' }).realSend, false);
    assert.equal(job.noticeConfig({ APP_BASE_URL: 'https://test.example.invalid/' }).link, LINK);

    // 00:30 in Taipei on 3 March checks 2 March.
    assert.equal(job.previousTaipeiDate(new Date('2026-03-02T16:30:00Z')), '2026-03-02');
    assert.equal(job.previousTaipeiDate(new Date('2026-03-01T15:59:00Z')), '2026-02-28');
  });
});

test('missed-punch notice: sending off -> only outbox files, no SMTP connection; leave, weekends and resigned people skipped; re-run sends nothing', async () => {
  const smtp = await startFakeSmtp('accept');
  const saved = { SMTP_SERVER: process.env.SMTP_SERVER, SMTP_PORT: process.env.SMTP_PORT };
  try {
    process.env.SMTP_SERVER = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.port);
    await withJob(async ({ cwd, file, db, job, }) => {
      seedDay(file, MONDAY);
      db.createMakeupRequest({ id: 'emp9', name: 'Fixture emp9', department: 'JEFF' }, { date: MONDAY, kind: 'both', clockin: '08:30', clockout: '17:30', reason: '忘記打卡' });
      assert.equal(db.softDeletePunch({ id: 'emp8', date: MONDAY, num: 2 }, { id: 'admin1', name: 'Admin One' }, '誤打'), 'done');

      // A real mailer pointed at the fake server: it must never be used.
      const { mailer } = require(path.join(require('../testlib/harness').BUILD_DIR, 'plugins', 'mailer.js'));
      const real = new mailer();
      let senderCalls = 0;
      const sender = (to, s, b) => { senderCalls++; return real.send(to, s, b); };
      const outbox = path.join(cwd, 'logs', 'mail-outbox');
      const config = job.noticeConfig({ MAIL_OUTBOX_DIR: outbox, APP_BASE_URL: 'https://test.example.invalid' });
      const log = capture();

      // Weekend: nothing at all.
      const weekend = await job.runMissedPunchCheck(db, log, { date: SATURDAY, sender, config });
      assert.equal(weekend.skipped, 'not-working-day');
      assert.equal(fs.existsSync(outbox), false);

      const report = await job.runMissedPunchCheck(db, log, { date: MONDAY, sender, config });
      assert.equal(report.skipped, null);
      assert.deepEqual(report.notified.map((n) => [n.id, n.channel]).sort(), [['emp1', 'outbox'], ['emp3', 'outbox'], ['emp8', 'outbox']]);
      assert.deepEqual(report.failed, []);
      assert.deepEqual(notices(file).map((n) => [n.id, n.kind, n.channel, n.status]),
        [['emp1', 'out', 'outbox', 'sent'], ['emp3', 'both', 'outbox', 'sent'], ['emp8', 'out', 'outbox', 'sent']]);

      // Each outbox file holds recipient, subject, exact body and link.
      const files = fs.readdirSync(outbox).sort();
      assert.deepEqual(files, [`${MONDAY}_emp1.txt`, `${MONDAY}_emp3.txt`, `${MONDAY}_emp8.txt`]);
      const content = fs.readFileSync(path.join(outbox, `${MONDAY}_emp3.txt`), 'utf8');
      assert.equal(content, `To: emp3@example.invalid\nSubject: ${SUBJECT}\n\n${expectedBody('Fixture emp3', MONDAY, LINK)}\n`);
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(outbox).mode & 0o777, 0o700);
        for (const f of files) assert.equal(fs.statSync(path.join(outbox, f)).mode & 0o777, 0o600, f);
      }

      // Same day again: nobody is notified twice, files stay as they were.
      const before = files.map((f) => fs.readFileSync(path.join(outbox, f), 'utf8'));
      const again = await job.runMissedPunchCheck(db, log, { date: MONDAY, sender, config });
      assert.deepEqual(again.notified, []);
      assert.deepEqual(again.alreadyNotified.sort(), ['emp1', 'emp3', 'emp8']);
      assert.deepEqual(fs.readdirSync(outbox).sort().map((f) => fs.readFileSync(path.join(outbox, f), 'utf8')), before);
      assert.equal(notices(file).length, 3);

      // Never touched SMTP.
      assert.equal(senderCalls, 0);
      assert.equal(smtp.connections(), 0);
      assert.equal(smtp.messages.length, 0);

      // The log names internal ids only: no addresses, no names.
      const ours = log.lines.filter((l) => l.startsWith('Missed-punch'));
      assert.ok(ours.some((l) => l.includes('emp3') && l.includes('outbox')), ours.join('\n'));
      for (const line of ours) {
        assert.ok(!line.includes('@'), line);
        assert.ok(!line.includes('Fixture'), line);
      }
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await smtp.close();
  }
});

test('missed-punch notice: sending on -> mails through SMTP once; a failed send is retried on the next run', async () => {
  const saved = { SMTP_SERVER: process.env.SMTP_SERVER, SMTP_PORT: process.env.SMTP_PORT, USER_MAIL: process.env.USER_MAIL, USER_PWD: process.env.USER_PWD };
  const smtpDown = await startFakeSmtp('reject');
  const smtpUp = await startFakeSmtp('accept');
  try {
    await withJob(async ({ cwd, file, db, job }) => {
      // Plain fixture day: emp8 keeps both punches and emp9 has no make-up
      // request, so the notices go to emp1 (out), emp3 and emp9 (both).
      seedDay(file, TUESDAY);
      const { mailer } = require(path.join(require('../testlib/harness').BUILD_DIR, 'plugins', 'mailer.js'));
      const mailerFor = (smtp) => {
        process.env.SMTP_SERVER = '127.0.0.1';
        process.env.SMTP_PORT = String(smtp.port);
        // Fake credentials for the fake server (same as the harness uses).
        process.env.USER_MAIL = 'system@example.invalid';
        process.env.USER_PWD = 'fixture-smtp';
        const m = new mailer();
        return (to, s, b) => m.send(to, s, b);
      };
      const outbox = path.join(cwd, 'logs', 'mail-outbox');
      const config = job.noticeConfig({ MISSED_PUNCH_MAIL_ENABLED: '1', MAIL_OUTBOX_DIR: outbox, APP_BASE_URL: 'https://test.example.invalid' });
      assert.equal(config.realSend, true);
      const log = capture();

      // Server refuses: every notice fails and is recorded as failed.
      const down = await job.runMissedPunchCheck(db, log, { date: TUESDAY, sender: mailerFor(smtpDown), config });
      assert.deepEqual(down.notified, []);
      assert.deepEqual(down.failed.sort(), ['emp1', 'emp3', 'emp9']);
      assert.ok(notices(file).every((n) => n.status === 'failed' && n.channel === 'smtp'));

      // Next run: retried and delivered, one mail each.
      const up = await job.runMissedPunchCheck(db, log, { date: TUESDAY, sender: mailerFor(smtpUp), config });
      assert.deepEqual(up.notified.map((n) => [n.id, n.channel]).sort(), [['emp1', 'smtp'], ['emp3', 'smtp'], ['emp9', 'smtp']], log.lines.join(' | '));
      await smtpUp.waitForMessages(3);
      for (const id of ['emp1', 'emp3', 'emp9']) {
        assert.equal(smtpUp.messages.filter((m) => m.includes(`To: ${id}@example.invalid`)).length, 1, id);
      }
      assert.ok(smtpUp.messages.every((m) => /^Subject: /m.test(m)));
      assert.ok(notices(file).every((n) => n.status === 'sent'));

      // And not again.
      const third = await job.runMissedPunchCheck(db, log, { date: TUESDAY, sender: mailerFor(smtpUp), config });
      assert.deepEqual(third.notified, []);
      assert.equal(smtpUp.messages.length, 3);
      assert.equal(fs.existsSync(outbox), false, 'real sending writes no outbox files');
      for (const line of log.lines) assert.ok(!line.includes('@'), line);
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await smtpDown.close();
    await smtpUp.close();
  }
});

test('missed-punch notice: the backend schedules the check at start-up, with sending off by default', async () => {
  const server = await startServer();
  try {
    await server.waitForOutput(/Missed-punch check \d{4}-\d{2}-\d{2}: /);
    assert.equal(server.smtp.messages.length, 0);
    assert.ok(!/Missed-punch notice [^\n]*: sent\./.test(server.output()), server.output());
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});
