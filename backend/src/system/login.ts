import { Request,Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";
import dotenv from "dotenv";
dotenv.config();

// Remote validator for root's one-time code. Overridable for tests only.
const TOTP_VALIDATE_URL = process.env.TOTP_VALIDATE_URL || "https://www.authenticatorApi.com/Validate.aspx";
const TOTP_TIMEOUT_MS = 10000;

async function validateTwoFA(pin: string, log: logger): Promise<boolean> {
    const url = `${TOTP_VALIDATE_URL}?Pin=${encodeURIComponent(pin)}&SecretCode=${encodeURIComponent(`${process.env.SECRET}`)}`;
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(TOTP_TIMEOUT_MS) });
        const body = await resp.text();
        return body == "True";
    } catch (e) {
        log.logFormat(`2FA validation request failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

module.exports = async function utils(sqlPlugin:sql,log:logger,mailer:mailer,req:Request,res:Response):Promise<void>{
    const dataReceived:{[key:string]:any} = req.body;

    const account = dataReceived["account"] as string;
    const password = dataReceived["pwd"] as string;
    const cookie = dataReceived["cookie"] as string;
    const twoFA = dataReceived["twoFA"];

    if(!valid(dataReceived,["account","pwd"])){
        res.sendStatus(400);
        return;
      }

    if(cookie==null && (account==null || password==null)){
        log.logFormat(`Someone tried to login but was lack of info.`);
        res.sendStatus(403);
        return;
    }

    const sessionCookie = (typeof cookie === "string" && cookie) ? cookie : "NULL";

    if(account=='root'){
        // Check both factors before login() issues or refreshes a session, so a
        // failed second factor leaves root's existing session untouched.
        if(!(typeof twoFA === "string" || typeof twoFA === "number") || !/^\d{6,8}$/.test(`${twoFA}`)){
            res.sendStatus(400);
            return;
        }
        if(!(await sqlPlugin.credentialsValid(account, password, sessionCookie))){
            res.sendStatus(403);
            return;
        }
        if(!(await validateTwoFA(`${twoFA}`, log))){
            res.sendStatus(403);
            return;
        }
    }

    let ret = await sqlPlugin.login(account,password,sessionCookie);
    if(ret.msg=="success"){
        res.json(ret);
    }else{
        res.sendStatus(403);
    }
}
