"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const checkvalid_1 = require("../plugins/checkvalid");
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    const dataReceived = req.body;
    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    const user = dataReceived["user"] ? dataReceived["user"] : account;
    const year = dataReceived["year"];
    if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie", "year"])) {
        res.sendStatus(400);
        return;
    }
    let ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || (dataReceived["user"] && ret["accountType"] == "employee")) {
        res.sendStatus(403);
        return;
    }
    const dayoffdata = sqlPlugin.getEmployeeDayOffList(user, year.toString());
    if (dayoffdata) {
        res.json(dayoffdata);
    }
    else {
        res.sendStatus(500);
    }
    // res.sendStatus(403);
};
