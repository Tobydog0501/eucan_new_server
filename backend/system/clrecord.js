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
const clockin_excel_1 = require("../plugins/clockin_excel");
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const dataReceived = req.body;
        const account = dataReceived["account"];
        const cookie = dataReceived["cookie"];
        const year = dataReceived["year"];
        const month = dataReceived["month"].toString().padStart(2, '0');
        if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie", "year", "month"])) {
            res.sendStatus(400);
            return;
        }
        let ret = sqlPlugin.checkHash(account, cookie);
        if (ret == null || ret["accountType"] == "employee") {
            res.sendStatus(403);
            return;
        }
        const data = yield sqlPlugin.clockinRecord(year, month);
        yield (0, clockin_excel_1.output_excel)(data, year, month);
        res.sendStatus(200);
        // res.sendFile(`/app/clock/${year}-${month}clockin_record.xlsx`, (err) => {
        //     if (err) {
        //         log.logFormat(`Error sending file /app/clock/${year}-${month}clockin_record.xlsx` + err);
        //         res.sendStatus(500);
        //     }
        // });
    });
};
