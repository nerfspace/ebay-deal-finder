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
    this.pageSize = 200; // Maximum allowed by eBay Browse API per request
    
    // Store search configuration
    this.keywords = config.scan.keywords || ['laptop'];
    this.condition = config.scan.condition || 'USED';
    this.minPrice = config.scan.minPrice || 20;
    this.maxPrice = config.scan.maxPrice || 2000;
    this.currentKeywordIndex = 0;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    };
  }

  /**
   * Get the next keyword in rotation
   */
  _getNextKeyword() {
    const keyword = this.keywords[this.currentKeywordIndex];
    this.currentKeywordIndex = (this.currentKeywordIndex + 1) % this.keywords.length;
    return keyword;
  }

  /**
   * Fetch up to `total` recent listings using the eBay Browse API search endpoint.
   * The API supports a maximum of 200 items per request, so we paginate as needed.
   */
  async fetchRecentListings(total = 500) {
    const listings = [];
    let offset = 0;
    
    // Get current keyword
    const keyword = this._getNextKeyword();
    logger.info(`[EBAY] Searching for keyword: "${keyword}"`);

    while (listings.length < total) {
      const limit = Math.min(this.pageSize, total - listings.length);

      try {
        logger.debug(`Fetching eBay listings: offset=${offset}, limit=${limit}`);
        
        // Build filter string for price range and condition
        const filter = `price:[${this.minPrice}..${this.maxPrice}],priceCurrency:USD,condition:{${this.condition}}`;
        
        const response = await axios.get(`${this.baseUrl}/item_summary/search`, {
          headers: this._headers(),
          params: {
            q: keyword,  // Use specific keyword instead of wildcard
            sort: 'newlyListed',
            limit,
            offset,
            fieldgroups: 'MATCHING_ITEMS',
            filter: filter,  // Add price and condition filters
          },
          timeout: 15000,
        });

        const { itemSummaries = [], total: apiTotal = 0 } = response.data;

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

    logger.debug(`Fetched ${listings.length} listings from eBay for keyword "${keyword}".`);
    return listings;
  }

  /**
   * Normalize a raw eBay API item summary into a consistent internal format.
   */
  _normalizeItem(item) {
    const price =
      item.price ? parseFloat(item.price.value) : 0;

    const sellerFeedback =
      item.seller && item.seller.feedbackScore
        ? parseInt(item.seller.feedbackScore, 10)
        : null;

    const sellerFeedbackPct =
      item.seller && item.seller.feedbackPercentage
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
}

module.exports = EbayService;
