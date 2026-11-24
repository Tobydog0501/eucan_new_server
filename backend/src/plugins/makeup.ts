/**
 * Make-up punch (補打卡申請) requests: input checks shared by the endpoints. They
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
 * What the employee sends from a 補打卡申請 card: the card's date and half,
 * the actual time of that half (HH:MM, on the card's date) and the reason.
 */
export type MakeupCardInput = { date: string; kind: 'in' | 'out'; time: string; reason: string };

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Check a submitted card's own fields. Date and half come from the card and
 * must still be checked against the caller's missing punches by the caller,
 * and the time against that day's other half (checkMakeupTime). `today` is
 * the Taipei date (YYYY-MM-DD).
 */
export function validateMakeupCard(body: { [key: string]: unknown }, today: string): { ok: true, value: MakeupCardInput } | { ok: false, message: string } {
  const date = body['date'];
  const kind = body['kind'];
  if (typeof date !== 'string' || !isRealDate(date) || date >= today) return { ok: false, message: '未打卡日期不正確' };
  if (kind !== 'in' && kind !== 'out') return { ok: false, message: '未打卡類別不正確' };
  const label = kind === 'in' ? '上班' : '下班';
  const time = typeof body['time'] === 'string' ? body['time'].trim() : '';
  if (!time) return { ok: false, message: `請填寫實際${label}時間` };
  // Only a time of day: the date is always the card's, so "YYYY-MM-DD HH:MM" or seconds are refused.
  if (!TIME_PATTERN.test(time)) return { ok: false, message: `實際${label}時間須為 HH:MM` };
  const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
  if (!reason) return { ok: false, message: '請填寫未打卡原因' };
  if (reason.length > MAKEUP_REASON_MAX) return { ok: false, message: `未打卡原因最多 ${MAKEUP_REASON_MAX} 字` };
  // The reason is a textarea: line breaks and tabs are fine, other control characters are not.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(reason)) return { ok: false, message: '未打卡原因不能包含控制字元' };
  return { ok: true, value: { date, kind, time, reason } };
}

/**
 * Is the entered time plausible for its half? A clock-in must be earlier than
 * the day's recorded clock-out, a clock-out later than the recorded clock-in.
 * When the other half is missing too, the shift bounds stand in for it: a
 * clock-in must be before the shift end and a clock-out after the shift start.
 */
export function checkMakeupTime(
  card: { kind: 'in' | 'out', time: string },
  recorded: { clockin: string | null, clockout: string | null },
  slot: { start: string, end: string }
): { ok: true } | { ok: false, message: string } {
  if (card.kind === 'in') {
    if (recorded.clockout) {
      return card.time < recorded.clockout ? { ok: true } : { ok: false, message: `實際上班時間須早於當日下班時間 ${recorded.clockout}` };
    }
    return card.time < slot.end ? { ok: true } : { ok: false, message: `實際上班時間須早於 ${slot.end}` };
  }
  if (recorded.clockin) {
    return card.time > recorded.clockin ? { ok: true } : { ok: false, message: `實際下班時間須晚於當日上班時間 ${recorded.clockin}` };
  }
  return card.time > slot.start ? { ok: true } : { ok: false, message: `實際下班時間須晚於 ${slot.start}` };
}

/** The request to store for a card: the punch time is the actual time the employee entered. */
export function makeupFromCard(card: MakeupCardInput): MakeupInput {
  return {
    date: card.date,
    kind: card.kind,
    clockin: card.kind === 'in' ? card.time : null,
    clockout: card.kind === 'out' ? card.time : null,
    reason: card.reason,
  };
}
