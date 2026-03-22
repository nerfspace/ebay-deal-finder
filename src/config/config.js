'use strict';

require('dotenv').config();

const REQUIRED_VARS = ['EBAY_APP_ID', 'EBAY_CERT_ID', 'EBAY_AUTH_TOKEN', 'DISCORD_WEBHOOK_URL'];

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
    keywords: (process.env.SEARCH_KEYWORDS || 'Snap-on wrench,Griswold cast iron,Marantz amplifier,Titleist golf club,vintage camera lens,Wagner cookware,Pokemon card,Nintendo game,vintage audio').split(',').map(k => k.trim()),
condition: process.env.SEARCH_CONDITION || 'NEW',
    minPrice: parseFloat(process.env.MIN_PRICE || '20'),
    maxPrice: parseFloat(process.env.MAX_PRICE || '2000'),
  },
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  },
  deals: {
    minProfitThreshold: parseFloat(process.env.MIN_PROFIT_THRESHOLD || '50'),
    minDealScore: parseInt(process.env.MIN_DEAL_SCORE || '85', 10),
    minSellerFeedbackPct: parseFloat(process.env.MIN_SELLER_FEEDBACK_PCT || '95'),
    maxDealsPerScan: parseInt(process.env.MAX_DEALS_PER_SCAN || '20', 10),
    binOnly: process.env.BIN_ONLY !== 'false',
  },
  notifications: {
    delayMs: parseInt(process.env.NOTIFICATION_DELAY_MS || '1500', 10),
    maxRetries: parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10),
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
