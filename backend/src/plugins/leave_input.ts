/**
 * Input checks shared by the leave endpoints (/request, /batchrequest, /tmodify).
 * They never throw: malformed or wrongly typed input simply fails validation.
 */

// Two-digit month/day/hour/minute, optional seconds 00-59: the shape SQLite's
// strftime() accepts, so a value that passes here is never stored as NULL.
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::([0-5]\d))?$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A single request may not span more than this many days. */
export const MAX_SPAN_DAYS = 366;

/**
 * Parse "YYYY-MM-DD HH:MM" into a Date. Returns null for a wrong shape or a
 * date/time that does not exist (e.g. 2026-02-30, 25:00).
 */
export function parseLeaveTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map((part) => parseInt(part, 10));
  if (hour > 23 || minute > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/**
 * The stored form "YYYY-MM-DD HH:MM" of a value parseLeaveTime accepts
 * (drops optional seconds), or null when it does not parse.
 */
export function normalizeLeaveTime(value: unknown): string | null {
  if (parseLeaveTime(value) === null) return null;
  return (value as string).slice(0, 16);
}

/**
 * A leave boundary for a new request: a real date, on the hour or half hour,
 * between 08:30 and 17:30 (the rule these endpoints always applied).
 */
export function validTime(time: unknown): boolean {
  if (parseLeaveTime(time) === null) return false;
  const match = TIMESTAMP.exec(time as string) as RegExpExecArray;
  const hourText = match[4];
  const minuteText = match[5];
  const hour = parseInt(hourText, 10);
  if (hour < 8 || hour > 17) return false;
  if (hourText == "08" && minuteText == "00") return false;
  return minuteText == "00" || minuteText == "30";
}

export type RangeCheck = { ok: true } | { ok: false, reason: string };

/**
 * start must not be after end, and the span is capped. With `nearYearsOnly`
 * both ends must also fall within last year .. next year, which keeps requests
 * inside the working-day calendars the server already has.
 */
export function validRange(start: unknown, end: unknown, options: { nearYearsOnly?: boolean, now?: Date } = {}): RangeCheck {
  const from = parseLeaveTime(start);
  const to = parseLeaveTime(end);
  if (from === null || to === null) return { ok: false, reason: "invalid time" };
  if (from.getTime() > to.getTime()) return { ok: false, reason: "start is after end" };
  if (to.getTime() - from.getTime() > MAX_SPAN_DAYS * DAY_MS) return { ok: false, reason: "range too long" };
  if (options.nearYearsOnly) {
    const thisYear = (options.now || new Date()).getFullYear();
    for (const year of [from.getFullYear(), to.getFullYear()]) {
      if (year < thisYear - 1 || year > thisYear + 1) return { ok: false, reason: "year out of range" };
    }
  }
  return { ok: true };
}

/** A reason must be a string with at least one non-space character. */
export function validReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.replace(/\ /g, "").length > 0;
}
