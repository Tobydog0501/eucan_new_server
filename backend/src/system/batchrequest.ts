import { Request, Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";
import { caculateTime } from "../plugins/dayoff_calculate";
import { dayofftype } from "../types/types";

const leaveTypes: dayofftype = {
  "特休假": "annual",
  "特休假_N": "annual_special",
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

module.exports = async function utils(sqlPlugin: sql, log: logger, mailer: mailer, req: Request, res: Response): Promise<void> {
  const dataReceived: { [key: string]: any } = req.body;
  const account = dataReceived["account"] as string;
  const cookie = dataReceived["cookie"] as string;
  const type = dataReceived["type"] as keyof dayofftype;
  const reason = dataReceived["reason"] as string;
  const start = dataReceived["start"] as string;
  const end = dataReceived["end"] as string;
  const users = dataReceived["users"];

  if (!valid(dataReceived, ["account", "cookie", "type", "reason", "start", "end", "users"]) || !Object.keys(leaveTypes).includes(type)) {
    res.sendStatus(400);
    return;
  }

  if (!Array.isArray(users) || users.length === 0) {
    res.sendStatus(400);
    return;
  }

  if (String(reason).replace(/\ /g, "").length == 0) {
    res.sendStatus(400);
    return;
  }

  if (!(validTime(start) && validTime(end))) {
    res.sendStatus(403);
    return;
  }

  const auth = sqlPlugin.checkHash(account, cookie);
  if (auth == null || auth["accountType"] == "employee") {
    res.sendStatus(403);
    return;
  }

  const totalTime = await caculateTime(start, end);
  const directory = new Map(sqlPlugin.getAllUsers().map((user) => [user.id, user]));
  const seen = new Set<string>();
  const success: Array<{ id: string, name: string, num: string }> = [];
  const failed: Array<{ id: string, name: string, reason: string }> = [];

  for (const rawId of users) {
    const id = String(rawId || "").trim();
    if (!id) {
      failed.push({ id: String(rawId), name: "", reason: "員工編號空白" });
      continue;
    }
    if (seen.has(id)) {
      failed.push({ id, name: directory.get(id)?.name || "", reason: "重複勾選" });
      continue;
    }
    seen.add(id);

    const employee = directory.get(id);
    if (!employee) {
      failed.push({ id, name: "", reason: "找不到員工" });
      continue;
    }
    if (employee.id === "monitor" || employee.type !== "employee" || employee.status !== 1) {
      failed.push({ id, name: employee.name, reason: "不是在職員工" });
      continue;
    }

    try {
      const ret = await sqlPlugin.newRequest(id, type, start, end, totalTime, reason);
      if (ret == null) {
        failed.push({
          id,
          name: employee.name,
          reason: type === "特休假" ? "特休額度不足" : "無法建立假單"
        });
        continue;
      }
      sqlPlugin.setPermit(ret["num"], 1);
      if (ret["multiple"]) {
        sqlPlugin.setPermit(`${parseInt(ret["num"]) - 1}`, 1);
      }
      success.push({ id, name: employee.name, num: ret["num"] });
    } catch (e) {
      log.logFormat(`Batch leave failed for ${id}: ${String(e)}`);
      failed.push({ id, name: employee.name, reason: "系統錯誤" });
    }
  }

  log.logFormat(`${account} batch requested ${type} for ${success.length} employees, ${failed.length} failed.`);
  res.json({
    status: 200,
    success,
    failed
  });
}

function validTime(time: string): boolean {
  const T = time.split(" ")[1].split(":");
  if (8 <= parseInt(T[0]) && parseInt(T[0]) <= 17) {
    if (T[0] == "08" && T[1] == "00") {
      return false;
    }
    if (T[1] != "00" && T[1] != "30") {
      return false;
    }
    return true;
  }
  return false;
}
