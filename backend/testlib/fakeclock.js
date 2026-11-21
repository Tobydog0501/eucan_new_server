// Preload for the backend under test: moves the process clock to FAKE_NOW
// (any Date.parse-able string, e.g. 2026-06-03T09:05:00+08:00) and lets it
// keep ticking from there. Used for routes that read the wall clock, such as
// clock-in. Load it with NODE_OPTIONS=--require=<this file>.
//
// Function-based rather than a subclass so that `Date()` called without `new`
// (the backend's logger does this) keeps working.
'use strict';

if (process.env.FAKE_NOW) {
  const RealDate = Date;
  const target = RealDate.parse(process.env.FAKE_NOW);
  if (Number.isNaN(target)) throw new Error(`FAKE_NOW is not a date: ${process.env.FAKE_NOW}`);
  const offset = target - RealDate.now();
  function FakeDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString();
    return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + offset);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => RealDate.now() + offset;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  global.Date = FakeDate;
}
