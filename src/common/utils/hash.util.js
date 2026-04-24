'use strict';

const crypto = require('crypto');

/**
 * Produces a stable SHA-256 hash of an object.
 * Keys are sorted before serialization to ensure identical objects produce identical hashes
 * regardless of property insertion order.
 *
 * Used for idempotency key validation: detect if client reused a key with a different payload.
 */
function hashObject(obj) {
  const sorted = sortObjectKeys(obj);
  const json = JSON.stringify(sorted);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function sortObjectKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectKeys(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}

module.exports = { hashObject };
