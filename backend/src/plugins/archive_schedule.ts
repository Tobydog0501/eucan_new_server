import { main as generateCalendarExcel } from './dayoff_calendar';
import { output_excel } from './clockin_excel';
import { sql } from './sql';
import logger from './logger';

const TAIPEI = 'Asia/Taipei';

type TaipeiParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

let lastRunDate: string | null = null;

function taipeiParts(now: Date): TaipeiParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TAIPEI,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(now);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return parseInt(part ? part.value : '0', 10);
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function taipeiDateKey(now: Date): string {
  const { year, month, day } = taipeiParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function msUntilNextTaipeiMidnight(now: Date): number {
  const p = taipeiParts(now);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = asUtc - now.getTime();
  const nextMidnightAsUtc = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0);
  const delay = nextMidnightAsUtc - offset - now.getTime();
  // Land slightly after midnight so the Taipei date has rolled over.
  return Math.max(delay + 1000, 1000);
}

async function writeTodayArchives(sqlPlugin: sql, log: logger): Promise<void> {
  const { year, month } = taipeiParts(new Date());

  try {
    await generateCalendarExcel(parseInt(`${year}`), parseInt(`${month}`), sqlPlugin);
    log.logFormat(`Daily archive generated /app/calendars/${year}-${month}calendar.xlsx`);
  } catch (e) {
    log.logFormat(`Failed to generate daily calendar /app/calendars/${year}-${month}calendar.xlsx: ${String(e)}`);
  }

  const paddedMonth = month.toString().padStart(2, '0');
  try {
    const data = await sqlPlugin.clockinRecord(year, paddedMonth);
    await output_excel(data, year, paddedMonth);
    log.logFormat(`Daily archive generated /app/clock/${year}-${paddedMonth}clockin_record.xlsx`);
  } catch (e) {
    log.logFormat(`Failed to generate daily clockin record /app/clock/${year}-${paddedMonth}clockin_record.xlsx: ${String(e)}`);
  }
}

function runIfDue(sqlPlugin: sql, log: logger): void {
  const today = taipeiDateKey(new Date());
  if (lastRunDate === today) {
    return;
  }
  lastRunDate = today;
  writeTodayArchives(sqlPlugin, log).catch((e) => {
    log.logFormat(`Failed to run daily archive: ${String(e)}`);
  });
}

export function startArchiveSchedule(sqlPlugin: sql, log: logger): void {
  const scheduleNext = (): void => {
    const delay = msUntilNextTaipeiMidnight(new Date());
    setTimeout(() => {
      try {
        runIfDue(sqlPlugin, log);
      } catch (e) {
        log.logFormat(`Failed to run daily archive: ${String(e)}`);
      }
      scheduleNext();
    }, delay);
  };

  try {
    runIfDue(sqlPlugin, log);
  } catch (e) {
    log.logFormat(`Failed to run daily archive: ${String(e)}`);
  }
  scheduleNext();
}
