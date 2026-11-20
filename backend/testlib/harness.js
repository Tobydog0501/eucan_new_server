// Shared harness for the backend regression tests.
//
// Each test boots the compiled backend (`main.js`) as a child process inside a
// throw-away working directory with a freshly seeded SQLite database and a fake
// SMTP server on a random local port. Tests never touch real data, the real
// backend/.env (the child's cwd is the temp dir, which has no .env) or real mail.
//
// Nothing here sleeps for a fixed time: waits are driven by process output,
// SMTP events or an HTTP probe, each with an upper bound.
//
//   EUCAN_BUILD  directory holding the compiled main.js (default: ../.test-build)
//   EUCAN_PORT   fixed HTTP port (default: a random free port, passed as PORT)
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const Database = require('better-sqlite3');

const BUILD_DIR = path.resolve(process.env.EUCAN_BUILD || path.join(__dirname, '..', '.test-build'));
const WAIT_MS = 15000;

const SCHEMA = `
CREATE TABLE userinfo (id TEXT PRIMARY KEY,pwd TEXT NOT NULL,type TEXT DEFAULT employee,email TEXT NOT NULL,name TEXT NOT NULL,joinTime DATETIME DEFAULT (strftime('%Y-%m-%d', 'now', '+8 hours')), mgroup INT NOT NULL,permit INT DEFAULT 1,status INT DEFAULT 1);
CREATE TABLE logininfo (id TEXT NOT NULL,sKey TEXT PRIMARY KEY,createTime DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours')));
CREATE TABLE dayoffinfo (id TEXT NOT NULL,annual FLOAT DEFAULT 0,personal FLOAT DEFAULT 0,care FLOAT DEFAULT 0,sick FLOAT DEFAULT 0,wedding FLOAT DEFAULT 0,funeral FLOAT DEFAULT 0,birth FLOAT DEFAULT 0,pcheckup FLOAT DEFAULT 0,miscarriage FLOAT DEFAULT 0,paternity FLOAT DEFAULT 0,maternity FLOAT DEFAULT 0,official FLOAT DEFAULT 0,typhoon FLOAT DEFAULT 0,other FLOAT DEFAULT 0,total FLOAT DEFAULT 0,year DATETIME DEFAULT (strftime('%Y', 'now', '+8 hours')));
CREATE TABLE requestquery (serialnum TEXT PRIMARY KEY,id TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,start DATETIME NOT NULL,end DATETIME NOT NULL,mgroup INT NOT NULL,state INT DEFAULT 0,year DATETIME DEFAULT (strftime('%Y', 'now', '+8 hours')),month DATETIME DEFAULT (strftime('%m', 'now', '+8 hours')),totalTime FLOAT NOT NULL,reason TEXT NOT NULL);
CREATE TABLE clockinrecord (id TEXT NOT NULL,name TEXT NOT NULL,date DATETIME DEFAULT (strftime('%Y-%m-%d', 'now', '+8 hours')),num INT DEFAULT 1,clockin DATETIME,clockout DATETIME);
`;

// Test-only fixtures. Passwords and session keys here are fake values that
// exist solely inside the temporary database created for each test.
const USERS = [
  { id: 'root', pwd: 'fixture-root', type: 'admin', name: 'Root', mgroup: 0, permit: 0, sKey: 'aaaaaaaaa1' },
  { id: 'admin1', pwd: 'fixture-admin', type: 'admin', name: 'Admin One', mgroup: 0, permit: 0, sKey: 'aaaaaaaaa2' },
  { id: 'emp1', pwd: 'fixture-emp1', type: 'employee', name: 'Employee One', mgroup: 0, permit: 1, sKey: 'aaaaaaaaa3' },
  { id: 'emp2', pwd: 'fixture-emp2', type: 'employee', name: 'Employee Two', mgroup: 1, permit: 1, sKey: 'aaaaaaaaa4' },
  { id: 'admin2', pwd: 'fixture-admin2', type: 'admin', name: 'Admin Two', mgroup: 1, permit: 0, sKey: 'aaaaaaaaa5' },
];

function session(id) {
  const user = USERS.find((u) => u.id === id);
  return { account: user.id, cookie: user.sKey };
}

function seed(dbFile) {
  const db = new Database(dbFile);
  try {
    db.exec(SCHEMA);
    const addUser = db.prepare(`INSERT INTO userinfo (id,pwd,type,email,name,joinTime,mgroup,permit) VALUES (?,?,?,?,?,'2020-01-01',?,?)`);
    const addSession = db.prepare(`INSERT INTO logininfo (id,sKey) VALUES (?,?)`);
    for (const u of USERS) {
      addUser.run(u.id, u.pwd, u.type, `${u.id}@example.invalid`, u.name, u.mgroup, u.permit);
      addSession.run(u.id, u.sKey);
    }
    const year = new Date().getFullYear();
    const addTicket = db.prepare(`INSERT INTO requestquery (serialnum,id,name,type,start,end,mgroup,state,year,month,totalTime,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    addTicket.run(`${year}0000`, 'emp1', 'Employee One', '事假', `${year}-03-02 08:30`, `${year}-03-02 17:30`, 0, 0, `${year}`, '3', 8, 'pending ticket');
    addTicket.run(`${year}0001`, 'emp2', 'Employee Two', '病假', `${year}-03-03 08:30`, `${year}-03-03 17:30`, 1, 1, `${year}`, '3', 8, 'approved ticket');
    // Real accounts get this row from init() at registration.
    const addUsage = db.prepare(`INSERT INTO dayoffinfo (id,year) VALUES (?,?)`);
    for (const u of USERS) addUsage.run(u.id, `${year}`);
  } finally {
    db.close();
  }
}

// Offline stand-in for the government working-day calendar so the backend never
// launches its headless-browser scraper during tests. Weekends are days off.
function writeCalendars(dirs) {
  const now = new Date().getFullYear();
  for (let year = now - 1; year <= now + 1; year++) {
    const cal = {};
    for (let month = 1; month <= 12; month++) {
      cal[month] = {};
      const days = new Date(year, month, 0).getDate();
      for (let day = 1; day <= days; day++) {
        const dow = new Date(year, month - 1, day).getDay();
        cal[month][day] = { status: dow === 0 || dow === 6 ? 1 : 0, comment: '' };
      }
    }
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `office_calendar_${year - 1911}.json`), JSON.stringify(cal));
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// One-shot HTTP request on a fresh connection. Ports are reused between test
// servers, so pooled keep-alive sockets (as fetch keeps) could point at a
// backend that has already been stopped.
function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: route, agent: false,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', reject);
    });
    req.setTimeout(WAIT_MS, () => req.destroy(new Error(`${method} ${route} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * A minimal SMTP server on a random local port.
 *   mode 'accept': takes every message and records it in `messages`.
 *   mode 'reject': answers the greeting with 554 so every send fails at once.
 */
function startFakeSmtp(mode = 'accept') {
  const messages = [];
  const waiters = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    if (mode === 'reject') {
      sock.end('554 no service\r\n');
      return;
    }
    let buf = '';
    let inData = false;
    let data = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(data);
            data = '';
            sock.write('250 queued\r\n');
            for (const w of waiters.splice(0)) w();
          } else {
            data += line + '\n';
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'AUTH') sock.write('235 ok\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });

  // Resolve once at least `count` messages have arrived.
  function waitForMessages(count, timeoutMs = WAIT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`expected ${count} mail(s), got ${messages.length}`)), timeoutMs);
      const check = () => {
        if (messages.length >= count) { clearTimeout(timer); resolve(messages.slice()); }
        else waiters.push(check);
      };
      check();
    });
  }

  function close() {
    for (const s of sockets) s.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, messages, waitForMessages, close }));
  });
}

function makeDirs(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const dir of ['databases', 'logs', 'api', 'calendars', 'clock', 'proofs']) {
    fs.mkdirSync(path.join(cwd, dir));
  }
  seed(path.join(cwd, 'databases', 'loginDatabase.db'));
  // The backend checks ./api relative to its cwd but require()s the file
  // relative to the compiled plugins directory, so both need a copy.
  writeCalendars([path.join(cwd, 'api'), path.join(BUILD_DIR, 'api')]);
  return cwd;
}

/**
 * Start the backend.
 *   options.smtp  'accept' (default) or 'reject'
 *   options.env   extra environment variables for the backend
 */
async function startServer(options = {}) {
  const mainJs = path.join(BUILD_DIR, 'main.js');
  if (!fs.existsSync(mainJs)) {
    throw new Error(`Compiled backend not found at ${mainJs}. Run "npm run build:test" first.`);
  }
  const cwd = makeDirs('eucan-test-');
  const dbFile = path.join(cwd, 'databases', 'loginDatabase.db');
  const smtp = await startFakeSmtp(options.smtp || 'accept');

  const port = Number(process.env.EUCAN_PORT) || await freePort();
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TZ: 'Asia/Taipei',
    PORT: String(port),
    SMTP_SERVER: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    USER_MAIL: 'system@example.invalid',
    USER_PWD: 'fixture-smtp',
    ...(options.env || {}),
  };
  const proc = spawn(process.execPath, [mainJs], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const outputWaiters = new Set();
  const onOutput = (d) => {
    output += d;
    for (const w of outputWaiters) w();
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);
  const exited = new Promise((resolve) => proc.once('exit', (code) => {
    for (const w of outputWaiters) w();
    resolve(code);
  }));

  // Resolve when `pattern` appears in the backend's output; reject on timeout
  // or if the process exits first.
  function waitForOutput(pattern, timeoutMs = WAIT_MS) {
    return new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        const match = output.match(pattern);
        if (match) { finish(); resolve(match); return; }
        if (proc.exitCode !== null) { finish(); reject(new Error(`backend exited (${proc.exitCode}) before ${pattern}:\n${output}`)); }
      };
      const finish = () => { clearTimeout(timer); outputWaiters.delete(check); };
      timer = setTimeout(() => { finish(); reject(new Error(`timed out waiting for ${pattern}:\n${output}`)); }, timeoutMs);
      outputWaiters.add(check);
      check();
    });
  }

  async function stop() {
    if (proc.exitCode === null) {
      proc.kill();
      await exited;
    }
    await smtp.close();
    removeDir(cwd);
  }

  try {
    await waitForOutput(/Server running/, 30000);
  } catch (e) {
    await stop();
    throw e;
  }

  const base = `http://127.0.0.1:${port}`;

  async function post(route, body) {
    const res = await request(port, 'POST', route, JSON.stringify(body));
    let json = null;
    try { json = JSON.parse(res.text); } catch { /* not JSON */ }
    return { status: res.status, text: res.text, json };
  }

  // The process is still running and answers a fresh request.
  async function alive() {
    if (proc.exitCode !== null) return false;
    try {
      const res = await request(port, 'GET', '/');
      return res.status === 200 && proc.exitCode === null;
    } catch {
      return false;
    }
  }

  // Run fn with a handle on the test database (read-only unless
  // { write: true }), then close it.
  function withDb(fn, { write = false } = {}) {
    const db = new Database(dbFile, { readonly: !write });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  return { base, cwd, post, alive, withDb, waitForOutput, smtp, stop, output: () => output };
}

/**
 * Run fn inside a seeded temp working directory with the compiled modules
 * loadable via `load(relPath)`. The backend resolves ./databases and .env
 * relative to cwd, so this keeps in-process tests away from the real ones.
 * The directory is removed afterwards; fn must close what it opens.
 */
const unitDirs = [];
// Loaded modules log with fs.appendFile, which may still be in flight when a
// test returns. Node only emits 'exit' once that I/O has drained, so remove
// the directories then instead of racing the writes.
process.once('exit', () => {
  for (const dir of unitDirs) removeDir(dir);
});

async function inWorkdir(fn) {
  const cwd = makeDirs('eucan-unit-');
  unitDirs.push(cwd);
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    const load = (rel) => require(path.join(BUILD_DIR, rel));
    return await fn({ cwd, load });
  } finally {
    process.chdir(prev);
  }
}

module.exports = { startServer, startFakeSmtp, inWorkdir, session, USERS, BUILD_DIR };
