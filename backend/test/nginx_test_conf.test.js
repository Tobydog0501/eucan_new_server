// The test-site frontend nginx (frontend/nginx.test.conf) proxies backend
// routes by name. A route added to the backend but not to that file works in
// production and answers 404 on the test site, so keep the two in step.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mainTs = read('backend/src/main.ts');
const conf = read('frontend/nginx.test.conf');
const prodConf = read('nginx/conf.d/default.conf');

// Comments stripped, so commented-out locations do not count.
const confCode = conf.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

function rootPosts() {
  const m = mainTs.match(/const posts:\s*Array<string>\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'could not find the `posts` list in backend/src/main.ts');
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

function explicitRoutes() {
  return [...mainTs.matchAll(/\bapp\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/g)].map((x) => ({ method: x[1], path: x[2] }));
}

function proxiedRootNames() {
  const m = confCode.match(/location\s+~\s+\^\/\(([^)]*)\)\$\s*\{[^}]*proxy_pass\s+http:\/\/backend:3000;/);
  assert.ok(m, 'frontend/nginx.test.conf has no root-level POST proxy location');
  return m[1].split('|');
}

test('nginx.test.conf proxies exactly the root-level POST routes of the backend', () => {
  const posts = rootPosts();
  const proxied = proxiedRootNames();
  assert.ok(posts.length > 0);
  const missing = posts.filter((p) => !proxied.includes(p));
  const stale = proxied.filter((p) => !posts.includes(p));
  assert.deepEqual(missing, [], `add to frontend/nginx.test.conf: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `no longer backend routes, remove from frontend/nginx.test.conf: ${stale.join(', ')}`);
});

test('every explicit backend route is under /api/ (proxied by prefix) or is the liveness route', () => {
  assert.match(confCode, /location\s+\^~\s+\/api\/\s*\{[^}]*proxy_pass\s+http:\/\/backend:3000;/);
  assert.match(confCode, /location\s+=\s+\/healthz\s*\{[^}]*proxy_pass\s+http:\/\/backend:3000\/;/);
  // `/${v}` is the loop over `posts`, covered by the test above.
  const routes = explicitRoutes().filter((r) => r.path !== '/${v}');
  assert.ok(routes.length > 0);
  assert.ok(explicitRoutes().some((r) => r.path === '/${v}'), 'the `posts` loop in main.ts changed; update this test');
  const outside = routes.filter((r) => r.path !== '/' && !r.path.startsWith('/api/'));
  assert.deepEqual(outside, [], 'routes outside /api/ need their own location in frontend/nginx.test.conf');
});

test('upload limit matches production', () => {
  const limit = (text) => [...text.matchAll(/^\s*client_max_body_size\s+(\S+);/gm)].map((x) => x[1]);
  const prod = [...new Set(limit(prodConf))];
  assert.equal(prod.length, 1, `expected one client_max_body_size in nginx/conf.d/default.conf, got ${prod}`);
  assert.deepEqual(limit(confCode), prod);
});

test('docker-compose-test.yml serves the frontend with nginx.test.conf', () => {
  const compose = read('docker-compose-test.yml');
  assert.match(compose, /\.\/frontend\/nginx\.test\.conf:\/etc\/nginx\/conf\.d\/nginx\.conf:ro/);
});

test('nginx.test.conf is kept out of the image web root', () => {
  const ignore = read('frontend/.dockerignore').split(/\r?\n/).map((l) => l.trim());
  assert.ok(ignore.includes('nginx.test.conf'), 'list nginx.test.conf in frontend/.dockerignore');
});
