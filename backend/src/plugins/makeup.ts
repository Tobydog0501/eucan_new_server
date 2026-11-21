/**
 * Make-up punch (補登) requests: input checks shared by the endpoints. They
 * never throw; malformed or wrongly typed input simply fails validation.
 */
import { isRealDate } from './clockin_sheet';

export type MakeupKind = 'in' | 'out' | 'both';

/** Labels as the form shows them. */
export const MAKEUP_KIND_LABELS: Readonly<Record<MakeupKind, string>> = Object.freeze({
  in: '上班未打卡',
  out: '下班未打卡',
  both: '上下班皆未打卡',
});

export const MAKEUP_REASON_MAX = 200;

/**
 * Department shown on the form. The account table has no department column;
 * the closest thing is the supervisor group (mgroup), labelled the same way as
 * on the admin personnel page.
 */
const DEPARTMENTS: Readonly<Record<string, string>> = Object.freeze({ '0': 'JEFF', '1': 'CAT' });

export function departmentOf(mgroup: unknown): string {
  return DEPARTMENTS[String(mgroup)] || '';
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isMakeupKind(value: unknown): value is MakeupKind {
  return value === 'in' || value === 'out' || value === 'both';
}

export function needsClockin(kind: MakeupKind): boolean {
  return kind === 'in' || kind === 'both';
}

export function needsClockout(kind: MakeupKind): boolean {
  return kind === 'out' || kind === 'both';
}

/** Do two requests on the same day ask for the same half (in or out)? */
export function kindsOverlap(a: MakeupKind, b: MakeupKind): boolean {
  return (needsClockin(a) && needsClockin(b)) || (needsClockout(a) && needsClockout(b));
}

export type MakeupInput = {
  date: string;
  kind: MakeupKind;
  clockin: string | null;
  clockout: string | null;
  reason: string;
};

/**
 * Check a submitted form. Only the time fields the category asks for are
 * required and kept; the other one is dropped. `today` is the Taipei date
 * (YYYY-MM-DD); a request may not be for a later day.
 */
export function validateMakeup(body: { [key: string]: unknown }, today: string): { ok: true, value: MakeupInput } | { ok: false, message: string } {
  const date = body['date'];
  const kind = body['kind'];
  if (typeof date !== 'string' || !isRealDate(date)) return { ok: false, message: '請選擇正確的未打卡日期' };
  if (date > today) return { ok: false, message: '未打卡日期不能晚於今天' };
  if (!isMakeupKind(kind)) return { ok: false, message: '請選擇未打卡類別' };

  const time = (value: unknown): string | null | undefined => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !TIME.test(value)) return undefined;
    return value;
  };
  let clockin: string | null = null;
  let clockout: string | null = null;
  if (needsClockin(kind)) {
    const value = time(body['clockin']);
    if (!value) return { ok: false, message: '請填寫實際上班時間（HH:MM）' };
    clockin = value;
  }
  if (needsClockout(kind)) {
    const value = time(body['clockout']);
    if (!value) return { ok: false, message: '請填寫實際下班時間（HH:MM）' };
    clockout = value;
  }
  if (clockin && clockout && clockin >= clockout) return { ok: false, message: '實際下班時間必須晚於上班時間' };

  const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
  if (!reason) return { ok: false, message: '請填寫未打卡原因' };
  if (reason.length > MAKEUP_REASON_MAX) return { ok: false, message: `未打卡原因最多 ${MAKEUP_REASON_MAX} 字` };

  return { ok: true, value: { date, kind, clockin, clockout, reason } };
}
