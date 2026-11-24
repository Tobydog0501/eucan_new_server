import crypto from "crypto";
import Database from "better-sqlite3";
import logger from './logger'
import { getSplitTimestamp, fetch_all_nwd, getROCYearsInRange } from "./dayoff_calculate"
import { userinfo, userinfo_public, dayoffinfo, clockinrecord, requestquery, logininfo, digit, dayofftype, dayoffinfo_ret } from "../types/types";
import { hashPassword, verifyPassword } from "./password";
import { ClockEdit, ClockSheetRow, normalizeTime } from "./clockin_sheet";
import { join } from "path";
import { DAYOFF_COLUMNS, dayoffColumnFor, leaveColumn } from "./leave_types";
import { runMigrations } from "./migrations";
import { kindsOverlap, MakeupInput, MakeupKind } from "./makeup";
import type { FeatureFlagRow } from "./features";
import { FEATURES, SYSTEM_ACTOR } from "./features";
// const logger = require("./logger.js");
const log: logger = new logger(`./logs/${new Date().toISOString().split('T')[0]}.log`);

/** userinfo columns that may leave the server (everything except pwd). */
const USERINFO_PUBLIC_COLUMNS = "id,type,email,name,joinTime,mgroup,permit,status,leaveDate";

export class sql {

  private login_db: Database.Database;

  public constructor() {
    this.login_db = new Database('./databases/loginDatabase.db');
    this.login_db.pragma('journal_mode = WAL');
    this.ensureUserinfoLeaveDateColumn();
    this.ensureClockinTables();
    const { applied } = runMigrations(this.login_db);
    if (applied.length > 0) {
      log.logFormat(`Database migrations applied: ${applied.join("; ")}.`, new Date());
    }
    this.ensureFeatureFlags();
    log.logFormat("Database is connected with server.", new Date());
  }

  close(): void {
    this.login_db.close();
  }

  private ensureUserinfoLeaveDateColumn(): void {
    const columns = this.login_db.prepare(`PRAGMA table_info(userinfo);`).all() as Array<{ name: string }>;
    const hasLeaveDate = columns.some((column) => column.name === 'leaveDate');
    if (!hasLeaveDate) {
      this.login_db.prepare(`ALTER TABLE userinfo ADD COLUMN leaveDate DATETIME DEFAULT NULL;`).run();
    }
  }

  private ensureClockinTables(): void {
    this.login_db.exec(`
      CREATE TABLE IF NOT EXISTS clockin_edit (
        id TEXT NOT NULL,
        date TEXT NOT NULL,
        name TEXT NOT NULL,
        clockin TEXT,
        clockout TEXT,
        reason TEXT NOT NULL,
        editor_id TEXT NOT NULL,
        editor_name TEXT NOT NULL,
        edited_at TEXT NOT NULL,
        PRIMARY KEY (id, date)
      );
      CREATE TABLE IF NOT EXISTS clockin_master (
        year TEXT NOT NULL,
        month TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        PRIMARY KEY (year, month)
      );
      CREATE TABLE IF NOT EXISTS clockin_master_row (
        year TEXT NOT NULL,
        month TEXT NOT NULL,
        date TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        clockin TEXT,
        clockout TEXT,
        modified INTEGER NOT NULL,
        reason TEXT NOT NULL,
        edited_at TEXT,
        PRIMARY KEY (year, month, date, id)
      );
    `);
    this.ensureClockinMasterEditedAtColumn();
  }

  private ensureClockinMasterEditedAtColumn(): void {
    const columns = this.login_db.prepare(`PRAGMA table_info(clockin_master_row);`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'edited_at')) {
      this.login_db.prepare(`ALTER TABLE clockin_master_row ADD COLUMN edited_at TEXT;`).run();
    }
  }

  /**
   * Would login() accept these credentials? Read-only: no session is issued
   * or refreshed and nothing is logged. Used to gate root's second factor.
   */
  async credentialsValid(user: string, pwd: string | null, cookie: string | null): Promise<boolean> {
    if (typeof user !== "string") return false;
    const row = this.login_db.prepare(`SELECT pwd, status FROM userinfo WHERE id= ?`).get(user) as { pwd: string, status: number } | undefined;
    if (row === undefined || row.status == 0) return false;
    if (typeof cookie === "string" && cookie !== "NULL") {
      const session = this.login_db.prepare(`SELECT sKey, createTime FROM logininfo WHERE id= ?`).get(user) as { sKey: string, createTime: string } | undefined;
      if (session && session.sKey === cookie && (Date.now() - Date.parse(session.createTime)) <= 60 * 60 * 1000) {
        return true;
      }
    }
    return (await verifyPassword(pwd, row.pwd)).ok;
  }

  /**
   * Replace a stored password (a legacy plain value, or a hash with older cost
   * parameters) with a fresh hash, but only if the row still holds the value
   * that was just verified.
   */
  private async upgradePasswordHash(user: string, password: string, verifiedStored: string): Promise<void> {
    try {
      const hashed = await hashPassword(password);
      const changed = this.login_db.prepare(`UPDATE userinfo SET pwd= ? WHERE id= ? AND pwd= ?;`).run(hashed, user, verifiedStored).changes;
      if (changed > 0) log.logFormat(`${user}'s stored password was upgraded to the current hash format.`);
    } catch (e) {
      // The login itself already succeeded; the upgrade is retried next time.
      log.logFormat(`Could not upgrade the stored password of ${user}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async login(user: string, pwd: string | null, cookie: string | null): Promise<{ msg: string, accountType?: string, sessionKey?: string, name?: string }> {
    if (typeof user !== "string" || (pwd !== null && typeof pwd !== "string") || (cookie !== null && typeof cookie !== "string")) {
      return { msg: "wrong type" };
    }
    if (cookie !== null) {
      if (user.match(/['"?><:;\\|)(*&^%$#@!~`]/) || cookie.match(/['"?><:;\\|)(*&^%$#@!~`]/) || cookie.match(/['"?><:;\\|)(*&^%$#@!~`]/)) {
        return { msg: "wrong type" };
      }
    }
    const currentTime: Date = new Date();
    const sqldata: userinfo | undefined = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo | undefined);
    const loginHashData: logininfo | undefined = (this.login_db.prepare(`SELECT * FROM logininfo WHERE id= ?;`).get(user) as logininfo | undefined);


    if (sqldata == undefined) {
      log.logFormat(`Someone failed to log in with an incorrect account.`, currentTime);
      return { msg: "wrong account" };
    }

    if (sqldata["status"] == 0) {
      log.logFormat(`${user} tried to log in but the account is marked as resigned.`, currentTime);
      return { msg: "resigned account" };
    }

    // cookie here must be stripped.
    // accepted types: null, string.
    var hash: string = "";
    var expired: boolean = false;
    if (cookie && loginHashData != undefined) {   // if u got a cookie, there must be ur data in the database.
      const ret: null | object = this.checkHash(user, cookie);
      if (ret && user != "monitor") {
        log.logFormat(`${user} has logined with cookie successfully.`);
        return { msg: "success", accountType: sqldata["type"], sessionKey: cookie, name: sqldata["name"] };
      }
      else expired = true;
    }
    const check = await verifyPassword(pwd, sqldata["pwd"]);
    if (check.ok) {
      if (check.needsRehash) {
        await this.upgradePasswordHash(user, pwd as string, sqldata["pwd"]);
      }
      // Checking database if the user have logined before.
      if (loginHashData == undefined) {
        // Generating hash.
        hash = crypto.randomBytes(5).toString('hex');
        while (this.login_db.prepare(`SELECT * FROM logininfo WHERE sKey= ?;`).get(hash)) {
          hash = crypto.randomBytes(5).toString('hex');
        }
        this.login_db.prepare(`INSERT INTO logininfo (id,sKey) VALUES (?,?);`).run(user, hash);
      } else {
        // hash expired.
        hash = crypto.randomBytes(5).toString('hex');
        while (this.login_db.prepare(`SELECT * FROM logininfo WHERE sKey= ?;`).get(hash)) {
          hash = crypto.randomBytes(5).toString('hex');
        }
        this.login_db.prepare(`UPDATE logininfo SET createTime = strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'),sKey= ? WHERE id= ?;`).run(hash, user);
      }
      if (user != "monitor")
        log.logFormat(`${user} has logined with password successfully.`, currentTime);
      return { msg: "success", accountType: sqldata["type"], sessionKey: hash, name: sqldata["name"] };
    } else {
      log.logFormat(`${user} failed to log in: wrong password.`, currentTime);
      return { msg: "wrong pwd" };
    }
  }

  /**
   * 
   * @returns {Array<object>}
   */
  getAllUsers(): userinfo_public[] {
    // Never the stored password: callers may send these rows to the browser.
    const data = (this.login_db.prepare(`SELECT ${USERINFO_PUBLIC_COLUMNS} FROM userinfo;`).all() as userinfo_public[]);
    return data;
  }

  getEmployeeDayOffList(user: string, year: string): null | dayoffinfo_ret {
    try {
      const userinfo = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ?;`).get(user) as userinfo);
      const joinTime = userinfo["joinTime"];
      if (joinTime.split('-')[0] == year) {
        const rq_all = (this.login_db.prepare(`SELECT * FROM requestquery WHERE id= ? AND year= ? AND state=1;`).all(user, year) as requestquery[] | undefined);
        const joinMonth = parseInt(userinfo.joinTime.split("-")[1]);
        const joinDay = parseInt(userinfo.joinTime.split("-")[2]);
        var first_half: dayoffinfo = {
          id: user,
          annual: 0,
          personal: 0,
          care: 0,
          sick: 0,
          wedding: 0,
          funeral: 0,
          birth: 0,
          pcheckup: 0,
          miscarriage: 0,
          paternity: 0,
          maternity: 0,
          official: 0,
          typhoon: 0,
          other: 0,
          total: 0,
          year: year
        };
        var second_half: dayoffinfo = {
          id: user,
          annual: 0,
          personal: 0,
          care: 0,
          sick: 0,
          wedding: 0,
          funeral: 0,
          birth: 0,
          pcheckup: 0,
          miscarriage: 0,
          paternity: 0,
          maternity: 0,
          official: 0,
          typhoon: 0,
          other: 0,
          total: 0,
          year: year
        };
        const table = {
          "特休假": "annual",
          "特休假_N": "特N",
          "事假": "personal",
          "家庭照顧假": "care",
          "病假": "sick",
          "婚假": "wedding",
          "喪假": "funeral",
          "分娩假": "birth",
          "產檢假": "pcheckup",
          "流產假": "miscarriage",
          "陪產假": "paternity",
          "產假": "maternity",
          "公假": "official",
          "停班停課": "typhoon",
          "其他": "other"
        };
        rq_all?.forEach((v: requestquery, i, a) => {
          const reqMonth = parseInt(v.month);
          const reqYear = parseInt(v.start.split("-")[0]);
          const joinYear = parseInt(userinfo.joinTime.split("-")[0]);
          const monthDiff = (reqYear - joinYear) * 12 + (reqMonth - joinMonth);
          console.log(`Month diff: ${monthDiff}`);
          if (monthDiff < 6) {
            (first_half[table[v.type as keyof dayofftype] as keyof dayoffinfo] as number) += v.totalTime;
          } else if (monthDiff === 6) {
            // Split totalTime between first_half and second_half based on day boundary.
            (parseInt(v["start"].split("-")[2]) < joinDay) ? (first_half[table[v.type as keyof dayofftype] as keyof dayoffinfo] as number) += v.totalTime : (second_half[table[v.type as keyof dayofftype] as keyof dayoffinfo] as number) += v.totalTime;
          } else {
            (second_half[table[v.type as keyof dayofftype] as keyof dayoffinfo] as number) += v.totalTime;
          }
        })
        // const dayoffData_LF = (this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id='${user}' AND year='${year}';`).all()[0] as dayoffinfo|undefined);
        return { "separate": true, "data": [first_half, second_half] };
      } else {
        const df = (this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).all(user, year) as dayoffinfo[]);
        if (df.length == 0) {
          this.login_db.prepare(`INSERT INTO dayoffinfo (id,year) VALUES (?,?);`).run(user, year);
          return { "separate": false, "data": [(this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).get(user, year) as dayoffinfo)] };
        } else {
          return { "separate": false, "data": [df[0]] };
        }
      }

    } catch {
      return null;
    }
  }

  async register(user: string, password: string, mail: string, name: string, type: string, jointime: string, mgroup: digit, permit: digit): Promise<void> {
    // id,pwd,type,email,name,type,mgroup
    const hashed = await hashPassword(password);
    this.login_db.prepare(`INSERT INTO userinfo (id,pwd,type,email,name,joinTime,mgroup,permit) VALUES (?,?,?,?,?,(strftime('%Y-%m-%d',?)),?,?);`).run(user, hashed, type, mail, name, jointime, mgroup, permit);
    return;
  }

  /**
   * Overwrite leave usage for one user/year. Keys must resolve to a known
   * dayoffinfo column (see leave_types.ts); values are bound as parameters.
   * Returns the number of rows updated, or null when any key is not allowed.
   */
  modify(user: string, year: string, dayoff: { [key: string]: number }): number | null {
    const assignments: string[] = [];
    const values: number[] = [];
    for (const [key, value] of Object.entries(dayoff)) {
      const column = dayoffColumnFor(key);
      if (column === null) {
        return null;
      }
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    if (assignments.length === 0) {
      return null;
    }
    const result = this.login_db.prepare(`UPDATE dayoffinfo SET ${assignments.join(", ")} WHERE id= ? AND year= ?`).run(...values, user, year);
    return result.changes;
  }

  /**
   * 
   * @param {string} user 
   * @param {string} cookie 
   * @returns 
   */
  checkHash(user: string, cookie: string): { msg: string, accountType: string, sessionKey: string, name: string } | null {
    if (typeof user !== "string" || typeof cookie !== "string") {
      return null;
    }
    if (user.match(/['"?><:;\\|)(*&^%$#@!~`]/) || cookie.match(/['"?><:;\\|)(*&^%$#@!~`]/)) {
      return null;
    }
    const sqldata = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo | undefined);
    const loginHashData = (this.login_db.prepare(`SELECT * FROM logininfo WHERE id= ?;`).get(user) as logininfo | undefined);
    if (sqldata == undefined || loginHashData == undefined) {
      return null;
    }
    const current: Date = new Date();
    const lastLogin = Date.parse(loginHashData["createTime"]);
    const DateLastLogin = new Date(lastLogin);

    if (sqldata["status"] == 0) {
      log.logFormat(`${user} tried to log in but the account is marked as resigned.`, current);
      return null
    }

    if (((current.getTime() - DateLastLogin.getTime()) / 1000 / 60 / 60) <= 1) {    // Caculating the elapsed time
      // if elapsed time <= 1 hr
      if (loginHashData["sKey"] == cookie) {
        // if cookie correct.
        this.login_db.prepare(`UPDATE logininfo SET createTime = strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours') WHERE id= ?;`).run(user);
        return { msg: "success", accountType: sqldata["type"], sessionKey: cookie, name: sqldata["name"] };
      } else {
        return null;
      }
    } else {  // if elapsed time > 1 hr
      // log.logFormat(`${user} tried to login with cookie but it had expired.`,current);
      return null;
    }
  }

  init(user: string, year?: digit | undefined) {
    // {
    //     "annual":0,
    //     "personal":0,
    //     "care":0,
    //     "sick":0,
    //     "wedding":0,
    //     "funeral":0,
    //     "birth":0,
    //     "pcheckup":0,
    //     "miscarriage":0,
    //     "paternity":0,
    //     "maternity":0,
    //     "official":0,
    //     "typhoon":0,
    //     "other":0,
    //     "total":0,
    //     "year":0,
    // }
    // ["annual","personal","care","sick","wedding","funeral","birth","pcheckup","miscarriage","paternity","maternity","other","total","year"]

    try {
      if (year != undefined) {
        this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).get(user, year);
        this.login_db.prepare(`DELETE FROM dayoffinfo WHERE id= ? AND year= ?;`).run(user, year);
        this.login_db.prepare(`INSERT INTO dayoffinfo (id,year) VALUES (?,?);`).run(user, year);
      } else {
        throw new Error("cant find the user");
      }
    } catch (e) {
      this.login_db.prepare(`INSERT INTO dayoffinfo (id) VALUES (?);`).run(user);
      log.logFormat(`${user}'s dayoffinfo has been initialize.`, new Date());
    }

  }

  /**
   * Get dayoff info
   * @param {*} user 
   * @param {*} year 
   * @returns 
   */
  dayoff(user: string, year: digit): dayoffinfo | null {
    try {
      const sqldata = (this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ? `).get(user, year) as dayoffinfo | undefined);
      // console.log(sqldata);
      if (sqldata === undefined) return null;
      return sqldata;
    } catch (e) {
      console.warn(e);
      return null;
    }
  }

  /**
   * 
   * @param {*} user 
   * @param {*} type 
   * @param {*} start 
   * @param {*} end 
   * @returns 
   */
  async newRequest(user: string, type: string, start: string, end: string, totalTime: digit, reason: string): Promise<{ mgroup: digit, name: string, num: string, multiple: boolean } | null> {
    const query: userinfo = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo);
    const joinDate = new Date(query["joinTime"]);
    const now = new Date();
    const checkpoint: Date = new Date(`${end.split("-")[0]}-${query["joinTime"].substring(5)}`);
    const endDate: Date = new Date(end.split(" ")[0]);
    const year: string = checkpoint > endDate ? (parseInt(end.split("-")[0]) - 1).toString() : end.split("-")[0];
    const new_reason = reason.replace("<", "").replace(">", "").replace('"', '');
    const tTime = parseFloat(`${totalTime}`);

    // m = months joined
    const { m } = calculate(joinDate, now);

    const quotaInfoY = this.calculateAnnualQuota(user, year);
    const usedInYObj = this.login_db.prepare(`SELECT annual FROM dayoffinfo WHERE id= ? AND year= ?`).get(user, year) as dayoffinfo;
    const usedInY = usedInYObj ? (usedInYObj["annual"] as number) : 0;

    // Current Year Quota Available (q1)
    const q1 = quotaInfoY.separate ? (m < 6 ? 0 : 24 - usedInY) : (quotaInfoY.data[0].quota - usedInY);

    let tickets: { start: string, end: string, time: number, type: string }[] = [];
    if (type === "特休假") {
      if (tTime <= q1) {
        // Case 1: Quota sufficient, straightforward insertion
        tickets.push({ start, end, time: tTime, type: "特休假" });
      } else {
        // Case 2: Out of boundaries (Check Spillover Year + 1)
        const quotaInfoYPlus1 = this.calculateAnnualQuota(user, parseInt(year) + 1);
        const usedInYPlus1Obj = this.login_db.prepare(`SELECT annual FROM dayoffinfo WHERE id= ? AND year= ?`).get(user, parseInt(year) + 1) as dayoffinfo;
        const usedInYPlus1 = usedInYPlus1Obj ? (usedInYPlus1Obj["annual"] as number) : 0;

        const q2 = quotaInfoY.separate ? 24 : (quotaInfoYPlus1.data[0].quota - usedInYPlus1);

        if (q2 < (tTime - q1)) {
          log.logFormat(`${user} try to request a dayoff but exceed total quota.`);
          return null;
        }

        if (q1 > 0) {
          // Determine exact valid breakpoints skipping non-working days
          const startD = new Date(start);
          const rocYears = getROCYearsInRange(startD, startD);
          const allNonWorkingDays = await fetch_all_nwd(rocYears);

          // Fetch split logic that strictly complies with shift time requirements
          const splits = await getSplitTimestamp(start, q1, allNonWorkingDays);

          tickets.push({ start: start, end: splits.calc1, time: q1, type: "特休假" });
          tickets.push({ start: splits.calc2, end: end, time: tTime - q1, type: "特休假_N" });
        } else {
          // If q1 is flat 0, ONLY create 1 special ticket per requirement
          tickets.push({ start: start, end: end, time: tTime, type: "特休假_N" });
        }
      }
    } else {
      tickets.push({ start, end, time: tTime, type: type });
    }

    // Store into DB
    let lastCount = "";
    const multiple: boolean = tickets.length > 1;
    for (const t of tickets) {
      const currentYear = new Date().getFullYear();
      const serials: requestquery[] | [] = (this.login_db.prepare(`SELECT serialnum FROM requestquery WHERE serialnum LIKE ? ORDER BY serialnum ASC`).all(`${currentYear}%`) as requestquery[] | []);
      const count: string = serials[serials.length - 1] ? `${currentYear}${(parseInt(serials[serials.length - 1]["serialnum"].substring(4)) + 1).toString().padStart(4, '0')}` : `${currentYear}0000`;

      this.login_db.prepare(`INSERT INTO requestquery (serialnum,id,name,type,start,end,mgroup,totalTime,reason,month,year) VALUES (?,?,?,?,(strftime('%Y-%m-%d %H:%M',?)),(strftime('%Y-%m-%d %H:%M',?)),?,?,?,?,?);`)
        .run(count, user, query["name"], t.type, t.start, t.end, query["mgroup"], t.time, new_reason, parseInt(start.split("-")[1]), year);

      lastCount = count;
      log.logFormat(`${user} just request a new dayoff. Ticket id: #${count}.`, new Date());
    }

    return { "mgroup": query["mgroup"], "name": query["name"], "num": lastCount, "multiple": multiple };
  }

  //  newRequest(user: string, type: string, start: string, end: string, totalTime: digit, reason: string): { mgroup: digit, name: string, num: string } | null {
  //    const query: userinfo = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo);
  //    const checkpoint: Date = new Date(`${end.split("-")[0]}-${query["joinTime"].substring(5)}`);
  //    const endDate: Date = new Date(end.split(" ")[0]);
  //    const year: string = checkpoint > endDate ? (parseInt(end.split("-")[0]) - 1).toString() : end.split("-")[0];
  //    const currentYear: number = new Date().getFullYear();
  //    const month: number = parseInt(start.split("-")[1]);
  //    const serials: requestquery[] | [] = (this.login_db.prepare(`SELECT serialnum FROM requestquery WHERE serialnum LIKE ? ORDER BY serialnum ASC`).all(`${currentYear}%`) as requestquery[] | []);
  //    const count: string = serials[serials.length - 1] ? `${currentYear}${(parseInt(serials[serials.length - 1]["serialnum"].substring(4)) + 1).toString().padStart(4, '0')}` : `${currentYear}0000`;
  //    const name: string = query["name"];
  //    const new_reason: string = reason.replace("<", "").replace(">", "").replace('"', '');
  //
  //    const { m, d } = calculate(new Date(start), new Date(end));
  //    if (this.checkRemainAnnual(user, parseInt(year), parseInt(`${totalTime}`), m < 6) == false) {
  //      log.logFormat(`${user} try to request a dayoff but exceed annual quota.`);
  //      return null;
  //    }
  //
  //    this.login_db.prepare(`INSERT INTO requestquery (serialnum,id,name,type,start,end,mgroup,totalTime,reason,month,year) VALUES (?,?,?,?,(strftime('%Y-%m-%d %H:%M',?)),(strftime('%Y-%m-%d %H:%M',?)),?,?,?,?,?);`).run(count, user, name, type, start, end, query["mgroup"], totalTime, new_reason, month, year);
  //    log.logFormat(`${user} just request a new dayoff. Ticket id: #${count}.`, new Date())
  //    return { "mgroup": query["mgroup"], "name": name, "num": count };
  //  }

  /**
   * List tickets in a given state. Every filter value is bound as a query
   * parameter; never splice caller input into the SQL text.
   */
  showQuery(state: number = 0, filters: { id?: string, year?: string, month?: string, limit?: number } = {}): requestquery[] | [] {
    const clauses: string[] = ["state = ?"];
    const params: Array<string | number> = [state];
    if (filters.id) { clauses.push("id = ?"); params.push(filters.id); }
    if (filters.year) { clauses.push("year = ?"); params.push(filters.year); }
    if (filters.month) { clauses.push("month = ?"); params.push(filters.month); }
    let tail = "";
    if (filters.limit) { tail = " ORDER BY serialnum DESC LIMIT ?"; params.push(filters.limit); }
    const query: requestquery[] | [] = (this.login_db.prepare(`SELECT serialnum,name,type,start,end,reason,totalTime FROM requestquery WHERE ${clauses.join(" AND ")}${tail};`).all(...params) as requestquery[] | []);
    return query;
  }

  setPermit(num: string, state: number): string {
    const query = (this.login_db.prepare(`SELECT * FROM requestquery WHERE serialnum= ? `).get(num) as requestquery);
    const year: string = query["year"];
    const column = leaveColumn(query["type"]);

    if (state == 1) {
      if (column === null) {
        throw new Error(`Ticket #${num} has an unknown leave type and cannot be approved.`);
      }
      if (column == "annual_special") {
        const ny: number = parseInt(year) + 1;
        if (!this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).get(query["id"], ny)) {
          this.init(query["id"], ny);
        }

        this.login_db.prepare(`UPDATE dayoffinfo SET annual=annual+? WHERE id= ? AND year= ?;`).run(query["totalTime"], query["id"], ny);
      } else {
        if (!this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).get(query["id"], year)) {
          this.init(query["id"], year);
        }

        // `column` comes from the fixed leave-type list, never from caller input.
        this.login_db.prepare(`UPDATE dayoffinfo SET ${column}=${column}+? WHERE id= ? AND year= ?;`).run(query["totalTime"], query["id"], year);
      }
    }
    this.login_db.prepare(`UPDATE requestquery SET state= ? WHERE serialnum= ?;`).run(state, num);
    log.logFormat(`Dayoff ticket #${num} has been set to ${state == 1 ? "accepted" : "denied"}.`);
    return (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(query["id"]) as userinfo)["email"];
  }

  /**
   * The function check if the user requires the permission to have a dayoff
   * @param {*} user 
   * @returns {number|null} 1 means require a permission
   */
  getPermission(user: string): userinfo["permit"] | null {
    const query = (this.login_db.prepare(`SELECT permit FROM userinfo WHERE id= ? `).get(user) as userinfo | undefined);
    if (query) return query["permit"];
    return null
  }

  clockinAction(user: string, type: number, now: Date): clockinrecord[] | { status: digit } | null {
    const year: number = now.getFullYear();
    const month: digit = now.getMonth() + 1 > 9 ? (now.getMonth() + 1) : '0' + (now.getMonth() + 1).toString();
    const date: digit = now.getDate() > 9 ? (now.getDate()) : '0' + (now.getDate()).toString();
    const hour: string = now.getHours() > 9 ? (now.getHours().toString()) : '0' + (now.getHours()).toString();
    const min: digit = now.getMinutes() > 9 ? (now.getMinutes()) : '0' + (now.getMinutes()).toString();
    var datetime: string;
    if (parseInt(hour) >= 18) {
      datetime = `${year}-${month}-${date} 18:00`;
    } else {
      datetime = `${year}-${month}-${date} ${hour}:${min}`;
    }
    const day = datetime.split(" ")[0];
    const time = datetime.split(" ")[1];
    // Soft-deleted punches stay in the table (see softDeletePunch) but are
    // invisible here: they are not returned, not filled in, and a new punch
    // never reuses their number.
    const all = (this.login_db.prepare(`SELECT * FROM clockinrecord WHERE date= ? AND id= ? ORDER BY num;`).all(day, user) as clockinrecord[]);
    const data = all.filter(isLiveRow).map(livePunch);
    if (type == 0) {
      return data;
    }
    const column = type == 1 ? "clockin" : "clockout";
    const name: string = (this.login_db.prepare(`SELECT name FROM userinfo WHERE id= ?;`).get(user) as userinfo)["name"];
    // A make-up (補登) punch is a finished record approved by an admin; a live
    // punch never fills its empty half.
    // Nor does it refill a half an admin deleted on purpose (see softDeletePunch).
    const deletedColumn = type == 1 ? "deleted_clockin" : "deleted_clockout";
    const open = all.find((row) => isLiveRow(row) && !row[column] && row[deletedColumn] == null && row.makeup_request_id == null);
    if (open) {
      this.login_db.prepare(`UPDATE clockinrecord SET ${column}= ? WHERE id= ? AND num= ? AND date= ? AND deleted_at IS NULL;`).run(time, user, open.num, day);
      return { "status": 200 };
    }
    const nextNum = all.reduce((max, row) => Math.max(max, Number(row.num) || 0), 0) + 1;
    this.login_db.prepare(`INSERT INTO clockinrecord (id,name,date,${column},num) VALUES (?,?,?,?,?);`).run(user, name, day, time, nextNum);
    return { "status": 200 };
  }

  showPersonalQuery(user: string, year: string): requestquery[] | [] {
    const query = (this.login_db.prepare(`SELECT serialnum,name,type,start,end,reason,totalTime,state FROM requestquery WHERE id= ? AND year= ? `).all(user, year) as requestquery[] | []);
    return query;
  }

  deleteAccount(user: string): void {
    this.login_db.prepare(`DELETE FROM userinfo WHERE id= ? `).run(user);
    return;
  }

  calculateAnnualQuota(user: string, year: digit): { separate: boolean, data: { quota: number, years: number, month: number, days: number, joinTime: string }[] } {
    const db_jt: string = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo)["joinTime"];
    const joinTime: Date = new Date(db_jt);
    const month: number = parseInt(db_jt.split("-")[1]);
    const endTime: Date = month == -1 ? new Date(`${year}-${db_jt.split("-")[1]}-${db_jt.split("-")[2]}`) : new Date(`${year}-${month}-${db_jt.split("-")[2]}`);
    const elapse: { m: number, d: number } = calculate(joinTime, endTime);
    const months = elapse['m'], days = elapse['d'];
    const years = months / 12;
    const realMonth: number = (months - (Math.floor(years) * 12));
    var quota: number = 0;
    console.log(`Calculating annual quota for ${user} in ${year}-${month}. Join time: ${db_jt}, Elapsed: ${years} years, ${realMonth} months, ${days} days.`);
    if (years < 1) {
      return { separate: true, data: [{ "quota": 0, "years": Math.floor(years) + (realMonth < 6 ? 0 : 0.5), "month": realMonth, "days": days, "joinTime": db_jt }, { "quota": 3 * 8, "years": Math.floor(years) + (realMonth < 6 ? 0 : 0.5), "month": 6, "days": days, "joinTime": db_jt }] };
    } else if (years >= 1 && years < 2) {
      quota = 7;
    } else if (years >= 2 && years < 3) {
      quota = 10;
    } else if (years >= 3 && years < 5) {
      quota = 14;
    } else if (years >= 5 && years < 10) {
      quota = 15;
    } else if (years >= 10) {
      const w = Math.floor(years) + 6;
      quota = (w >= 30 ? 30 : w);
    }

    return { separate: false, data: [{ "quota": quota * 8, "years": Math.floor(years) + (realMonth < 6 ? 0 : 0.5), "month": realMonth, "days": days, "joinTime": db_jt }] };

  }

  showQueryInMonth(year: number, month: number): requestquery[] | [] {
    const query = (this.login_db.prepare(`SELECT name,start,end,type FROM requestquery WHERE state=1 AND start LIKE ? `).all(`${year}-${month.toString().padStart(2, '0')}%`) as requestquery[] | []);
    return query;
  }

  checkRemainAnnual(user: string, year: digit, adds: number, first_half: boolean): boolean {
    const quotaData = this.calculateAnnualQuota(user, year);
    // A year with no usage row yet has used nothing (same rule as newRequest).
    const usedRow = this.login_db.prepare(`SELECT annual FROM dayoffinfo WHERE id= ? AND year= ?`).get(user, year) as dayoffinfo | undefined;
    const used = usedRow ? (usedRow["annual"] as number) : 0;
    if (quotaData.separate) {
      const q = first_half ? 0 : 24
      if (used + adds <= q) {
        return true;
      }
    } else {
      const quota = quotaData.data[0]["quota"];
      if (used + adds <= quota) {
        return true;
      }
    }
    return false;
  }

  /**
   * 
   * @param {string} year 
   * @param {string} month 
   */
  async clockinRecord(year: digit, month: digit): Promise<[] | clockinrecord[]> {
    const query = (this.login_db.prepare(`SELECT * FROM clockinrecord WHERE date LIKE ? AND deleted_at IS NULL AND (clockin IS NOT NULL OR clockout IS NOT NULL);`).all(`${year}-${month}-%`) as clockinrecord[]).map(livePunch);
    return new Promise(res => { res(query) });
  }

  clockinYears(): number[] {
    const rows = this.login_db.prepare(`SELECT DISTINCT substr(date, 1, 4) AS year FROM clockinrecord WHERE deleted_at IS NULL AND (clockin IS NOT NULL OR clockout IS NOT NULL) ORDER BY year;`).all() as Array<{ year: string }>;
    return rows
      .map((row) => parseInt(row.year, 10))
      .filter((year) => !Number.isNaN(year));
  }

  syncTickets(user: string, year: digit): void {
    const tickets = (this.login_db.prepare(`SELECT * FROM requestquery WHERE id= ? AND year= ? AND state=1;`).all(user, year) as requestquery[] | []);
    const ny: number = parseInt(`${year}`) + 1;
    const last_tickets = (this.login_db.prepare(`SELECT * FROM requestquery WHERE id= ? AND year= ? AND state=1;`).all(user, ny - 2) as requestquery[] | []);
    // Sum approved hours per column. Tickets with a type outside the fixed
    // leave-type list are skipped (and logged) rather than turned into SQL.
    const amount: { [column: string]: number } = {};
    const lastAnnualSpecial = last_tickets
      .filter((ticket) => leaveColumn(ticket["type"]) === "annual_special")
      .reduce((sum, ticket) => sum + ticket["totalTime"], 0);
    for (const column of DAYOFF_COLUMNS) {
      amount[column] = 0;
    }
    for (const ticket of tickets) {
      const column = leaveColumn(ticket["type"]);
      if (column === null) {
        log.logFormat(`Skipping ticket #${ticket["serialnum"]} with unknown leave type while syncing ${user}.`);
        continue;
      }
      if (column === "annual_special") {
        continue;
      }
      amount[column] += ticket["totalTime"];
    }
    amount["annual"] += lastAnnualSpecial;
    this.init(user, year);
    const assignments = DAYOFF_COLUMNS.map((column) => `${column} = ?`);
    const values: Array<string | number> = DAYOFF_COLUMNS.map((column) => amount[column]);
    values.push(user, `${year}`);
    log.logFormat(`Syncing ${user}'s leave usage for ${year}.`);
    this.login_db.prepare(`UPDATE dayoffinfo SET ${assignments.join(", ")} WHERE id= ? AND year= ?;`).run(...values);
    return;
  }

  resyncEmployeeDayoff(user: string): void {
    const years = this.login_db.prepare(`SELECT DISTINCT year FROM dayoffinfo WHERE id= ? UNION SELECT DISTINCT year FROM requestquery WHERE id= ?;`).all(user, user) as Array<{ year: string }>;
    years.forEach((yearInfo) => {
      this.syncTickets(user, yearInfo.year);
    });
  }

  /**
   * Edit (action 1) or delete (action 0) a ticket, then recompute the usage of
   * every leave year the ticket touched before and after the change. Runs in
   * one transaction so the ticket and the usage rows never disagree.
   * Returns null when an annual-leave edit would exceed the quota.
   */
  modifyTicket(num: string, action: number, type: string, start: string, end: string, totalTime: number, state: digit, reason: string): number | null {
    const ticket = (this.login_db.prepare(`SELECT * FROM requestquery WHERE serialnum= ?;`).get(num) as requestquery);
    const user = ticket["id"];
    const oldYear = `${ticket["year"]}`;
    // Approved 特休假_N tickets count towards the following year (see syncTickets).
    const affectedYears = (year: string, ticketType: string): string[] =>
      leaveColumn(ticketType) === "annual_special" ? [year, `${parseInt(year) + 1}`] : [year];

    const run = this.login_db.transaction((): number | null => {
      if (action == 0) {
        this.login_db.prepare(`DELETE FROM requestquery WHERE serialnum= ?;`).run(num);
        log.logFormat(`Ticket #${num} has been DELETED.`);
        for (const y of new Set(affectedYears(oldYear, ticket["type"]))) this.syncTickets(user, y);
        return 0;
      }

      const query = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ?;`).get(user) as userinfo);
      const checkpoint = new Date(`${end.split("-")[0]}-${query["joinTime"].substring(5)}`);
      const endDate = new Date(end.split(" ")[0]);
      const year = checkpoint > endDate ? (parseInt(end.split("-")[0]) - 1).toString() : end.split("-")[0];

      if (type === "特休假") {
        // dayoffinfo.annual only holds approved tickets; the old copy of this
        // ticket is already counted there only if it was approved annual leave
        // in the same leave year.
        const counted = ticket["type"] === "特休假" && `${ticket["state"]}` === "1" && oldYear === year ? ticket["totalTime"] : 0;
        const { m } = calculate(new Date(query["joinTime"]), new Date());
        if (this.checkRemainAnnual(user, parseInt(year), totalTime - counted, m < 6) == false) {
          log.logFormat(`${user} try to request a dayoff but exceed annual quota.`);
          return null;
        }
      }
      const new_reason: string = reason.replace("<", "").replace(">", "").replace('"', '');
      this.login_db.prepare(`UPDATE requestquery SET type= ?, start= ?, end= ?, totalTime= ?, state= ?, year= ?, reason= ?, month= ? WHERE serialnum= ?;`)
        .run(type, start, end, totalTime, state, year, new_reason, parseInt(start.split("-")[1]), num);
      const years = new Set([...affectedYears(oldYear, ticket["type"]), ...affectedYears(year, type)]);
      for (const y of years) this.syncTickets(user, y);
      return 0;
    });
    return run();
  }

  /** `pwd` null or empty keeps the current password; anything else is stored hashed. */
  async modifyEmployeeInfo(user: string, pwd: string | null, type: string, email: string, name: string, joinTime: string, mgroup: digit, permit: digit, status: digit, leaveDate: string | null): Promise<void> {
    const hashed = typeof pwd === "string" && pwd.length > 0 ? await hashPassword(pwd) : null;
    this.login_db.transaction(() => {
      this.login_db.prepare(`UPDATE userinfo SET type= ?,email= ?,name= ?,joinTime= ?,mgroup= ?,permit= ?,status= ?,leaveDate= ? WHERE id= ?;`).run(type, email, name, joinTime, mgroup, permit, status, leaveDate, user);
      if (hashed !== null) {
        this.login_db.prepare(`UPDATE userinfo SET pwd= ? WHERE id= ?;`).run(hashed, user);
      }
    })();
    return;
  }

  getTicket(num: string): requestquery | null {
    const row = this.login_db.prepare(`SELECT * FROM requestquery WHERE serialnum = ?;`).get(num) as requestquery | undefined;
    return row ? row : null;
  }

  getUser(id: string): userinfo_public | null {
    const row = this.login_db.prepare(`SELECT ${USERINFO_PUBLIC_COLUMNS} FROM userinfo WHERE id = ?;`).get(id) as userinfo_public | undefined;
    return row ? row : null;
  }

  clockinEditsForMonth(year: string | number, month: string | number): ClockEdit[] {
    const parts = this.clockMonthParts(year, month);
    const rows = this.login_db.prepare(
      `SELECT id, date, name, clockin, clockout, reason, editor_id, editor_name, edited_at
       FROM clockin_edit WHERE date LIKE ?;`
    ).all(`${parts.year}-${parts.month}-%`) as ClockEditSqlRow[];
    return rows.map((row) => this.toClockEdit(row));
  }

  clockinEditsForDate(date: string): ClockEdit[] {
    const rows = this.login_db.prepare(
      `SELECT id, date, name, clockin, clockout, reason, editor_id, editor_name, edited_at
       FROM clockin_edit WHERE date = ?;`
    ).all(date) as ClockEditSqlRow[];
    return rows.map((row) => this.toClockEdit(row));
  }

  saveClockinEdit(input: {
    id: string;
    date: string;
    name: string;
    clockin: string | null;
    clockout: string | null;
    reason: string;
    editorId: string;
    editorName: string;
  }): void {
    this.login_db.prepare(
      `INSERT INTO clockin_edit (id, date, name, clockin, clockout, reason, editor_id, editor_name, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M', 'now', '+8 hours'))
       ON CONFLICT(id, date) DO UPDATE SET
         name = excluded.name,
         clockin = excluded.clockin,
         clockout = excluded.clockout,
         reason = excluded.reason,
         editor_id = excluded.editor_id,
         editor_name = excluded.editor_name,
         edited_at = strftime('%Y-%m-%d %H:%M', 'now', '+8 hours');`
    ).run(
      input.id,
      input.date,
      input.name,
      normalizeTime(input.clockin),
      normalizeTime(input.clockout),
      input.reason,
      input.editorId,
      input.editorName
    );
  }

  replaceClockinMaster(year: string | number, month: string | number, rows: ClockSheetRow[]): void {
    const parts = this.clockMonthParts(year, month);
    const remove = this.login_db.prepare(`DELETE FROM clockin_master_row WHERE year = ? AND month = ?;`);
    const insert = this.login_db.prepare(
      `INSERT INTO clockin_master_row (year, month, date, id, name, clockin, clockout, modified, reason, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
    );
    const mark = this.login_db.prepare(
      `INSERT INTO clockin_master (year, month, generated_at)
       VALUES (?, ?, strftime('%Y-%m-%d %H:%M', 'now', '+8 hours'))
       ON CONFLICT(year, month) DO UPDATE SET
         generated_at = strftime('%Y-%m-%d %H:%M', 'now', '+8 hours');`
    );
    const writeRows = this.login_db.transaction(() => {
      remove.run(parts.year, parts.month);
      for (const row of rows) {
        insert.run(
          parts.year,
          parts.month,
          row.date,
          row.id,
          row.name,
          row.clockin,
          row.clockout,
          row.modified ? 1 : 0,
          row.modified ? row.reason : '',
          row.modified ? row.editedAt : null
        );
      }
      mark.run(parts.year, parts.month);
    });
    writeRows();
  }

  clockinMasterReady(year: string | number, month: string | number): boolean {
    const parts = this.clockMonthParts(year, month);
    const row = this.login_db.prepare(`SELECT 1 AS ready FROM clockin_master WHERE year = ? AND month = ?;`).get(parts.year, parts.month);
    return row != null;
  }

  clockinMasterRows(year: string | number, month: string | number, id?: string): ClockSheetRow[] {
    const parts = this.clockMonthParts(year, month);
    const rows = (id == null
      ? this.login_db.prepare(
        `SELECT date, id, name, clockin, clockout, modified, reason, edited_at
         FROM clockin_master_row WHERE year = ? AND month = ?;`
      ).all(parts.year, parts.month)
      : this.login_db.prepare(
        `SELECT date, id, name, clockin, clockout, modified, reason, edited_at
         FROM clockin_master_row WHERE year = ? AND month = ? AND id = ?;`
      ).all(parts.year, parts.month, id)) as ClockMasterSqlRow[];
    const mapped = rows.map((row) => this.toClockSheetRow(row));
    mapped.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id, 'zh-Hant', { numeric: true, sensitivity: 'base' }));
    return mapped;
  }

  employeeIdsWithMonthActivity(year: string | number, month: string | number): string[] {
    const parts = this.clockMonthParts(year, month);
    const prefix = `${parts.year}-${parts.month}-%`;
    const rows = this.login_db.prepare(
      `SELECT id FROM clockinrecord WHERE date LIKE ? AND deleted_at IS NULL AND (clockin IS NOT NULL OR clockout IS NOT NULL)
       UNION
       SELECT id FROM clockin_edit WHERE date LIKE ?
       UNION
       SELECT id FROM clockin_master_row WHERE year = ? AND month = ?;`
    ).all(prefix, prefix, parts.year, parts.month) as Array<{ id: string }>;
    const ids: string[] = [];
    for (const row of rows) {
      if (row.id) {
        ids.push(row.id);
      }
    }
    return ids;
  }

  approvedLeaveIdsOnDate(date: string): string[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return [];
    }
    const rows = this.login_db.prepare(
      `SELECT DISTINCT id FROM requestquery
       WHERE state = 1 AND date(start) <= ? AND date(end) >= ?;`
    ).all(date, date) as Array<{ id: string }>;
    const ids: string[] = [];
    for (const row of rows) {
      if (row.id) {
        ids.push(row.id);
      }
    }
    return ids;
  }

  /**
   * Every punch of one employee on one day, lowest number first. Soft-deleted
   * punches are only included when `includeDeleted` is set (root's view).
   */
  clockinPunches(id: string, date: string, includeDeleted: boolean): PunchRow[] {
    const rows = this.login_db.prepare(
      `SELECT id, name, date, num, clockin, clockout, deleted_at, deleted_by, delete_reason, makeup_request_id, deleted_clockin, deleted_clockout
       FROM clockinrecord WHERE id = ? AND date = ? ORDER BY num;`
    ).all(id, date) as clockinrecord[];
    // Admins see only live halves; root also sees deleted punches and halves.
    const visible = includeDeleted
      ? rows.filter((row) => isLiveRow(row) || row.deleted_at != null || row.deleted_clockin != null || row.deleted_clockout != null)
      : rows.filter(isLiveRow);
    return visible.map((row) => ({
      id: row.id,
      name: row.name,
      date: row.date,
      num: Number(row.num),
      clockin: normalizeTime(row.clockin),
      clockout: normalizeTime(row.clockout),
      deleted: row.deleted_at != null,
      deletedAt: row.deleted_at ?? null,
      deletedBy: row.deleted_by ?? null,
      deleteReason: row.delete_reason ?? null,
      deletedClockin: includeDeleted ? normalizeTime(row.deleted_clockin ?? null) : null,
      deletedClockout: includeDeleted ? normalizeTime(row.deleted_clockout ?? null) : null,
      makeup: row.makeup_request_id != null,
      makeupRequestId: row.makeup_request_id ?? null,
    }));
  }

  /**
   * Soft-delete one punch: mark it and write an audit row, in one transaction.
   * Returns 'missing' when no live punch matches, 'ambiguous' when more than
   * one does (legacy duplicates), otherwise 'done'.
   */
  softDeletePunch(target: PunchKey, actor: { id: string, name: string }, reason: string, part: PunchPart = "both"): PunchChange {
    return this.login_db.transaction((): PunchChange => {
      const live = this.login_db.prepare(
        `SELECT clockin, clockout FROM clockinrecord WHERE id = ? AND date = ? AND num = ? AND deleted_at IS NULL;`
      ).all(target.id, target.date, target.num) as Array<{ clockin: string | null, clockout: string | null }>;
      if (live.length === 0) return "missing";
      if (live.length > 1) return "ambiguous";
      if (part !== "both") {
        // Only one half: move its time aside so root can put it back.
        const value = live[0][part];
        if (value == null) return "missing";
        this.login_db.prepare(
          `UPDATE clockinrecord SET deleted_${part} = ${part}, ${part} = NULL
           WHERE id = ? AND date = ? AND num = ? AND deleted_at IS NULL;`
        ).run(target.id, target.date, target.num);
        this.writePunchAudit("delete", target, halfOf(part, value), actor, reason, part);
        return "done";
      }
      if (live[0].clockin == null && live[0].clockout == null) return "missing";
      this.login_db.prepare(
        `UPDATE clockinrecord SET deleted_at = strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'), deleted_by = ?, delete_reason = ?
         WHERE id = ? AND date = ? AND num = ? AND deleted_at IS NULL;`
      ).run(actor.id, reason, target.id, target.date, target.num);
      this.writePunchAudit("delete", target, live[0], actor, reason);
      return "done";
    })();
  }

  /** Undo softDeletePunch; same return values. The audit trail keeps both events. */
  restorePunch(target: PunchKey, actor: { id: string, name: string }, reason: string, part: PunchPart = "both"): PunchChange {
    return this.login_db.transaction((): PunchChange => {
      if (part !== "both") {
        const halves = this.login_db.prepare(
          `SELECT ${part} AS current, deleted_${part} AS removed FROM clockinrecord WHERE id = ? AND date = ? AND num = ?;`
        ).all(target.id, target.date, target.num) as Array<{ current: string | null, removed: string | null }>;
        const withRemoved = halves.filter((row) => row.removed != null);
        if (withRemoved.length === 0) return "missing";
        if (halves.length > 1) return "ambiguous";
        // The half was filled again in the meantime: putting the old time back would overwrite it.
        if (withRemoved[0].current != null) return "conflict";
        this.login_db.prepare(
          `UPDATE clockinrecord SET ${part} = deleted_${part}, deleted_${part} = NULL
           WHERE id = ? AND date = ? AND num = ? AND deleted_${part} IS NOT NULL;`
        ).run(target.id, target.date, target.num);
        this.writePunchAudit("restore", target, halfOf(part, withRemoved[0].removed), actor, reason, part);
        return "done";
      }
      const rows = this.login_db.prepare(
        `SELECT clockin, clockout, deleted_at FROM clockinrecord WHERE id = ? AND date = ? AND num = ?;`
      ).all(target.id, target.date, target.num) as Array<{ clockin: string | null, clockout: string | null, deleted_at: string | null }>;
      const deleted = rows.filter((row) => row.deleted_at != null);
      if (deleted.length === 0) return "missing";
      // Restoring next to another punch with the same number would make the
      // two indistinguishable.
      if (rows.length > 1) return "ambiguous";
      this.login_db.prepare(
        `UPDATE clockinrecord SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
         WHERE id = ? AND date = ? AND num = ? AND deleted_at IS NOT NULL;`
      ).run(target.id, target.date, target.num);
      this.writePunchAudit("restore", target, deleted[0], actor, reason);
      return "done";
    })();
  }

  /** Audit trail of punch deletions and restorations, newest first. */
  punchAudit(filter: { id?: string, date?: string } = {}): PunchAuditRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.id) { clauses.push("punch_id = ?"); params.push(filter.id); }
    if (filter.date) { clauses.push("punch_date = ?"); params.push(filter.date); }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.login_db.prepare(
      `SELECT audit_id, action, punch_id, punch_date, punch_num, clockin, clockout, actor_id, actor_name, reason, acted_at, part
       FROM clockin_punch_audit${where} ORDER BY audit_id DESC;`
    ).all(...params) as PunchAuditRow[];
  }

  private writePunchAudit(
    action: "delete" | "restore",
    target: PunchKey,
    punch: { clockin: string | null, clockout: string | null },
    actor: { id: string, name: string },
    reason: string,
    part: PunchPart = "both"
  ): void {
    this.login_db.prepare(
      `INSERT INTO clockin_punch_audit (action, punch_id, punch_date, punch_num, clockin, clockout, actor_id, actor_name, reason, acted_at, part)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'), ?);`
    ).run(action, target.id, target.date, target.num, punch.clockin, punch.clockout, actor.id, actor.name, reason, part === "both" ? null : part);
  }

  /** Approved leave tickets that touch `date` (YYYY-MM-DD). */
  approvedLeavesOnDate(date: string): Array<{ id: string, start: string, end: string }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return [];
    }
    return this.login_db.prepare(
      `SELECT id, start, end FROM requestquery
       WHERE state = 1 AND date(start) <= ? AND date(end) >= ?;`
    ).all(date, date) as Array<{ id: string, start: string, end: string }>;
  }

  /** One person's leave tickets in the given states (0 pending, 1 approved) that touch `date`. */
  leavesOnDate(date: string, id: string, states: number[]): Array<{ id: string, start: string, end: string }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !states.length) {
      return [];
    }
    return this.login_db.prepare(
      `SELECT id, start, end FROM requestquery
       WHERE id = ? AND state IN (${states.map(() => '?').join(', ')}) AND date(start) <= ? AND date(end) >= ?;`
    ).all(id, ...states, date, date) as Array<{ id: string, start: string, end: string }>;
  }

  // ---- Make-up punch (補登) requests ------------------------------------

  /**
   * File a make-up request and write its 'submit' audit row, in one
   * transaction. Returns 'duplicate' when a pending or approved request of the
   * same person already covers the same half of that day.
   */
  createMakeupRequest(applicant: { id: string, name: string, department: string }, input: MakeupInput): number | "duplicate" {
    return this.login_db.transaction((): number | "duplicate" => {
      const existing = this.login_db.prepare(
        `SELECT kind FROM makeup_request WHERE id = ? AND missed_date = ? AND state IN ('pending', 'approved');`
      ).all(applicant.id, input.date) as Array<{ kind: MakeupKind }>;
      if (existing.some((row) => kindsOverlap(row.kind, input.kind))) return "duplicate";
      const result = this.login_db.prepare(
        `INSERT INTO makeup_request (id, name, department, missed_date, kind, clockin, clockout, reason, applied_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'), 'pending');`
      ).run(applicant.id, applicant.name, applicant.department, input.date, input.kind, input.clockin, input.clockout, input.reason);
      const requestId = Number(result.lastInsertRowid);
      this.writeMakeupAudit(requestId, "submit", { id: applicant.id, name: applicant.name }, input.reason);
      return requestId;
    })();
  }

  getMakeupRequest(requestId: number): MakeupRequestRow | null {
    const row = this.login_db.prepare(`SELECT * FROM makeup_request WHERE request_id = ?;`).get(requestId) as MakeupRequestRow | undefined;
    return row ? row : null;
  }

  /** One person's own requests, newest first. */
  makeupRequestsOf(id: string): MakeupRequestRow[] {
    return this.login_db.prepare(`SELECT * FROM makeup_request WHERE id = ? ORDER BY request_id DESC;`).all(id) as MakeupRequestRow[];
  }

  /** Every request, optionally in one state; pending ones oldest first, others newest first. */
  makeupRequests(state?: MakeupState): MakeupRequestRow[] {
    if (state) {
      const order = state === "pending" ? "ASC" : "DESC";
      return this.login_db.prepare(`SELECT * FROM makeup_request WHERE state = ? ORDER BY request_id ${order};`).all(state) as MakeupRequestRow[];
    }
    return this.login_db.prepare(`SELECT * FROM makeup_request ORDER BY request_id DESC;`).all() as MakeupRequestRow[];
  }

  /** Kinds of one person's pending or approved make-up requests for `date`. */
  activeMakeupKindsOn(id: string, date: string): MakeupKind[] {
    const rows = this.login_db.prepare(
      `SELECT kind FROM makeup_request WHERE id = ? AND missed_date = ? AND state IN ('pending', 'approved');`
    ).all(id, date) as Array<{ kind: MakeupKind }>;
    return rows.map((row) => row.kind);
  }

  /** Ids of people with a pending make-up request for `date`. */
  pendingMakeupIdsOn(date: string): string[] {
    const rows = this.login_db.prepare(`SELECT DISTINCT id FROM makeup_request WHERE missed_date = ? AND state = 'pending';`).all(date) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Approve or reject a pending request, in one transaction. Approval inserts
   * the punch (flagged with makeup_request_id) under a fresh number for that
   * day; rejection inserts nothing. Both write an audit row.
   */
  reviewMakeupRequest(requestId: number, decision: "approve" | "reject", actor: { id: string, name: string }, note: string): MakeupReview {
    return this.login_db.transaction((): MakeupReview => {
      const request = this.getMakeupRequest(requestId);
      if (!request) return { result: "missing" };
      if (request.state !== "pending") return { result: "not-pending", state: request.state };
      let punchNum: number | null = null;
      if (decision === "approve") {
        // Count soft-deleted rows too, so a later restore cannot clash.
        const max = this.login_db.prepare(`SELECT MAX(num) AS n FROM clockinrecord WHERE id = ? AND date = ?;`).get(request.id, request.missed_date) as { n: number | null };
        punchNum = (Number(max.n) || 0) + 1;
        this.login_db.prepare(
          `INSERT INTO clockinrecord (id, name, date, num, clockin, clockout, makeup_request_id) VALUES (?, ?, ?, ?, ?, ?, ?);`
        ).run(request.id, request.name, request.missed_date, punchNum, request.clockin, request.clockout, request.request_id);
      }
      this.login_db.prepare(
        `UPDATE makeup_request SET state = ?, reviewer_id = ?, reviewer_name = ?, review_note = ?, punch_num = ?,
           reviewed_at = strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours')
         WHERE request_id = ? AND state = 'pending';`
      ).run(decision === "approve" ? "approved" : "rejected", actor.id, actor.name, note, punchNum, requestId);
      this.writeMakeupAudit(requestId, decision, actor, note);
      return { result: "done", request: this.getMakeupRequest(requestId) as MakeupRequestRow };
    })();
  }

  /** Audit trail of make-up requests, oldest first. */
  makeupAudit(requestId?: number): MakeupAuditRow[] {
    if (requestId != null) {
      return this.login_db.prepare(`SELECT * FROM makeup_audit WHERE request_id = ? ORDER BY audit_id;`).all(requestId) as MakeupAuditRow[];
    }
    return this.login_db.prepare(`SELECT * FROM makeup_audit ORDER BY audit_id;`).all() as MakeupAuditRow[];
  }

  private writeMakeupAudit(requestId: number, action: "submit" | "approve" | "reject", actor: { id: string, name: string }, reason: string): void {
    this.login_db.prepare(
      `INSERT INTO makeup_audit (request_id, action, actor_id, actor_name, reason, acted_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'));`
    ).run(requestId, action, actor.id, actor.name, reason);
  }

  // ---- 功能管理（feature flags） -----------------------------------------

  featureFlag(key: string): FeatureFlagRow | undefined {
    return this.login_db.prepare(`SELECT * FROM feature_flag WHERE key = ?;`).get(key) as FeatureFlagRow | undefined;
  }

  /** Save one feature's setting and its audit row in one transaction. */
  setFeatureFlag(key: string, enabled: boolean, startAt: string | null, actor: { id: string, name: string }): void {
    this.login_db.transaction(() => {
      this.login_db.prepare(
        `INSERT INTO feature_flag (key, enabled, start_at, updated_by, updated_by_name, updated_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'))
         ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, start_at = excluded.start_at,
           updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at;`
      ).run(key, enabled ? 1 : 0, startAt, actor.id, actor.name);
      this.login_db.prepare(
        `INSERT INTO feature_audit (key, enabled, start_at, actor_id, actor_name, acted_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'));`
      ).run(key, enabled ? 1 : 0, startAt, actor.id, actor.name);
    })();
  }

  /** Oldest first (the page turns consecutive rows into sentences). */
  featureAudit(): FeatureAuditRow[] {
    return this.login_db.prepare(`SELECT * FROM feature_audit ORDER BY audit_id;`).all() as FeatureAuditRow[];
  }

  /**
   * A newly registered feature gets its first-start setting (and an audit row
   * by 系統初始設定), so every setting on the page has a recorded origin.
   */
  private ensureFeatureFlags(): void {
    for (const f of FEATURES) {
      if (this.featureFlag(f.key)) continue;
      this.setFeatureFlag(f.key, f.initialLaunchAt != null, f.initialLaunchAt, SYSTEM_ACTOR);
    }
  }

  // ---- 公告 ---------------------------------------------------------------

  /** Every announcement not deleted, newest publish time first (management page). */
  announcements(): AnnouncementRow[] {
    return this.login_db.prepare(
      `SELECT * FROM announcement WHERE deleted_at IS NULL ORDER BY publish_at DESC, announcement_id DESC;`
    ).all() as AnnouncementRow[];
  }

  /** Announcements in force at `minute` for these audiences: pinned first, then newest. */
  visibleAnnouncements(minute: string, audiences: string[]): AnnouncementRow[] {
    const marks = audiences.map(() => '?').join(',');
    return this.login_db.prepare(
      `SELECT * FROM announcement
       WHERE deleted_at IS NULL AND publish_at <= ? AND (expire_at IS NULL OR expire_at > ?) AND audience IN (${marks})
       ORDER BY pinned DESC, publish_at DESC, announcement_id DESC;`
    ).all(minute, minute, ...audiences) as AnnouncementRow[];
  }

  getAnnouncement(id: number): AnnouncementRow | undefined {
    return this.login_db.prepare(`SELECT * FROM announcement WHERE announcement_id = ? AND deleted_at IS NULL;`).get(id) as AnnouncementRow | undefined;
  }

  createAnnouncement(input: AnnouncementInput, actor: { id: string, name: string }): number {
    const result = this.login_db.prepare(
      `INSERT INTO announcement (title, body, audience, publish_at, expire_at, pinned, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'), ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'));`
    ).run(input.title, input.body, input.audience, input.publishAt, input.expireAt, input.pinned ? 1 : 0, actor.id, actor.name, actor.id, actor.name);
    return Number(result.lastInsertRowid);
  }

  /** False when the announcement does not exist (or was deleted). */
  updateAnnouncement(id: number, input: AnnouncementInput, actor: { id: string, name: string }): boolean {
    const result = this.login_db.prepare(
      `UPDATE announcement SET title = ?, body = ?, audience = ?, publish_at = ?, expire_at = ?, pinned = ?,
         updated_by = ?, updated_by_name = ?, updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours')
       WHERE announcement_id = ? AND deleted_at IS NULL;`
    ).run(input.title, input.body, input.audience, input.publishAt, input.expireAt, input.pinned ? 1 : 0, actor.id, actor.name, id);
    return result.changes > 0;
  }

  deleteAnnouncement(id: number, actor: { id: string }): boolean {
    const result = this.login_db.prepare(
      `UPDATE announcement SET deleted_at = strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'), deleted_by = ?
       WHERE announcement_id = ? AND deleted_at IS NULL;`
    ).run(actor.id, id);
    return result.changes > 0;
  }

  // ---- Missed-punch notice de-duplication -------------------------------

  /**
   * Claim the notice for (id, date). True when this caller should send it:
   * no notice exists yet, or the earlier attempt failed. A notice that was
   * sent (or is being sent) is never claimed again.
   */
  claimMissedPunchNotice(id: string, date: string, kind: string, channel: string): boolean {
    const result = this.login_db.prepare(
      `INSERT INTO missed_punch_notice (id, date, kind, channel, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'), strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'))
       ON CONFLICT(id, date) DO UPDATE SET
         status = 'pending', kind = excluded.kind, channel = excluded.channel, updated_at = excluded.updated_at
       WHERE missed_punch_notice.status = 'failed';`
    ).run(id, date, kind, channel);
    return result.changes > 0;
  }

  finishMissedPunchNotice(id: string, date: string, status: "sent" | "failed"): void {
    this.login_db.prepare(
      `UPDATE missed_punch_notice SET status = ?, updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours') WHERE id = ? AND date = ?;`
    ).run(status, id, date);
  }

  private clockMonthParts(year: string | number, month: string | number): { year: string; month: string } {
    return {
      year: String(year),
      month: String(month).padStart(2, '0'),
    };
  }

  private toClockEdit(row: ClockEditSqlRow): ClockEdit {
    return {
      id: row.id,
      name: row.name || '',
      date: row.date,
      clockin: normalizeTime(row.clockin),
      clockout: normalizeTime(row.clockout),
      reason: row.reason || '',
      editorId: row.editor_id,
      editorName: row.editor_name,
      editedAt: row.edited_at,
    };
  }

  private toClockSheetRow(row: ClockMasterSqlRow): ClockSheetRow {
    const modified = Number(row.modified) === 1;
    return {
      id: row.id,
      name: row.name || '',
      date: row.date,
      clockin: normalizeTime(row.clockin),
      clockout: normalizeTime(row.clockout),
      modified,
      reason: modified ? (row.reason || '') : '',
      editorName: null,
      editedAt: modified ? (row.edited_at || null) : null,
    };
  }

}

export type PunchKey = { id: string, date: string, num: number };

export type PunchChange = "done" | "missing" | "ambiguous" | "conflict";

/** The whole punch, or only its 上班 / 下班 half. */
export type PunchPart = "both" | "clockin" | "clockout";

export type PunchRow = {
  id: string;
  name: string;
  date: string;
  num: number;
  clockin: string | null;
  clockout: string | null;
  deleted: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
  deleteReason: string | null;
  deletedClockin: string | null;
  deletedClockout: string | null;
  makeup: boolean;
  makeupRequestId: number | null;
};

export type FeatureAuditRow = {
  audit_id: number;
  key: string;
  enabled: number;
  start_at: string | null;
  actor_id: string;
  actor_name: string;
  acted_at: string;
};

export type AnnouncementAudience = "all" | "employee" | "admin";

export type AnnouncementInput = {
  title: string;
  body: string;
  audience: AnnouncementAudience;
  publishAt: string;
  expireAt: string | null;
  pinned: boolean;
};

export type AnnouncementRow = {
  announcement_id: number;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  publish_at: string;
  expire_at: string | null;
  pinned: number;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_by: string;
  updated_by_name: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
};

export type MakeupState = "pending" | "approved" | "rejected";

export type MakeupRequestRow = {
  request_id: number;
  id: string;
  name: string;
  department: string;
  missed_date: string;
  kind: MakeupKind;
  clockin: string | null;
  clockout: string | null;
  reason: string;
  applied_at: string;
  state: MakeupState;
  reviewer_id: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  punch_num: number | null;
};

export type MakeupAuditRow = {
  audit_id: number;
  request_id: number;
  action: "submit" | "approve" | "reject";
  actor_id: string;
  actor_name: string;
  reason: string;
  acted_at: string;
};

export type MakeupReview =
  | { result: "done", request: MakeupRequestRow }
  | { result: "missing" }
  | { result: "not-pending", state: MakeupState };

export type PunchAuditRow = {
  audit_id: number;
  action: "delete" | "restore";
  punch_id: string;
  punch_date: string;
  punch_num: number;
  clockin: string | null;
  clockout: string | null;
  actor_id: string;
  actor_name: string;
  reason: string;
  acted_at: string;
  /** Which half was deleted / restored; null for the whole punch. */
  part: "clockin" | "clockout" | null;
};

/** A live punch in the shape callers had before soft delete existed. */
function livePunch(row: clockinrecord): clockinrecord {
  const { deleted_at, deleted_by, delete_reason, deleted_clockin, deleted_clockout, ...rest } = row;
  return rest;
}

/** Not soft-deleted, and at least one half still has a time. */
function isLiveRow(row: clockinrecord): boolean {
  return row.deleted_at == null && (row.clockin != null || row.clockout != null);
}

function halfOf(part: "clockin" | "clockout", value: string | null): { clockin: string | null, clockout: string | null } {
  return part === "clockin" ? { clockin: value, clockout: null } : { clockin: null, clockout: value };
}

type ClockEditSqlRow = {
  id: string;
  date: string;
  name: string;
  clockin: string | null;
  clockout: string | null;
  reason: string | null;
  editor_id: string;
  editor_name: string;
  edited_at: string;
};

type ClockMasterSqlRow = {
  date: string;
  id: string;
  name: string;
  clockin: string | null;
  clockout: string | null;
  modified: number;
  reason: string | null;
  edited_at: string | null;
};

function calculate(startDate: Date, endDate: Date): { m: number, d: number } {
  if (!(startDate instanceof Date) || isNaN(startDate.getTime())) {
    throw new Error("Invalid date. Please provide a valid startDate as a Date object.");
  }

  // const endDate = new Date();

  let months = (endDate.getFullYear() - startDate.getFullYear()) * 12;
  months += endDate.getMonth() - startDate.getMonth();
  let days = endDate.getDate() - startDate.getDate();

  if (days < 0) {
    months -= 1;
    const previousMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 0); // Last day of previous month
    days += previousMonth.getDate(); // Add days from previous month
  }

  return { "m": months, "d": days };
}
