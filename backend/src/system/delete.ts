import { Request,Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";
import { canDelete } from "../plugins/account_rules";


module.exports = function utils(sqlPlugin:sql,log:logger,mailer:mailer,req:Request,res:Response):void{
    const dataReceived:{[key:string]:any} = req.body;
    const account = dataReceived["account"] as string;
    const cookie = dataReceived["cookie"] as string;
    const user = dataReceived["user"] as string;

    if(!valid(dataReceived,["account","cookie","user"])){
      res.sendStatus(400);
      return;
    }
    if (typeof account !== "string" || typeof cookie !== "string" || typeof user !== "string" || user.length === 0) {
      res.sendStatus(400);
      return;
    }
    let ret = sqlPlugin.checkHash(account,cookie);
    if (ret==null||ret["accountType"]!="admin"){
      res.sendStatus(403);
      return;
    }
    const target = sqlPlugin.getUser(user);
    if (target == null) {
      res.sendStatus(404);
      return;
    }
    const decision = canDelete(account, { id: target.id, type: target.type });
    if (!decision.ok) {
      log.logFormat(`${account} was refused deleting account ${user}: ${decision.reason}.`);
      res.sendStatus(decision.status);
      return;
    }
    sqlPlugin.deleteAccount(user);
    log.logFormat(`${account} deleted account ${user}.`);
    res.sendStatus(200); 
}