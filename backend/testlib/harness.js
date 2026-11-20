// Shared harness for the HTTP regression tests.
//
// Each test boots the compiled backend (`main.js`) as a child process inside a
// throw-away working directory with a freshly seeded SQLite database, so tests
// never touch real data, real .env files or real SMTP credentials.
//
//   EUCAN_BUILD  directory holding the compiled main.js (default: ../.test-build)
//   EUCAN_PORT   fixed port to use (default: a random free port, passed as PORT)
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const Database = require('better-sqlite3');

const BUILD_DIR = path.resolve(process.env.EUCAN_BUILD || path.join(__dirname, '..', '.test-build'));

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
];

function session(id) {
  const user = USERS.find((u) => u.id === id);
  return { account: user.id, cookie: user.sKey };
}

function seed(dbFile) {
  const db = new Database(dbFile);
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
  db.close();
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

async function startServer() {
  const mainJs = path.join(BUILD_DIR, 'main.js');
  if (!fs.existsSync(mainJs)) {
    throw new Error(`Compiled backend not found at ${mainJs}. Run "npm run build:test" first.`);
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eucan-test-'));
  for (const dir of ['databases', 'logs', 'api', 'calendars', 'clock', 'proofs']) {
    fs.mkdirSync(path.join(cwd, dir));
  }
  const dbFile = path.join(cwd, 'databases', 'loginDatabase.db');
  seed(dbFile);
  // The backend checks ./api relative to its cwd but require()s the file
  // relative to the compiled plugins directory, so both need a copy.
  writeCalendars([path.join(cwd, 'api'), path.join(BUILD_DIR, 'api')]);

  const port = Number(process.env.EUCAN_PORT) || await freePort();
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TZ: 'Asia/Taipei',
    PORT: String(port),
    // Point SMTP at a closed local port so every send fails fast and offline.
    SMTP_SERVER: '127.0.0.1',
  };
  const proc = spawn(process.execPath, [mainJs], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Never leave an orphaned backend behind when startup stalls.
      proc.kill();
      reject(new Error(`server did not start within 30s:\n${output}`));
    }, 30000);
    const check = () => {
      if (output.includes('Server running')) { clearTimeout(timer); resolve(); }
    };
    proc.stdout.on('data', check);
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}):\n${output}`)); });
    check();
  });

  const base = `http://127.0.0.1:${port}`;

  async function post(route, body) {
    const res = await fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  }

  // True when the process is still running and answering requests after any
  // pending async work from the previous request has had time to settle.
  async function alive() {
    await new Promise((r) => setTimeout(r, 500));
    if (proc.exitCode !== null) return false;
    try {
      const res = await fetch(base + '/');
      return res.status === 200;
    } catch {
      return false;
    }
  }

  function db() {
    return new Database(dbFile, { readonly: true });
  }

  async function stop() {
    if (proc.exitCode === null) {
      proc.kill();
      await new Promise((r) => proc.once('exit', r));
    }
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  return { base, post, alive, db, stop, output: () => output };
}

// Create a seeded working directory without starting the server, for tests that
// load compiled modules directly (they resolve ./databases relative to cwd).
function makeWorkdir() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eucan-unit-'));
  for (const dir of ['databases', 'logs', 'api', 'calendars', 'clock', 'proofs']) {
    fs.mkdirSync(path.join(cwd, dir));
  }
  seed(path.join(cwd, 'databases', 'loginDatabase.db'));
  writeCalendars([path.join(cwd, 'api'), path.join(BUILD_DIR, 'api')]);
  return cwd;
}

module.exports = { startServer, makeWorkdir, session, USERS, BUILD_DIR };
