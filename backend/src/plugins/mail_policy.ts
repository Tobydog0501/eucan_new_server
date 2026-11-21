/**
 * Who may receive mail, and how the subject is marked, on a non-production site.
 *
 *   SITE_ENV                 unset, "production" or "prod": production, nothing changes.
 *                            Any other value (e.g. "test") is a test site. Unknown
 *                            values count as test so a typo cannot open up sending.
 *   MAIL_ALLOWED_RECIPIENTS  comma/semicolon separated addresses. On a test site only
 *                            these receive mail; an empty list means nobody does.
 *                            An entry "name+*@domain" also admits plus-addresses
 *                            ("name+anything@domain"); a plain "name@domain" entry
 *                            admits only that exact address.
 *                            If set on production it is enforced there too.
 *   MAIL_SUBJECT_PREFIX      prepended to every subject. Defaults to "[TEST] " on a
 *                            test site; no prefix on production unless set.
 */

const PRODUCTION_VALUES = new Set(["", "production", "prod"]);
const DEFAULT_TEST_PREFIX = "[TEST] ";

export function isTestSite(env: NodeJS.ProcessEnv = process.env): boolean {
  return !PRODUCTION_VALUES.has((env.SITE_ENV || "").trim().toLowerCase());
}

/** Bare, lower-cased addresses from a header-style list ("Name <a@b>, c@d; ..."). */
export function parseAddresses(list: string): string[] {
  return list
    .split(/[,;]/)
    .map((part) => {
      const angle = part.match(/<([^<>]*)>/);
      return (angle ? angle[1] : part).trim().toLowerCase();
    })
    .filter((addr) => addr.length > 0);
}

function allowList(env: NodeJS.ProcessEnv): string[] | null {
  const raw = (env.MAIL_ALLOWED_RECIPIENTS || "").trim();
  if (raw) return parseAddresses(raw);
  return isTestSite(env) ? [] : null; // null: no restriction (production, list unset)
}

/** Exact match, or a "local+*@domain" entry matching "local+tag@domain" (non-empty tag). */
function isPermitted(addr: string, list: string[]): boolean {
  return list.some((entry) => {
    const plus = entry.match(/^([^@+\s]+)\+\*@([^@\s]+)$/);
    if (!plus) return entry === addr;
    const [, local, domain] = plus;
    const prefix = `${local}+`;
    const suffix = `@${domain}`;
    if (!addr.startsWith(prefix) || !addr.endsWith(suffix)) return false;
    const tag = addr.slice(prefix.length, addr.length - suffix.length);
    return /^[^@\s]+$/.test(tag);
  });
}

export type RecipientDecision = {
  /** Addresses to send to; empty means do not send. */
  allowed: string[];
  /** How many requested recipients were removed. */
  dropped: number;
  /** Whether a restriction was applied at all. */
  restricted: boolean;
};

export function filterRecipients(to: string, env: NodeJS.ProcessEnv = process.env): RecipientDecision {
  const requested = parseAddresses(to || "");
  const list = allowList(env);
  if (list === null) return { allowed: requested, dropped: 0, restricted: false };
  const allowed = requested.filter((addr) => isPermitted(addr, list));
  return { allowed, dropped: requested.length - allowed.length, restricted: true };
}

export function subjectPrefix(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAIL_SUBJECT_PREFIX !== undefined) return env.MAIL_SUBJECT_PREFIX;
  return isTestSite(env) ? DEFAULT_TEST_PREFIX : "";
}

export function prefixedSubject(title: string, env: NodeJS.ProcessEnv = process.env): string {
  const prefix = subjectPrefix(env);
  return prefix && !title.startsWith(prefix) ? `${prefix}${title}` : title;
}
