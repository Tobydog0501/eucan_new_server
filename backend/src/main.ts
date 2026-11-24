import express, { Express, Request, Response } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { sql } from './plugins/sql';
import logger from './plugins/logger';
import { mailer } from './plugins/mailer';
import { sqli_detect } from './plugins/anti_SQLI';
import { check_working_day, main as generateCalendarExcel } from './plugins/dayoff_calendar';
import { startArchiveSchedule } from './plugins/archive_schedule';
import { aggregateDay, ClockEdit, decideEdit, isRealDate, taipeiToday } from './plugins/clockin_sheet';
import { personalClockinPdf, readMasterClockinPdf, writeClockinMaster } from './plugins/clockin_archive';
import { canDeletePunch, canRestorePunch, canReviewMakeup } from './plugins/account_rules';
import { departmentOf, kindsOverlap, MAKEUP_KIND_LABELS, MAKEUP_REASON_MAX, checkMakeupTime, makeupFromCard, validateMakeupCard } from './plugins/makeup';
import { missingPunchCards, startMissedPunchSchedule, WORK_END, WORK_START } from './plugins/missed_punch';
import type { MissingPunchCard } from './plugins/missed_punch';
import type { MakeupRequestRow, MakeupState } from './plugins/sql';
import { onDownloadDone } from './plugins/http_util';
import path from 'path';
import fs from 'fs';

const log = new logger(`./logs/${new Date().toISOString().split('T')[0]}.log`);
const sqlPlugin: sql = new sql();
const mailers = new mailer();
const app: Express = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);

app.use(bodyParser.urlencoded({
  extended: true
}));

app.use(bodyParser.json());

app.use(cors({
  "origin": process.env.CORS_ORIGIN || "https://eucan.ddns.net",
  "methods": "GET,POST,OPTIONS",
  "credentials": true,             // MUST be true if sending cookies/sessions
  "optionsSuccessStatus": 204
}));

app.all('/', (req: Request, res: Response) => {
  res.send("System online.");
});

app.get('/api/calendar/years', (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');

    if (!account || !cookie) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null) {
      res.sendStatus(403);
      return;
    }

    const years = new Set<number>();
    const calendarDir = './api';
    if (fs.existsSync(calendarDir)) {
      for (const fileName of fs.readdirSync(calendarDir)) {
        const match = fileName.match(/^office_calendar_(\d{2,3})\.json$/);
        if (!match) {
          continue;
        }
        years.add(parseInt(match[1], 10) + 1911);
      }
    }

    if (years.size === 0) {
      years.add(new Date().getFullYear());
    }

    res.json({ years: Array.from(years).sort((a, b) => a - b) });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.get('/api/clockin/years', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');

    if (!account || !cookie) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const years = sqlPlugin.clockinYears();
    res.json({ years: years.length > 0 ? years : [new Date().getFullYear()] });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

const posts: Array<string> = ['login', 'users', 'session', "register", 'dayoff', 'request', 'query', 'permit', 'init', 'approved', 'empquery', 'delete', "modify", "quota", "clockin", "sync", "calendar", "clrecord", "tmodify", "modemp", "batchrequest"];
posts.forEach(v => {
  const utils = require(`./system/${v}.js`).bind(null, sqlPlugin, log, mailers);
  app.post(`/${v}`, (req: Request, res: Response) => {
    if (sqli_detect(req.body)) {
      res.sendStatus(400);
      return;
    }
    // Handlers may be sync or async; route both thrown errors and rejected
    // promises to a 500 instead of letting a rejection take the process down.
    Promise.resolve()
      .then(() => utils(req, res))
      .catch((e: unknown) => {
        log.logFormat(`POST /${v} failed: ${errorText(e)}`, new Date());
        if (!res.headersSent) {
          res.sendStatus(500);
        }
      });
  });
})

// Last line of defence: log stray rejections (e.g. a fire-and-forget mail send)
// rather than crashing every user's session.
process.on('unhandledRejection', (reason: unknown) => {
  log.logFormat(`Unhandled promise rejection: ${errorText(reason)}`, new Date());
});

function errorText(e: unknown): string {
  if (e instanceof Error) {
    return e.stack || e.message;
  }
  return String(e);
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  log.logFormat("Server online.");
  const mailerStatus = mailers.verify();
  if (!mailerStatus) {
    console.error("Mailer Verify Failed!");
  }
  startArchiveSchedule(sqlPlugin, log);
  startMissedPunchSchedule(sqlPlugin, log, mailers);
});

// Public view endpoint: return calendar JSON (weeks grid)
app.get('/api/calendar/view', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const year = parseInt(String(req.query.year || '0'));
    const month = parseInt(String(req.query.month || '0'));

    if (!account || !cookie || !year || !month) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null) {
      res.sendStatus(403);
      return;
    }

    // Build calendar JSON (re-using the same logic as dayoff_calendar)
    const reminders = sqlPlugin.showQueryInMonth(year, month);
    const totalDays = new Date(year, month, 0).getDate();
    let dailyReminders: { [key: number]: string[] } = {};
    for (let d = 1; d <= totalDays; d++) {
      dailyReminders[d] = [];
    }

    // Fill non-working day comments
    for (let d = 1; d <= totalDays; d++) {
      let cal = await check_working_day(year, month.toString(), d.toString());
      if (cal['status'] === 1 && cal['comment']) {
        dailyReminders[d].push(cal['comment']);
      }
    }

    for (const rem of reminders) {
      const start = new Date(rem.start.replace(' ', 'T'));
      const end = new Date(rem.end.replace(' ', 'T'));
      const name = rem.name;
      const startDay = start.getDate();
      const endDay = end.getDate();

      for (let day = startDay; day <= endDay; day++) {
        const cal = await check_working_day(year, month.toString(), day.toString());
        if (cal['status'] === 1) continue;
        const shortdayoffd: { [k: string]: string } = {
          '事假': '事', '特休假_N': '特N', '家庭照顧假': '家', '病假': '病', '婚假': '婚', '喪假': '喪', '分娩假': '娩', '產檢假': '檢', '流產假': '流', '陪產假': '陪', '產假': '產', '公假': '公', '停班停課': '停', '其他': '其'
        };
        let text = `${name}`;
        if (rem.type != '特休假') {
          text += `(${shortdayoffd[rem.type as keyof typeof shortdayoffd]})`;
        }
        let temp = '';
        if (start.getTime() === end.getTime()) continue;
        if (startDay === endDay) {
          temp += `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}~${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`;
        } else if (day === startDay) {
          temp += `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}~17:30`;
        } else if (day === endDay) {
          temp += `08:30~${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`;
        }
        if (temp != '08:30~17:30') {
          text += temp;
        }
        const two_times = temp.split('~');
        if (two_times[0] == two_times[1]) continue;
        dailyReminders[day].push(text);
      }
    }

    // Build weeks (grid)
    const weeks: Array<Array<null | { day: number, reminders: string[] }>> = [];
    let currentWeek: Array<null | { day: number, reminders: string[] }> = [];
    const firstDayIndex = new Date(year, month - 1, 1).getDay();
    for (let i = 0; i < firstDayIndex; i++) currentWeek.push(null);
    for (let day = 1; day <= totalDays; day++) {
      currentWeek.push({ day, reminders: dailyReminders[day] });
      if (currentWeek.length === 7) { weeks.push(currentWeek); currentWeek = []; }
    }
    if (currentWeek.length > 0) { while (currentWeek.length < 7) currentWeek.push(null); weeks.push(currentWeek); }

    res.json({ year, month, weeks });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

// Public view endpoint: return clock-in records JSON (admin only)
app.get('/api/clockin/view', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    const day = parseInt(String(req.query.day || ''), 10);

    if (!account || !cookie || !parsed || !Number.isInteger(day)) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const { year, month, yearKey, monthKey } = parsed;
    const totalDays = new Date(year, month, 0).getDate();
    if (day < 1 || day > totalDays) {
      res.sendStatus(400);
      return;
    }

    const date = `${yearKey}-${monthKey}-${day.toString().padStart(2, '0')}`;
    const users = sqlPlugin.getAllUsers().filter((user) =>
      user.id !== 'monitor' &&
      user.status === 1 &&
      user.type === 'employee' &&
      (user.name || '').trim().length > 0
    );
    users.sort((a, b) => compareEmployeeId(a.id, b.id));
    const monthRecords = await sqlPlugin.clockinRecord(yearKey, monthKey);
    const punches = indexPunches(monthRecords);
    const edits = indexEdits(sqlPlugin.clockinEditsForMonth(yearKey, monthKey));
    const downloadableIds = new Set(sqlPlugin.clockinMasterRows(yearKey, monthKey).map((row) => row.id));
    const onLeaveIds = new Set(sqlPlugin.approvedLeaveIdsOnDate(date));
    const records = users.map((user) => {
      const live = summarizeClockinDay(punches.get(clockinKey(user.id, date)) || [], edits.get(clockinKey(user.id, date)) || null, user.name);
      return {
        id: user.id,
        name: user.name,
        clockin: live.clockin,
        clockout: live.clockout,
        hasRecord: live.hasRecord,
        onLeave: onLeaveIds.has(user.id),
        downloadable: downloadableIds.has(user.id),
        modified: live.modified,
        makeup: live.makeup,
        reason: live.reason,
        editorName: live.editorName,
        editedAt: live.editedAt,
      };
    });

    res.json({
      year,
      month,
      day,
      masterReady: sqlPlugin.clockinMasterReady(yearKey, monthKey),
      records,
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

// Public view endpoint: return clock-in status for a specific day (admin only)
app.get('/api/clockin/day', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const year = parseInt(String(req.query.year || '0'));
    const month = parseInt(String(req.query.month || '0'));
    const day = parseInt(String(req.query.day || '0'));

    if (!account || !cookie || !year || !month || !day) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const monthKey = month.toString().padStart(2, '0');
    const dayKey = day.toString().padStart(2, '0');
    const targetDate = `${year}-${monthKey}-${dayKey}`;
    const users = sqlPlugin.getAllUsers().filter((user) =>
      user.id !== 'monitor' &&
      user.status === 1 &&
      user.type === 'employee' &&
      (user.name || '').trim().length > 0
    );
    const recordsForMonth = await sqlPlugin.clockinRecord(year, monthKey);
    const punches = indexPunches(recordsForMonth);
    const edits = indexEdits(sqlPlugin.clockinEditsForDate(targetDate));
    const data = users.map((user) => {
      const live = summarizeClockinDay(punches.get(clockinKey(user.id, targetDate)) || [], edits.get(clockinKey(user.id, targetDate)) || null, user.name);
      return {
        id: user.id,
        name: user.name,
        clockin: live.clockin,
        clockout: live.clockout,
        hasRecord: live.hasRecord,
        modified: live.modified,
        makeup: live.makeup,
        reason: live.reason,
        editorName: live.editorName,
        editedAt: live.editedAt,
      };
    });
    data.sort((a, b) => compareEmployeeId(a.id, b.id));

    res.json({ year, month, day, records: data });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.get('/api/clockin/directory', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    if (!account || !cookie || !parsed) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const activity = new Set(sqlPlugin.employeeIdsWithMonthActivity(parsed.yearKey, parsed.monthKey));
    const employees = sqlPlugin.getAllUsers().filter((user) => {
      if (user.type !== 'employee' || user.id === 'monitor' || !(user.name || '').trim()) {
        return false;
      }
      if (user.status === 1) {
        return true;
      }
      return user.status === 0 && activity.has(user.id);
    }).map((user) => ({
      id: user.id,
      name: user.name,
      status: user.status,
    }));
    employees.sort((a, b) => compareEmployeeId(a.id, b.id));
    res.json({ employees });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.get('/api/clockin/employee', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const id = String(req.query.id || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    if (!account || !cookie || !id || !parsed) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const user = sqlPlugin.getUser(id);
    if (!user || user.type !== 'employee' || user.id === 'monitor') {
      res.status(404).json({ message: '找不到這位員工' });
      return;
    }

    const { year, month, yearKey, monthKey } = parsed;
    const monthRecords = await sqlPlugin.clockinRecord(yearKey, monthKey);
    const punches = indexPunches(monthRecords.filter((item) => item.id === id));
    const edits = indexEdits(sqlPlugin.clockinEditsForMonth(yearKey, monthKey).filter((item) => item.id === id));
    const snapshot = sqlPlugin.clockinMasterRows(yearKey, monthKey, id);
    const totalDays = new Date(year, month, 0).getDate();
    const days = [];
    for (let day = 1; day <= totalDays; day++) {
      const date = `${yearKey}-${monthKey}-${day.toString().padStart(2, '0')}`;
      const live = summarizeClockinDay(punches.get(clockinKey(id, date)) || [], edits.get(clockinKey(id, date)) || null, user.name || '');
      days.push({
        day,
        date,
        clockin: live.clockin,
        clockout: live.clockout,
        hasRecord: live.hasRecord,
        modified: live.modified,
        makeup: live.makeup,
        reason: live.reason,
        editorName: live.editorName,
        editedAt: live.editedAt,
      });
    }

    res.json({
      employee: { id: user.id, name: user.name, status: user.status },
      masterReady: sqlPlugin.clockinMasterReady(yearKey, monthKey),
      downloadable: snapshot.length > 0,
      days,
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.post('/api/clockin/edit', async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body as { [key: string]: unknown } : {};
    const account = bodyText(body['account']);
    const cookie = bodyText(body['cookie']);
    const id = bodyText(body['id']);
    const date = bodyText(body['date']);
    const clockin = body['clockin'] == null ? null : String(body['clockin']);
    const clockout = body['clockout'] == null ? null : String(body['clockout']);
    const reason = body['reason'] == null ? '' : String(body['reason']);

    if (!account || !cookie || !id || !date) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const user = sqlPlugin.getUser(id);
    if (!user || user.type !== 'employee' || user.id === 'monitor') {
      res.status(404).json({ message: '找不到這位員工' });
      return;
    }

    const today = taipeiToday();
    let currentClockin: string | null = null;
    let currentClockout: string | null = null;
    if (isRealDate(date) && date <= today) {
      const yearKey = date.slice(0, 4);
      const monthKey = date.slice(5, 7);
      const monthRecords = await sqlPlugin.clockinRecord(yearKey, monthKey);
      const punches = monthRecords.filter((item) => item.id === id && item.date === date);
      const dayEdits = sqlPlugin.clockinEditsForDate(date);
      let edit: ClockEdit | null = null;
      for (const item of dayEdits) {
        if (item.id === id) {
          edit = item;
          break;
        }
      }
      const live = summarizeClockinDay(punches, edit, user.name || '');
      currentClockin = live.clockin;
      currentClockout = live.clockout;
    }

    const decision = decideEdit(
      { clockin: currentClockin, clockout: currentClockout },
      { date, clockin, clockout, reason },
      today
    );
    if (!decision.ok) {
      res.status(400).json({ message: decision.message });
      return;
    }
    if (decision.kind === 'unchanged') {
      res.status(200).json({ status: 'unchanged', message: '時間沒有變更' });
      return;
    }

    sqlPlugin.saveClockinEdit({
      id: user.id,
      date,
      name: user.name || '',
      clockin: decision.clockin,
      clockout: decision.clockout,
      reason: decision.reason,
      editorId: account,
      editorName: ret['name'],
    });
    log.logFormat(`${ret['name']} (${account}) corrected clock-in of ${user.name} (${id}) on ${date}.`);
    res.status(200).json({ status: 'saved' });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

// Single punches of one employee on one day, for the delete / restore UI
// (admin only; soft-deleted punches and the audit trail are root only).
app.get('/api/clockin/punches', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const id = String(req.query.id || '');
    const date = String(req.query.date || '');
    if (!account || !cookie || !id || !isRealDate(date)) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] != 'admin') {
      res.sendStatus(403);
      return;
    }

    const isRoot = canRestorePunch({ id: account, type: ret['accountType'] }).ok;
    res.json({
      id,
      date,
      canRestore: isRoot,
      punches: sqlPlugin.clockinPunches(id, date, isRoot),
      audit: isRoot ? sqlPlugin.punchAudit({ id, date }) : [],
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.post('/api/clockin/punch/delete', async (req: Request, res: Response) => {
  await changePunch(req, res, 'delete');
});

app.post('/api/clockin/punch/restore', async (req: Request, res: Response) => {
  await changePunch(req, res, 'restore');
});

const PUNCH_REASON_MAX = 200;

async function changePunch(req: Request, res: Response, action: 'delete' | 'restore'): Promise<void> {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body as { [key: string]: unknown } : {};
    const account = body['account'];
    const cookie = body['cookie'];
    const id = body['id'];
    const date = body['date'];
    const numRaw = body['num'];
    const reasonRaw = body['reason'];
    if (typeof account !== 'string' || typeof cookie !== 'string' || typeof id !== 'string' || id.length === 0 ||
      typeof date !== 'string' || !isRealDate(date) ||
      !((typeof numRaw === 'number' || typeof numRaw === 'string') && /^[1-9]\d{0,5}$/.test(`${numRaw}`))) {
      res.sendStatus(400);
      return;
    }
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    if (!reason) {
      res.status(400).json({ message: '請填寫原因' });
      return;
    }
    if (reason.length > PUNCH_REASON_MAX) {
      res.status(400).json({ message: `原因最多 ${PUNCH_REASON_MAX} 字` });
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null) {
      res.sendStatus(403);
      return;
    }
    const actor = { id: account, type: ret['accountType'] };
    // A punch whose account no longer exists is treated like an admin's:
    // only root may touch it.
    const owner = sqlPlugin.getUser(id);
    const target = { id, type: owner ? owner.type : 'admin' };
    const decision = action === 'delete' ? canDeletePunch(actor, target) : canRestorePunch(actor);
    if (!decision.ok) {
      log.logFormat(`${account} was refused to ${action} a clock-in punch of ${id} on ${date}: ${decision.reason}.`);
      res.sendStatus(decision.status);
      return;
    }

    const key = { id, date, num: parseInt(`${numRaw}`, 10) };
    const who = { id: account, name: ret['name'] || account };
    const result = action === 'delete'
      ? sqlPlugin.softDeletePunch(key, who, reason)
      : sqlPlugin.restorePunch(key, who, reason);
    if (result === 'missing') {
      res.status(404).json({ message: action === 'delete' ? '找不到這筆打卡紀錄' : '找不到已刪除的這筆打卡紀錄' });
      return;
    }
    if (result === 'ambiguous') {
      res.status(409).json({ message: '這筆打卡紀錄有重複資料，請聯絡系統管理員' });
      return;
    }
    log.logFormat(`${who.name} (${account}) ${action === 'delete' ? 'deleted' : 'restored'} clock-in punch #${key.num} of ${id} on ${date}. Reason: ${reason}`);

    // Keep an already generated month sheet (the PDF exports) in step.
    const yearKey = date.slice(0, 4);
    const monthKey = date.slice(5, 7);
    let masterRefreshed = false;
    if (sqlPlugin.clockinMasterReady(yearKey, monthKey)) {
      try {
        await writeClockinMaster(sqlPlugin, yearKey, monthKey);
        masterRefreshed = true;
      } catch (e) {
        log.logFormat(`Failed to refresh clockin master ${yearKey}-${monthKey} after punch ${action}: ${String(e)}`);
      }
    }
    res.status(200).json({ status: action === 'delete' ? 'deleted' : 'restored', masterRefreshed });
  } catch (e) {
    log.logFormat((e as string), new Date());
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  }
}

// ---- Make-up punch requests (employee page 補打卡申請, admin page 補登審核) ----

const MAKEUP_STATE_LABELS: Record<MakeupState, string> = { pending: '待審', approved: '核准', rejected: '駁回' };

function makeupView(row: MakeupRequestRow) {
  return {
    requestId: row.request_id,
    name: row.name,
    department: row.department,
    date: row.missed_date,
    kind: row.kind,
    kindLabel: MAKEUP_KIND_LABELS[row.kind],
    clockin: row.clockin,
    clockout: row.clockout,
    reason: row.reason,
    appliedAt: row.applied_at,
    state: row.state,
    stateLabel: MAKEUP_STATE_LABELS[row.state],
    reviewerName: row.reviewer_name,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
  };
}

const MISSING_KIND_LABELS: Record<'in' | 'out', string> = { in: '上班', out: '下班' };

function missingCardView(card: MissingPunchCard) {
  return {
    date: card.date,
    kind: card.kind,
    kindLabel: MISSING_KIND_LABELS[card.kind],
    // The shift time of the missing half, as the default for the time input.
    time: card.kind === 'in' ? WORK_START : WORK_END,
    // The day's other half, if recorded (the entered time must fit around it).
    clockin: card.clockin,
    clockout: card.clockout,
  };
}

// The caller's own requests and missing punches. Only ever the caller's: no
// parameter selects another person.
app.get('/api/makeup/mine', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    if (!account || !cookie) {
      res.sendStatus(400);
      return;
    }
    const ret = sqlPlugin.checkHash(account, cookie);
    const user = ret == null ? null : sqlPlugin.getUser(account);
    if (ret == null || !user || user.id === 'monitor') {
      res.sendStatus(403);
      return;
    }
    const today = taipeiToday();
    const missing = await missingPunchCards(sqlPlugin, user.id, { today });
    res.json({
      applicant: { name: user.name, department: departmentOf(user.mgroup) },
      today,
      missing: missing.map(missingCardView),
      requests: sqlPlugin.makeupRequestsOf(account).map(makeupView),
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.post('/api/makeup/apply', async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body as { [key: string]: unknown } : {};
    const account = body['account'];
    const cookie = body['cookie'];
    if (typeof account !== 'string' || typeof cookie !== 'string' || !account || !cookie) {
      res.sendStatus(400);
      return;
    }
    const ret = sqlPlugin.checkHash(account, cookie);
    const user = ret == null ? null : sqlPlugin.getUser(account);
    if (ret == null || !user || user.id === 'monitor') {
      res.sendStatus(403);
      return;
    }
    const today = taipeiToday();
    const checked = validateMakeupCard(body, today);
    if (!checked.ok) {
      res.status(400).json({ message: checked.message });
      return;
    }
    // Only a card the page shows may be filed: date and half must be a missing punch of the caller.
    const card = checked.value;
    const missing = await missingPunchCards(sqlPlugin, user.id, { today });
    const match = missing.find((m) => m.date === card.date && m.kind === card.kind);
    if (!match) {
      const filed = sqlPlugin.activeMakeupKindsOn(user.id, card.date).some((kind) => kindsOverlap(kind, card.kind));
      res.status(409).json({ message: filed ? '這一天已有待審或已核准的同類補打卡申請' : '這一天沒有需要補打卡的紀錄' });
      return;
    }
    const plausible = checkMakeupTime(card, match, { start: WORK_START, end: WORK_END });
    if (!plausible.ok) {
      res.status(400).json({ message: plausible.message });
      return;
    }
    const input = makeupFromCard(card);
    const result = sqlPlugin.createMakeupRequest({ id: user.id, name: user.name, department: departmentOf(user.mgroup) }, input);
    if (result === 'duplicate') {
      res.status(409).json({ message: '這一天已有待審或已核准的同類補打卡申請' });
      return;
    }
    log.logFormat(`${account} filed make-up request #${result} for ${input.date} (${input.kind} ${card.time}).`);
    res.status(201).json({ status: 'pending', request: makeupView(sqlPlugin.getMakeupRequest(result) as MakeupRequestRow) });
  } catch (e) {
    log.logFormat((e as string), new Date());
    if (!res.headersSent) res.sendStatus(500);
  }
});

// Admin list. `canReview` tells the page whether this admin may decide.
app.get('/api/makeup/requests', (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const stateRaw = String(req.query.state || 'pending');
    if (!account || !cookie || !['pending', 'approved', 'rejected', 'all'].includes(stateRaw)) {
      res.sendStatus(400);
      return;
    }
    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] !== 'admin') {
      res.sendStatus(403);
      return;
    }
    const actor = { id: account, type: ret['accountType'] };
    const rows = sqlPlugin.makeupRequests(stateRaw === 'all' ? undefined : stateRaw as MakeupState);
    res.json({
      requests: rows.map((row) => {
        const owner = sqlPlugin.getUser(row.id);
        const applicant = { id: row.id, type: owner ? owner.type : 'admin' };
        return { ...makeupView(row), account: row.id, canReview: row.state === 'pending' && canReviewMakeup(actor, applicant).ok };
      }),
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.get('/api/makeup/audit', (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const requestId = String(req.query.requestId || '');
    if (!account || !cookie || !/^[1-9]\d{0,9}$/.test(requestId)) {
      res.sendStatus(400);
      return;
    }
    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] !== 'admin') {
      res.sendStatus(403);
      return;
    }
    res.json({ audit: sqlPlugin.makeupAudit(parseInt(requestId, 10)) });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.post('/api/makeup/review', async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body as { [key: string]: unknown } : {};
    const account = body['account'];
    const cookie = body['cookie'];
    const idRaw = body['requestId'];
    const decision = body['decision'];
    if (typeof account !== 'string' || typeof cookie !== 'string' || !account || !cookie ||
      !((typeof idRaw === 'number' || typeof idRaw === 'string') && /^[1-9]\d{0,9}$/.test(`${idRaw}`)) ||
      (decision !== 'approve' && decision !== 'reject')) {
      res.sendStatus(400);
      return;
    }
    const note = typeof body['note'] === 'string' ? body['note'].trim() : '';
    if (decision === 'reject' && !note) {
      res.status(400).json({ message: '駁回請填寫原因' });
      return;
    }
    if (note.length > MAKEUP_REASON_MAX) {
      res.status(400).json({ message: `原因最多 ${MAKEUP_REASON_MAX} 字` });
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null) {
      res.sendStatus(403);
      return;
    }
    const requestId = parseInt(`${idRaw}`, 10);
    const actor = { id: account, type: ret['accountType'] };
    if (actor.type !== 'admin') {
      log.logFormat(`${account} was refused to review make-up request #${requestId}: not an admin.`);
      res.sendStatus(403);
      return;
    }
    const request = sqlPlugin.getMakeupRequest(requestId);
    if (!request) {
      res.status(404).json({ message: '找不到這筆補打卡申請' });
      return;
    }
    // An applicant whose account no longer exists is treated like an admin:
    // only root may decide (same rule as punch deletion).
    const owner = sqlPlugin.getUser(request.id);
    const allowed = canReviewMakeup(actor, { id: request.id, type: owner ? owner.type : 'admin' });
    if (!allowed.ok) {
      log.logFormat(`${account} was refused to review make-up request #${requestId}: ${allowed.reason}.`);
      res.sendStatus(allowed.status);
      return;
    }

    const who = { id: account, name: ret['name'] || account };
    const result = sqlPlugin.reviewMakeupRequest(requestId, decision, who, note);
    if (result.result === 'missing') {
      res.status(404).json({ message: '找不到這筆補打卡申請' });
      return;
    }
    if (result.result === 'not-pending') {
      res.status(409).json({ message: `這筆申請已${MAKEUP_STATE_LABELS[result.state]}` });
      return;
    }
    log.logFormat(`${who.name} (${account}) ${decision === 'approve' ? 'approved' : 'rejected'} make-up request #${requestId} of ${request.id} for ${request.missed_date}.`);

    // An approval adds a punch: keep an already generated month sheet in step.
    let masterRefreshed = false;
    if (decision === 'approve') {
      const yearKey = request.missed_date.slice(0, 4);
      const monthKey = request.missed_date.slice(5, 7);
      if (sqlPlugin.clockinMasterReady(yearKey, monthKey)) {
        try {
          await writeClockinMaster(sqlPlugin, yearKey, monthKey);
          masterRefreshed = true;
        } catch (e) {
          log.logFormat(`Failed to refresh clockin master ${yearKey}-${monthKey} after make-up approval: ${String(e)}`);
        }
      }
    }
    res.status(200).json({ status: result.request.state, request: makeupView(result.request), masterRefreshed });
  } catch (e) {
    log.logFormat((e as string), new Date());
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get('/api/clockin/master', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    if (!account || !cookie || !parsed) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const result = readMasterClockinPdf(sqlPlugin, parsed.yearKey, parsed.monthKey);
    if (result.kind === 'no-master') {
      res.status(409).json({ message: '請先重新載入，產生該月總表' });
      return;
    }

    res.status(200);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', clockinMasterDisposition(result.filename, parsed.yearKey, parsed.monthKey));
    res.send(result.buffer);
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.get('/api/clockin/personal', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const id = String(req.query.id || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    if (!account || !cookie || !id || !parsed) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const result = await personalClockinPdf(sqlPlugin, parsed.yearKey, parsed.monthKey, id);
    if (result.kind === 'no-master') {
      res.status(409).json({ message: '請先重新載入，產生該月總表' });
      return;
    }
    if (result.kind === 'no-rows') {
      res.status(404).json({ message: '總表沒有這位員工的紀錄' });
      return;
    }

    res.status(200);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', clockinAttachmentDisposition(result.filename, parsed.yearKey, parsed.monthKey, id));
    res.send(result.buffer);
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

// Export endpoint: generate and download Excel (admin only)
app.get('/api/calendar/export', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const year = parseInt(String(req.query.year || '0'));
    const month = parseInt(String(req.query.month || '0'));

    if (!account || !cookie || !year || !month) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    await generateCalendarExcel(year, month, sqlPlugin);
    const filePath = `/app/calendars/${year}-${month}calendar.xlsx`;
    res.download(filePath, `${year}-${month}calendar.xlsx`, onDownloadDone(res, log, 'calendar file'));
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

function compareEmployeeId(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hant', { numeric: true, sensitivity: 'base' });
}

function parseClockinYearMonth(yearRaw: unknown, monthRaw: unknown): { year: number; month: number; yearKey: string; monthKey: string } | null {
  const yearText = String(yearRaw == null ? '' : yearRaw).trim();
  const monthText = String(monthRaw == null ? '' : monthRaw).trim();
  if (!/^\d{4}$/.test(yearText) || !/^\d{1,2}$/.test(monthText)) {
    return null;
  }
  const year = parseInt(yearText, 10);
  const month = parseInt(monthText, 10);
  if (month < 1 || month > 12) {
    return null;
  }
  return {
    year,
    month,
    yearKey: yearText,
    monthKey: month.toString().padStart(2, '0'),
  };
}

function bodyText(value: unknown): string {
  if (value == null) {
    return '';
  }
  return String(value);
}

function clockinKey(id: string, date: string): string {
  return `${id}\t${date}`;
}

function indexPunches<T extends { id: string; date: string }>(records: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const record of records) {
    const key = clockinKey(record.id, record.date);
    const list = map.get(key);
    if (list) {
      list.push(record);
    } else {
      map.set(key, [record]);
    }
  }
  return map;
}

function indexEdits(edits: ClockEdit[]): Map<string, ClockEdit> {
  const map = new Map<string, ClockEdit>();
  for (const edit of edits) {
    map.set(clockinKey(edit.id, edit.date), edit);
  }
  return map;
}

function summarizeClockinDay(
  punches: Array<{ id: string; name: string; date: string; num: number; clockin: string | null; clockout: string | null; makeup_request_id?: number | null }>,
  edit: ClockEdit | null,
  fallbackName: string
): {
  clockin: string | null;
  clockout: string | null;
  hasRecord: boolean;
  modified: boolean;
  makeup: boolean;
  reason: string;
  editorName: string | null;
  editedAt: string | null;
} {
  const row = aggregateDay(punches, edit, fallbackName);
  return {
    clockin: row ? row.clockin : null,
    clockout: row ? row.clockout : null,
    hasRecord: punches.length > 0 || edit !== null,
    modified: row ? row.modified : false,
    // The day's times include a punch from an approved make-up request (an
    // admin correction, when there is one, takes precedence over punches).
    makeup: edit === null && punches.some((p) => p.makeup_request_id != null),
    reason: row ? row.reason : '',
    editorName: row ? row.editorName : null,
    editedAt: row ? row.editedAt : null,
  };
}

function clockinMasterDisposition(filename: string, yearKey: string, monthKey: string): string {
  const ascii = `${yearKey}-${monthKey}_clockin.pdf`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function clockinAttachmentDisposition(filename: string, yearKey: string, monthKey: string, id: string): string {
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, '_') || 'employee';
  const ascii = `${yearKey}-${monthKey}_${safeId}_clockin.pdf`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
