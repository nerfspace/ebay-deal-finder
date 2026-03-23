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

  async filterDeals(items, ebayService) {
    var passing = [];
    var skipped = {
      auction: 0,
      lowFeedback: 0,
      excludedKeyword: 0,
      noSoldItems: 0,
      insufficientPriceDifference: 0
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

      if (!ebayService) {
        logger.debug('[SKIP] No eBay service: ' + item.title.substring(0, 50));
        continue;
      }

      var soldCheck = await ebayService.checkSoldItems(
        item.title,
        item.currentPrice,
        this.minPriceDifference
      );

      if (!soldCheck.hasSoldItems) {
        logger.debug('[SKIP] NO RECENTLY SOLD ITEMS: ' + item.title.substring(0, 50));
        skipped.noSoldItems = skipped.noSoldItems + 1;
        continue;
      }

      if (!soldCheck.meetsThreshold) {
        logger.debug('[SKIP] Price difference too low: ' + item.title.substring(0, 50));
        skipped.insufficientPriceDifference = skipped.insufficientPriceDifference + 1;
        continue;
      }

      logger.info('[DEAL] PASSED | ' + item.title.substring(0, 60) + ' | Sold: $' + soldCheck.recentlySoldPrice.toFixed(2));
      passing.push(item);
    }

    logger.info('=== FILTER SUMMARY ===');
    logger.info('Input: ' + items.length + ' items');
    logger.info('Auctions skipped: ' + skipped.auction);
    logger.info('Low feedback skipped: ' + skipped.lowFeedback);
    logger.info('Excluded keywords skipped: ' + skipped.excludedKeyword);
    logger.info('No sold items skipped: ' + skipped.noSoldItems);
    logger.info('Insufficient price difference skipped: ' + skipped.insufficientPriceDifference);
    logger.info('Output: ' + passing.length + ' deals passed');

    return passing;
  }
}

module.exports = FilterEngine;
