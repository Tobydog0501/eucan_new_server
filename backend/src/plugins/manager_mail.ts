/**
 * Leave-approval mail recipient for a manager group (mgroup is the index).
 * LEAVE_MANAGER_MAILS overrides the list as comma-separated addresses, mgroup 0
 * first; when it is unset or blank the built-in list is used unchanged.
 */
const DEFAULT_MANAGER_MAILS = ["jeff@eucan.com.tw", "catherine@eucan.com.tw"];
export function managerMail(mgroup: number | string): string | undefined {
  const raw = (process.env.LEAVE_MANAGER_MAILS || "").trim();
  const list = raw ? raw.split(",").map((s) => s.trim()) : DEFAULT_MANAGER_MAILS;
  const mail = /^\d+$/.test(String(mgroup)) ? list[Number(mgroup)] : undefined;
  return mail ? mail : undefined;
}
