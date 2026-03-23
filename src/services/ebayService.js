'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const BROWSE_API_BASE = 'https://api.ebay.com/buy/browse/v1';
const SANDBOX_API_BASE = 'https://api.sandbox.ebay.com/buy/browse/v1';

class EbayService {
  constructor(config) {
    this.authToken = config.ebay.authToken;
    this.sandbox = config.ebay.sandbox;
    this.baseUrl = config.ebay.sandbox ? SANDBOX_API_BASE : BROWSE_API_BASE;
    this.pageSize = 200;
    this.keywords = config.scan.keywords || [];
    this.condition = config.scan.condition || 'NEW';
    this.minPrice = config.scan.minPrice || 10;
    this.maxPrice = config.scan.maxPrice || 5000;
  }

  async _headers() {
    return {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    };
  }

  async fetchRecentListings(total = 500) {
    var listings = [];
    var offset = 0;
    var searchTerms = [
      'tools', 'vintage', 'collectible', 'audio', 'camera', 'game',
      'electronics', 'jewelry', 'watches', 'coins', 'stamps', 'sports',
      'toys', 'art', 'antique', 'furniture', 'books', 'memorabilia',
      'musical instruments', 'photography', 'records', 'comic',
      'gaming', 'automation', 'industrial', 'machinery', 'scientific'
    ];

    logger.info('[EBAY] Fetching ' + total + ' most recent NEW listings...');
    
    while (listings.length < total) {
      var limit = Math.min(this.pageSize, total - listings.length);
      var retryCount = 0;
      var maxRetries = 3;
      var backoffMs = 1000;

      var success = false;
      var itemSummaries = [];
      var apiTotal = 0;

      while (retryCount < maxRetries && !success) {
        try {
          logger.debug('Fetching eBay listings: offset=' + offset + ', limit=' + limit + ', retry=' + retryCount);
          var filter = 'price:[' + this.minPrice + '..' + this.maxPrice + '],priceCurrency:USD,condition:{' + this.condition + '},buyingOptions:{FIXED_PRICE}';
          var q = searchTerms[Math.floor(Math.random() * searchTerms.length)];
          logger.info('[EBAY] Searching for: "' + q + '"');

          var response = await axios.get(this.baseUrl + '/item_summary/search', {
            headers: await this._headers(),
            params: { q: q, sort: 'newlyListed', limit: limit, offset: offset, fieldgroups: 'MATCHING_ITEMS', filter: filter },
            timeout: 15000,
          });

          itemSummaries = response.data.itemSummaries || [];
          apiTotal = response.data.total || 0;
          success = true;

          if (itemSummaries.length === 0) {
            logger.debug('No more listings returned by eBay API.');
            break;
          }

          listings.push.apply(listings, itemSummaries.map(this._normalizeItem.bind(this)));
          offset = offset + itemSummaries.length;

          if (offset >= apiTotal || listings.length >= total) {
            break;
          }
        } catch (err) {
          var status = err.response ? err.response.status : 'N/A';
          var message = err.response ? JSON.stringify(err.response.data) : err.message;

          if (status === 429) {
            logger.warn('Rate limited (429). Waiting ' + backoffMs + 'ms before retry...');
            retryCount = retryCount + 1;
            if (retryCount < maxRetries) {
              await new Promise(function(resolve) { setTimeout(resolve, backoffMs); });
              backoffMs = backoffMs * 2;
            } else {
              logger.error('eBay API rate limit - max retries exceeded');
              throw err;
            }
          } else {
            logger.error('eBay API request failed (status ' + status + '): ' + message);
            throw err;
          }
        }
      }

      if (!success) {
        break;
      }
    }

    logger.debug('Fetched ' + listings.length + ' NEW listings from eBay.');
    return listings;
  }

  _normalizeItem(item) {
    const price = item.price ? parseFloat(item.price.value) : 0;
    const sellerFeedback = item.seller && item.seller.feedbackScore ? parseInt(item.seller.feedbackScore, 10) : null;
    const sellerFeedbackPct = item.seller && item.seller.feedbackPercentage ? parseFloat(item.seller.feedbackPercentage) : null;

    return {
      ebayItemId: item.itemId,
      title: item.title || '',
      currentPrice: price,
      currency: item.price ? item.price.currency : 'USD',
      url: item.itemWebUrl || '',
      condition: item.condition || 'Unknown',
      listingType: item.buyingOptions ? item.buyingOptions[0] : 'FIXED_PRICE',
      seller: item.seller ? item.seller.username : null,
      sellerFeedback: sellerFeedback,
      sellerFeedbackPct: sellerFeedbackPct,
      categoryId: item.categories ? item.categories[0].categoryId : null,
      categoryName: item.categories ? item.categories[0].categoryName : null,
      imageUrl: item.image ? item.image.imageUrl : null,
      postedAt: item.itemCreationDate || null,
    };
  }

  async checkSoldItems(title, currentPrice, minPriceDifference, limit) {
    if (!minPriceDifference) minPriceDifference = 50;
    if (!limit) limit = 10;

    try {
      logger.debug('Checking SOLD items for: "' + title.substring(0, 50) + '"');
      
      const response = await axios.get(this.baseUrl + '/item_summary/search', {
        headers: await this._headers(),
        params: {
          q: title,
          sort: 'endingSoonest',
          limit: limit,
          filter: 'buyingOptions:{SOLD}',
        },
        timeout: 10000,
      });

      const itemSummaries = response.data.itemSummaries || [];
      
      if (itemSummaries.length === 0) {
        logger.debug('NO SOLD ITEMS found for: "' + title.substring(0, 50) + '"');
        return { hasSoldItems: false, recentlySoldPrice: null, priceDifference: 0, meetsThreshold: false };
      }

      const mostRecentSold = itemSummaries[0];
      const recentlySoldPrice = mostRecentSold.price ? parseFloat(mostRecentSold.price.value) : null;

      if (!recentlySoldPrice) {
        logger.debug('Could not extract sold price for: "' + title.substring(0, 50) + '"');
        return { hasSoldItems: false, recentlySoldPrice: null, priceDifference: 0, meetsThreshold: false };
      }

      const priceDifference = recentlySoldPrice - currentPrice;
      const meetsThreshold = priceDifference >= minPriceDifference;

      logger.debug('Sold items found: ' + itemSummaries.length + ' | Most recent sold: $' + recentlySoldPrice.toFixed(2) + ' | Current listing: $' + currentPrice.toFixed(2) + ' | Difference: $' + priceDifference.toFixed(2) + ' | Meets threshold: ' + (meetsThreshold ? 'YES' : 'NO'));

      return {
        hasSoldItems: true,
        recentlySoldPrice: recentlySoldPrice,
        priceDifference: priceDifference,
        meetsThreshold: meetsThreshold,
      };
    } catch (err) {
      logger.warn('Error checking sold items: ' + err.message);
      return { hasSoldItems: false, recentlySoldPrice: null, priceDifference: 0, meetsThreshold: false };
    }
  }
}

module.exports = EbayService;
