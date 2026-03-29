'use strict';

const axios = require('axios');
const config = require('../config/config');
const logger = require('../utils/logger');
const { enqueue } = require('../queue/queueManager');

const QUEUE_NAME = 'new-listings';

/** Maximum number of listing IDs to retain in the seen-ID set before pruning. */
const MAX_SEEN_IDS = 50000;
/** Number of oldest IDs to drop when the seen set hits MAX_SEEN_IDS. */
const PRUNE_COUNT = 10000;

/** Pool of realistic browser user-agent strings rotated on every request. */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

const SEARCH_TERMS = [
  'electronics', 'tools', 'camera', 'laptop', 'jewelry', 'watches',
  'coins', 'vintage', 'gaming', 'audio', 'collectible', 'sports',
  'photography', 'musical instruments', 'antique',
];

const BROWSE_API_BASE = 'https://api.ebay.com/buy/browse/v1';
const SANDBOX_API_BASE = 'https://api.sandbox.ebay.com/buy/browse/v1';

class ListingPoller {
  constructor(cfg) {
    this.config = cfg;
    this.seenIds = new Set();
    this.running = false;
    this.pollCount = 0;
    this.baseUrl = cfg.ebay.sandbox ? SANDBOX_API_BASE : BROWSE_API_BASE;
    this.proxyUrls = (cfg.poller && cfg.poller.proxyUrls) ? cfg.poller.proxyUrls : [];
    this.proxyIndex = 0;
    this.minIntervalMs = (cfg.poller && cfg.poller.minIntervalMs) ? cfg.poller.minIntervalMs : 5000;
    this.maxIntervalMs = (cfg.poller && cfg.poller.maxIntervalMs) ? cfg.poller.maxIntervalMs : 15000;
    this._timeoutHandle = null;
  }

  /** Returns a random delay between minIntervalMs and maxIntervalMs. */
  _randomDelay() {
    return Math.floor(Math.random() * (this.maxIntervalMs - this.minIntervalMs + 1)) + this.minIntervalMs;
  }

  /** Returns a random user-agent string from the pool. */
  _randomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  /** Returns the next proxy URL from the rotation (or null if none configured). */
  _nextProxy() {
    if (this.proxyUrls.length === 0) return null;
    const proxy = this.proxyUrls[this.proxyIndex % this.proxyUrls.length];
    this.proxyIndex++;
    return proxy;
  }

  /**
   * Fetch only the first page of eBay search results sorted by newest listings.
   * @returns {Promise<object[]>} raw eBay itemSummary objects
   */
  async _fetchFirstPage() {
    const q = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];

    const headers = {
      Authorization: `Bearer ${this.config.ebay.authToken}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'User-Agent': this._randomUserAgent(),
    };

    const params = {
      q,
      sort: 'newlyListed',
      limit: 50,
      offset: 0,
      fieldgroups: 'MATCHING_ITEMS',
      filter: `price:[${this.config.scan.minPrice}..${this.config.scan.maxPrice}],priceCurrency:USD,buyingOptions:{FIXED_PRICE}`,
    };

    const axiosOptions = { headers, params, timeout: 15000 };

    const proxyUrl = this._nextProxy();
    if (proxyUrl) {
      const parsed = new URL(proxyUrl);
      axiosOptions.proxy = {
        host: parsed.hostname,
        port: parseInt(parsed.port, 10) || 80,
        protocol: parsed.protocol.replace(':', ''),
      };
    }

    const response = await axios.get(`${this.baseUrl}/item_summary/search`, axiosOptions);
    return response.data.itemSummaries || [];
  }

  /**
   * Convert a raw eBay itemSummary into a queue message.
   * @param {object} item
   * @returns {object} queue message
   */
  _toQueueMessage(item) {
    const price = item.price ? parseFloat(item.price.value) : 0;
    const shippingCost =
      item.shippingOptions &&
      item.shippingOptions[0] &&
      item.shippingOptions[0].shippingCost
        ? parseFloat(item.shippingOptions[0].shippingCost.value)
        : 0;
    const sellerFeedback =
      item.seller && item.seller.feedbackScore
        ? parseInt(item.seller.feedbackScore, 10)
        : null;
    const category =
      item.categories && item.categories[0]
        ? item.categories[0].categoryName
        : 'Unknown';

    return {
      listing_id: item.itemId,
      title: item.title || '',
      price,
      shipping_cost: shippingCost,
      seller_feedback: sellerFeedback,
      category,
      listing_url: item.itemWebUrl || '',
      timestamp_detected: new Date().toISOString(),
    };
  }

  /** Execute one poll cycle. */
  async _poll() {
    this.pollCount++;
    logger.debug(`[Poller] Poll #${this.pollCount} starting...`);

    try {
      const items = await this._fetchFirstPage();
      let newCount = 0;

      for (const item of items) {
        const id = item.itemId;
        if (!id) continue;

        if (!this.seenIds.has(id)) {
          this.seenIds.add(id);
          // Skip enqueueing on the very first poll — that run seeds the seen set
          // so we avoid flooding the queue with already-existing listings.
          if (this.pollCount > 1) {
            enqueue(QUEUE_NAME, this._toQueueMessage(item));
            newCount++;
          }
        }
      }

      // Prune the seen-ID set if it exceeds the maximum size to prevent
      // unbounded memory growth in long-running processes.
      if (this.seenIds.size > MAX_SEEN_IDS) {
        const toDelete = Array.from(this.seenIds).slice(0, PRUNE_COUNT);
        for (const id of toDelete) this.seenIds.delete(id);
        logger.debug(`[Poller] Pruned ${PRUNE_COUNT} old IDs from seen set (size: ${this.seenIds.size})`);
      }

      logger.scan(
        `[Poller] Poll #${this.pollCount}: ${items.length} fetched, ` +
          `${newCount} new enqueued (seen: ${this.seenIds.size})`,
      );
    } catch (err) {
      logger.error(`[Poller] Poll #${this.pollCount} failed: ${err.message}`);
    }
  }

  /** Schedule the next poll after a random delay. */
  _scheduleNext() {
    if (!this.running) return;
    const delay = this._randomDelay();
    logger.debug(`[Poller] Next poll in ${delay}ms`);
    this._timeoutHandle = setTimeout(async () => {
      await this._poll();
      this._scheduleNext();
    }, delay);
  }

  /** Start the poller. The first poll runs immediately to seed the seen-ID set. */
  async start() {
    if (this.running) return;
    this.running = true;
    logger.info(
      `[Poller] Starting — interval: ${this.minIntervalMs}–${this.maxIntervalMs}ms`,
    );
    await this._poll();
    this._scheduleNext();
  }

  /** Stop the poller. */
  stop() {
    this.running = false;
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
    logger.info('[Poller] Stopped.');
  }
}

module.exports = ListingPoller;

// Standalone entry point: `node src/poller/listingPoller.js`
if (require.main === module) {
  const poller = new ListingPoller(config);
  poller.start().catch((err) => {
    logger.error(`[Poller] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
