import { Request,Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";

const MAX_LIMIT = 1000;

/**
 * Normalise an optional scalar filter. Returns "" when absent, the trimmed
 * string when it is a string/number, or null when the type is not allowed.
 */
function optionalText(value: unknown): string | null {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
}

module.exports = function utils(sqlPlugin:sql,log:logger,mailer:mailer,req:Request,res:Response):void{
    const dataReceived:{[key:string]:any} = req.body;

    if(!valid(dataReceived,["account","cookie"])){
        res.sendStatus(400);
        return;
    }

    const account = dataReceived["account"] as string;
    const cookie = dataReceived["cookie"] as string;
    const user = optionalText(dataReceived["user"]);
    const year = optionalText(dataReceived["year"]);
    const month = optionalText(dataReceived["month"]);
    const limitText = optionalText(dataReceived["limit"]);

    if (user === null || year === null || month === null || limitText === null) {
        res.sendStatus(400);
        return;
    }
    if ((year && !/^\d{1,4}$/.test(year)) || (month && !/^(0?[1-9]|1[0-2])$/.test(month)) || (limitText && !/^[1-9]\d{0,3}$/.test(limitText))) {
        res.sendStatus(400);
        return;
    }
    const limit = limitText ? Math.min(parseInt(limitText, 10), MAX_LIMIT) : 0;

    let ret = sqlPlugin.checkHash(account,cookie);
    // Lists every employee's tickets: admin pages only.
    if (ret==null||ret["accountType"]!="admin"){
        res.sendStatus(403);
        return;
    }
    const retu = sqlPlugin.showQuery(1, { id: user, year, month, limit });
    res.send({"data":retu});
}
