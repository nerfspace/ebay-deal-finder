'use strict';

const logger = require('../utils/logger');

const DEFAULT_EXCLUDE_KEYWORDS = [
  'for parts', 'not working', 'broken', 'damaged', 'cracked',
  'replica', 'fake', 'inspired', 'digital', 'pdf', 'download',
  'warranty card', 'box only', 'empty box',
];

class FilterEngine {
  constructor(options) {
    if (!options) options = {};
    this.minSellerFeedbackPct = options.minSellerFeedbackPct || 95;
    this.minPriceDifference = options.minPriceDifference || 30;
    this.minProfitPercentage = options.minProfitPercentage || 25;
    this.binOnly = options.binOnly !== false;
    this.excludeKeywords = new Set(DEFAULT_EXCLUDE_KEYWORDS);
  }

  loadKeywords(dbKeywords) {
    if (!dbKeywords) dbKeywords = [];
    for (var i = 0; i < dbKeywords.length; i++) {
      var kw = dbKeywords[i];
      var word = kw.keyword.toLowerCase();
      if (kw.filter_type === 'exclude') {
        this.excludeKeywords.add(word);
      }
    }
    logger.debug('Filter engine loaded: ' + this.excludeKeywords.size + ' exclude keywords');
  }

  isExcluded(title) {
    var lower = title.toLowerCase();
    var keys = this.excludeKeywords.values();
    var entry = keys.next();
    while (!entry.done) {
      if (lower.includes(entry.value)) {
        return true;
      }
      entry = keys.next();
    }
    return false;
  }

  /**
   * Filter a list of scored items to qualifying deals.
   *
   * @param {object[]} items - Scored listing objects
   * @param {Map<string, object>} soldDataMap - Pre-computed sold/market data keyed by ebayItemId.
   *        Each value is the result of ebayService.checkSoldItems().
   *        Pass null/undefined to skip the sold-price filter (not recommended).
   */
  async filterDeals(items, soldDataMap) {
    var passing = [];
    var skipped = {
      auction: 0,
      lowFeedback: 0,
      excludedKeyword: 0,
      noSoldItems: 0,
      insufficientPriceDifference: 0,
    };

    for (var idx = 0; idx < items.length; idx++) {
      var item = items[idx];

      if (this.binOnly) {
        var lt = (item.listingType || '').toUpperCase();
        if (lt === 'AUCTION') {
          logger.debug('[SKIP] Auction: ' + item.title.substring(0, 50));
          skipped.auction = skipped.auction + 1;
          continue;
        }
      }

      if (item.sellerFeedbackPct != null && item.sellerFeedbackPct < this.minSellerFeedbackPct) {
        logger.debug('[SKIP] Low feedback: ' + item.title.substring(0, 50));
        skipped.lowFeedback = skipped.lowFeedback + 1;
        continue;
      }

      if (this.isExcluded(item.title)) {
        logger.debug('[SKIP] Excluded keyword: ' + item.title.substring(0, 50));
        skipped.excludedKeyword = skipped.excludedKeyword + 1;
        continue;
      }

      // Use the pre-computed sold/market data — no second API call
      var soldData = soldDataMap ? soldDataMap.get(item.ebayItemId) : null;

      if (!soldData || !soldData.hasSoldItems) {
        logger.debug('[SKIP] No matching market items: ' + item.title.substring(0, 50));
        skipped.noSoldItems = skipped.noSoldItems + 1;
        continue;
      }

      if (soldData.profitPercentage < this.minProfitPercentage) {
        logger.debug('[SKIP] Profit margin too low (' + (soldData.profitPercentage || 0).toFixed(1) + '%): ' + item.title.substring(0, 50));
        skipped.insufficientPriceDifference = skipped.insufficientPriceDifference + 1;
        continue;
      }

      logger.info(
        '[DEAL] PASSED | ' + item.title.substring(0, 60) +
        ' | Market: $' + soldData.medianSoldPrice.toFixed(2) +
        ' | Similarity: ' + (soldData.bestSimilarity * 100).toFixed(1) + '%' +
        ' | Margin: ' + soldData.profitPercentage.toFixed(1) + '%'
      );
      passing.push(item);
    }

    logger.info('=== FILTER SUMMARY ===');
    logger.info('Input: ' + items.length + ' items');
    logger.info('Auctions skipped: ' + skipped.auction);
    logger.info('Low feedback skipped: ' + skipped.lowFeedback);
    logger.info('Excluded keywords skipped: ' + skipped.excludedKeyword);
    logger.info('No matching market items skipped: ' + skipped.noSoldItems);
    logger.info('Insufficient profit margin skipped: ' + skipped.insufficientPriceDifference);
    logger.info('Output: ' + passing.length + ' deals passed');

    return passing;
  }
}

module.exports = FilterEngine;
