/**
 * Who may create, edit or delete which account, and who may delete or restore
 * clock-in punches. Shared by /register, /modemp, /delete and the punch
 * endpoints so they cannot drift apart.
 */

/** Account types that may be stored through the API. */
export const ACCOUNT_TYPES: readonly string[] = Object.freeze(["employee", "admin"]);
/** Built-in accounts. Only root may touch them, and they cannot be registered. */
export const RESERVED_IDS: readonly string[] = Object.freeze(["root", "monitor"]);
export const ROOT_ID = "root";

export function isAccountType(type: unknown): type is string {
  return typeof type === "string" && ACCOUNT_TYPES.includes(type);
}

export function isReservedId(id: string): boolean {
  return RESERVED_IDS.includes(id.toLowerCase());
}

export type Decision = { ok: true } | { ok: false, status: 400 | 403, reason: string };

/** May `actorId` (already known to be an admin) create an account of `type`? */
export function canCreate(actorId: string, newId: string, type: string): Decision {
  if (!isAccountType(type)) return { ok: false, status: 400, reason: "unknown account type" };
  if (isReservedId(newId)) return { ok: false, status: 403, reason: "reserved id" };
  if (type === "admin" && actorId !== ROOT_ID) return { ok: false, status: 403, reason: "only root may create admins" };
  return { ok: true };
}

/**
 * May `actorId` (already known to be an admin) save `changes` onto the account
 * `target` (its current row)?
 *  - only root may edit built-in accounts, admin accounts, or grant admin;
 *  - root's own account must stay an active admin, so it cannot be locked out.
 */
export function canEdit(actorId: string, target: { id: string, type: string }, changes: { type: string, status: string }): Decision {
  if (!isAccountType(changes.type)) return { ok: false, status: 400, reason: "unknown account type" };
  const isRoot = actorId === ROOT_ID;
  if (!isRoot) {
    if (isReservedId(target.id)) return { ok: false, status: 403, reason: "only root may edit built-in accounts" };
    if (target.type === "admin") return { ok: false, status: 403, reason: "only root may edit admin accounts" };
    if (changes.type === "admin") return { ok: false, status: 403, reason: "only root may grant admin" };
  }
  if (target.id === ROOT_ID && (changes.type !== "admin" || changes.status !== "1")) {
    return { ok: false, status: 400, reason: "root must remain an active admin" };
  }
  return { ok: true };
}

/**
 * May `actorId` (already known to be an admin) delete the account `target`?
 *  - built-in accounts (root, monitor) are never deleted through the API;
 *  - only root may delete admin accounts.
 */
export function canDelete(actorId: string, target: { id: string, type: string }): Decision {
  if (isReservedId(target.id)) return { ok: false, status: 403, reason: "built-in accounts cannot be deleted" };
  if (target.type === "admin" && actorId !== ROOT_ID) return { ok: false, status: 403, reason: "only root may delete admin accounts" };
  return { ok: true };
}

/**
 * May `actor` (the caller's own account) soft-delete a clock-in punch that
 * belongs to `target`? Same shape as canDelete:
 *  - only admins (supervisors) may delete punches; employees never can;
 *  - punches of built-in or admin accounts may only be deleted by root.
 */
export function canDeletePunch(actor: { id: string, type: string }, target: { id: string, type: string }): Decision {
  if (actor.type !== "admin") return { ok: false, status: 403, reason: "only admins may delete clock-in punches" };
  if (actor.id === ROOT_ID) return { ok: true };
  if (isReservedId(target.id)) return { ok: false, status: 403, reason: "only root may delete punches of built-in accounts" };
  if (target.type === "admin") return { ok: false, status: 403, reason: "only root may delete punches of admin accounts" };
  return { ok: true };
}

/**
 * May `actor` approve or reject a make-up punch request filed by `applicant`?
 * Same rule as deleting a punch (an approval creates one), plus nobody reviews
 * their own request:
 *  - only admins (supervisors) review; employees never can;
 *  - requests of built-in or admin accounts may only be reviewed by root.
 */
export function canReviewMakeup(actor: { id: string, type: string }, applicant: { id: string, type: string }): Decision {
  if (actor.type !== "admin") return { ok: false, status: 403, reason: "only admins may review make-up requests" };
  if (actor.id === applicant.id) return { ok: false, status: 403, reason: "nobody may review their own make-up request" };
  return canDeletePunch(actor, applicant);
}

/** Only root may see soft-deleted punches and restore them. */
export function canRestorePunch(actor: { id: string, type: string }): Decision {
  if (actor.id !== ROOT_ID || actor.type !== "admin") return { ok: false, status: 403, reason: "only root may restore deleted punches" };
  return { ok: true };
}
