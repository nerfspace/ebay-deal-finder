'use strict';

const logger = require('../utils/logger');
const { getHighValueMultiplier } = require('./scoringEngine');

/**
 * Default exclude keywords — titles containing any of these are almost
 * certainly not deals (broken, replicas, unverified, etc.).
 */
const DEFAULT_EXCLUDE_KEYWORDS = [
  'for parts', 'not working', 'broken', 'damaged', 'cracked',
  'replica', 'fake', 'inspired', 'digital', 'pdf', 'download',
  'warranty card', 'box only', 'empty box',
  'used - poor', 'poor condition',
];

/**
 * Conditions that are explicitly excluded from consideration.
 */
const EXCLUDED_CONDITIONS = ['used - poor', 'poor', 'for parts or not working'];

class FilterEngine {
  constructor(options = {}) {
   this.minDealScore = options.minDealScore || 65;
this.minProfitThreshold = options.minProfitThreshold || 15;
    this.minSellerFeedbackPct = options.minSellerFeedbackPct || 95;
    this.binOnly = options.binOnly !== false;
    this.excludeKeywords = new Set(DEFAULT_EXCLUDE_KEYWORDS);
  }

  /**
   * Load additional keyword filters from the database.
   */
  loadKeywords(dbKeywords = []) {
    for (const kw of dbKeywords) {
      const word = kw.keyword.toLowerCase();
      if (kw.filter_type === 'exclude') {
        this.excludeKeywords.add(word);
      }
    }
    logger.debug(
      `Filter engine loaded: ${this.excludeKeywords.size} exclude keywords`,
    );
  }

  /**
   * Check whether a listing title matches any exclude keyword.
   * Returns true if the item should be excluded.
   */
  isExcluded(title) {
    const lower = title.toLowerCase();
    for (const kw of this.excludeKeywords) {
      if (lower.includes(kw)) return true;
    }
    return false;
  }

  /**
   * Check whether an item belongs to a high-value category.
   * Returns true if the item's liquidity multiplier exceeds 1.0.
   */
  isHighValueCategory(item) {
    return getHighValueMultiplier(item) > 1.0;
  }

  /**
   * Filter a batch of scored items, returning only those that pass all criteria.
   * Results are sorted by dealScore descending and capped at maxDeals.
   */
  filterDeals(scoredItems, maxDeals = 20) {
    const passing = [];

    for (const item of scoredItems) {
      // BIN-only filter: skip auctions when enabled
      if (this.binOnly) {
        const lt = (item.listingType || '').toUpperCase();
        if (lt === 'AUCTION') {
          logger.debug(`Skipped auction listing: "${item.title}"`);
          continue;
        }
      }

      // Exclude "used - poor" and similar conditions
      const cond = (item.condition || '').toLowerCase();
      if (EXCLUDED_CONDITIONS.some((c) => cond.includes(c))) {
        logger.debug(`Excluded poor condition: "${item.title}"`);
        continue;
      }

      // Minimum seller feedback percentage
      if (item.sellerFeedbackPct != null && item.sellerFeedbackPct < this.minSellerFeedbackPct) {
        logger.debug(`Excluded low seller feedback (${item.sellerFeedbackPct}%): "${item.title}"`);
        continue;
      }

      // Must belong to a high-value category
      if (!this.isHighValueCategory(item)) {
        logger.debug(`Excluded non-high-value category: "${item.title}"`);
        continue;
      }

      // Must not match any exclude keyword
      if (this.isExcluded(item.title)) {
        logger.debug(`Excluded by keyword: "${item.title}"`);
        continue;
      }

      // Must meet minimum deal score threshold
      if (item.dealScore < this.minDealScore) continue;

      // Must meet minimum profit threshold
      if (item.expectedProfit < this.minProfitThreshold) continue;

      passing.push(item);
    }

    // Sort by deal score descending and cap at maxDeals
    passing.sort((a, b) => b.dealScore - a.dealScore);
    const topDeals = passing.slice(0, maxDeals);

    logger.debug(`Filter: ${scoredItems.length} items → ${passing.length} passed → top ${topDeals.length} selected`);
    return topDeals;
  }
}

module.exports = FilterEngine;

