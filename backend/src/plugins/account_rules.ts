/**
 * Who may create or edit which account. Shared by /register and /modemp so the
 * two endpoints cannot drift apart.
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
