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
// const calen = require("../plugins/dayoff_calendar");
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const dataReceived = req.body;
        const account = dataReceived["account"];
        const cookie = dataReceived["cookie"];
        const year = dataReceived["year"];
        const month = dataReceived["month"];
        if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie", "year", "month"])) {
            res.sendStatus(400);
            return;
        }
        let ret = sqlPlugin.checkHash(account, cookie);
        if (ret == null || ret["accountType"] == "employee") {
            res.sendStatus(403);
            return;
        }
        log.logFormat(`${account} is requesting a calendar.`);
        try {
            yield (0, dayoff_calendar_1.main)(parseInt(`${year}`), parseInt(`${month}`), sqlPlugin);
            log.logFormat(`Calendar has generated. Sending File /app/calendars/${year}-${month}calendar.xlsx...`);
            res.sendStatus(200);
        }
        catch (e) {
            log.logFormat(`Failed to generate calendar /app/calendars/${year}-${month}calendar.xlsx: ${String(e)}`);
            res.sendStatus(500);
        }
        // res.download(`/app/calendars/${year}-${month}calendar.xlsx`,`${year}-${month}calendar.xlsx`);
    });
};
