'use strict';

/**
 * Abstract base class for all external auction sources.
 * Each source must extend this class and implement fetchEndingSoon() and normalizeItem().
 */
class BaseAuctionSource {
  /**
   * @param {string} name - Human-readable source name (e.g. 'ShopGoodwill')
   * @param {object} config - Source-specific config { enabled, delayMs }
   */
  constructor(name, config) {
    this.name = name;
    this.enabled = config.enabled !== false;
    this.delayMs = config.delayMs || 2000;
  }

  /**
   * Fetch auctions ending within the specified time window.
   * Must be implemented by subclasses.
   *
   * @param {number} timeWindowMinutes - Only return items ending within this many minutes
   * @param {string[]} keywords - Optional search keywords
   * @param {object} options - Additional source-specific options
   * @returns {Promise<NormalizedItem[]>}
   */
  async fetchEndingSoon(timeWindowMinutes, keywords, options) {
    throw new Error(`${this.name}: fetchEndingSoon() must be implemented`);
  }

  /**
   * Normalize a raw API/scrape result into the standard item format.
   * Must be implemented by subclasses.
   *
   * @param {object} raw - Raw item data from the source
   * @returns {NormalizedItem}
   */
  normalizeItem(raw) {
    throw new Error(`${this.name}: normalizeItem() must be implemented`);
  }

  /**
   * Pause execution for this.delayMs milliseconds (rate-limiting helper).
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms || this.delayMs));
  }

  /**
   * Calculate minutes remaining until an ISO timestamp.
   *
   * @param {string|Date} endTime - ISO timestamp or Date of auction end
   * @returns {number} Minutes remaining (may be negative if already ended)
   */
  calcTimeLeftMinutes(endTime) {
    const end = new Date(endTime).getTime();
    const now = Date.now();
    return Math.round((end - now) / 60000);
  }
}

/**
 * @typedef {object} NormalizedItem
 * @property {string} sourceId       - Unique ID per source (e.g. 'shopgoodwill-12345')
 * @property {string} source         - Source name (e.g. 'ShopGoodwill')
 * @property {string} title          - Auction item title
 * @property {number} currentBid     - Current bid price in USD
 * @property {string} endTime        - ISO 8601 timestamp of auction end
 * @property {number} timeLeftMinutes - Minutes remaining until end
 * @property {string} url            - Direct URL to the auction listing
 * @property {string|null} imageUrl  - Thumbnail image URL (if available)
 * @property {string|null} category  - Item category (if available)
 * @property {number} bidCount       - Number of bids placed
 * @property {number|null} ebayMedianSoldPrice - Populated after eBay cross-reference
 * @property {number|null} projectedProfit     - Populated after eBay cross-reference
 * @property {number|null} profitPercentage    - Populated after eBay cross-reference
 * @property {number|null} titleSimilarity     - Populated after eBay cross-reference
 * @property {number} ebayMatchCount           - Populated after eBay cross-reference
 */

module.exports = BaseAuctionSource;
