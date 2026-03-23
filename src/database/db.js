'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const logger = require('../utils/logger');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ebay_item_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  current_price REAL NOT NULL,
  estimated_resale_price REAL,
  expected_profit REAL,
  deal_score REAL,
  price_discount_score REAL,
  liquidity_score REAL,
  seller_score REAL,
  listing_quality_score REAL,
  speed_score REAL,
  risk_score REAL,
  title_similarity REAL,
  sold_match_count INTEGER,
  sold_median_price REAL,
  url TEXT,
  seller TEXT,
  seller_feedback INTEGER,
  condition TEXT,
  listing_type TEXT,
  posted_at TEXT,
  found_at TEXT NOT NULL,
  notified_at TEXT
);

CREATE TABLE IF NOT EXISTS filter_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  filter_type TEXT NOT NULL CHECK(filter_type IN ('include', 'exclude')),
  priority INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS scan_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_time TEXT NOT NULL,
  listings_checked INTEGER NOT NULL DEFAULT 0,
  deals_found INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
);
`;

function initDb(dbPath) {
  const resolvedPath = path.resolve(dbPath);
  const dir = path.dirname(resolvedPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  logger.info(`Database connected: ${resolvedPath}`);

  db.exec(SCHEMA);
  logger.info('Database schema initialized');

  return Promise.resolve(db);
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
  return Promise.resolve();
}

module.exports = { initDb, getDb, closeDb };
