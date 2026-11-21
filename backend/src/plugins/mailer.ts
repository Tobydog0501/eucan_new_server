// import SMTPPool,{Options} from 'nodemailer/lib/smtp-pool';
import nodemailer,{Transporter} from 'nodemailer';
import dotenv from 'dotenv';
import SMTPTransport from 'nodemailer/lib/smtp-transport';
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
 * This overrides every other mail switch, including MISSED_PUNCH_MAIL_ENABLED.
 */
export function mailDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.MAIL_DISABLED === "1";
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
        var message = {
            from: `"祐肯企業請假系統訊息" <${process.env.USER_MAIL}>`, // listed in rfc822 message header
            to: `${mail}`, // listed in rfc822 message header
            subject: title,
            text: text,
        };
        const ret = await this.transporter.sendMail(message);
        return new Promise(res=>{res(ret)});
    }

}