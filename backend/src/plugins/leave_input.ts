/**
 * Input checks shared by the leave-request endpoints (/request, /batchrequest).
 * They never throw: malformed or wrongly typed input simply fails validation.
 */

/**
 * A leave boundary looks like "YYYY-MM-DD HH:MM" and must fall on the hour or
 * half hour between 08:30 and 17:30 (same rule the endpoints always applied).
 */
export function validTime(time: unknown): boolean {
  if (typeof time !== "string") return false;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{2}):(\d{2})(?::\d{2})?$/.exec(time);
  if (!match) return false;
  const hourText = match[4];
  const minuteText = match[5];
  const hour = parseInt(hourText, 10);
  if (hour < 8 || hour > 17) return false;
  if (hourText == "08" && minuteText == "00") return false;
  return minuteText == "00" || minuteText == "30";
}

/** A reason must be a string with at least one non-space character. */
export function validReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.replace(/\ /g, "").length > 0;
}
