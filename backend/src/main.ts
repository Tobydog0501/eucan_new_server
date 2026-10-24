import express, { Express, Request, Response } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { sql } from './plugins/sql';
import logger from './plugins/logger';
import { mailer } from './plugins/mailer';
import { sqli_detect } from './plugins/anti_SQLI';
import { check_working_day, main as generateCalendarExcel } from './plugins/dayoff_calendar';
import path from 'path';

const log = new logger(`./logs/${new Date().toISOString().split('T')[0]}.log`);
const sqlPlugin: sql = new sql();
const mailers = new mailer();
const app: Express = express();
const PORT: number = 3000;

app.use(bodyParser.urlencoded({
  extended: true
}));

app.use(bodyParser.json());

app.use(cors({
  "origin": "https://eucan.ddns.net",
  "methods": "GET,POST,OPTIONS",
  "credentials": true,             // MUST be true if sending cookies/sessions
  "optionsSuccessStatus": 204
}));

app.all('/', (req: Request, res: Response) => {
  res.send("System online.");
});

const posts: Array<string> = ['login', 'users', 'session', "register", 'dayoff', 'request', 'query', 'permit', 'init', 'approved', 'empquery', 'delete', "modify", "quota", "clockin", "sync", "calendar", "clrecord", "tmodify", "modemp"];
posts.forEach(v => {
  const utils = require(`./system/${v}.js`).bind(null, sqlPlugin, log, mailers);
  app.post(`/${v}`, (req: Request, res: Response) => {
    if (sqli_detect(req.body)) {
      res.sendStatus(400);
      return;
    }
    try {
      utils(req, res);
    } catch (e) {
      log.logFormat((e as string), new Date());
      res.sendStatus(500);
    }
  });
})

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  log.logFormat("Server online.");
  const mailerStatus = mailers.verify();
  if (!mailerStatus) {
    console.error("Mailer Verify Failed!");
  }
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
    res.download(filePath, `${year}-${month}calendar.xlsx`, (err) => {
      if (err) {
        log.logFormat(`Failed to send calendar file: ${String(err)}`);
        res.sendStatus(500);
      }
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});
