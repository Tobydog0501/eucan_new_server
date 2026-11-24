import { Request,Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";

module.exports = function utils(sqlPlugin:sql,log:logger,mailer:mailer,req:Request,res:Response):void{
    const dataReceived:{[key:string]:any} = req.body;

    if(!valid(dataReceived,["account","cookie","num","permit"])){
        res.sendStatus(400);
        return;
    }

    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    const num = dataReceived["num"];
    const permitRaw = dataReceived["permit"];

    if (typeof account !== "string" || typeof cookie !== "string") {
        res.sendStatus(400);
        return;
    }
    if (!((typeof num === "string" || typeof num === "number") && /^\d{1,12}$/.test(`${num}`))) {
        res.sendStatus(400);
        return;
    }
    if (![0, 1, true, false, "0", "1"].includes(permitRaw)) {
        res.sendStatus(400);
        return;
    }
    const permit = permitRaw === 1 || permitRaw === true || permitRaw === "1";

    let ret = sqlPlugin.checkHash(account,cookie);
    // Only admins may approve or reject leave requests.
    if (ret==null || ret["accountType"]!="admin"){
        res.sendStatus(403);
        return;
    }

    const ticket = sqlPlugin.getTicket(`${num}`);
    if (ticket == null) {
        res.sendStatus(404);
        return;
    }
    // Deciding a ticket twice would add its hours to the leave balance again.
    if (`${ticket["state"]}` !== "0") {
        res.sendStatus(409);
        return;
    }

    const mail = sqlPlugin.setPermit(`${num}`,(permit)?1:-1);
    log.logFormat(`${account} set ticket #${num} to ${permit ? "accepted" : "rejected"}.`);
    mailer.send(mail,`假單審核結果${(permit)?"通過":"未通過"}`,`您好，\n您的主管於剛才${permit?"批准":"拒絕"}了您的假單。\n如有任何問題請私訊主管。\n\n<此信為系統自動發送，請勿回覆>`)
        .catch((e) => log.logFormat(`Failed to send permit mail for ticket #${num}: ${String(e)}`));
    res.json({
        "status":200
    });
}
