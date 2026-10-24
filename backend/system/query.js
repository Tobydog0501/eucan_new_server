"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const checkvalid_1 = require("../plugins/checkvalid");
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    const dataReceived = req.body;
    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie"])) {
        res.sendStatus(400);
        return;
    }
    let ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null) {
        res.sendStatus(403);
        return;
    }
    const retu = sqlPlugin.showQuery(account, 0);
    res.send({ "data": retu });
};
