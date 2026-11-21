/**
 * Missed-punch notice (未打卡通知信).
 *
 * Every day at 00:00 Asia/Taipei (and once at start-up, to catch up after a
 * restart) the previous day is checked: an active employee who should have
 * worked that day but has no clock-in or no clock-out gets one mail.
 *
 *  - Working days come from the office calendar the leave system already uses
 *    (national holidays and make-up workdays included); approved leave that
 *    covers 08:30 / 17:30 excuses the clock-in / clock-out.
 *  - At most one notice per person and day (table missed_punch_notice).
 *  - Nothing is mailed unless MISSED_PUNCH_MAIL_ENABLED is on and
 *    MAIL_TEST_MODE is off. Otherwise the mail is written to a file in
 *    MAIL_OUTBOX_DIR (default ./logs/mail-outbox) so it can be checked.
 *  - Log lines carry only the internal account id, the date and the outcome.
 */
import fs from 'fs';
import path from 'path';
import { sql } from './sql';
import logger from './logger';
import { mailer } from './mailer';
import { aggregateDay, ClockEdit, taipeiToday } from './clockin_sheet';
import { check_working_day } from './dayoff_calendar';
import { msUntilNextTaipeiMidnight } from './archive_schedule';

export const MISSED_PUNCH_SUBJECT = '祐肯企業上下班未打卡系統通知';

/** Path of the make-up request page, relative to the site root. */
export const MAKEUP_PAGE_PATH = '/employee/makeup.html';

/** "2026-03-02" -> "2026年03月02日" */
export function noticeDateText(date: string): string {
  const [year, month, day] = date.split('-');
  return `${year}年${month}月${day}日`;
}

/** The fixed notice text with name and date filled in, then the page link. */
export function missedPunchBody(name: string, date: string, link: string): string {
  return [
    `員工 ${name}您好：`,
    `經系統查核，發現您於 ${noticeDateText(date)} 有未打卡紀錄，請確認當日出勤狀況。`,
    '如因忘記打卡、系統異常或其他特殊原因而未完成打卡，請儘速填寫補登申請，並註明實際上班或下班時間及未打卡原因，由人資單位協助辦理補登作業。',
    '請同仁確實落實每日上下班打卡，以維護出勤紀錄之正確性。',
    '感謝您的配合！',
    '<此信為系統自動發送，請勿回覆>',
    '',
    `補登申請頁：${link}`,
  ].join('\n');
}

export type NoticeConfig = {
  /** True only when real SMTP sending is switched on and test mode is off. */
  realSend: boolean;
  outboxDir: string;
  link: string;
};

function isOn(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value || '').trim());
}

/**
 *   MISSED_PUNCH_MAIL_ENABLED  1/true to really send (default: off)
 *   MAIL_TEST_MODE             1/true forces the outbox even when enabled
 *   MAIL_OUTBOX_DIR            where the outbox files go (default ./logs/mail-outbox)
 *   APP_BASE_URL               site origin for the link, e.g. https://test.example
 *                              (unset: the link is the site-relative path)
 */
export function noticeConfig(env: NodeJS.ProcessEnv = process.env): NoticeConfig {
  const base = (env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  return {
    realSend: isOn(env.MISSED_PUNCH_MAIL_ENABLED) && !isOn(env.MAIL_TEST_MODE),
    outboxDir: path.resolve((env.MAIL_OUTBOX_DIR || '').trim() || './logs/mail-outbox'),
    link: `${base}${MAKEUP_PAGE_PATH}`,
  };
}

/** The Taipei calendar day before `now`, as YYYY-MM-DD. */
export function previousTaipeiDate(now: Date = new Date()): string {
  const [y, m, d] = taipeiToday(now).split('-').map((part) => parseInt(part, 10));
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return prev.toISOString().slice(0, 10);
}

/** Is `date` a working day in the office calendar? Throws when it cannot tell. */
export async function isOfficeWorkingDay(date: string): Promise<boolean> {
  const [y, m, d] = date.split('-').map((part) => parseInt(part, 10));
  const day = await check_working_day(y, String(m), String(d));
  if (!day || typeof day.status !== 'number') {
    throw new Error(`no calendar entry for ${date}`);
  }
  return day.status === 0;
}

export type MissedKind = 'in' | 'out' | 'both';

export type MissedPunch = { id: string; name: string; email: string; kind: MissedKind };

/**
 * Who missed a punch on `date` (assumed to be a working day): active
 * employees on the payroll that day, minus what approved leave excuses.
 * Soft-deleted punches do not count; approved make-up punches and admin
 * corrections do. People with a pending make-up request for the day are
 * left out, since they have already reported it.
 */
export async function findMissedPunches(sqlPlugin: sql, date: string): Promise<MissedPunch[]> {
  const yearKey = date.slice(0, 4);
  const monthKey = date.slice(5, 7);
  const punches = (await sqlPlugin.clockinRecord(yearKey, monthKey)).filter((p) => p.date === date);
  const edits = new Map<string, ClockEdit>();
  for (const edit of sqlPlugin.clockinEditsForDate(date)) edits.set(edit.id, edit);
  const leaves = sqlPlugin.approvedLeavesOnDate(date);
  const reported = new Set(sqlPlugin.pendingMakeupIdsOn(date));
  const workStart = `${date} 08:30`;
  const workEnd = `${date} 17:30`;

  const missed: MissedPunch[] = [];
  for (const user of sqlPlugin.getAllUsers()) {
    const name = (user.name || '').trim();
    if (user.type !== 'employee' || user.id === 'monitor' || Number(user.status) !== 1 || !name) continue;
    if (user.joinTime && String(user.joinTime).slice(0, 10) > date) continue;
    const leaveDate = user.leaveDate;
    if (leaveDate && String(leaveDate).slice(0, 10) < date) continue;
    if (reported.has(user.id)) continue;

    const own = leaves.filter((l) => l.id === user.id);
    const needIn = !own.some((l) => l.start <= workStart && l.end > workStart);
    const needOut = !own.some((l) => l.start < workEnd && l.end >= workEnd);
    if (!needIn && !needOut) continue;

    const row = aggregateDay(punches.filter((p) => p.id === user.id), edits.get(user.id) || null, name);
    const missIn = needIn && !(row && row.clockin);
    const missOut = needOut && !(row && row.clockout);
    if (!missIn && !missOut) continue;
    missed.push({ id: user.id, name, email: (user.email || '').trim(), kind: missIn && missOut ? 'both' : missIn ? 'in' : 'out' });
  }
  return missed;
}

export type Sender = (to: string, subject: string, text: string) => Promise<unknown>;

export type CheckReport = {
  date: string;
  skipped: null | 'not-working-day' | 'calendar-unavailable' | 'already-running';
  notified: Array<{ id: string; channel: 'smtp' | 'outbox' }>;
  alreadyNotified: string[];
  failed: string[];
  noEmail: string[];
};

type Log = Pick<logger, 'logFormat'>;

function outboxFileName(date: string, id: string): string {
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
  return `${date}_${safeId}.txt`;
}

function writeOutbox(dir: string, date: string, id: string, to: string, subject: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort (e.g. Windows) */ }
  const file = path.join(dir, outboxFileName(date, id));
  const content = `To: ${to}\nSubject: ${subject}\n\n${body}\n`;
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

/** A short, address-free description of a send failure for the log. */
function failureCode(e: unknown): string {
  const err = e as { code?: unknown, responseCode?: unknown, name?: unknown };
  if (err && typeof err.code === 'string') return err.code;
  if (err && typeof err.responseCode === 'number') return `SMTP ${err.responseCode}`;
  if (err && typeof err.name === 'string') return err.name;
  return 'error';
}

let running = false;

/**
 * Check one day (default: yesterday in Taipei) and notify. Safe to run again
 * for the same day: people already notified are skipped. A failed send is
 * retried on the next run.
 */
export async function runMissedPunchCheck(
  sqlPlugin: sql,
  log: Log,
  options: { date?: string, now?: Date, sender?: Sender, config?: NoticeConfig, isWorkingDay?: (date: string) => Promise<boolean> } = {}
): Promise<CheckReport> {
  const date = options.date || previousTaipeiDate(options.now);
  const report: CheckReport = { date, skipped: null, notified: [], alreadyNotified: [], failed: [], noEmail: [] };
  if (running) {
    report.skipped = 'already-running';
    return report;
  }
  running = true;
  try {
    const config = options.config || noticeConfig();
    let working: boolean;
    try {
      working = await (options.isWorkingDay || isOfficeWorkingDay)(date);
    } catch (e) {
      // Without a calendar we cannot tell holidays apart; mailing everybody on
      // a holiday is worse than a missed notice, so do nothing this time.
      report.skipped = 'calendar-unavailable';
      log.logFormat(`Missed-punch check ${date}: calendar unavailable, skipped (${failureCode(e)}).`);
      return report;
    }
    if (!working) {
      report.skipped = 'not-working-day';
      log.logFormat(`Missed-punch check ${date}: not a working day, skipped.`);
      return report;
    }

    const channel: 'smtp' | 'outbox' = config.realSend ? 'smtp' : 'outbox';
    for (const person of await findMissedPunches(sqlPlugin, date)) {
      if (!person.email) {
        report.noEmail.push(person.id);
        log.logFormat(`Missed-punch notice ${date} for ${person.id} (${person.kind}): no e-mail address on file, not sent.`);
        continue;
      }
      if (!sqlPlugin.claimMissedPunchNotice(person.id, date, person.kind, channel)) {
        report.alreadyNotified.push(person.id);
        continue;
      }
      const body = missedPunchBody(person.name, date, config.link);
      try {
        if (channel === 'smtp') {
          if (!options.sender) throw new Error('no sender configured');
          await options.sender(person.email, MISSED_PUNCH_SUBJECT, body);
        } else {
          writeOutbox(config.outboxDir, date, person.id, person.email, MISSED_PUNCH_SUBJECT, body);
        }
        sqlPlugin.finishMissedPunchNotice(person.id, date, 'sent');
        report.notified.push({ id: person.id, channel });
        log.logFormat(`Missed-punch notice ${date} for ${person.id} (${person.kind}): ${channel === 'smtp' ? 'sent' : 'written to outbox (sending is off)'}.`);
      } catch (e) {
        sqlPlugin.finishMissedPunchNotice(person.id, date, 'failed');
        report.failed.push(person.id);
        log.logFormat(`Missed-punch notice ${date} for ${person.id} (${person.kind}): failed (${failureCode(e)}), will retry on the next run.`);
      }
    }
    log.logFormat(`Missed-punch check ${date}: ${report.notified.length} notified via ${channel}, ${report.alreadyNotified.length} already notified, ${report.failed.length} failed, ${report.noEmail.length} without e-mail.`);
    return report;
  } finally {
    running = false;
  }
}

/**
 * Run the check at start-up and then every day just after 00:00 Taipei time.
 * MISSED_PUNCH_CHECK=0 turns the schedule off.
 */
export function startMissedPunchSchedule(sqlPlugin: sql, log: logger, mail: mailer): void {
  if (/^(0|false|no|off)$/i.test((process.env.MISSED_PUNCH_CHECK || '').trim())) {
    log.logFormat('Missed-punch check is switched off (MISSED_PUNCH_CHECK).');
    return;
  }
  const sender: Sender = (to, subject, text) => mail.send(to, subject, text);
  const run = (): void => {
    runMissedPunchCheck(sqlPlugin, log, { sender }).catch((e) => {
      log.logFormat(`Missed-punch check failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  const scheduleNext = (): void => {
    setTimeout(() => {
      run();
      scheduleNext();
    }, msUntilNextTaipeiMidnight(new Date()));
  };
  run();
  scheduleNext();
}
