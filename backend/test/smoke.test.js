'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../testlib/harness');

test('server boots against a seeded temp database and answers /', async () => {
  const server = await startServer();
  try {
    assert.equal(await server.alive(), true);
  } finally {
    await server.stop();
  }
});
