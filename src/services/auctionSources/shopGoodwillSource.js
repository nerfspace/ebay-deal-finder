'use strict';

const axios = require('axios');
const BaseAuctionSource = require('./baseSource');
const logger = require('../../utils/logger');

const BASE_URL = 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing';

const MAX_SEARCH_PRICE = 999999;

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://shopgoodwill.com',
  'Origin': 'https://shopgoodwill.com',
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

    // ShopGoodwill requires actual search terms — empty string returns 404
    const searchTerms = keywords.filter((k) => k.length > 0);
    if (searchTerms.length === 0) {
      logger.warn(`[${this.name}] No keywords configured. Skipping scan.`);
      return [];
    }

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
      searchInDescription: false,
      selectedCategoryIds: [],
      selectedSellerIds: [],
      lowPrice: 0,
      highPrice: MAX_SEARCH_PRICE,
      sortColumn: 'EndingDate',
      sortOrder: 'a',
      page: 1,
      pageSize: 40,
      categoryLevelNo: 1,
      searchCategoryLevel: 0,
      closedAuctionEndingDate: '',
      closedAuctionDaysBack: 0,
      buyNowOnly: false,
      selectedLocationIds: [],
      savedSearchName: '',
      isFeaturedSearch: false,
    };

    const response = await axios.post(BASE_URL, body, {
      headers: DEFAULT_HEADERS,
      timeout: 15000,
    });

    logger.debug(`[${this.name}] Response status: ${response.status}, size: ${JSON.stringify(response.data).length} bytes`);
    logger.debug(`[${this.name}] Response top-level keys: ${Object.keys(response.data || {}).join(', ')}`);

    const items =
      response.data?.searchResults?.items ||
      response.data?.items ||
      (Array.isArray(response.data) ? response.data : []);

    if (items.length === 0) {
      const sample = JSON.stringify(response.data).slice(0, 300);
      logger.debug(`[${this.name}] 0 items returned for keyword "${keyword}". Response sample: ${sample}`);
    } else {
      logger.debug(`[${this.name}] First normalized item sample: ${JSON.stringify(items[0]).slice(0, 200)}`);
    }

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
