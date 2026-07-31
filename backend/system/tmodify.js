"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const checkvalid_1 = require("../plugins/checkvalid");
const dayoff_calculate_1 = require("../plugins/dayoff_calculate");
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const dataReceived = req.body;
        const account = dataReceived["account"];
        const cookie = dataReceived["cookie"];
        // const user = dataReceived["user"] as string;
        const action = dataReceived["action"];
        const num = dataReceived["serialnum"];
        const state = dataReceived["state"];
        const type = dataReceived["type"];
        const reason = dataReceived["reason"];
        // data below requires front-end format time into 2024-01-01
        const start = dataReceived["start"];
        const end = dataReceived["end"];
        if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie", "serialnum", "state", "action", "type", "start", "end", "reason"])) {
            console.log("tmodify invalid data");
            res.sendStatus(400);
            return;
        }
        let ret = sqlPlugin.checkHash(account, cookie);
        if (ret == null || ret["accountType"] == "employee") {
            res.sendStatus(403);
            return;
        }
        const totalTime = yield (0, dayoff_calculate_1.caculateTime)(start, end);
        const result = sqlPlugin.modifyTicket(num.toString(), parseInt(`${action}`), type, start, end, totalTime, state, reason);
        if (result === null) {
            res.sendStatus(403);
            return;
        }
        res.json({
            "status": 200
        });
    });
};
