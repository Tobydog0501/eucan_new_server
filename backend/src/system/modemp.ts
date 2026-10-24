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
  const name = dataReceived["name"] as string;
  const status = dataReceived["status"] as digit;
  const leaveDate = dataReceived["leaveDate"] as string;

  if (!valid(dataReceived, ["account", "cookie", "user", "name", "status"])) {
    res.sendStatus(400);
    return;
  }

  let ret = sqlPlugin.checkHash(account, cookie);
  if (ret == null || ret["accountType"] != "admin") {
    res.sendStatus(403);
    return;
  }

  if (`${status}` != "0" || `${status}` != "1") {
    res.sendStatus(400);
    return;
  }
  if (leaveDate != "null" && !isValidDate(leaveDate)) {
    res.sendStatus(400);
    return;
  }

  sqlPlugin.modifyEmployeeInfo(user, name, status, leaveDate);

  res.sendStatus(200);
}

function isValidDate(dateString: string): boolean {
  // 1. Strict Regex to check the format: YYYY-MM-DD HH:mm
  const regex = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d)$/;
  const match = dateString.match(regex);

  if (!match) return false; // Fails format check

  // Extract parts from the regex match
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);

  // 2. Semantic validation to catch invalid dates (e.g., Feb 30)
  const date = new Date(year, month - 1, day, hour, minute);
  date.setFullYear(year); // Fixes JS edge case where years 0-99 map to 1900-1999

  // JS Date will automatically roll over invalid dates (e.g., Feb 30 -> March 2).
  // If the extracted parts match the parsed Date parts, the date is valid!
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
  );
}

