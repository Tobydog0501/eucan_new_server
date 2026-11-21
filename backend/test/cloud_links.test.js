'use strict';

// frontend/cloud_links.sh: the "cloud history" links on the admin pages are
// set at image build time. Production keeps its folders unless told otherwise;
// a test build hides them or points them at a test folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const SCRIPT = path.join(FRONTEND, 'cloud_links.sh');
const PROD = {
  calendar: 'https://drive.google.com/drive/folders/1YkJ9qs0lIDk5BfGMr_xV5bA7YmFn7S_p?usp=sharing',
  record: 'https://drive.google.com/drive/folders/1_4mNF0GZOGRhZ30ZHcm6zcVxT3oJ1R6E?usp=sharing',
};
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

function webRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eucan-cloud-'));
  fs.mkdirSync(path.join(dir, 'admin'));
  for (const key of Object.keys(PROD)) {
    fs.copyFileSync(path.join(FRONTEND, 'admin', `${key}.html`), path.join(dir, 'admin', `${key}.html`));
  }
  return dir;
}

function run(mode, env = {}) {
  const dir = webRoot();
  const r = spawnSync('sh', [SCRIPT, dir, mode], {
    env: { PATH: process.env.PATH, CLOUD_HISTORY_URL_CALENDAR: '', CLOUD_HISTORY_URL_RECORD: '', ...env },
    encoding: 'utf8',
  });
  const page = (key) => fs.readFileSync(path.join(dir, 'admin', `${key}.html`), 'utf8');
  return { status: r.status, stderr: r.stderr, page, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('pages: each cloud-history link carries its marker and the production folder', () => {
  for (const [key, url] of Object.entries(PROD)) {
    const html = fs.readFileSync(path.join(FRONTEND, 'admin', `${key}.html`), 'utf8');
    assert.ok(html.includes(`href="${url}" data-cloud-link="${key}"`), key);
  }
});

test('cloud_links.sh keep (production) with no URLs: pages are byte-for-byte unchanged', { skip: !hasSh && 'no sh' }, () => {
  const r = run('keep');
  try {
    assert.equal(r.status, 0, r.stderr);
    for (const key of Object.keys(PROD)) {
      assert.equal(r.page(key), fs.readFileSync(path.join(FRONTEND, 'admin', `${key}.html`), 'utf8'), key);
    }
  } finally { r.cleanup(); }
});

test('cloud_links.sh hide (test) with no URLs: both links hidden, no production folder left', { skip: !hasSh && 'no sh' }, () => {
  const r = run('hide');
  try {
    assert.equal(r.status, 0, r.stderr);
    for (const [key, url] of Object.entries(PROD)) {
      assert.ok(r.page(key).includes(`hidden style="display:none" data-cloud-link="${key}"`), key);
      assert.ok(!r.page(key).includes(url), key);
    }
  } finally { r.cleanup(); }
});

test('cloud_links.sh: a given URL replaces the folder (& kept literally); the other link follows its mode', { skip: !hasSh && 'no sh' }, () => {
  const url = 'https://drive.google.com/drive/folders/TESTfolder_1?usp=sharing&x=1';
  const r = run('hide', { CLOUD_HISTORY_URL_CALENDAR: url });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.page('calendar').includes(`href="${url}" data-cloud-link="calendar"`));
    assert.ok(r.page('record').includes('hidden style="display:none" data-cloud-link="record"'));
  } finally { r.cleanup(); }
});

test('cloud_links.sh: non-https or unsafe URLs fail the build', { skip: !hasSh && 'no sh' }, () => {
  for (const bad of ['http://example.invalid/x', 'https://example.invalid/"onclick="x', 'https://a|b', 'javascript:alert(1)', 'https://a b']) {
    const r = run('hide', { CLOUD_HISTORY_URL_RECORD: bad });
    try {
      assert.notEqual(r.status, 0, bad);
    } finally { r.cleanup(); }
  }
  const r = run('bogus');
  try { assert.notEqual(r.status, 0); } finally { r.cleanup(); }
});
