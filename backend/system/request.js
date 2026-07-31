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
        // console.log(req.account);
        const account = dataReceived["account"];
        const cookie = dataReceived["cookie"];
        const type = dataReceived["type"];
        const checkObj = {
            "特休假": "annual",
            "特休假_N": "annual_special",
            "事假": "personal",
            "家庭照顧假": "care",
            "病假": "sick",
            "婚假": "wedding",
            "喪假": "funeral",
            "分娩假": "birth",
            "產檢假": "pcheckup",
            "流產假": "miscarriage",
            "陪產假": "paternity",
            "產假": "maternity",
            "公假": "official",
            "停班停課": "typhoon",
            "其他": "other"
        };
        // data below requires front-end format time into 2024-01-01
        const reason = dataReceived["reason"];
        const start = dataReceived["start"];
        const end = dataReceived["end"];
        if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie", "type", "reason", "start", "end"]) || !Object.keys(checkObj).includes(type)) {
            res.sendStatus(400);
            return;
        }
        if (dataReceived["reason"].replace(/\ /g, "").length == 0) {
            res.sendStatus(400);
            return;
        }
        if (!(validTime(start) && validTime(end))) {
            res.sendStatus(403);
            return;
        }
        const totalTime = yield (0, dayoff_calculate_1.caculateTime)(start, end);
        const permission = sqlPlugin.getPermission(account);
        if (permission === null) {
            res.sendStatus(403);
            return;
        }
        let ret1 = sqlPlugin.checkHash(account, cookie);
        if (ret1 == null) {
            res.sendStatus(403);
            return;
        }
        const ret = yield sqlPlugin.newRequest(account, type, start, end, totalTime, reason);
        if (ret == null) {
            res.sendStatus(403);
            return;
        }
        if (!ret) {
            res.sendStatus(501);
            return;
        }
        if (permission == 0) {
            log.logFormat("此假單無須審核，正在自動通過");
            sqlPlugin.setPermit(ret["num"], 1);
            if (ret["multiple"])
                sqlPlugin.setPermit(`${parseInt(ret["num"]) - 1}`, 1);
            res.send("已成功請假");
        }
        else {
            var man = ["jeff@eucan.com.tw", "catherine@eucan.com.tw"];
            mailer.send(man[ret["mgroup"]], "請假審核要求", `您好，\n員工 ${ret["name"]}於剛才發送請假要求。\n詳細內容請登入請假系統審核。\n\n<此信為系統自動發送，請勿回覆>`);
            res.send("已向主管提出請假申請，請點擊上一頁回到請假頁面");
        }
    });
};
function validTime(time) {
    const T = time.split(" ")[1].split(":");
    // if(0<=date.getHours()<=8)
    if (8 <= parseInt(T[0]) && parseInt(T[0]) <= 17) {
        if (T[0] == '08' && T[1] == "00") {
            return false;
        }
        if (T[1] != "00" && T[1] != "30") {
            return false;
        }
        else {
            return true;
        }
    }
    else {
        return false;
    }
}
