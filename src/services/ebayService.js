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

  _headers() {
    return {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    };
  }

  async fetchRecentListings(total = 500) {
    const listings = [];
    let offset = 0;
    logger.info(`[EBAY] Fetching ${total} most recent NEW listings...`);
    while (listings.length < total) {
      const limit = Math.min(this.pageSize, total - listings.length);
      try {
        logger.debug(`Fetching eBay listings: offset=${offset}, limit=${limit}`);
        const filter = `price:[${this.minPrice}..${this.maxPrice}],priceCurrency:USD,condition:{${this.condition}},buyingOptions:{FIXED_PRICE}`;
                const searchTerms = [
          'tools', 'vintage', 'collectible', 'audio', 'camera', 'game',
          'electronics', 'jewelry', 'watches', 'coins', 'stamps', 'sports',
          'toys', 'art', 'antique', 'furniture', 'books', 'memorabilia',
          'musical instruments', 'photography', 'stamps', 'records', 'comic',
          'gaming', 'automation', 'industrial', 'machinery', 'scientific'
        ];
        const q = searchTerms[Math.floor(Math.random() * searchTerms.length)];
        logger.info(`[EBAY] Searching for: "${q}"`);
        const response = await axios.get(`${this.baseUrl}/item_summary/search`, {
          headers: this._headers(),
          params: { q, sort: 'newlyListed', limit, offset, fieldgroups: 'MATCHING_ITEMS', filter },
          timeout: 15000,
        });
        const itemSummaries = response.data.itemSummaries || [];
        const apiTotal = response.data.total || 0;
        if (itemSummaries.length === 0) {
          logger.debug('No more listings returned by eBay API.');
          break;
        }
        listings.push(...itemSummaries.map(this._normalizeItem.bind(this)));
        offset += itemSummaries.length;
        if (offset >= apiTotal || listings.length >= total) {
          break;
        }
      } catch (err) {
        const status = err.response ? err.response.status : 'N/A';
        const message = err.response ? JSON.stringify(err.response.data) : err.message;
        logger.error(`eBay API request failed (status ${status}): ${message}`);
        throw err;
      }
    }
    logger.debug(`Fetched ${listings.length} NEW listings from eBay.`);
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
      sellerFeedback,
      sellerFeedbackPct,
      categoryId: item.categories ? item.categories[0]?.categoryId : null,
      categoryName: item.categories ? item.categories[0]?.categoryName : null,
      imageUrl: item.image ? item.image.imageUrl : null,
      postedAt: item.itemCreationDate || null,
    };
  }

  async checkSellerSize(item, maxSellerSales = 100) {
    try {
      const sellerName = item.seller;
      const feedbackScore = item.sellerFeedback;
      if (!sellerName || !feedbackScore) {
        logger.debug(`Seller info missing for: "${item.title.substring(0, 50)}"`);
        return { isSmallSeller: false, totalSales: 0, reason: 'No seller data' };
      }
      logger.debug(`Checking seller size for: ${sellerName} (feedback: ${feedbackScore})`);
      const isSmallSeller = feedbackScore <= maxSellerSales;
      logger.debug(`Seller: ${sellerName} | Total sales: ${feedbackScore} | Small seller (≤${maxSellerSales}): ${isSmallSeller ? 'YES' : 'NO'}`);
      return { isSmallSeller, totalSales: feedbackScore, reason: isSmallSeller ? 'Small seller' : `Too many sales (${feedbackScore})` };
    } catch (err) {
      logger.warn(`Error checking seller size: ${err.message}`);
      return { isSmallSeller: false, totalSales: 0, reason: 'Error' };
    }
  }

  async checkSoldItems(title, currentPrice, minPriceDifference = 50, limit = 10) {
    try {
      logger.debug(`Checking SOLD items for: "${title.substring(0, 50)}"`);
      
      // Search for SOLD items only, sorted by most recently completed
      const response = await axios.get(`${this.baseUrl}/item_summary/search`, {
        headers: await this._headers(),
        params: {
          q: title,
          sort: 'endingSoonest',  // This gives most recent sales
          limit,
          filter: 'buyingOptions:{SOLD}',
        },
        timeout: 10000,
      });

      const itemSummaries = response.data.itemSummaries || [];
      
      if (itemSummaries.length === 0) {
        logger.debug(`❌ NO SOLD ITEMS found for: "${title.substring(0, 50)}"`);
        return { hasSoldItems: false, recentlySoldPrice: null, priceDifference: 0, meetsThreshold: false };
      }

      // Get the most recent sold price (first item in results)
      const mostRecentSold = itemSummaries[0];
      const recentlySoldPrice = mostRecentSold.price ? parseFloat(mostRecentSold.price.value) : null;

      if (!recentlySoldPrice) {
        logger.debug(`❌ Could not extract sold price for: "${title.substring(0, 50)}"`);
        return { hasSoldItems: false, recentlySoldPrice: null, priceDifference: 0, meetsThreshold: false };
      }

      const priceDifference = recentlySoldPrice - currentPrice;
      const meetsThreshold = priceDifference >= minPriceDifference;

      logger.debug(
        `✅ Sold items found: ${itemSummaries.length} | ` +
        `Most recent sold: $${recentlySoldPrice.toFixed(2)} | ` +
        `Current listing: $${currentPrice.toFixed(2)} | ` +
        `Difference: $${priceDifference.toFixed(2)} | ` +
        `Meets threshold: ${meetsThreshold ? 'YES' : 'NO'}`
      );

      return {
        hasSoldItems: true,
        recentlySoldPrice,
        priceDifference,
        meetsThreshold,
      };
    } catch (err) {
      logger.warn(`Error checking sold items: ${err.message}`);
      return { hasSoldItems: false, recentlySoldPrice: null, priceDifference: 0, meetsThreshold: false };
    }
  }

module.exports = EbayService;
