/**
 * Leave-approval mail recipient for a manager group (mgroup is the index).
 * LEAVE_MANAGER_MAILS overrides the list as comma-separated addresses, mgroup 0
 * first; when it is unset or blank the built-in list is used unchanged, except
 * on a test site (SITE_ENV), where nobody gets the mail.
 */
import { isTestSite } from "./mail_policy";

const DEFAULT_MANAGER_MAILS = ["jeff@eucan.com.tw", "catherine@eucan.com.tw"];
export function managerMail(mgroup: number | string): string | undefined {
  const raw = (process.env.LEAVE_MANAGER_MAILS || "").trim();
  // A test site (SITE_ENV) never falls back to the real managers' addresses.
  const fallback = isTestSite() ? [] : DEFAULT_MANAGER_MAILS;
  const list = raw ? raw.split(",").map((s) => s.trim()) : fallback;
  const mail = /^\d+$/.test(String(mgroup)) ? list[Number(mgroup)] : undefined;
  return mail ? mail : undefined;
}
