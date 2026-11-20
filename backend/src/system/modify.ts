import { Request,Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";

module.exports = function utils(sqlPlugin:sql,log:logger,mailer:mailer,req:Request,res:Response):void{
    const dataReceived:{[key:string]:any} = req.body;

    if(!valid(dataReceived,["account","cookie","user","data","year"])){
        res.sendStatus(400);
        return;
    }

    const account = dataReceived["account"];
    const cookie = dataReceived["cookie"];
    const user = dataReceived["user"];
    const year = dataReceived["year"];
    const data = dataReceived["data"];

    if (typeof account !== "string" || typeof cookie !== "string" || typeof user !== "string" || user.length === 0) {
        res.sendStatus(400);
        return;
    }
    if (!((typeof year === "string" || typeof year === "number") && /^\d{4}$/.test(`${year}`))) {
        res.sendStatus(400);
        return;
    }
    // data: { <column or leave-type name>: <hours> }, a plain object of finite, non-negative numbers.
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        res.sendStatus(400);
        return;
    }
    const entries = Object.entries(data as { [key: string]: unknown });
    if (entries.length === 0 || entries.some(([, v]) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
        res.sendStatus(400);
        return;
    }

    let ret = sqlPlugin.checkHash(account,cookie);
    if (ret==null||ret["accountType"]=="employee"){
        res.sendStatus(403);
        return;
    }

    const changes = sqlPlugin.modify(user, `${year}`, data as { [key: string]: number });
    if (changes === null) {
        // At least one key is not a known leave column.
        res.sendStatus(400);
        return;
    }
    if (changes === 0) {
        res.sendStatus(404);
        return;
    }
    log.logFormat(`${account} overwrote leave usage of ${user} for ${year}.`);
    res.sendStatus(200);
}
