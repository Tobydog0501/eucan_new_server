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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const checkvalid_1 = require("../plugins/checkvalid");
const fs_1 = __importDefault(require("fs"));
const dayoff_reader_1 = require("../plugins/dayoff_reader");
// import { digit } from "../types/types";
module.exports = function utils(sqlPlugin, log, mailer, req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const dataReceived = req.body;
        const account = dataReceived["account"];
        const cookie = dataReceived["cookie"];
        if (!(0, checkvalid_1.valid)(dataReceived, ["account", "cookie"])) {
            res.sendStatus(400);
            return;
        }
        let ret = sqlPlugin.checkHash(account, cookie);
        if (ret == null) {
            res.sendStatus(403);
            return;
        }
        log.logFormat(`${account} is requesting a working day json file.`);
        var rocYear = req.url.replace("/api/", "");
        if (parseInt(rocYear) > 1911) {
            rocYear = (parseInt(rocYear) - 1911).toString();
        }
        const filePath = `./api/office_calendar_${rocYear}.json`;
        if (!fs_1.default.existsSync(filePath)) {
            log.logFormat("Can't find file.");
            yield (0, dayoff_reader_1.downloadJSON)(rocYear);
        }
        const data = require(`../api/office_calendar_${rocYear}.json`);
        res.json(data);
    });
};
