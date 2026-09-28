'use strict';

const crypto = require('crypto');

const MAX_FLAG_LENGTH = 500;

function digest(s) {
  return crypto.createHash('sha256').update(s).digest();
}

/**
 * Check a submission against a challenge's flags. Static flags are compared through
 * fixed-length digests with timingSafeEqual so response time doesn't leak prefix matches.
 */
function checkFlag(flags, submitted) {
  if (typeof submitted !== 'string' || submitted.length === 0 || submitted.length > MAX_FLAG_LENGTH) return false;
  const value = submitted.trim();
  for (const flag of flags) {
    if (flag.type === 'regex') {
      try {
        if (new RegExp(`^(?:${flag.content})$`, flag.case_sensitive ? '' : 'i').test(value)) return true;
      } catch {
        // Invalid admin-supplied pattern: never matches.
      }
    } else {
      const a = flag.case_sensitive ? value : value.toLowerCase();
      const b = flag.case_sensitive ? flag.content : flag.content.toLowerCase();
      if (crypto.timingSafeEqual(digest(a), digest(b))) return true;
    }
  }
  return false;
}

module.exports = { checkFlag, MAX_FLAG_LENGTH };
