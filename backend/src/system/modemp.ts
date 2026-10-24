import { Request, Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";
import { digit } from "../types/types";


module.exports = function utils(sqlPlugin: sql, log: logger, mailer: mailer, req: Request, res: Response): void {
  // modify employee information
  const dataReceived: { [key: string]: any } = req.body;

  const account = dataReceived["account"] as string;
  const cookie = dataReceived["cookie"] as string;
  const user = dataReceived["user"] as string;
  const pwd = dataReceived["pwd"] as string;
  const email = dataReceived["email"] as string;
  const name = dataReceived["name"] as string;
  const joinTime = dataReceived["date"] as string;
  const type = dataReceived["type"] as string;
  const mgroup = dataReceived["mgroup"] as digit;
  const permit = dataReceived["permit"] as digit;
  const status = dataReceived["status"] as digit;
  let leaveDate = dataReceived["leaveDate"] as string | null;

  if (!valid(dataReceived, ["account", "cookie", "user", "pwd", "email", "name", "date", "type", "mgroup", "permit", "status"])) {
    res.sendStatus(400);
    return;
  }

  let ret = sqlPlugin.checkHash(account, cookie);
  if (ret == null || ret["accountType"] != "admin") {
    res.sendStatus(403);
    return;
  }

  if (`${status}` !== "0" && `${status}` !== "1") {
    res.sendStatus(400);
    return;
  }

  if (`${mgroup}` !== "0" && `${mgroup}` !== "1") {
    res.sendStatus(400);
    return;
  }

  if (`${permit}` !== "0" && `${permit}` !== "1") {
    res.sendStatus(400);
    return;
  }

  if (!isValidJoinDate(joinTime)) {
    res.sendStatus(400);
    return;
  }

  if (`${status}` === "0") {
    if (leaveDate == null || leaveDate === "") {
      res.sendStatus(400);
      return;
    }
    if (!isValidLeaveDate(leaveDate)) {
      res.sendStatus(400);
      return;
    }
  } else {
    leaveDate = null;
  }

  sqlPlugin.modifyEmployeeInfo(user, pwd, type, email, name, joinTime, mgroup, permit, status, leaveDate);
  sqlPlugin.resyncEmployeeDayoff(user);

  res.sendStatus(200);
}

function isValidJoinDate(dateString: string): boolean {
  const regex = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const match = dateString.match(regex);

  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const date = new Date(year, month - 1, day);
  date.setFullYear(year);

  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isValidLeaveDate(dateString: string): boolean {
  const regex = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d)$/;
  const match = dateString.match(regex);

  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);

  const date = new Date(year, month - 1, day, hour, minute);
  date.setFullYear(year);

  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
  );
}

