'use strict';

const moment = require('moment');

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function timestamp() {
  return moment().format('YYYY-MM-DD HH:mm:ss');
}

function log(level, color, ...args) {
  if (LEVELS[level] < currentLevel) return;
  const prefix = `${COLORS[color]}[${timestamp()}] [${level.toUpperCase()}]${COLORS.reset}`;
  console.log(prefix, ...args);
}

const logger = {
  debug: (...args) => log('debug', 'cyan', ...args),
  info: (...args) => log('info', 'green', ...args),
  warn: (...args) => log('warn', 'yellow', ...args),
  error: (...args) => log('error', 'red', ...args),
  deal: (...args) => {
    const prefix = `${COLORS.magenta}${COLORS.bright}[${timestamp()}] [DEAL]${COLORS.reset}`;
    console.log(prefix, ...args);
  },
  scan: (...args) => {
    const prefix = `${COLORS.blue}[${timestamp()}] [SCAN]${COLORS.reset}`;
    console.log(prefix, ...args);
  },
  setLevel(level) {
    if (LEVELS[level] !== undefined) {
      currentLevel = LEVELS[level];
    }
  },
};

module.exports = logger;
