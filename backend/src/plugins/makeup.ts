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

/** What the employee sends from a 補打卡申請 card: the card's date and half, and the reason. */
export type MakeupCardInput = { date: string; kind: 'in' | 'out'; reason: string };

/**
 * Check a submitted card. The employee only types the reason; date and half
 * come from the card and must still be checked against the caller's missing
 * punches by the caller. Times are never taken from the request (see
 * makeupFromCard). `today` is the Taipei date (YYYY-MM-DD).
 */
export function validateMakeupCard(body: { [key: string]: unknown }, today: string): { ok: true, value: MakeupCardInput } | { ok: false, message: string } {
  const date = body['date'];
  const kind = body['kind'];
  if (typeof date !== 'string' || !isRealDate(date) || date >= today) return { ok: false, message: '未打卡日期不正確' };
  if (kind !== 'in' && kind !== 'out') return { ok: false, message: '未打卡類別不正確' };
  const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
  if (!reason) return { ok: false, message: '請填寫未打卡原因' };
  if (reason.length > MAKEUP_REASON_MAX) return { ok: false, message: `未打卡原因最多 ${MAKEUP_REASON_MAX} 字` };
  return { ok: true, value: { date, kind, reason } };
}

/** The request to store for a card: the punch time is the shift slot of that half. */
export function makeupFromCard(card: MakeupCardInput, slot: { start: string, end: string }): MakeupInput {
  return {
    date: card.date,
    kind: card.kind,
    clockin: card.kind === 'in' ? slot.start : null,
    clockout: card.kind === 'out' ? slot.end : null,
    reason: card.reason,
  };
}
