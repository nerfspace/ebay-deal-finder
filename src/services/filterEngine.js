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
];

class FilterEngine {
  constructor(options = {}) {
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
   * Filter a batch of items, returning only those that pass all criteria.
   * 
   * FILTERS APPLIED (IN ORDER):
   * 1. Listing Type: Must be FIXED_PRICE (Buy It Now)
   * 2. Seller Feedback: Must be >= 95%
   * 3. High-Value Category: Must match known profitable categories
   * 4. Exclude Keywords: Must NOT contain banned keywords
   * 5. Sold Items Validation: Must have recently sold items to confirm demand
   */
  async filterDeals(items, ebayService) {
    const passing = [];
    let skipped = {
      auction: 0,
      lowFeedback: 0,
      notHighValue: 0,
      excludedKeyword: 0,
      noSoldItems: 0,
    };

    for (const item of items) {
      // 1. BIN-only filter: skip auctions when enabled
      if (this.binOnly) {
        const lt = (item.listingType || '').toUpperCase();
        if (lt === 'AUCTION') {
          logger.debug(`[SKIP] Auction: "${item.title.substring(0, 50)}"`);
          skipped.auction++;
          continue;
        }
      }

      // 2. Minimum seller feedback percentage
      if (item.sellerFeedbackPct != null && item.sellerFeedbackPct < this.minSellerFeedbackPct) {
        logger.debug(`[SKIP] Low feedback (${item.sellerFeedbackPct}%): "${item.title.substring(0, 50)}"`);
        skipped.lowFeedback++;
        continue;
      }

      // 3. Must belong to a high-value category
      if (!this.isHighValueCategory(item)) {
        logger.debug(`[SKIP] Not high-value: "${item.title.substring(0, 50)}"`);
        skipped.notHighValue++;
        continue;
      }

      // 4. Must not match any exclude keyword
      if (this.isExcluded(item.title)) {
        logger.debug(`[SKIP] Excluded keyword: "${item.title.substring(0, 50)}"`);
        skipped.excludedKeyword++;
        continue;
      }

      // 5. CHECK FOR RECENTLY SOLD ITEMS (validates market demand)
      if (ebayService) {
        const hasSoldItems = await ebayService.checkSoldItems(item.title);
        if (!hasSoldItems) {
          logger.debug(`[SKIP] No sold items found: "${item.title.substring(0, 50)}"`);
          skipped.noSoldItems++;
          continue;
        }
      }

      // ✅ PASSED ALL FILTERS
      logger.info(`[DEAL] ✅ ${item.title.substring(0, 60)}`);
      passing.push(item);
    }

    // Log summary
    logger.info(`=== FILTER SUMMARY ===`);
    logger.info(`Input: ${items.length} items`);
    logger.info(`Auctions skipped: ${skipped.auction}`);
    logger.info(`Low feedback skipped: ${skipped.lowFeedback}`);
    logger.info(`Not high-value skipped: ${skipped.notHighValue}`);
    logger.info(`Excluded keywords skipped: ${skipped.excludedKeyword}`);
    logger.info(`No sold items skipped: ${skipped.noSoldItems}`);
    logger.info(`Output: ${passing.length} deals passed`);

    return passing;
  }
}

module.exports = FilterEngine;
