"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const checkvalid_1 = require("../plugins/checkvalid");
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    const dataReceived = req.body;
    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    const user = dataReceived["user"];
    const year = dataReceived["year"];
    const data = dataReceived["data"];
    if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie", "user", "data", "year"]) && typeof data != "object") {
        res.sendStatus(400);
        return;
    }
    let ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret["accountType"] == "employee") {
        res.sendStatus(403);
        return;
    }
    // console.log(data)
    sqlPlugin.modify(user, year, data);
    res.sendStatus(200);
};
