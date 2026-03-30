'use strict';

require('dotenv').config();

const REQUIRED_VARS = ['EBAY_APP_ID', 'EBAY_CERT_ID', 'EBAY_AUTH_TOKEN', 'EMAIL_TO'];

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
   keywords: [],  // No keyword filtering - use wildcard search
condition: process.env.SEARCH_CONDITION || 'NEW',
    minPrice: parseFloat(process.env.MIN_PRICE || '20'),
    maxPrice: parseFloat(process.env.MAX_PRICE || '2000'),
  },
  email: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
  },
  deals: {
    minProfitThreshold: parseFloat(process.env.MIN_PROFIT_THRESHOLD || '20'),
minDealScore: parseInt(process.env.MIN_DEAL_SCORE || '70', 10),
    minSellerFeedbackPct: parseFloat(process.env.MIN_SELLER_FEEDBACK_PCT || '95'),
    maxDealsPerScan: parseInt(process.env.MAX_DEALS_PER_SCAN || '20', 10),
    binOnly: process.env.BIN_ONLY !== 'false',
    minTitleSimilarity: parseFloat(process.env.MIN_TITLE_SIMILARITY || '0.95'),
    minProfitPercentage: parseFloat(process.env.MIN_PROFIT_PERCENTAGE || '25'),
    soldItemsPerCheck: parseInt(process.env.SOLD_ITEMS_PER_CHECK || '10', 10),
    maxSoldChecksPerScan: parseInt(process.env.MAX_SOLD_CHECKS_PER_SCAN || '100', 10),
    ebayApiDelayMs: parseInt(process.env.EBAY_API_DELAY_MS || '1500', 10),
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
  poller: {
    minIntervalMs: parseInt(process.env.POLL_INTERVAL_MIN_MS || '5000', 10),
    maxIntervalMs: parseInt(process.env.POLL_INTERVAL_MAX_MS || '15000', 10),
    proxyUrls: process.env.PROXY_URLS
      ? process.env.PROXY_URLS.split(',').map((u) => u.trim()).filter(Boolean)
      : [],
  },
  api: {
    minDealScore: parseInt(process.env.MIN_DEAL_SCORE_API || '80', 10),
  },
  marketplace: {
    feeRate: parseFloat(process.env.MARKETPLACE_FEE_RATE || '0.16'),
  },
  queue: {
    type: process.env.QUEUE_TYPE || 'memory',
  },
  auctionSources: {
    enabled: process.env.AUCTION_SOURCES_ENABLED !== 'false',
    minTitleSimilarity: parseFloat(process.env.AUCTION_MIN_TITLE_SIMILARITY || '0.80'),
    minProfitPercentage: parseFloat(process.env.AUCTION_MIN_PROFIT_PCT || '20'),
    keywords: (process.env.AUCTION_KEYWORDS || 'electronics,camera,laptop,jewelry,watches,coins,tools,vintage,gaming,audio').split(',').map((k) => k.trim()).filter(Boolean),
    shopGoodwill: {
      enabled: process.env.SHOPGOODWILL_ENABLED !== 'false',
      delayMs: 2500,
    },
    govDeals: {
      enabled: process.env.GOVDEALS_ENABLED !== 'false',
      delayMs: 3000,
    },
    propertyRoom: {
      enabled: process.env.PROPERTYROOM_ENABLED !== 'false',
      delayMs: 3000,
    },
    bidSpotter: {
      enabled: process.env.BIDSPOTTER_ENABLED !== 'false',
      delayMs: 3000,
    },
  },
};

validate();

module.exports = config;
