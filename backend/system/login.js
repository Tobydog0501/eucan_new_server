"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const checkvalid_1 = require("../plugins/checkvalid");
const request_1 = __importDefault(require("request"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    const dataReceived = req.body;
    const account = dataReceived["account"];
    const password = dataReceived["pwd"];
    const cookie = dataReceived["cookie"];
    const twoFA = dataReceived["twoFA"];
    if (!(0, checkvalid_1.valid)(dataReceived, ["account", "pwd"])) {
        res.sendStatus(400);
        return;
    }
    if (cookie == null && (account == null || password == null)) {
        log.logFormat(`Someone tried to login but was lack of info.`);
        res.sendStatus(403);
        return;
    }
    let ret = sqlPlugin.login(account, password, cookie ? cookie : "NULL");
    if (ret.msg == "success") {
        // log.logFormat(`${account} logged in successfully.`);
        if (account == 'root') {
            if (isNaN(parseInt(twoFA))) {
                res.sendStatus(400);
                return;
            }
            request_1.default.get(`https://www.authenticatorApi.com/Validate.aspx?Pin=${twoFA}&SecretCode=${process.env.SECRET}`, (err, resp, body) => {
                // console.log(body)
                if (body == "True") {
                    res.json(ret);
                }
                else {
                    res.sendStatus(403);
                }
            });
        }
        else {
            res.json(ret);
        }
    }
    else {
        res.sendStatus(403);
    }
};
