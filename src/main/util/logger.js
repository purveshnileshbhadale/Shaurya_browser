'use strict';
/**
 * Tiny levelled logger. Deliberately dependency-free: a browser's main
 * process should not pull a logging framework into its startup path.
 *
 * Set SHAURYA_LOG=debug for verbose output; default is `info`.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[process.env.SHAURYA_LOG] ?? LEVELS.info;

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(`${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`, ...args);
}

/** Create a logger bound to a subsystem name. */
function createLogger(scope) {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

module.exports = { createLogger };
