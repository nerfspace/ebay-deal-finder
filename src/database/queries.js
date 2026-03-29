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

async function auctionDealExists(sourceId) {
  const row = await get('SELECT id FROM auction_deals WHERE source_id = ?', [sourceId]);
  return !!row;
}

async function saveAuctionDeal(item) {
  const sql = `
    INSERT OR IGNORE INTO auction_deals (
      source_id, source, title, current_bid, end_time, time_left_minutes,
      url, image_url, category, bid_count,
      ebay_median_sold_price, projected_profit, profit_percentage,
      title_similarity, ebay_match_count, found_at, notified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    item.sourceId,
    item.source,
    item.title,
    item.currentBid,
    item.endTime || null,
    item.timeLeftMinutes != null ? item.timeLeftMinutes : null,
    item.url || null,
    item.imageUrl || null,
    item.category || null,
    item.bidCount || 0,
    item.ebayMedianSoldPrice != null ? item.ebayMedianSoldPrice : null,
    item.projectedProfit != null ? item.projectedProfit : null,
    item.profitPercentage != null ? item.profitPercentage : null,
    item.titleSimilarity != null ? item.titleSimilarity : null,
    item.ebayMatchCount || 0,
    moment().toISOString(),
    null,
  ];
  return run(sql, params);
}

async function markAuctionDealNotified(sourceId) {
  return run('UPDATE auction_deals SET notified_at = ? WHERE source_id = ?', [
    moment().toISOString(),
    sourceId,
  ]);
}

// ---------------------------------------------------------------------------
// listings / scores tables (new event-driven pipeline)
// ---------------------------------------------------------------------------

async function listingExists(listingId) {
  const row = await get('SELECT listing_id FROM listings WHERE listing_id = ?', [listingId]);
  return !!row;
}

async function saveListing(listing) {
  const sql = `
    INSERT OR IGNORE INTO listings (
      listing_id, title, price, shipping_cost, seller_feedback,
      category, listing_url, timestamp_detected
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  return run(sql, [
    listing.listing_id,
    listing.title,
    listing.price,
    listing.shipping_cost != null ? listing.shipping_cost : 0,
    listing.seller_feedback != null ? listing.seller_feedback : null,
    listing.category || null,
    listing.listing_url || null,
    listing.timestamp_detected,
  ]);
}

async function saveScore(score) {
  const sql = `
    INSERT OR REPLACE INTO scores (
      listing_id, deal_score, estimated_profit, risk_score,
      sell_through_rate, confidence, analyzed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  return run(sql, [
    score.listing_id,
    score.deal_score,
    score.estimated_profit != null ? score.estimated_profit : null,
    score.risk_score != null ? score.risk_score : null,
    score.sell_through_rate != null ? score.sell_through_rate : null,
    score.confidence != null ? score.confidence : null,
    score.analyzed_at,
  ]);
}

/**
 * Return top deals joining listings and scores, ordered by deal_score DESC.
 * @param {number} minScore - minimum deal_score to include
 * @param {number} [limit=50]
 * @returns {object[]}
 */
async function getTopDeals(minScore, limit) {
  if (minScore == null) minScore = 80;
  if (!limit) limit = 50;
  return all(
    `SELECT l.listing_id, l.title, l.price, s.deal_score, s.estimated_profit, l.listing_url
     FROM listings l
     JOIN scores s ON l.listing_id = s.listing_id
     WHERE s.deal_score >= ?
     ORDER BY s.deal_score DESC
     LIMIT ?`,
    [minScore, limit],
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
  auctionDealExists,
  saveAuctionDeal,
  markAuctionDealNotified,
  listingExists,
  saveListing,
  saveScore,
  getTopDeals,
};
