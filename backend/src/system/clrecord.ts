import { Request,Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";
import { writeClockinMaster } from "../plugins/clockin_archive";
import { digit } from "../types/types";

module.exports = async function utils(sqlPlugin:sql,log:logger,mailer:mailer,req:Request,res:Response):Promise<void>{
    const dataReceived:{[key:string]:any} = req.body;

    const account = dataReceived["account"] as string;
    const cookie = dataReceived["cookie"] as string;
    if(!valid(dataReceived,["account","cookie","year","month"])){
        res.sendStatus(400);
        return;
    }
    const year = dataReceived["year"] as digit;
    if (!/^\d{4}$/.test(`${year}`) || !/^(0?[1-9]|1[0-2])$/.test(`${dataReceived["month"]}`)) {
        res.sendStatus(400);
        return;
    }
    const month = `${dataReceived["month"]}`.padStart(2,'0');
    
    let ret = sqlPlugin.checkHash(account,cookie);
    if (ret==null||ret["accountType"]=="employee"){
        res.sendStatus(403);
        return;
    }

    try {
        const pdfPath = await writeClockinMaster(sqlPlugin, year, month);
        log.logFormat(`Generated clockin record ${pdfPath}`);
        res.sendStatus(200);
    } catch (e) {
        log.logFormat(`Failed to generate clockin record ${process.cwd()}/clock/${year}-${month}clockin_record.pdf: ${String(e)}`);
        res.sendStatus(500);
    }
}