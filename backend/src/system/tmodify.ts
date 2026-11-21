import { Request,Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";
import { caculateTime } from "../plugins/dayoff_calculate";
import { isLeaveType } from "../plugins/leave_types";
import { normalizeLeaveTime, validRange } from "../plugins/leave_input";


module.exports = async function utils(sqlPlugin:sql,log:logger,mailer:mailer,req:Request,res:Response):Promise<void>{
    const dataReceived:{[key:string]:any} = req.body;

    if(!valid(dataReceived,["account","cookie","serialnum","state","action","type","start","end","reason"])){
        res.sendStatus(400);
        return;
    }

    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    const actionRaw = dataReceived["action"];
    const num = dataReceived["serialnum"];
    const stateRaw = dataReceived["state"];
    const type = dataReceived["type"];
    const reason = dataReceived["reason"];
    // "YYYY-MM-DD HH:MM"
    const start = dataReceived["start"];
    const end = dataReceived["end"];

    if (typeof account !== "string" || typeof cookie !== "string") {
        res.sendStatus(400);
        return;
    }
    if (!((typeof num === "string" || typeof num === "number") && /^\d{1,12}$/.test(`${num}`))) {
        res.sendStatus(400);
        return;
    }
    if (!["0", "1"].includes(`${typeof actionRaw === "object" ? "" : actionRaw}`) || !["-1", "0", "1"].includes(`${typeof stateRaw === "object" ? "" : stateRaw}`)) {
        res.sendStatus(400);
        return;
    }
    const action = parseInt(`${actionRaw}`, 10);
    const state = parseInt(`${stateRaw}`, 10);

    let ret = sqlPlugin.checkHash(account,cookie);
    if (ret==null||ret["accountType"]=="employee"){
        res.sendStatus(403);
        return;
    }

    if (sqlPlugin.getTicket(`${num}`) === null) {
        res.sendStatus(404);
        return;
    }

    // Deleting only needs the serial number; the other fields are echoed back
    // from the stored ticket by the page and are not used.
    // Stored as "YYYY-MM-DD HH:MM", the same form /request writes via strftime().
    let startText = "";
    let endText = "";
    if (action === 1) {
        const startNorm = normalizeLeaveTime(start);
        const endNorm = normalizeLeaveTime(end);
        if (!isLeaveType(type) || typeof reason !== "string" || startNorm === null || endNorm === null) {
            res.sendStatus(400);
            return;
        }
        if (!validRange(startNorm, endNorm).ok) {
            res.sendStatus(400);
            return;
        }
        startText = startNorm;
        endText = endNorm;
    }

    const totalTime = action === 1 ? await caculateTime(startText, endText) : 0;
    const result = sqlPlugin.modifyTicket(`${num}`, action, `${type}`, startText, endText, totalTime, state, `${reason}`);
    if(result===null){
        res.sendStatus(403);
        return;
    }
    res.json({
        "status":200
    });
}
