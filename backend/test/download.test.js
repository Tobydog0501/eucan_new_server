'use strict';

// The res.download() callback runs outside the route's try/catch. If it answers
// after the headers went out it throws ERR_HTTP_HEADERS_SENT and the process dies.

const test = require('node:test');
const assert = require('node:assert');
const { inWorkdir } = require('../testlib/harness');

function fakeRes(headersSent) {
  const calls = [];
  return {
    calls,
    headersSent,
    sendStatus(code) {
      if (this.headersSent) {
        const err = new Error('Cannot set headers after they are sent to the client');
        err.code = 'ERR_HTTP_HEADERS_SENT';
        throw err;
      }
      calls.push(code);
      return this;
    },
  };
}

test('onDownloadDone: answers 500 only while the response is untouched', async () => {
  await inWorkdir(({ load }) => {
    const { onDownloadDone } = load('plugins/http_util.js');
    const lines = [];
    const log = { logFormat: (line) => lines.push(line) };

    const fresh = fakeRes(false);
    onDownloadDone(fresh, log, 'calendar file')(new Error('ENOENT'));
    assert.deepEqual(fresh.calls, [500]);

    const midStream = fakeRes(true);
    assert.doesNotThrow(() => onDownloadDone(midStream, log, 'calendar file')(new Error('ECONNABORTED')));
    assert.deepEqual(midStream.calls, []);

    const ok = fakeRes(false);
    onDownloadDone(ok, log, 'calendar file')(undefined);
    assert.deepEqual(ok.calls, []);

    assert.equal(lines.length, 2);
  });
});
