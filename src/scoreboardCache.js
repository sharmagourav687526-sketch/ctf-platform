'use strict';

// In-memory scoreboard cache. Recomputing the full scoreboard on every request
// is fine for small events but kills SQLite under load. 30-second TTL is short
// enough that scores feel live, long enough to absorb a scoreboard spike.
const TTL = 30_000;

let _cache = null;
let _ts = 0;
let _key = '';

function get(db, mode, computeFn, cutoff = null) {
  const key = `${mode}:${cutoff || 0}`;
  if (_cache && key === _key && Date.now() - _ts < TTL) return _cache;
  _cache = computeFn(db, mode, cutoff);
  _ts = Date.now();
  _key = key;
  return _cache;
}

function invalidate() {
  _cache = null;
  _ts = 0;
}

module.exports = { get, invalidate };
