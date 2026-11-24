/**
 * 公告：驗證管理員送來的欄位，並決定誰看得到哪些公告。
 * 內文是純文字，畫面一律用 textContent 顯示（不解讀 HTML）。
 */
import { normalizeMinute } from './features';
import type { AnnouncementAudience, AnnouncementInput, AnnouncementRow } from './sql';

export const ANNOUNCEMENT_TITLE_MAX = 100;
export const ANNOUNCEMENT_BODY_MAX = 2000;

export const AUDIENCE_LABELS: { [key in AnnouncementAudience]: string } = {
  all: '全體',
  employee: '員工',
  admin: '主管／管理員',
};

function isAudience(value: unknown): value is AnnouncementAudience {
  return value === 'all' || value === 'employee' || value === 'admin';
}

/** Which audiences an account type sees. */
export function audiencesFor(accountType: string): AnnouncementAudience[] {
  return accountType === 'admin' ? ['all', 'admin'] : ['all', 'employee'];
}

export function validateAnnouncement(
  body: { [key: string]: unknown }
): { ok: true, value: AnnouncementInput } | { ok: false, message: string } {
  const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
  const text = typeof body['body'] === 'string' ? body['body'].replace(/\r\n/g, '\n').trim() : '';
  if (!title) return { ok: false, message: '請填寫標題' };
  if (title.length > ANNOUNCEMENT_TITLE_MAX) return { ok: false, message: `標題最多 ${ANNOUNCEMENT_TITLE_MAX} 字` };
  if (!text) return { ok: false, message: '請填寫內容' };
  if (text.length > ANNOUNCEMENT_BODY_MAX) return { ok: false, message: `內容最多 ${ANNOUNCEMENT_BODY_MAX} 字` };
  const audience = body['audience'] ?? 'all';
  if (!isAudience(audience)) return { ok: false, message: '公告對象不正確' };
  const publishAt = normalizeMinute(body['publishAt']);
  if (!publishAt) return { ok: false, message: '發布時間不正確' };
  const rawExpire = body['expireAt'];
  let expireAt: string | null = null;
  if (rawExpire != null && rawExpire !== '') {
    expireAt = normalizeMinute(rawExpire);
    if (!expireAt) return { ok: false, message: '下架時間不正確' };
    if (expireAt <= publishAt) return { ok: false, message: '下架時間必須晚於發布時間' };
  }
  const pinned = body['pinned'] === true || body['pinned'] === 'true' || body['pinned'] === 1 || body['pinned'] === '1';
  return { ok: true, value: { title, body: text, audience, publishAt, expireAt, pinned } };
}

/** What the pages receive. `status` only matters on the management page. */
export function announcementView(row: AnnouncementRow, minute: string) {
  const status = row.publish_at > minute ? 'scheduled' : (row.expire_at != null && row.expire_at <= minute ? 'expired' : 'published');
  return {
    id: row.announcement_id,
    title: row.title,
    body: row.body,
    audience: row.audience,
    audienceLabel: AUDIENCE_LABELS[row.audience],
    publishAt: row.publish_at,
    expireAt: row.expire_at,
    pinned: row.pinned === 1,
    status,
    createdByName: row.created_by_name,
    updatedByName: row.updated_by_name,
    updatedAt: row.updated_at,
  };
}
