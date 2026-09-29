'use strict';

const crypto = require('crypto');

const MAX_FLAG_LENGTH = 500;

function digest(s) {
  return crypto.createHash('sha256').update(s).digest();
}

/**
 * Generate the per-user dynamic flag for a challenge.
 * Format: {content}{hex(HMAC-SHA256(secret, "userId:challengeId")[:16])}
 * content is the prefix stored in the flags row (e.g. "CTF{").
 */
function generateDynamicFlag(secret, prefix, userId, challengeId) {
  const hmac = crypto.createHmac('sha256', secret)
    .update(`${userId}:${challengeId}`)
    .digest('hex')
    .slice(0, 32);
  const pfx = (prefix || 'CTF{').replace(/\}$/, '');
  return `${pfx}${hmac}}`;
}

/**
 * Check a submission against a challenge's flags.
 * opts: { dynamicFlagSecret, userId, challengeId } — required only when a dynamic flag exists.
 */
function checkFlag(flags, submitted, opts = {}) {
  if (typeof submitted !== 'string' || submitted.length === 0 || submitted.length > MAX_FLAG_LENGTH) return false;
  const value = submitted.trim();
  for (const flag of flags) {
    if (flag.type === 'dynamic') {
      if (!opts.dynamicFlagSecret) continue;
      const expected = generateDynamicFlag(opts.dynamicFlagSecret, flag.content, opts.userId, opts.challengeId);
      if (crypto.timingSafeEqual(digest(value), digest(expected))) return true;
    } else if (flag.type === 'regex') {
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

module.exports = { checkFlag, generateDynamicFlag, MAX_FLAG_LENGTH };
