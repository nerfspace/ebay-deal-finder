'use strict';

const axios = require('axios');
const BaseAuctionSource = require('./baseSource');
const logger = require('../../utils/logger');

const BASE_URL = 'https://shopgoodwill.com/api/search/search';

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'ebay-deal-finder/1.0 (auction-scanner)',
  'Referer': 'https://shopgoodwill.com',
};

class ShopGoodwillSource extends BaseAuctionSource {
  constructor(config) {
    super('ShopGoodwill', config);
  }

  /**
   * Fetch auctions ending within timeWindowMinutes from ShopGoodwill.
   *
   * @param {number} timeWindowMinutes
   * @param {string[]} keywords
   * @returns {Promise<NormalizedItem[]>}
   */
  async fetchEndingSoon(timeWindowMinutes, keywords = []) {
    if (!this.enabled) return [];

    const searchTerms = keywords.length > 0 ? keywords : [''];
    const results = [];
    const seen = new Set();

    for (const keyword of searchTerms) {
      try {
        const items = await this._fetchPage(keyword, timeWindowMinutes);
        for (const item of items) {
          if (!seen.has(item.sourceId)) {
            seen.add(item.sourceId);
            results.push(item);
          }
        }
        await this.delay();
      } catch (err) {
        logger.warn(`[${this.name}] Error fetching keyword "${keyword}": ${err.message}`);
      }
    }

    return results;
  }

  async _fetchPage(keyword, timeWindowMinutes) {
    const body = {
      searchText: keyword,
      selectedCategoryIds: '',
      selectedSellerIds: '',
      lowPrice: 0,
      highPrice: 9999,
      sortColumn: 'EndDate',
      sortOrder: 'ASC',
      pageNumber: 1,
      pageSize: 40,
      isGetAllPages: false,
      isGet498Only: false,
      selectedLocationIds: '',
      closedAuctionDaysBack: 0,
      useBuyNowSearch: false,
      isFeaturedSearch: false,
    };

    const response = await axios.post(BASE_URL, body, {
      headers: DEFAULT_HEADERS,
      timeout: 15000,
    });

    const items = response.data?.searchResults?.items || [];
    const normalized = [];

    for (const raw of items) {
      try {
        const item = this.normalizeItem(raw);
        if (item.timeLeftMinutes >= 0 && item.timeLeftMinutes <= timeWindowMinutes) {
          normalized.push(item);
        }
      } catch (err) {
        logger.debug(`[${this.name}] Failed to normalize item: ${err.message}`);
      }
    }

    return normalized;
  }

  normalizeItem(raw) {
    const endTime = raw.endTime || raw.EndTime || raw.endDate || '';
    const timeLeftMinutes = this.calcTimeLeftMinutes(endTime);

    return {
      sourceId: `shopgoodwill-${raw.itemId || raw.ItemId}`,
      source: this.name,
      title: raw.title || raw.Title || 'Unknown',
      currentBid: parseFloat(raw.currentPrice || raw.CurrentPrice || 0),
      endTime: endTime ? new Date(endTime).toISOString() : '',
      timeLeftMinutes,
      url: `https://shopgoodwill.com/item/${raw.itemId || raw.ItemId}`,
      imageUrl: raw.smallImageUrl || raw.imageUrl || null,
      category: raw.categoryName || raw.CategoryName || null,
      bidCount: parseInt(raw.numBids || raw.NumBids || 0, 10),
      ebayMedianSoldPrice: null,
      projectedProfit: null,
      profitPercentage: null,
      titleSimilarity: null,
      ebayMatchCount: 0,
    };
  }
}

module.exports = ShopGoodwillSource;
