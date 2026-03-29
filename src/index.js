'use strict';

const config = require('./config/config');
const logger = require('./utils/logger');
const { initDb, closeDb } = require('./database/db');
const {
  dealExists,
  saveDeal,
  markNotified,
  saveScanHistory,
  getFilterKeywords,
  auctionDealExists,
  saveAuctionDeal,
} = require('./database/queries');
const EbayService = require('./services/ebayService');
const { scoreItem } = require('./services/scoringEngine');
const FilterEngine = require('./services/filterEngine');
const NotificationService = require('./services/notificationService');
const AuctionScanner = require('./services/auctionScanner');
const { createSources } = require('./services/auctionSources');
const ListingPoller = require('./poller/listingPoller');
const dealAnalyzer = require('./analyzer/dealAnalyzer');
const apiServer = require('./api/server');

logger.setLevel(config.logging.level);

const ebayService = new EbayService(config);
const notificationService = new NotificationService(config);
const filterEngine = new FilterEngine({
  minDealScore: config.deals.minDealScore,
  minProfitThreshold: config.deals.minProfitThreshold,
  minProfitPercentage: config.deals.minProfitPercentage,
  minSellerFeedbackPct: config.deals.minSellerFeedbackPct,
  binOnly: config.deals.binOnly,
});

/**
 * Run a single scan cycle:
 *  1. Fetch recent eBay listings
 *  2. Score each listing
 *  3. Filter for high-confidence deals
 *  4. Save new deals to the database
 *  5. Send push notifications for qualifying deals
 *  6. Record scan history
 */
async function runScan() {
  const scanStart = Date.now();
  let listingsChecked = 0;
  let dealsFound = 0;
  let errors = 0;

  logger.scan(`Starting scan (target: ${config.scan.listingsPerScan} listings)...`);

  try {
    // Load custom keywords from the database
    const dbKeywords = await getFilterKeywords();
    filterEngine.loadKeywords(dbKeywords);

    // Fetch listings from eBay
    const listings = await ebayService.fetchRecentListings(config.scan.listingsPerScan);
    listingsChecked = listings.length;
    logger.scan(`Fetched ${listingsChecked} listings from eBay.`);

    // Pre-filter BEFORE making sold-item API calls to reduce the number of
    // expensive API requests (remove auctions, low-feedback sellers, bad keywords).
    const preFiltered = filterEngine.preFilter(listings);
    logger.scan(`Pre-filter: ${preFiltered.length}/${listingsChecked} listings remain after basic filters.`);

    // Cap the number of sold-item lookups per scan to stay within eBay rate limits.
    const maxChecks = config.deals.maxSoldChecksPerScan;
    const toCheck = preFiltered.slice(0, maxChecks);
    if (preFiltered.length > maxChecks) {
      logger.scan(`Capping sold-item checks at ${maxChecks} (${preFiltered.length - maxChecks} skipped).`);
    }

    // Check market prices ONCE per listing and store results.
    // Sequential calls with a proper delay to avoid rate limiting.
    logger.scan(`Checking market prices for ${toCheck.length} listings...`);
    const soldDataMap = new Map();
    const delayMs = config.deals.ebayApiDelayMs;
    for (const item of toCheck) {
      const soldData = await ebayService.checkSoldItems(
        item.title,
        item.currentPrice,
        config.deals.minProfitThreshold,
        config.deals.soldItemsPerCheck,
      );
      soldDataMap.set(item.ebayItemId, soldData);
      await ebayService.delay(delayMs);
    }

    // Score all checked listings using the pre-fetched market price data
    const scored = toCheck.map((item) => {
      const soldData = soldDataMap.get(item.ebayItemId);
      const actualSoldPrice = soldData && soldData.hasSoldItems ? soldData.medianSoldPrice : null;
      const soldMatchConfidence = soldData ? soldData.bestSimilarity : 0;
      return scoreItem(item, config.deals.minProfitThreshold, actualSoldPrice, soldMatchConfidence);
    });

    // Filter to deals using the already-computed sold data (no second API call)
    const qualifyingDeals = await filterEngine.filterDeals(scored, soldDataMap);

    // Prioritize by: highest title similarity × largest profit percentage
    qualifyingDeals.sort((a, b) => {
      const soldA = soldDataMap.get(a.ebayItemId) || {};
      const soldB = soldDataMap.get(b.ebayItemId) || {};
      const priorityA = (soldA.bestSimilarity || 0) * (soldA.profitPercentage || 0);
      const priorityB = (soldB.bestSimilarity || 0) * (soldB.profitPercentage || 0);
      return priorityB - priorityA;
    });

    logger.scan(`${qualifyingDeals.length} listing(s) passed deal filter.`);

    // Process each qualifying deal
    const dealsToNotify = [];
    for (const deal of qualifyingDeals) {
      try {
        const exists = await dealExists(deal.ebayItemId);
        if (exists) {
          logger.debug(`Deal already seen: ${deal.ebayItemId}`);
          continue;
        }

        // Persist deal to database
        const soldData = soldDataMap.get(deal.ebayItemId) || {};
        await saveDeal(deal, soldData);
        dealsFound++;

                logger.deal(
          `NEW DEAL | Score: ${deal.dealScore}/100 | ` +
          `Listed: $${deal.currentPrice.toFixed(2)} → Market: $${deal.estimatedResalePrice.toFixed(2)} | ` +
          `Profit: $${deal.expectedProfit.toFixed(2)} (${soldData.profitPercentage ? soldData.profitPercentage.toFixed(1) + '%' : 'est.'}) | ` +
          `Similarity: ${soldData.bestSimilarity ? (soldData.bestSimilarity * 100).toFixed(1) + '%' : 'N/A'} | ` +
          `Matches: ${soldData.matchCount || 0} | ` +
          `"${deal.title.substring(0, 60)}"`,
        );

        // Queue notification (don't send yet)
        await notificationService.notifyDeal(deal, soldData);
        dealsToNotify.push(deal.ebayItemId);
      } catch (dealErr) {
        logger.error(`Error processing deal ${deal.ebayItemId}: ${dealErr.message}`);
        errors++;
      }
    }

    // Send all queued notifications in one or more batches
    if (dealsToNotify.length > 0) {
      const sent = await notificationService.flushQueue();
      if (sent) {
        await Promise.all(dealsToNotify.map(id => markNotified(id)));
      }
    }
  } catch (err) {
    logger.error(`Scan failed: ${err.message}`);
    errors++;
  }

  // Save scan summary
  try {
    await saveScanHistory({ listingsChecked, dealsFound, errors });
  } catch (dbErr) {
    logger.error(`Failed to save scan history: ${dbErr.message}`);
  }

  const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
  logger.scan(
    `Scan complete in ${elapsed}s — ` +
    `${listingsChecked} checked, ${dealsFound} deals found, ${errors} errors.`,
  );

  return { listingsChecked, dealsFound, errors };
}

/**
 * Main application entry point.
 * Runs all four components in a single process for development convenience.
 * Each component is also independently startable via its own entry point.
 */
async function main() {
  logger.info('eBay Deal Finder starting up...');
  logger.info(`Scan interval: ${config.scan.intervalMinutes} minutes`);
  logger.info(`Min deal score: ${config.deals.minDealScore}`);
  logger.info(`Min profit threshold: $${config.deals.minProfitThreshold}`);

  await initDb(config.database.path);

  // Component 4: API Layer (handles /deals, /health, /ebay/notification)
  const PORT = process.env.PORT || 3000;
  await apiServer.start(PORT);

  // Component 3: Deal Analyzer (consumes new-listings queue)
  await dealAnalyzer.start();

  // Component 1: Listing Poller (discovers new listings, feeds the queue)
  const poller = new ListingPoller(config);
  poller.start();

  // Legacy scan loop (retained for backward compatibility)
  logger.info('[LEGACY] Starting legacy scan loop alongside event-driven components.');
  await runScan();
  const intervalMs = config.scan.intervalMinutes * 60 * 1000;
  const intervalId = setInterval(async () => {
    try {
      await runScan();
    } catch (err) {
      logger.error(`Unhandled error in scan loop: ${err.message}`);
    }
  }, intervalMs);
  logger.info(`Next legacy scan in ${config.scan.intervalMinutes} minutes.`);

  // Initialize and start the multi-source auction scanner (if enabled)
  let auctionScanner = null;
  if (config.auctionSources && config.auctionSources.enabled) {
    const auctionSources = createSources(config.auctionSources);
    auctionScanner = new AuctionScanner(
      config,
      ebayService,
      notificationService,
      auctionSources,
      { auctionDealExists, saveAuctionDeal },
    );
    auctionScanner.start();
  } else {
    logger.info('[AuctionScanner] Disabled via config (AUCTION_SOURCES_ENABLED=false).');
  }

  // Graceful shutdown
  async function shutdown(signal) {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    clearInterval(intervalId);
    poller.stop();
    if (auctionScanner) auctionScanner.stop();
    apiServer.stop();
    await closeDb();
    logger.info('Shutdown complete.');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
