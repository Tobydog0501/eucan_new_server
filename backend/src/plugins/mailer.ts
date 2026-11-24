// import SMTPPool,{Options} from 'nodemailer/lib/smtp-pool';
import nodemailer,{Transporter} from 'nodemailer';
import dotenv from 'dotenv';
import SMTPTransport from 'nodemailer/lib/smtp-transport';
import { filterRecipients, prefixedSubject } from './mail_policy';
// import SMTPConnection from 'nodemailer/lib/smtp-connection';
// const dotenv = require('dotenv');
dotenv.config();

/** SMTP port; 25 unless SMTP_PORT is set (used by tests to avoid a privileged port). */
function smtpPort(): number {
    const port = parseInt(process.env.SMTP_PORT || "", 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 25;
}

/**
 * MAIL_DISABLED=1 (test sites): never open an SMTP connection or send mail.
 * This overrides every other mail switch, including the 未打卡通知信 feature.
 */
export function mailDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.MAIL_DISABLED === "1";
}

/** 未打卡通知信主旨。 */
export const MISSED_PUNCH_SUBJECT = '祐肯企業上下班未打卡系統通知';

/** "2026-03-02" -> "2026年03月02日" */
export function noticeDateText(date: string): string {
    const [year, month, day] = date.split('-');
    return `${year}年${month}月${day}日`;
}

/** 未打卡通知信內文：固定文字填入姓名與日期，信末附補打卡申請頁連結。 */
export function missedPunchBody(name: string, date: string, link: string): string {
    return [
        `員工 ${name}您好：`,
        `經系統查核，發現您於 ${noticeDateText(date)} 有未打卡紀錄，請確認當日出勤狀況。`,
        '如因忘記打卡、系統異常或其他特殊原因而未完成打卡，請儘速填寫補打卡申請，並註明實際上班或下班時間及未打卡原因，由人資單位協助辦理補打卡作業。',
        '請同仁確實落實每日上下班打卡，以維護出勤紀錄之正確性。',
        '感謝您的配合！',
        '<此信為系統自動發送，請勿回覆>',
        '',
        `補打卡申請頁：${link}`,
    ].join('\n');
}

export class mailer{
    private option:SMTPTransport.Options;
    private transporter:Transporter

    public constructor(){
        /**
         * @type {nodemailer.Transporter}
         */
        this.option = {
            // "biz-mx2-6.hinet.net"
            host: process.env.SMTP_SERVER,
            // pool: true,
            port: smtpPort(),
            secure: false,
            auth: {
                user: process.env.USER_MAIL,
                pass: process.env.USER_PWD,
            },
            tls: {rejectUnauthorized: false}
        }
        this.transporter = nodemailer.createTransport(this.option);
    }

    verify():boolean{
        var ret:boolean = false;
        if (mailDisabled()) {
            console.log("Mailer disabled (MAIL_DISABLED=1); no SMTP connection is made.");
            return true;
        }
        this.transporter.verify(function (error, success) {
            if (error) {
                console.error(error);
                ret = false;
            } else {
                console.log("Server is ready to take our messages");
                ret = true;
            }
        });
        return ret;
    }

    relogin(){
        /**
         * @type {nodemailer.Transporter}
         */
        this.option = {
            host: process.env.SMTP_SERVER,
            port: smtpPort(),
            secure: false,
            auth: {
                user: process.env.USER_MAIL,
                pass: process.env.USER_PWD,
            },
            tls: {
                rejectUnauthorized: false
            }
        }
        this.transporter = nodemailer.createTransport(this.option);
    }

    async send(mail:string,title:string,text:string):Promise<any>{
        if (mailDisabled()) {
            console.log(`[MAIL_DISABLED] not sent: subject="${title}"`);
            return { disabled: true };
        }
        // Test sites deliver only to MAIL_ALLOWED_RECIPIENTS (see mail_policy.ts).
        // Dropped recipients are logged by count only, never by address.
        const recipients = filterRecipients(`${mail}`);
        if (recipients.dropped > 0) {
            console.log(`[MAIL_ALLOWLIST] dropped ${recipients.dropped} recipient(s) not on the allowlist`);
        }
        if (recipients.allowed.length === 0) {
            return { blocked: true, dropped: recipients.dropped };
        }
        var message = {
            from: `"祐肯企業請假系統訊息" <${process.env.USER_MAIL}>`, // listed in rfc822 message header
            to: recipients.restricted ? recipients.allowed.join(", ") : `${mail}`, // listed in rfc822 message header
            subject: prefixedSubject(title),
            text: text,
        };
        const ret = await this.transporter.sendMail(message);
        return new Promise(res=>{res(ret)});
    }

    /**
     * 寄未打卡通知信給一位員工。date 為 "YYYY-MM-DD"，link 為補打卡申請頁網址。
     * 經由 send()，所以 MAIL_DISABLED 與測試站收件者白名單一樣有效。
     */
    async sendMissedPunchNotice(mail:string,name:string,date:string,link:string):Promise<any>{
        return this.send(mail, MISSED_PUNCH_SUBJECT, missedPunchBody(name, date, link));
    }

}