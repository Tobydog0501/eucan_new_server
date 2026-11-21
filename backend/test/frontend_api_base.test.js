'use strict';

// The frontend pages take their API base from js/cookieOperation.js instead of a hardcoded host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const PROD_HOST = ['eucan', 'ddns', 'net'].join('.');

function pageFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return pageFiles(p);
    return /\.(js|html)$/.test(e.name) ? [p] : [];
  });
}

// Run the API-base lines of cookieOperation.js as a browser would, from a page at `href`.
function apiBaseFor(href, source) {
  const head = source.split(/\r?\n/).filter((l) => /^var EUCAN_API_BASE/.test(l)).join('\n');
  const url = new URL(href);
  const ctx = { window: { location: { protocol: url.protocol, hostname: url.hostname } } };
  vm.runInNewContext(`${head}\nresult = EUCAN_API_BASE;`, ctx);
  return ctx.result;
}

test('frontend: no page or script hardcodes the production host', () => {
  const hits = pageFiles(FRONTEND).filter((f) => fs.readFileSync(f, 'utf8').includes(PROD_HOST));
  assert.deepEqual(hits.map((f) => path.relative(FRONTEND, f)), []);
});

test('frontend: the API base follows the page host, so production keeps its address and a test site its own', () => {
  const src = fs.readFileSync(path.join(FRONTEND, 'js', 'cookieOperation.js'), 'utf8');
  assert.equal(apiBaseFor(`https://${PROD_HOST}/index.html`, src), `https://${PROD_HOST}:3000`);
  assert.equal(apiBaseFor(`https://${PROD_HOST}:8000/admin/log.html`, src), `https://${PROD_HOST}:3000`);
  assert.equal(apiBaseFor('http://test-host:8000/index.html', src), 'http://test-host:3000');

  // What the API_BASE build arg does in frontend/Dockerfile.
  const pinned = src.replace("var EUCAN_API_BASE_CONFIGURED = ''; // @API_BASE@",
    "var EUCAN_API_BASE_CONFIGURED = 'http://api.test:3001'; // @API_BASE@");
  assert.notEqual(pinned, src, 'the @API_BASE@ line the Dockerfile rewrites must exist');
  assert.equal(apiBaseFor('http://test-host:8000/', pinned), 'http://api.test:3001');
});

test('frontend: every page that loads a page script loads cookieOperation.js before it', () => {
  for (const f of pageFiles(FRONTEND).filter((p) => p.endsWith('.html'))) {
    const scripts = [...fs.readFileSync(f, 'utf8').matchAll(/<script[^>]*src="([^"]*js\/[^"]+)"/g)].map((m) => path.basename(m[1]));
    const own = scripts.filter((s) => !/^(jquery|cookieOperation|adminNavbar|employeeNavbar)/.test(s));
    if (own.length === 0) continue;
    const cookie = scripts.indexOf('cookieOperation.js');
    assert.ok(cookie >= 0 && own.every((s) => scripts.indexOf(s) > cookie), `${path.relative(FRONTEND, f)}: ${scripts.join(', ')}`);
  }
});
