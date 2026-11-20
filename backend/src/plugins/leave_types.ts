/**
 * The single list of leave types and the dayoffinfo columns they map to.
 * Anything used to build SQL identifiers must come from here.
 */

export const LEAVE_TYPE_COLUMNS: { readonly [type: string]: string } = Object.freeze({
  "特休假": "annual",
  "特休假_N": "annual_special", // next year's annual leave; booked into `annual` of year+1
  "事假": "personal",
  "家庭照顧假": "care",
  "病假": "sick",
  "婚假": "wedding",
  "喪假": "funeral",
  "分娩假": "birth",
  "產檢假": "pcheckup",
  "流產假": "miscarriage",
  "陪產假": "paternity",
  "產假": "maternity",
  "公假": "official",
  "停班停課": "typhoon",
  "其他": "other",
});

/** Writable usage columns of dayoffinfo. */
export const DAYOFF_COLUMNS: readonly string[] = Object.freeze([
  "annual", "personal", "care", "sick", "wedding", "funeral", "birth",
  "pcheckup", "miscarriage", "paternity", "maternity", "official", "typhoon", "other",
]);

/** Legacy display names accepted by /modify in addition to LEAVE_TYPE_COLUMNS. */
const LEGACY_ALIASES: { readonly [name: string]: string } = Object.freeze({
  "颱風假": "typhoon",
});

export function isLeaveType(type: unknown): type is string {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(LEAVE_TYPE_COLUMNS, type);
}

/** The column a leave type maps to, or null when the type is not on the list. */
export function leaveColumn(type: unknown): string | null {
  return isLeaveType(type) ? LEAVE_TYPE_COLUMNS[type] : null;
}

/**
 * Resolve a /modify key (a column name or a leave-type name) to a writable
 * dayoffinfo column, or null when it is not allowed.
 */
export function dayoffColumnFor(key: string): string | null {
  if (DAYOFF_COLUMNS.includes(key)) return key;
  const fromType = leaveColumn(key);
  if (fromType && DAYOFF_COLUMNS.includes(fromType)) return fromType;
  if (Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, key)) return LEGACY_ALIASES[key];
  return null;
}
