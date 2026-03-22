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
        
        const searchTerms = ['tools', 'vintage', 'collectible', 'audio', 'camera', 'game'];
        const q = searchTerms[Math.floor(Math.random() * searchTerms.length)];
        logger.info(`[EBAY] Searching for: "${q}"`);

        const response = await axios.get(`${this.baseUrl}/item_summary/search`, {
          headers: this._headers(),
          params: {
            q: q,
            sort: 'newlyListed',
            limit,
            offset,
            fieldgroups: 'MATCHING_ITEMS',
            filter: filter,
          },
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
        const message = err.response
          ? JSON.stringify(err.response.data)
          : err.message;
        logger.error(`eBay API request failed (status ${status}): ${message}`);
        throw err;
      }
    }

    logger.debug(`Fetched ${listings.length} NEW listings from eBay.`);
    return listings;
  }

  _normalizeItem(item) {
    const price = item.price ? parseFloat(item.price.value) : 0;
    const sellerFeedback = item.seller && item.seller.feedbackScore
      ? parseInt(item.seller.feedbackScore, 10)
      : null;
    const sellerFeedbackPct = item.seller && item.seller.feedbackPercentage
      ? parseFloat(item.seller.feedbackPercentage)
      : null;

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

  /**
   * Search for recently sold items matching a query.
   * Returns true if matches found, false if none.
   */
  async checkSoldItems(title, limit = 5) {
    try {
      logger.debug(`Checking sold items for: "${title.substring(0, 50)}"`);
      
      const response = await axios.get(`${this.baseUrl}/item_summary/search`, {
        headers: this._headers(),
        params: {
          q: title,
          sort: 'newlyListed',
          limit,
          filter: 'buyingOptions:{SOLD}',
        },
        timeout: 10000,
      });

      const itemSummaries = response.data.itemSummaries || [];
      const hasSoldItems = itemSummaries.length > 0;
      
      if (hasSoldItems) {
        logger.debug(`✅ Found ${itemSummaries.length} sold items for: "${title.substring(0, 50)}"`);
      } else {
        logger.debug(`❌ No sold items found for: "${title.substring(0, 50)}"`);
      }
      
      return hasSoldItems;
    } catch (err) {
      logger.warn(`Error checking sold items: ${err.message}`);
      return true;
    }
  }
}

module.exports = EbayService;
