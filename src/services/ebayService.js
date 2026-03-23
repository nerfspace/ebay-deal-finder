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
    logger.debug(`Fetched ${listings.length} NEW listings from eBay.`);*

