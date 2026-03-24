'use strict';

const { titleSimilarity } = require('../utils/similarity');
const logger = require('../utils/logger');

/**
 * Urgency level metadata for each time window.
 */
const TIME_WINDOWS = [
  { minutes: 5,    emoji: '🔴', label: 'ENDING IN 5 MIN',   scanIntervalMs: 2 * 60 * 1000 },
  { minutes: 30,   emoji: '🟠', label: 'ENDING IN 30 MIN',  scanIntervalMs: 5 * 60 * 1000 },
  { minutes: 60,   emoji: '🟡', label: 'ENDING IN 1 HOUR',  scanIntervalMs: 10 * 60 * 1000 },
  { minutes: 360,  emoji: '🔵', label: 'ENDING IN 6 HOURS', scanIntervalMs: 30 * 60 * 1000 },
  { minutes: 1440, emoji: '⚪', label: 'ENDING IN 1 DAY',   scanIntervalMs: 2 * 60 * 60 * 1000 },
];

class AuctionScanner {
  /**
   * @param {object}              config              - Full app config
   * @param {object}              ebayService         - EbayService instance
   * @param {object}              notificationService - NotificationService instance
   * @param {BaseAuctionSource[]} sources             - Enabled auction source instances
   * @param {object}              queries             - Database query helpers
   */
  constructor(config, ebayService, notificationService, sources, queries) {
    this.config = config;
    this.ebayService = ebayService;
    this.notificationService = notificationService;
    this.sources = sources;
    this.queries = queries;

    const cfg = config.auctionSources || {};
    this.minTitleSimilarity = cfg.minTitleSimilarity || 0.80;
    this.minProfitPercentage = cfg.minProfitPercentage || 20;

    this._intervals = [];
  }

  /**
   * Start independent scan intervals for each time window.
   */
  start() {
    if (this.sources.length === 0) {
      logger.info('[AuctionScanner] No enabled auction sources. Scanner not started.');
      return;
    }

    logger.info(
      `[AuctionScanner] Starting with ${this.sources.length} source(s): ` +
      this.sources.map((s) => s.name).join(', '),
    );

    for (const window of TIME_WINDOWS) {
      // Run immediately for the first window, then on interval
      this._runWindowScan(window).catch((err) =>
        logger.error(`[AuctionScanner] Error in initial scan (${window.label}): ${err.message}`),
      );

      const id = setInterval(() => {
        this._runWindowScan(window).catch((err) =>
          logger.error(`[AuctionScanner] Error in scan interval (${window.label}): ${err.message}`),
        );
      }, window.scanIntervalMs);

      this._intervals.push(id);
    }
  }

  /**
   * Clear all scan intervals (for graceful shutdown).
   */
  stop() {
    for (const id of this._intervals) {
      clearInterval(id);
    }
    this._intervals = [];
    logger.info('[AuctionScanner] Stopped.');
  }

  /**
   * Run a full scan cycle for a single time window across all enabled sources.
   *
   * @param {{ minutes: number, emoji: string, label: string }} window
   */
  async _runWindowScan(window) {
    logger.scan(`[AuctionScanner] Scanning ${window.label} window across ${this.sources.length} source(s)...`);

    const allDeals = [];

    for (const source of this.sources) {
      try {
        const items = await source.fetchEndingSoon(window.minutes, []);
        logger.scan(`[AuctionScanner] ${source.name}: ${items.length} item(s) ending within ${window.minutes} min`);

        for (const item of items) {
          try {
            const enriched = await this._crossReferenceEbay(item);
            if (enriched) allDeals.push({ item: enriched, window });
          } catch (err) {
            logger.debug(`[AuctionScanner] eBay cross-ref error for "${item.title}": ${err.message}`);
          }

          // Delay between eBay API calls to respect rate limits
          await this.ebayService.delay(this.config.deals.ebayApiDelayMs || 1500);
        }
      } catch (err) {
        logger.warn(`[AuctionScanner] Source ${source.name} failed: ${err.message}`);
      }
    }

    if (allDeals.length === 0) return;

    // Sort by urgency (shortest time left first), then by profit percentage descending
    allDeals.sort((a, b) => {
      if (a.item.timeLeftMinutes !== b.item.timeLeftMinutes) {
        return a.item.timeLeftMinutes - b.item.timeLeftMinutes;
      }
      return (b.item.profitPercentage || 0) - (a.item.profitPercentage || 0);
    });

    // Notify for each qualifying deal
    for (const { item, window: win } of allDeals) {
      try {
        // Avoid re-notifying the same auction
        const alreadySeen = await this.queries.auctionDealExists(item.sourceId);
        if (alreadySeen) {
          logger.debug(`[AuctionScanner] Already seen: ${item.sourceId}`);
          continue;
        }

        await this.queries.saveAuctionDeal(item);
        await this.notificationService.notifyAuctionDeal(item, win);

        logger.deal(
          `[AuctionScanner] DEAL | ${win.emoji} ${win.label} | ${item.source} | ` +
          `Bid: $${item.currentBid.toFixed(2)} → eBay: $${(item.ebayMedianSoldPrice || 0).toFixed(2)} | ` +
          `Profit: $${(item.projectedProfit || 0).toFixed(2)} (${(item.profitPercentage || 0).toFixed(1)}%) | ` +
          `Match: ${((item.titleSimilarity || 0) * 100).toFixed(1)}% | ` +
          `"${item.title.substring(0, 60)}"`,
        );
      } catch (err) {
        logger.error(`[AuctionScanner] Error saving/notifying deal: ${err.message}`);
      }
    }

    if (allDeals.length > 0) {
      await this.notificationService.flushQueue().catch((err) =>
        logger.error(`[AuctionScanner] flushQueue error: ${err.message}`),
      );
    }
  }

  /**
   * Cross-reference a non-eBay auction item against eBay's sold/completed items.
   * Returns the enriched item if it qualifies as a deal, or null if it doesn't meet thresholds.
   *
   * @param {NormalizedItem} item
   * @returns {Promise<NormalizedItem|null>}
   */
  async _crossReferenceEbay(item) {
    const soldData = await this.ebayService.checkSoldItems(
      item.title,
      item.currentBid,
      this.config.deals.minProfitThreshold || 20,
      this.config.deals.soldItemsPerCheck || 10,
    );

    if (!soldData || !soldData.hasSoldItems || soldData.matchCount === 0) return null;

    // Apply 80% similarity threshold for cross-site matching (vs 95% for eBay-to-eBay)
    if ((soldData.bestSimilarity || 0) < this.minTitleSimilarity) return null;

    const medianSoldPrice = soldData.medianSoldPrice;
    if (!medianSoldPrice || medianSoldPrice <= item.currentBid) return null;

    const projectedProfit = medianSoldPrice - item.currentBid;
    const profitPercentage = (projectedProfit / item.currentBid) * 100;

    if (profitPercentage < this.minProfitPercentage) return null;

    return {
      ...item,
      ebayMedianSoldPrice: medianSoldPrice,
      projectedProfit,
      profitPercentage,
      titleSimilarity: soldData.bestSimilarity,
      ebayMatchCount: soldData.matchCount || 0,
    };
  }
}

module.exports = AuctionScanner;
