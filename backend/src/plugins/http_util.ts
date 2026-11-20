import { Response } from "express";
import logger from "./logger";

/**
 * Callback for res.download()/res.sendFile(). It runs outside the route's
 * try/catch, possibly after the headers (and part of the body) have gone out,
 * e.g. when the client disconnects mid-download. Answering again at that point
 * throws ERR_HTTP_HEADERS_SENT and would take the process down, so only send
 * a 500 while the response is still untouched.
 */
export function onDownloadDone(res: Pick<Response, "headersSent" | "sendStatus">, log: Pick<logger, "logFormat">, label: string): (err?: Error) => void {
  return (err?: Error) => {
    if (!err) {
      return;
    }
    log.logFormat(`Failed to send ${label}: ${String(err)}`);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  };
}
