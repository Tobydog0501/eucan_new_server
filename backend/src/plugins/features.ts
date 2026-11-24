/**
 * 功能發布管理（feature flags）。
 *
 * 流程：開發人員把功能做完、部署到正式機，並在 FEATURES 把 ready 設為
 * true；主管在「系統 → 功能發布」排定上線時間（或立即上線、取消、下架）。
 * 功能在上線時間前保持隱藏，所以部署日不必等於上線日。
 *
 *  - ready=false（開發中）的功能永遠不會上線，管理頁也不能排定。
 *  - 設定存在 feature_flag 表（enabled＋start_at），每次修改寫一筆 feature_audit。
 *    新登記的功能第一次啟動時自動寫入初始設定（initialLaunchAt），紀錄的
 *    修改人為「系統初始設定」。
 *  - 上線與否用台北時間 "YYYY-MM-DD HH:MM" 字串比對，時間一到下一次判斷
 *    就是上線，不需要另外的排程器。
 *  - FEATURE_OVERRIDES（例如 "makeup=on,missed_punch_notice=off"）可強制
 *    蓋過一切設定，給自動測試或緊急關閉用；正常不需要設定。
 */

export type FeatureKey = 'makeup' | 'missed_punch_notice';

export type FeatureDefinition = {
  key: FeatureKey;
  name: string;
  description: string;
  /** 開發完成並已部署：true 才能排定上線。 */
  ready: boolean;
  /** First-start launch time written to the database (null: not scheduled). */
  initialLaunchAt: string | null;
};

export const FEATURES: readonly FeatureDefinition[] = Object.freeze([
  {
    key: 'makeup',
    name: '補打卡申請／補登審核',
    description: '員工導覽列的「補打卡申請」與主管端「補登審核」。未上線時入口隱藏，員工無法送出申請。',
    ready: true,
    initialLaunchAt: '2026-12-01 00:00',
  },
  {
    key: 'missed_punch_notice',
    name: '未打卡通知信',
    description: '每天 23:30 檢查當天出勤，上班或下班沒打卡的員工會收到「祐肯企業上下班未打卡系統通知」。',
    ready: true,
    initialLaunchAt: '2026-12-01 00:00',
  },
]);

export function isFeatureKey(key: unknown): key is FeatureKey {
  return typeof key === 'string' && FEATURES.some((f) => f.key === key);
}

export function featureDefinition(key: FeatureKey): FeatureDefinition {
  return FEATURES.find((f) => f.key === key) as FeatureDefinition;
}

/** A row of feature_flag. */
export type FeatureFlagRow = {
  key: string;
  enabled: number;
  start_at: string | null;
  updated_by: string;
  updated_by_name: string;
  updated_at: string;
};

export type FeatureSetting = { enabled: boolean; startAt: string | null };

/** Who the first-start rows are recorded as. */
export const SYSTEM_ACTOR = { id: 'system', name: '系統初始設定' };

/** Taiwan has no daylight saving time, so Taipei is always UTC+8. */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Taipei wall-clock time as "YYYY-MM-DD HH:MM". */
export function taipeiMinute(now: Date = new Date()): string {
  return new Date(now.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** "YYYY-MM-DD HH:MM" with a real date and time, or null. */
export function normalizeMinute(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().replace('T', ' ').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** FEATURE_OVERRIDES parsed: key -> forced on/off. Unknown keys are ignored. */
export function featureOverrides(env: NodeJS.ProcessEnv = process.env): Map<FeatureKey, boolean> {
  const result = new Map<FeatureKey, boolean>();
  for (const part of (env.FEATURE_OVERRIDES || '').split(',')) {
    const [rawKey, rawValue] = part.split('=').map((s) => (s || '').trim());
    if (!isFeatureKey(rawKey)) continue;
    if (/^(1|on|true|yes)$/i.test(rawValue)) result.set(rawKey, true);
    else if (/^(0|off|false|no)$/i.test(rawValue)) result.set(rawKey, false);
  }
  return result;
}

/** The stored setting, or the first-start setting when nothing is stored yet. */
export function settingOf(key: FeatureKey, row: FeatureFlagRow | undefined): FeatureSetting {
  if (!row) {
    const initial = featureDefinition(key).initialLaunchAt;
    return { enabled: initial != null, startAt: initial };
  }
  return { enabled: row.enabled === 1, startAt: row.start_at };
}

/** Is a setting in force at `minute` ("YYYY-MM-DD HH:MM", Taipei)? */
export function settingActiveAt(setting: FeatureSetting, minute: string): boolean {
  return setting.enabled && (setting.startAt == null || setting.startAt <= minute);
}

/**
 * Whether `key` is live at `minute`. FEATURE_OVERRIDES wins over everything;
 * otherwise a feature still in development is never live.
 */
export function featureActiveAt(
  key: FeatureKey, row: FeatureFlagRow | undefined, minute: string, env: NodeJS.ProcessEnv = process.env
): boolean {
  const forced = featureOverrides(env).get(key);
  if (forced !== undefined) return forced;
  if (!featureDefinition(key).ready) return false;
  return settingActiveAt(settingOf(key, row), minute);
}

/** Anything that can read stored feature settings (the sql plugin). */
export type FeatureStore = { featureFlag(key: string): FeatureFlagRow | undefined };

export function isFeatureOn(store: FeatureStore, key: FeatureKey, now: Date | string = new Date()): boolean {
  const minute = typeof now === 'string' ? now : taipeiMinute(now);
  return featureActiveAt(key, store.featureFlag(key), minute);
}

/**
 * The release state shown to managers:
 *  developing  開發中（不可排定）
 *  off         未上線（沒有排定）
 *  scheduled   已排定上線
 *  live        已上線
 */
export type ReleaseState = 'developing' | 'off' | 'scheduled' | 'live';

export function releaseState(definition: FeatureDefinition, setting: FeatureSetting, minute: string): ReleaseState {
  if (!definition.ready) return 'developing';
  if (!setting.enabled) return 'off';
  return settingActiveAt(setting, minute) ? 'live' : 'scheduled';
}

/** A manager's action on one feature. */
export type ReleaseAction = 'schedule' | 'launch' | 'stop';

/**
 * What an action stores, or a message for the manager when it is not allowed.
 *  schedule  排定（或改）上線時間：must be in the future
 *  launch    立即上線
 *  stop      取消排定，或把已上線的功能下架
 */
export function applyReleaseAction(
  definition: FeatureDefinition, action: unknown, rawStart: unknown, minute: string
): { ok: true, setting: FeatureSetting } | { ok: false, status: 400 | 409, message: string } {
  if (action !== 'schedule' && action !== 'launch' && action !== 'stop') {
    return { ok: false, status: 400, message: '操作不正確' };
  }
  if (!definition.ready && action !== 'stop') {
    return { ok: false, status: 409, message: '這個功能還在開發中，開發完成並部署後才能排定上線' };
  }
  if (action === 'launch') return { ok: true, setting: { enabled: true, startAt: null } };
  if (action === 'stop') return { ok: true, setting: { enabled: false, startAt: null } };
  const startAt = normalizeMinute(rawStart);
  if (!startAt) return { ok: false, status: 400, message: '上線時間不正確' };
  if (startAt <= minute) return { ok: false, status: 400, message: '上線時間必須晚於現在；要馬上上線請按「立即上線」' };
  return { ok: true, setting: { enabled: true, startAt } };
}

/** One audit row as a sentence, given the setting before it (null: first row). */
export function describeChange(
  before: FeatureSetting | null, after: FeatureSetting, actedMinute: string
): string {
  const wasScheduled = before != null && before.enabled && before.startAt != null && before.startAt > actedMinute;
  const wasLive = before != null && settingActiveAt(before, actedMinute);
  if (!after.enabled) {
    if (wasLive) return '下架';
    if (wasScheduled) return `取消排定（原定 ${before!.startAt} 上線）`;
    return '設為未上線';
  }
  if (after.startAt != null && after.startAt > actedMinute) {
    if (wasScheduled && before!.startAt !== after.startAt) return `上線時間從 ${before!.startAt} 改為 ${after.startAt}`;
    return `排定 ${after.startAt} 上線`;
  }
  return '立即上線';
}
