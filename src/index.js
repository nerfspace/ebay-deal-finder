'use strict';

const express = require('express');
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
const ebayWebhookRouter = require('./routes/ebayWebhook');

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

// Create Express app
const app = express();
app.use(express.json());

// Register webhook routes
app.use('/ebay', ebayWebhookRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
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

    // Check market prices ONCE per listing and store results.
    // Sequential calls with a short delay to avoid rate limiting.
    logger.scan(`Checking market prices for ${listingsChecked} listings...`);
    const soldDataMap = new Map();
    for (const item of listings) {
      const soldData = await ebayService.checkSoldItems(
        item.title,
        item.currentPrice,
        config.deals.minProfitThreshold,
        config.deals.soldItemsPerCheck,
      );
      soldDataMap.set(item.ebayItemId, soldData);
      await ebayService.delay(200);
    }

    // Score all listings using the pre-fetched market price data
    const scored = listings.map((item) => {
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

        // Send push notification
        const sent = await notificationService.notifyDeal(deal, soldData);
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

  // Start Express server
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`[SERVER] Listening on port ${PORT}`);
    logger.info(`[WEBHOOK] Ready to receive eBay notifications at /ebay/notification`);
  });

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
