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
} = require('./database/queries');
const EbayService = require('./services/ebayService');
const { scoreItem } = require('./services/scoringEngine');
const FilterEngine = require('./services/filterEngine');
const NotificationService = require('./services/notificationService');

logger.setLevel(config.logging.level);

const ebayService = new EbayService(config);
const notificationService = new NotificationService(config);
const filterEngine = new FilterEngine({
  minDealScore: config.deals.minDealScore,
  minProfitThreshold: config.deals.minProfitThreshold,
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

    // Score all listings
    const scored = listings.map((item) => scoreItem(item, config.deals.minProfitThreshold));

    // Filter to deals that meet minimum thresholds
    const qualifyingDeals = filterEngine.filterDeals(scored);
    logger.scan(`${qualifyingDeals.length} listing(s) passed deal filter.`);

    // Process each qualifying deal
    for (const deal of qualifyingDeals) {
      try {
        const exists = await dealExists(deal.ebayItemId);
        if (exists) {
          logger.debug(`Deal already seen: ${deal.ebayItemId}`);
          continue;
        }

        // Persist deal to database
        await saveDeal(deal);
        dealsFound++;

        logger.deal(
          `NEW DEAL | Score: ${deal.dealScore}/100 | ` +
          `$${deal.currentPrice.toFixed(2)} → ~$${deal.estimatedResalePrice.toFixed(2)} | ` +
          `Profit: ~$${deal.expectedProfit.toFixed(2)} | ` +
          `"${deal.title.substring(0, 60)}"`,
        );

        // Send push notification
        const sent = await notificationService.notifyDeal(deal);
        if (sent) {
          await markNotified(deal.ebayItemId);
        }
      } catch (dealErr) {
        logger.error(`Error processing deal ${deal.ebayItemId}: ${dealErr.message}`);
        errors++;
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
 */
async function main() {
  logger.info('eBay Deal Finder starting up...');
  logger.info(`Scan interval: ${config.scan.intervalMinutes} minutes`);
  logger.info(`Min deal score: ${config.deals.minDealScore}`);
  logger.info(`Min profit threshold: $${config.deals.minProfitThreshold}`);

  await initDb(config.database.path);

  // Run initial scan immediately
  await runScan();

  // Schedule recurring scans
  const intervalMs = config.scan.intervalMinutes * 60 * 1000;
  const intervalId = setInterval(async () => {
    try {
      await runScan();
    } catch (err) {
      logger.error(`Unhandled error in scan loop: ${err.message}`);
    }
  }, intervalMs);

  logger.info(`Next scan in ${config.scan.intervalMinutes} minutes.`);

  // Graceful shutdown
  async function shutdown(signal) {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    clearInterval(intervalId);
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
