'use strict';

const logger = require('../utils/logger');

/**
 * Default include keywords — titles containing any of these phrases are
 * more likely to be genuinely underpriced deals worth investigating.
 */
const DEFAULT_INCLUDE_KEYWORDS = [
  'lot', 'bundle', 'liquidation', 'wholesale', 'clearance',
  'estate sale', 'moving sale', 'must sell', 'quick sale',
  'no reserve', 'starting at $1', 'urgent', 'reduced',
];

/**
 * Default exclude keywords — titles containing any of these are almost
 * certainly not deals (broken, replicas, unverified, etc.).
 */
const DEFAULT_EXCLUDE_KEYWORDS = [
  'for parts', 'not working', 'broken', 'damaged', 'cracked',
  'replica', 'fake', 'inspired', 'digital', 'pdf', 'download',
  'warranty card', 'box only', 'empty box',
];

class FilterEngine {
  constructor(options = {}) {
    this.minDealScore = options.minDealScore || 75;
    this.minProfitThreshold = options.minProfitThreshold || 20;
    this.includeKeywords = new Set(DEFAULT_INCLUDE_KEYWORDS);
    this.excludeKeywords = new Set(DEFAULT_EXCLUDE_KEYWORDS);
  }

  /**
   * Load additional keyword filters from the database.
   */
  loadKeywords(dbKeywords = []) {
    for (const kw of dbKeywords) {
      const word = kw.keyword.toLowerCase();
      if (kw.filter_type === 'include') {
        this.includeKeywords.add(word);
      } else if (kw.filter_type === 'exclude') {
        this.excludeKeywords.add(word);
      }
    }
    logger.debug(
      `Filter engine loaded: ${this.includeKeywords.size} include, ` +
      `${this.excludeKeywords.size} exclude keywords`,
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
   * Check whether a listing title matches any include keyword (optional boost).
   * Returns true if there's a positive keyword match.
   */
  hasIncludeKeyword(title) {
    const lower = title.toLowerCase();
    for (const kw of this.includeKeywords) {
      if (lower.includes(kw)) return true;
    }
    return false;
  }

  /**
   * Filter a batch of scored items, returning only those that pass all criteria.
   */
  filterDeals(scoredItems) {
    const passing = [];

    for (const item of scoredItems) {
      // Must meet minimum deal score threshold
      if (item.dealScore < this.minDealScore) continue;

      // Must meet minimum profit threshold
      if (item.expectedProfit < this.minProfitThreshold) continue;

      // Must not match any exclude keyword
      if (this.isExcluded(item.title)) {
        logger.debug(`Excluded by keyword: "${item.title}"`);
        continue;
      }

      passing.push(item);
    }

    logger.debug(`Filter: ${scoredItems.length} items → ${passing.length} deals passed`);
    return passing;
  }
}

module.exports = FilterEngine;
