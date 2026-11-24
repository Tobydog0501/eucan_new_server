'use strict';

// 功能管理（發布排定）、公告，以及未打卡通知改為每天 23:30 檢查當天。
// All people are harness fixtures in a throw-away database.

const test = require('node:test');
const assert = require('node:assert');
const { startServer, inWorkdir, session } = require('../testlib/harness');

const admin = session('admin1');
const employee = session('emp1');

// ---- pure helpers -----------------------------------------------------------

test('features: release state follows readiness, the switch and the launch time; FEATURE_OVERRIDES wins', async () => {
  await inWorkdir(async ({ load }) => {
    const f = load('plugins/features.js');
    assert.equal(f.taipeiMinute(new Date('2026-11-30T16:00:00Z')), '2026-12-01 00:00');
    assert.equal(f.normalizeMinute('2026-12-01T00:00'), '2026-12-01 00:00');
    assert.equal(f.normalizeMinute(' 2026-12-01 23:30 '), '2026-12-01 23:30');
    for (const bad of ['2026-02-30 10:00', '2026-12-01 24:00', '2026-12-01', 'tomorrow', 5, null]) {
      assert.equal(f.normalizeMinute(bad), null, String(bad));
    }

    const row = (enabled, start) => ({ key: 'makeup', enabled: enabled ? 1 : 0, start_at: start, updated_by: 'a', updated_by_name: 'A', updated_at: 'x' });
    const env = {};
    // No row yet: the first-start setting (on from 2026-12-01 00:00).
    assert.equal(f.featureActiveAt('makeup', undefined, '2026-11-30 23:59', env), false);
    assert.equal(f.featureActiveAt('makeup', undefined, '2026-12-01 00:00', env), true);
    assert.equal(f.featureActiveAt('makeup', row(true, null), '2000-01-01 00:00', env), true);
    assert.equal(f.featureActiveAt('makeup', row(false, null), '2099-01-01 00:00', env), false);
    assert.equal(f.featureActiveAt('makeup', row(true, '2027-01-01 08:00'), '2027-01-01 07:59', env), false);
    assert.equal(f.featureActiveAt('makeup', row(true, '2027-01-01 08:00'), '2027-01-01 08:00', env), true);
    // Overrides: on/off beat the stored row; unknown keys and junk are ignored.
    assert.equal(f.featureActiveAt('makeup', row(false, null), '2000-01-01 00:00', { FEATURE_OVERRIDES: 'makeup=on' }), true);
    assert.equal(f.featureActiveAt('makeup', row(true, null), '2000-01-01 00:00', { FEATURE_OVERRIDES: 'missed_punch_notice=on, makeup = off' }), false);
    assert.equal(f.featureOverrides({ FEATURE_OVERRIDES: 'nope=on,makeup=maybe' }).size, 0);

    // Release state as managers see it; a feature still in development is never live.
    const ready = f.featureDefinition('makeup');
    const developing = { ...ready, ready: false };
    const at = '2026-12-01 00:00';
    assert.equal(f.releaseState(ready, { enabled: false, startAt: null }, at), 'off');
    assert.equal(f.releaseState(ready, { enabled: true, startAt: '2026-12-02 00:00' }, at), 'scheduled');
    assert.equal(f.releaseState(ready, { enabled: true, startAt: at }, at), 'live');
    assert.equal(f.releaseState(ready, { enabled: true, startAt: null }, at), 'live');
    assert.equal(f.releaseState(developing, { enabled: true, startAt: null }, at), 'developing');

    // Manager actions.
    assert.deepEqual(f.applyReleaseAction(ready, 'schedule', '2026-12-03T08:00', at), { ok: true, setting: { enabled: true, startAt: '2026-12-03 08:00' } });
    assert.deepEqual(f.applyReleaseAction(ready, 'launch', null, at), { ok: true, setting: { enabled: true, startAt: null } });
    assert.deepEqual(f.applyReleaseAction(ready, 'stop', null, at), { ok: true, setting: { enabled: false, startAt: null } });
    assert.equal(f.applyReleaseAction(ready, 'schedule', at, at).status, 400); // not in the future
    assert.equal(f.applyReleaseAction(ready, 'schedule', 'soon', at).message, '上線時間不正確');
    assert.equal(f.applyReleaseAction(ready, 'explode', null, at).status, 400);
    assert.equal(f.applyReleaseAction(developing, 'schedule', '2026-12-03 08:00', at).status, 409);
    assert.equal(f.applyReleaseAction(developing, 'launch', null, at).status, 409);
    assert.equal(f.applyReleaseAction(developing, 'stop', null, at).ok, true);

    // The change log in words.
    const off = { enabled: false, startAt: null };
    const plan = (s) => ({ enabled: true, startAt: s });
    assert.equal(f.describeChange(null, plan('2026-12-01 00:00'), '2026-11-25 00:00'), '排定 2026-12-01 00:00 上線');
    assert.equal(f.describeChange(plan('2026-12-01 00:00'), plan('2026-12-03 00:00'), '2026-11-26 10:00'), '上線時間從 2026-12-01 00:00 改為 2026-12-03 00:00');
    assert.equal(f.describeChange(plan('2026-12-01 00:00'), off, '2026-11-26 10:00'), '取消排定（原定 2026-12-01 00:00 上線）');
    assert.equal(f.describeChange(plan('2026-12-01 00:00'), off, '2026-12-05 10:00'), '下架');
    assert.equal(f.describeChange(off, plan(null), '2026-12-05 10:00'), '立即上線');
    assert.equal(f.describeChange(null, off, '2026-12-05 10:00'), '設為未上線');
  });
});

test('missed-punch timing: checked at 23:30 Taipei the same day; start-up catches up yesterday; cards include today after 23:30', async () => {
  await inWorkdir(async ({ load }) => {
    const job = load('plugins/missed_punch.js');
    assert.equal(job.NOTICE_TIME, '23:30');
    // 2026-12-01 23:29 Taipei = 15:29 UTC.
    const before = new Date('2026-12-01T15:29:00Z');
    const after = new Date('2026-12-01T15:31:00Z');
    assert.equal(job.pastNoticeTime(before), false);
    assert.equal(job.pastNoticeTime(after), true);
    assert.equal(job.msUntilNextNoticeTime(before), 61 * 1000);
    assert.equal(job.msUntilNextNoticeTime(after), (24 * 60 - 1) * 60 * 1000 + 1000);
    // 00:10 Taipei on 2 Dec waits until 23:30 that day.
    assert.equal(job.msUntilNextNoticeTime(new Date('2026-12-01T16:10:00Z')), (23 * 60 + 20) * 60 * 1000 + 1000);

    assert.deepEqual(job.startupCheckDates(before), ['2026-11-30']);
    assert.deepEqual(job.startupCheckDates(after), ['2026-11-30', '2026-12-01']);
    assert.equal(job.makeupCardsBefore(before), '2026-12-01');
    assert.equal(job.makeupCardsBefore(after), '2026-12-02');
  });
});

test('missed-punch notice feature: first start schedules 2026-12-01; a stored setting or an override decides otherwise', async () => {
  await inWorkdir(async ({ load }) => {
    const { sql } = load('plugins/sql.js');
    const job = load('plugins/missed_punch.js');
    const db = new sql();
    const saved = process.env.FEATURE_OVERRIDES;
    delete process.env.FEATURE_OVERRIDES;
    try {
      // First start wrote one row per feature, recorded as 系統初始設定.
      const initial = db.featureAudit();
      assert.deepEqual(initial.map((a) => [a.key, a.enabled, a.start_at, a.actor_name]), [
        ['makeup', 1, '2026-12-01 00:00', '系統初始設定'],
        ['missed_punch_notice', 1, '2026-12-01 00:00', '系統初始設定'],
      ]);
      // Starting again adds nothing.
      new sql().close();
      assert.equal(db.featureAudit().length, 2);

      assert.equal(job.noticeFeatureOn(db, '2026-11-30'), false);
      assert.equal(job.noticeFeatureOn(db, '2026-12-01'), true);

      const lines = [];
      const log = { logFormat: (m) => lines.push(String(m)) };
      const report = await job.runMissedPunchCheck(db, log, { date: '2026-11-30', isWorkingDay: async () => true });
      assert.equal(report.skipped, 'feature-off');
      assert.deepEqual(report.notified, []);

      db.setFeatureFlag('missed_punch_notice', false, null, { id: 'admin1', name: 'Admin One' });
      assert.equal(job.noticeFeatureOn(db, '2026-12-01'), false);
      db.setFeatureFlag('missed_punch_notice', true, '2026-12-03 00:00', { id: 'admin1', name: 'Admin One' });
      assert.equal(job.noticeFeatureOn(db, '2026-12-02'), false);
      assert.equal(job.noticeFeatureOn(db, '2026-12-03'), true);
      // The day is judged at its own 23:30: a launch at 23:00 still covers that day.
      db.setFeatureFlag('missed_punch_notice', true, '2026-12-05 23:00', { id: 'admin1', name: 'Admin One' });
      assert.equal(job.noticeFeatureOn(db, '2026-12-05'), true);

      process.env.FEATURE_OVERRIDES = 'missed_punch_notice=off';
      assert.equal(job.noticeFeatureOn(db, '2026-12-05'), false);

      const audit = db.featureAudit();
      assert.equal(audit.length, 5);
      assert.equal(audit[4].start_at, '2026-12-05 23:00'); // oldest first
    } finally {
      if (saved === undefined) delete process.env.FEATURE_OVERRIDES; else process.env.FEATURE_OVERRIDES = saved;
      db.close();
    }
  });
});

test('announcements: validation of the admin form', async () => {
  await inWorkdir(async ({ load }) => {
    const { validateAnnouncement, audiencesFor } = load('plugins/announcements.js');
    const good = { title: ' 12/1 起啟用未打卡通知 ', body: '第一行\r\n第二行', audience: 'employee', publishAt: '2026-11-26T09:00', expireAt: '', pinned: true };
    const ok = validateAnnouncement(good);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value, { title: '12/1 起啟用未打卡通知', body: '第一行\n第二行', audience: 'employee', publishAt: '2026-11-26 09:00', expireAt: null, pinned: true });
    assert.equal(validateAnnouncement({ ...good, audience: undefined }).value.audience, 'all');

    const bad = (patch) => validateAnnouncement({ ...good, ...patch });
    assert.equal(bad({ title: '  ' }).message, '請填寫標題');
    assert.equal(bad({ title: 'x'.repeat(101) }).ok, false);
    assert.equal(bad({ body: '' }).message, '請填寫內容');
    assert.equal(bad({ body: 'x'.repeat(2001) }).ok, false);
    assert.equal(bad({ audience: 'root' }).message, '公告對象不正確');
    assert.equal(bad({ publishAt: 'soon' }).message, '發布時間不正確');
    assert.equal(bad({ expireAt: '2026-11-26 09:00' }).message, '下架時間必須晚於發布時間');
    assert.equal(bad({ expireAt: 'never' }).message, '下架時間不正確');

    assert.deepEqual(audiencesFor('employee'), ['all', 'employee']);
    assert.deepEqual(audiencesFor('admin'), ['all', 'admin']);
  });
});

// ---- endpoints --------------------------------------------------------------

async function withServer(fn) {
  // FEATURE_OVERRIDES cleared: these tests exercise the stored settings themselves.
  const server = await startServer({ env: { MISSED_PUNCH_CHECK: '0', FEATURE_OVERRIDES: '' } });
  try {
    await fn(server);
    assert.equal(await server.alive(), true, server.output());
  } finally {
    await server.stop();
  }
}

const release = (server, who, key, action, launchAt) =>
  server.post('/api/features/release', { ...who, key, action, launchAt });

test('feature endpoints: managers schedule, launch, cancel and take down releases; the log reads as sentences; the makeup pages follow', async () => {
  await withServer(async (server) => {
    // Employees can read what is live, but cannot manage.
    const flags = await server.get('/api/features', employee);
    assert.equal(flags.status, 200, flags.text);
    assert.deepEqual(Object.keys(flags.json.features).sort(), ['makeup', 'missed_punch_notice']);
    assert.equal((await server.get('/api/features', {})).status, 400);
    assert.equal((await server.get('/api/features', { account: 'emp1', cookie: 'wrong' })).status, 403);
    assert.equal((await server.get('/api/features/manage', employee)).status, 403);
    assert.equal((await release(server, employee, 'makeup', 'launch')).status, 403);

    // First start: both scheduled for 2026-12-01, recorded as 系統初始設定.
    const fresh = await server.get('/api/features/manage', admin);
    assert.equal(fresh.status, 200, fresh.text);
    const first = fresh.json.features.find((f) => f.key === 'makeup');
    assert.equal(first.ready, true);
    assert.equal(first.forced, null);
    assert.equal(first.updatedByName, '系統初始設定');
    assert.equal(first.launchAt, first.state === 'scheduled' || first.state === 'live' ? '2026-12-01 00:00' : null);
    // Before 12/1 the first-start rows read 「排定…上線」; run after it, 「立即上線」.
    const startText = (t) => ['排定 2026-12-01 00:00 上線', '立即上線'].includes(t);
    assert.deepEqual(fresh.json.history.map((h) => [h.name, h.actorName]), [
      ['未打卡通知信', '系統初始設定'],
      ['補打卡申請／補登審核', '系統初始設定'],
    ]);
    assert.ok(fresh.json.history.every((h) => startText(h.text)), JSON.stringify(fresh.json.history));

    // Take down: the navbar flag is false and the employee endpoints refuse.
    let res = await release(server, admin, 'makeup', 'stop');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.feature.state, 'off');
    assert.equal((await server.get('/api/features', employee)).json.features.makeup, false);
    const closed = await server.get('/api/makeup/mine', employee);
    assert.equal(closed.status, 403);
    assert.equal(closed.json.message, '補打卡功能尚未開放');
    const apply = await server.post('/api/makeup/apply', { ...employee, date: '2026-01-05', kind: 'in', time: '08:40', reason: '忘記打卡' });
    assert.equal(apply.status, 403);

    // Schedule in the future, then move it: not live yet.
    res = await release(server, admin, 'makeup', 'schedule', '2099-01-01T08:00');
    assert.equal(res.json.feature.state, 'scheduled');
    assert.equal(res.json.feature.launchAt, '2099-01-01 08:00');
    res = await release(server, admin, 'makeup', 'schedule', '2099-01-03 08:00');
    assert.equal(res.json.feature.launchAt, '2099-01-03 08:00');
    assert.equal((await server.get('/api/features', employee)).json.features.makeup, false);

    // A launch time that has passed is refused; launching now works.
    res = await release(server, admin, 'makeup', 'schedule', '2020-01-01 00:00');
    assert.equal(res.status, 400);
    assert.match(res.json.message, /立即上線/);
    res = await release(server, admin, 'makeup', 'launch');
    assert.equal(res.json.feature.state, 'live');
    assert.equal((await server.get('/api/features', employee)).json.features.makeup, true);
    assert.equal((await server.get('/api/makeup/mine', employee)).status, 200);

    // Bad input.
    assert.equal((await release(server, admin, 'nope', 'launch')).status, 400);
    assert.equal((await release(server, admin, 'makeup', 'explode')).status, 400);
    assert.equal((await release(server, admin, 'makeup', 'schedule', '2099-13-01 00:00')).json.message, '上線時間不正確');

    const manage = await server.get('/api/features/manage', admin);
    const makeup = manage.json.features.find((f) => f.key === 'makeup');
    assert.equal(makeup.updatedByName, 'Admin One');
    const ours = manage.json.history.filter((h) => h.actorName === 'Admin One').map((h) => h.text);
    assert.equal(ours.length, 4);
    assert.equal(ours[0], '立即上線'); // newest first
    assert.equal(ours[1], '上線時間從 2099-01-01 08:00 改為 2099-01-03 08:00');
    assert.equal(ours[2], '排定 2099-01-01 08:00 上線');
    assert.ok(['下架', '取消排定（原定 2026-12-01 00:00 上線）'].includes(ours[3]), ours[3]);
    assert.equal(manage.json.history[0].name, '補打卡申請／補登審核');
  });
});

test('feature endpoints: FEATURE_OVERRIDES is reported and beats the stored setting', async () => {
  const server = await startServer({ env: { MISSED_PUNCH_CHECK: '0', FEATURE_OVERRIDES: 'makeup=off' } });
  try {
    assert.equal((await release(server, admin, 'makeup', 'launch')).status, 200);
    assert.equal((await server.get('/api/features', employee)).json.features.makeup, false);
    const makeup = (await server.get('/api/features/manage', admin)).json.features.find((f) => f.key === 'makeup');
    assert.equal(makeup.forced, false);
    assert.equal(makeup.state, 'live'); // the stored setting, shown as saved
    assert.equal(makeup.live, false);
  } finally {
    await server.stop();
  }
});

test('announcement endpoints: admins publish, schedule, edit and delete; each side sees its own audience', async () => {
  await withServer(async (server) => {
    const save = (who, form) => server.post('/api/announcements/save', { ...who, ...form });
    const base = { body: '內容', publishAt: '2020-01-01 09:00', expireAt: null, pinned: false };

    assert.equal((await save(employee, { ...base, title: 'x', audience: 'all' })).status, 403);
    assert.equal((await server.get('/api/announcements/manage', employee)).status, 403);
    assert.equal((await save(admin, { ...base, title: '', audience: 'all' })).json.message, '請填寫標題');

    const created = {};
    for (const [name, form] of Object.entries({
      all: { ...base, title: '全體公告', audience: 'all' },
      pinned: { ...base, title: '置頂公告', audience: 'all', publishAt: '2019-01-01 09:00', pinned: true },
      emp: { ...base, title: '員工公告', audience: 'employee' },
      adm: { ...base, title: '主管公告', audience: 'admin' },
      later: { ...base, title: '排程公告', audience: 'all', publishAt: '2099-01-01 00:00' },
      gone: { ...base, title: '已下架公告', audience: 'all', expireAt: '2020-06-01 00:00' },
    })) {
      const res = await save(admin, form);
      assert.equal(res.status, 200, res.text);
      created[name] = res.json.announcement;
    }
    assert.equal(created.later.status, 'scheduled');
    assert.equal(created.gone.status, 'expired');
    assert.equal(created.all.status, 'published');

    const titles = async (who) => (await server.get('/api/announcements', who)).json.announcements.map((a) => a.title);
    // Pinned first, then newest publish time (same time: newest first); never
    // the scheduled or expired one, never the other side's.
    assert.deepEqual(await titles(employee), ['置頂公告', '員工公告', '全體公告']);
    assert.deepEqual(await titles(admin), ['置頂公告', '主管公告', '全體公告']);

    // Edit: moving the employee notice to admins only.
    const edited = await save(admin, { ...base, id: created.emp.id, title: '員工公告（改）', audience: 'admin' });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json.announcement.updatedByName, 'Admin One');
    assert.ok(!(await titles(employee)).includes('員工公告（改）'));
    assert.ok((await titles(admin)).includes('員工公告（改）'));
    assert.equal((await save(admin, { ...base, id: 999999, title: 'x', audience: 'all' })).status, 404);

    // Delete hides it everywhere; deleting again is a 404.
    assert.equal((await server.post('/api/announcements/delete', { ...admin, id: created.all.id })).status, 200);
    assert.ok(!(await titles(employee)).includes('全體公告'));
    assert.equal((await server.post('/api/announcements/delete', { ...admin, id: created.all.id })).status, 404);
    assert.equal((await server.post('/api/announcements/delete', { ...employee, id: created.pinned.id })).status, 403);

    const manage = await server.get('/api/announcements/manage', admin);
    assert.equal(manage.status, 200);
    assert.deepEqual(manage.json.announcements.map((a) => a.title).sort(), ['主管公告', '員工公告（改）', '已下架公告', '排程公告', '置頂公告'].sort());
  });
});
