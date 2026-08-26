'use strict';
const crypto = require('node:crypto');

/** Short, collision-resistant id for tabs/groups/requests. */
function uid(prefix = '') {
  return `${prefix}${crypto.randomBytes(9).toString('base64url')}`;
}

module.exports = { uid };
