'use strict';

const moment = require('moment');
const { getDb } = require('./db');

function run(sql, params = []) {
  const stmt = getDb().prepare(sql);
  return stmt.run(...params);
}

function get(sql, params = []) {
  const stmt = getDb().prepare(sql);
  return stmt.get(...params);
}

function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  return stmt.all(...params);
}

async function dealExists(ebayItemId) {
  const row = await get('SELECT id FROM deals WHERE ebay_item_id = ?', [ebayItemId]);
  return !!row;
}

async function saveDeal(deal, soldData) {
  if (!soldData) soldData = {};
  const sql = `
    INSERT OR IGNORE INTO deals (
      ebay_item_id, title, current_price, estimated_resale_price, expected_profit,
      deal_score, price_discount_score, liquidity_score, seller_score, listing_quality_score,
      speed_score, risk_score,
      title_similarity, sold_match_count, sold_median_price,
      url, seller, seller_feedback, condition, listing_type,
      posted_at, found_at, notified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    deal.ebayItemId,
    deal.title,
    deal.currentPrice,
    deal.estimatedResalePrice || null,
    deal.expectedProfit || null,
    deal.dealScore,
    deal.priceDiscountScore || null,
    deal.liquidityScore || null,
    deal.sellerScore || null,
    deal.listingQualityScore || null,
    deal.speedScore || null,
    deal.riskScore || null,
    soldData.bestSimilarity != null ? soldData.bestSimilarity : null,
    soldData.matchCount != null ? soldData.matchCount : null,
    soldData.medianSoldPrice != null ? soldData.medianSoldPrice : null,
    deal.url,
    deal.seller || null,
    deal.sellerFeedback || null,
    deal.condition || null,
    deal.listingType || null,
    deal.postedAt || null,
    moment().toISOString(),
    null,
  ];
  return run(sql, params);
}

async function markNotified(ebayItemId) {
  return run('UPDATE deals SET notified_at = ? WHERE ebay_item_id = ?', [
    moment().toISOString(),
    ebayItemId,
  ]);
}

async function saveScanHistory(scanData) {
  const sql = `
    INSERT INTO scan_history (scan_time, listings_checked, deals_found, errors)
    VALUES (?, ?, ?, ?)
  `;
  return run(sql, [
    moment().toISOString(),
    scanData.listingsChecked,
    scanData.dealsFound,
    scanData.errors,
  ]);
}

async function getRecentDeals(limit = 20) {
  return all(
    'SELECT * FROM deals ORDER BY found_at DESC LIMIT ?',
    [limit],
  );
}

async function getScanHistory(limit = 10) {
  return all(
    'SELECT * FROM scan_history ORDER BY scan_time DESC LIMIT ?',
    [limit],
  );
}

async function getFilterKeywords() {
  return all('SELECT * FROM filter_keywords ORDER BY priority DESC, filter_type ASC');
}

async function addFilterKeyword(keyword, filterType, priority = 1) {
  return run(
    'INSERT INTO filter_keywords (keyword, filter_type, priority) VALUES (?, ?, ?)',
    [keyword.toLowerCase(), filterType, priority],
  );
}

module.exports = {
  dealExists,
  saveDeal,
  markNotified,
  saveScanHistory,
  getRecentDeals,
  getScanHistory,
  getFilterKeywords,
  addFilterKeyword,
};
