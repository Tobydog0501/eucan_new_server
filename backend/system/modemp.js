"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const checkvalid_1 = require("../plugins/checkvalid");
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    // modify employee information
    const dataReceived = req.body;
    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    const user = dataReceived["user"];
    const pwd = dataReceived["pwd"];
    const email = dataReceived["email"];
    const name = dataReceived["name"];
    const joinTime = dataReceived["date"];
    const type = dataReceived["type"];
    const mgroup = dataReceived["mgroup"];
    const permit = dataReceived["permit"];
    const status = dataReceived["status"];
    let leaveDate = dataReceived["leaveDate"];
    if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie", "user", "pwd", "email", "name", "date", "type", "mgroup", "permit", "status"])) {
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
    }
    else {
        leaveDate = null;
    }
    sqlPlugin.modifyEmployeeInfo(user, pwd, type, email, name, joinTime, mgroup, permit, status, leaveDate);
    sqlPlugin.resyncEmployeeDayoff(user);
    res.sendStatus(200);
};
function isValidJoinDate(dateString) {
    const regex = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    const match = dateString.match(regex);
    if (!match)
        return false;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const date = new Date(year, month - 1, day);
    date.setFullYear(year);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
function isValidLeaveDate(dateString) {
    const regex = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d)$/;
    const match = dateString.match(regex);
    if (!match)
        return false;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const hour = parseInt(match[4], 10);
    const minute = parseInt(match[5], 10);
    const date = new Date(year, month - 1, day, hour, minute);
    date.setFullYear(year);
    return (date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day &&
        date.getHours() === hour &&
        date.getMinutes() === minute);
}
