"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const checkvalid_1 = require("../plugins/checkvalid");
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    const dataReceived = req.body;
    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    const year = dataReceived["year"];
    const user = dataReceived["user"];
    if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie", "user", "year"])) {
        res.sendStatus(400);
        return;
    }
    let ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret["accountType"] == "employee") {
        res.sendStatus(403);
        return;
    }
    sqlPlugin.syncTickets(user, year);
    res.json({
        "status": 200
    });
};
