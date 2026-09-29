'use strict';

// In-memory scoreboard cache. Recomputing the full scoreboard on every request
// is fine for small events but kills SQLite under load. 30-second TTL is short
// enough that scores feel live, long enough to absorb a scoreboard spike.
const TTL = 30_000;

let _cache = null;
let _ts = 0;
let _mode = '';

function get(db, mode, computeFn) {
  if (_cache && mode === _mode && Date.now() - _ts < TTL) return _cache;
  _cache = computeFn(db, mode);
  _ts = Date.now();
  _mode = mode;
  return _cache;
}

function invalidate() {
  _cache = null;
  _ts = 0;
}

module.exports = { get, invalidate };
