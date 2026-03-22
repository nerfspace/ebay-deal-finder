'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
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
  confidence_score REAL,
  speed_score REAL,
  risk_score REAL,
  execution_score REAL,
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
  return new Promise((resolve, reject) => {
    const resolvedPath = path.resolve(dbPath);
    const dir = path.dirname(resolvedPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new sqlite3.Database(resolvedPath, (err) => {
      if (err) {
        reject(new Error(`Failed to open database: ${err.message}`));
        return;
      }
      logger.info(`Database connected: ${resolvedPath}`);

      db.exec(SCHEMA, (schemaErr) => {
        if (schemaErr) {
          reject(new Error(`Failed to initialize schema: ${schemaErr.message}`));
          return;
        }
        logger.info('Database schema initialized');
        resolve(db);
      });
    });
  });
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

function closeDb() {
  return new Promise((resolve, reject) => {
    if (!db) {
      resolve();
      return;
    }
    db.close((err) => {
      if (err) {
        reject(err);
      } else {
        db = null;
        resolve();
      }
    });
  });
}

module.exports = { initDb, getDb, closeDb };
