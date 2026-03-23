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
    this.minPriceDifference = options.minPriceDifference || 30;
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
   * Filter a batch of items, returning only those that pass all criteria.
   * 
   * FILTERS APPLIED (IN ORDER):
   * 1. Listing Type: Must be FIXED_PRICE (Buy It Now)
   * 2. Seller Feedback: Must be >= 95%
   * 3. Exclude Keywords: Must NOT contain banned keywords
   * 4. Sold Items Validation: Must have recently sold items
   * 5. Price Difference: Must have >= $30 difference from sold price
   */
  async filterDeals(items, ebayService) {
    const passing = [];
    let skipped = {
      auction: 0,
      lowFeedback: 0,
      excludedKeyword: 0,
      noSoldItems: 0,
      insufficientPriceDifference: 0,
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

      // 3. Must not match any exclude keyword
      if (this.isExcluded(item.title)) {
        logger.debug(`[SKIP] Excluded keyword: "${item.title.substring(0, 50)}"`);
        skipped.excludedKeyword++;
        continue;
      }

      // 4 & 5. CHECK SOLD ITEMS AND PRICE DIFFERENCE
      if (ebayService) {
        const soldCheck = await ebayService.checkSoldItems(
          item.title,
          item.currentPrice,
          this.minPriceDifference
        );

        if (!soldCheck.hasSoldItems) {
          logger.debug(`[SKIP] No sold items found: "${item.title.substring(0, 50)}"`);
          skipped.noSoldItems++;
          continue;
        }

        if (!soldCheck.meetsThreshold) {
          logger.debug(
            `[SKIP] Price difference too low ($${soldCheck.priceDifference.toFixed(2)} < $${this.minPriceDifference}): ` +
            `"${item.title.substring(0, 50)}"`
          );
          skipped.insufficientPriceDifference++;
          continue;
        }
      }

      // ✅ PASSED ALL FILTERS
      logger.info(`[DEAL] ✅ ${item.title.substring(0, 60)} | Seller: ${item.seller} (${item.sellerFeedback} sales)`);
      passing.push(item);
    }

    // Log summary
    logger.info(`=== FILTER SUMMARY ===`);
    logger.info(`Input: ${items.length} items`);
    logger.info(`Auctions skipped: ${skipped.auction}`);
    logger.info(`Low feedback skipped: ${skipped.lowFeedback}`);
    logger.info(`Excluded keywords skipped: ${skipped.excludedKeyword}`);
    logger.info(`No sold items skipped: ${skipped.noSoldItems}`);
    logger.info(`Insufficient price difference skipped: ${skipped.insufficientPriceDifference}`);
    logger.info(`Output: ${passing.length} deals passed`);

    return passing;
  }
}

module.exports = FilterEngine;
