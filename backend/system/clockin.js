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
const dayoff_calendar_1 = require("../plugins/dayoff_calendar");
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const dataReceived = req.body;
        const account = dataReceived["account"];
        const cookie = dataReceived["cookie"];
        const day = dataReceived["day"];
        /*
            Type can be these values:
            0: no specfic, enter searching mode
            1: clock in
            -1: clock out
        */
        const type = dataReceived["type"];
        if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie", "type"])) {
            res.sendStatus(400);
            return;
        }
        let ret = sqlPlugin.checkHash(account, cookie);
        if (ret == null) {
            res.sendStatus(403);
            return;
        }
        var date = (`${type}` == "0" && day) ? new Date(day) : new Date();
        if (type != 0) {
            let wk = (yield (0, dayoff_calendar_1.check_working_day)(date.getFullYear(), (date.getMonth() + 1).toString(), date.getDate().toString()))["status"];
            if ((date.getHours() <= 8 && date.getMinutes() < 30) || wk == 1) {
                // log.logFormat(`Current time is not allowed to clock-in or clock-out. Current time: ${date.getHours()}:${date.getMinutes()}. Working status: ${wk}`);
                res.sendStatus(403);
                return;
            }
        }
        // date.setDate(date.getHours() + 8);
        log.logFormat(`${account} tries to ${type == 0 ? "lookup clocking history" : type == 1 ? "clock-in" : "clock-out"}.`);
        const returns = sqlPlugin.clockinAction(account, parseInt(`${type}`), date);
        res.json(returns);
    });
};
