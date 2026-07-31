"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const checkvalid_1 = require("../plugins/checkvalid");
// import { digit } from "../types/types";
function utils(sqlPlugin, log, mailer, res, req) {
    const dataReceived = req.body;
    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie"])) {
        res.sendStatus(400);
        return;
    }
    let ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret["accountType"] == "employee") {
        res.sendStatus(403);
        return;
    }
    res.json({
        "status": 200
    });
}
