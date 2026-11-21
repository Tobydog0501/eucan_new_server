import { Request,Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";
import { canCreate } from "../plugins/account_rules";
import { isRealDate } from "../plugins/clockin_sheet";

/** "0"/"1" or 0/1 -> 0/1; anything else (including arrays) -> null. */
function zeroOrOne(value: unknown): 0 | 1 | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    if (`${value}` === "0") return 0;
    if (`${value}` === "1") return 1;
    return null;
}

module.exports = function utils(sqlPlugin:sql,log:logger,mailer:mailer,req:Request,res:Response):void{
    const dataReceived:{[key:string]:any} = req.body;

    if(!valid(dataReceived,["account","cookie","user","pwd","mail","name","date","mgroup","permit"])){
        res.sendStatus(400);
        return;
    }

    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    const user = dataReceived["user"];
    const password = dataReceived["pwd"];
    const mail = dataReceived["mail"];
    const name = dataReceived["name"];
    const jointime = dataReceived["date"];
    const type = dataReceived["type"] ? dataReceived["type"] : "employee";
    const mgroup = zeroOrOne(dataReceived["mgroup"]);
    // permit: 1 == leave requests need approval
    const permit = zeroOrOne(dataReceived["permit"]);

    const textFields = [account, cookie, user, password, mail, name, jointime, type];
    if (textFields.some((v) => typeof v !== "string" || v.length === 0)) {
        res.sendStatus(400);
        return;
    }
    if (mgroup === null || permit === null || !isRealDate(jointime)) {
        res.sendStatus(400);
        return;
    }

    let ret = sqlPlugin.checkHash(account,cookie);
    // Only admins may create accounts; see account_rules.ts for the rest.
    if (ret==null || ret["accountType"]!="admin"){
        res.sendStatus(403);
        return;
    }
    const decision = canCreate(account, user, type);
    if (!decision.ok) {
        log.logFormat(`${account} was refused creating account ${user}: ${decision.reason}.`);
        res.sendStatus(decision.status);
        return;
    }

    try{
        sqlPlugin.register(user,password,mail,name,type,jointime,mgroup,permit);
        sqlPlugin.init(user);
    }catch(e){
        // Most often the id already exists.
        log.logFormat(`Failed to create account ${user}: ${e instanceof Error ? e.message : String(e)}`);
        res.json({
            "status":200,
            "success":0
        });
        return;
    }
    log.logFormat(`${account} successfully created an account with id: ${user}`);
    mailer.send(mail,"請假系統帳號註冊成功",`${name} 您好，您的請假系統帳號已成功開通\n\n帳號為: ${user}\n密碼為您的身分證字號\n如有任何問題請洽主管\n\n<此信為系統自動發送，請勿回覆>`)
        .catch((e) => log.logFormat(`Failed to send registration mail for ${user}: ${String(e)}`));
    res.json({
        "status":200,
        "success":1
    });
}
