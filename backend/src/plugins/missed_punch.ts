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
 *  - Nothing is mailed unless MISSED_PUNCH_MAIL_ENABLED is on, MAIL_TEST_MODE
 *    is off and MAIL_DISABLED is not 1. Otherwise the mail is written to a
 *    file in MAIL_OUTBOX_DIR (default ./logs/mail-outbox) so it can be checked.
 *  - Log lines carry only the internal account id, the date and the outcome.
 */
import fs from 'fs';
import path from 'path';
import { sql } from './sql';
import logger from './logger';
import { mailer, mailDisabled } from './mailer';
import { aggregateDay, ClockEdit, taipeiToday } from './clockin_sheet';
import { check_working_day } from './dayoff_calendar';
import { msUntilNextTaipeiMidnight } from './archive_schedule';
import { kindsOverlap } from './makeup';

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
  /** True only when real SMTP sending is switched on, test mode is off and MAIL_DISABLED is not 1. */
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
 *   MAIL_DISABLED              1 forces the outbox too (the site-wide no-mail switch)
 *   MAIL_OUTBOX_DIR            where the outbox files go (default ./logs/mail-outbox)
 *   APP_BASE_URL               site origin for the link, e.g. https://test.example
 *                              (unset: the link is the site-relative path)
 */
export function noticeConfig(env: NodeJS.ProcessEnv = process.env): NoticeConfig {
  const base = (env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  return {
    realSend: isOn(env.MISSED_PUNCH_MAIL_ENABLED) && !isOn(env.MAIL_TEST_MODE) && !mailDisabled(env),
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

/** Shift times: leave covering WORK_START excuses the clock-in, WORK_END the clock-out. */
export const WORK_START = '08:30';
export const WORK_END = '17:30';

type Person = ReturnType<sql['getAllUsers']>[number];

/** Is this account expected to punch on `date` (an active employee on the payroll)? */
function expectedToPunch(user: Person, date: string): boolean {
  const name = (user.name || '').trim();
  if (user.type !== 'employee' || user.id === 'monitor' || Number(user.status) !== 1 || !name) return false;
  if (user.joinTime && String(user.joinTime).slice(0, 10) > date) return false;
  const leaveDate = user.leaveDate;
  if (leaveDate && String(leaveDate).slice(0, 10) < date) return false;
  return true;
}

export type MissedHalves = { user: Person; missIn: boolean; missOut: boolean };

/** Loads the punches of one month (year YYYY, month MM). */
export type MonthPunches = (year: string, month: string) => ReturnType<sql['clockinRecord']>;

/**
 * The detection shared by the notice mail and the 補打卡申請 page: for each
 * of `users` expected to punch on `date` (assumed to be a working day), which
 * halves have no punch and are not excused by leave. `leaves` are the leave
 * tickets of that day that excuse (the mail passes approved ones only).
 * Soft-deleted punches do not count; approved make-up punches and admin
 * corrections do. Only people missing at least one half are returned.
 * `monthPunches` loads a month's punches; callers checking many days pass a
 * cached one (see missingPunchCards).
 */
export async function missedHalvesOn(
  sqlPlugin: sql, date: string, users: Person[], leaves: Array<{ id: string, start: string, end: string }>,
  monthPunches: MonthPunches = (year, month) => sqlPlugin.clockinRecord(year, month)
): Promise<MissedHalves[]> {
  const candidates = users.filter((user) => expectedToPunch(user, date));
  if (!candidates.length) return [];
  const punches = (await monthPunches(date.slice(0, 4), date.slice(5, 7))).filter((p) => p.date === date);
  const edits = new Map<string, ClockEdit>();
  for (const edit of sqlPlugin.clockinEditsForDate(date)) edits.set(edit.id, edit);
  const workStart = `${date} ${WORK_START}`;
  const workEnd = `${date} ${WORK_END}`;

  const out: MissedHalves[] = [];
  for (const user of candidates) {
    const own = leaves.filter((l) => l.id === user.id);
    const needIn = !own.some((l) => l.start <= workStart && l.end > workStart);
    const needOut = !own.some((l) => l.start < workEnd && l.end >= workEnd);
    if (!needIn && !needOut) continue;
    const row = aggregateDay(punches.filter((p) => p.id === user.id), edits.get(user.id) || null, (user.name || '').trim());
    const missIn = needIn && !(row && row.clockin);
    const missOut = needOut && !(row && row.clockout);
    if (missIn || missOut) out.push({ user, missIn, missOut });
  }
  return out;
}

/**
 * Who missed a punch on `date` (assumed to be a working day): active
 * employees on the payroll that day, minus what approved leave excuses.
 * People with a pending make-up request for the day are left out, since they
 * have already reported it.
 */
export async function findMissedPunches(sqlPlugin: sql, date: string): Promise<MissedPunch[]> {
  const reported = new Set(sqlPlugin.pendingMakeupIdsOn(date));
  const users = sqlPlugin.getAllUsers().filter((user) => !reported.has(user.id));
  const halves = await missedHalvesOn(sqlPlugin, date, users, sqlPlugin.approvedLeavesOnDate(date));
  return halves.map(({ user, missIn, missOut }) => ({
    id: user.id,
    name: (user.name || '').trim(),
    email: (user.email || '').trim(),
    kind: missIn && missOut ? 'both' : missIn ? 'in' : 'out',
  }));
}

/** How many days back (ending yesterday) the 補打卡申請 page looks for missing punches. */
export const MAKEUP_LOOKBACK_DAYS = 31;

export type MissingPunchCard = { date: string; kind: 'in' | 'out' };

/** The Taipei date `days` days before `date` (YYYY-MM-DD). */
function daysBefore(date: string, days: number): string {
  const [y, m, d] = date.split('-').map((part) => parseInt(part, 10));
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/**
 * The cards on one employee's 補打卡申請 page: one per missing half (上班 or
 * 下班) on each working day of the last MAKEUP_LOOKBACK_DAYS days up to
 * yesterday, newest first. Same detection as the notice mail, except that a
 * pending leave ticket excuses too and only the halves already covered by a
 * pending or approved make-up request are hidden (the mail skips the whole
 * day). Days the calendar cannot classify are left out, as the mail does.
 */
export async function missingPunchCards(
  sqlPlugin: sql, userId: string,
  options: { today: string, isWorkingDay?: (date: string) => Promise<boolean>, lookbackDays?: number }
): Promise<MissingPunchCard[]> {
  const user = sqlPlugin.getUser(userId);
  if (!user) return [];
  const isWorking = options.isWorkingDay || isOfficeWorkingDay;
  const lookback = options.lookbackDays ?? MAKEUP_LOOKBACK_DAYS;
  const cards: MissingPunchCard[] = [];
  // The window spans one or two months (three at most for longer windows):
  // load each month's punches once, not once per day.
  const loaded = new Map<string, ReturnType<MonthPunches>>();
  const monthPunches: MonthPunches = (year, month) => {
    const key = `${year}-${month}`;
    if (!loaded.has(key)) loaded.set(key, sqlPlugin.clockinRecord(year, month));
    return loaded.get(key) as ReturnType<MonthPunches>;
  };
  for (let back = 1; back <= lookback; back++) {
    const date = daysBefore(options.today, back);
    if (!expectedToPunch(user, date)) continue;
    let working: boolean;
    try {
      working = await isWorking(date);
    } catch {
      continue;
    }
    if (!working) continue;
    const leaves = sqlPlugin.leavesOnDate(date, userId, [0, 1]);
    const [found] = await missedHalvesOn(sqlPlugin, date, [user], leaves, monthPunches);
    if (!found) continue;
    const filed = sqlPlugin.activeMakeupKindsOn(userId, date);
    if (found.missIn && !filed.some((kind) => kindsOverlap(kind, 'in'))) cards.push({ date, kind: 'in' });
    if (found.missOut && !filed.some((kind) => kindsOverlap(kind, 'out'))) cards.push({ date, kind: 'out' });
  }
  return cards;
}

/** mailer.send() returns { blocked: true } when the allowlist removed every recipient. */
function isBlocked(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { blocked?: unknown }).blocked === true;
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

    // MAIL_DISABLED=1 in the running process wins even over a config that asks to send.
    const channel: 'smtp' | 'outbox' = config.realSend && !mailDisabled() ? 'smtp' : 'outbox';
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
        let blocked = false;
        if (channel === 'smtp') {
          if (!options.sender) throw new Error('no sender configured');
          const result = await options.sender(person.email, MISSED_PUNCH_SUBJECT, body);
          blocked = isBlocked(result);
        } else {
          writeOutbox(config.outboxDir, date, person.id, person.email, MISSED_PUNCH_SUBJECT, body);
        }
        // A recipient dropped by the test-site allowlist counts as handled, so it is not retried.
        sqlPlugin.finishMissedPunchNotice(person.id, date, 'sent');
        report.notified.push({ id: person.id, channel });
        const outcome = channel === 'outbox' ? 'written to outbox (sending is off)'
          : blocked ? 'not delivered (recipient not on the test-site allowlist)' : 'sent';
        log.logFormat(`Missed-punch notice ${date} for ${person.id} (${person.kind}): ${outcome}.`);
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
