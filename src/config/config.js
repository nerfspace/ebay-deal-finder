'use strict';

require('dotenv').config();

const REQUIRED_VARS = ['EBAY_APP_ID', 'EBAY_CERT_ID', 'EBAY_AUTH_TOKEN', 'PUSHBULLET_API_KEY'];

function validate() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

const config = {
  ebay: {
    appId: process.env.EBAY_APP_ID,
    certId: process.env.EBAY_CERT_ID,
    authToken: process.env.EBAY_AUTH_TOKEN,
    sandbox: process.env.EBAY_SANDBOX === 'true',
  },
  scan: {
    intervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || '10', 10),
    listingsPerScan: 500,
  },
  pushbullet: {
    apiKey: process.env.PUSHBULLET_API_KEY,
  },
  deals: {
    minProfitThreshold: parseFloat(process.env.MIN_PROFIT_THRESHOLD || '20'),
    minDealScore: 75,
  },
  database: {
    path: process.env.DATABASE_PATH || './data/deals.db',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

validate();

module.exports = config;
