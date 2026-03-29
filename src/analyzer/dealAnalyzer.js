'use strict';

const config = require('../config/config');
const logger = require('../utils/logger');
const { consume } = require('../queue/queueManager');
const { identify } = require('./productIdentifier');
const { calculateNetResaleValue } = require('./feeCalculator');
const { assess } = require('./riskAssessor');
const { detect } = require('./ignoranceDetector');
const EbayService = require('../services/ebayService');
const { initDb } = require('../database/db');
const { listingExists, saveListing, saveScore } = require('../database/queries');

const QUEUE_NAME = 'new-listings';
const CONCURRENCY = 3;

let ebayService = null;
let activeJobs = 0;

/** EventEmitter used to signal when a concurrency slot becomes available. */
const { EventEmitter } = require('events');
const slotEmitter = new EventEmitter();
slotEmitter.setMaxListeners(100);

/**
 * Run the 12-step deal analysis pipeline on a single queue message.
 *
 * @param {object} message - queue message from the listing poller
 * @returns {Promise<{ listing_id: string, dealScore: number, profit: number }|null>}
 */
async function analyze(message) {
  const {
    listing_id,
    title,
    price,
    shipping_cost,
    seller_feedback,
    category,
    listing_url,
    timestamp_detected,
  } = message;

  logger.debug(`[Analyzer] Processing ${listing_id}: "${(title || '').substring(0, 50)}"`);

  try {
    // Step 1: Feature Extraction
    // Core fields already extracted by the poller (title, price, shipping_cost,
    // seller_feedback, category). Condition is derived from title for future use.

    // Step 2: Product Identification
    const productInfo = identify(title);

    // Step 3: Comparable Sales Lookup (median resale price)
    const searchQuery = productInfo.productName || title;
    const compSales = await ebayService.fetchComparableSales(searchQuery, 10);
    const medianPrice = compSales.medianPrice || 0;
    const itemCount = compSales.itemCount || 0;
    const totalListed = compSales.totalListed || Math.max(itemCount * 2, 1);

    // Step 4: True Purchase Cost
    const trueCost = (price || 0) + (shipping_cost || 0);

    // Step 5: Estimate Net Resale Value
    const feeRate = config.marketplace ? config.marketplace.feeRate : 0.16;
    const netResaleValue = calculateNetResaleValue(medianPrice, category, feeRate);

    // Step 6: Profit Calculation
    const profit = netResaleValue - trueCost;

    // Step 7: Risk Adjustments
    const riskResult = assess({ title, seller_feedback, price, medianPrice });
    const adjustedProfit = profit * riskResult.riskMultiplier;

    // Step 8: Liquidity Score (sell-through rate)
    const sellThroughRate = totalListed > 0
      ? Math.min(itemCount / totalListed, 1.0)
      : 0.5;

    // Step 9: Ignorance Signals
    const ignoranceResult = detect({ title, price, category }, medianPrice);

    // Step 10: Deal Score Calculation (0–100 weighted formula)
    const normalizedProfit = medianPrice > 0
      ? Math.max(0, Math.min(adjustedProfit / medianPrice, 1))
      : 0;
    const discountVsMarket = medianPrice > 0
      ? Math.max(0, Math.min((medianPrice - trueCost) / medianPrice, 1))
      : 0;
    const riskPenalty = riskResult.riskPenalty;

    let dealScore =
      (0.4 * normalizedProfit) +
      (0.3 * discountVsMarket) +
      (0.2 * sellThroughRate) -
      (0.1 * riskPenalty);

    // Scale to 0–100 and apply ignorance boost
    dealScore = dealScore * 100;
    dealScore = Math.min(100, Math.max(0, dealScore + ignoranceResult.ignoranceBoost));

    const confidence = medianPrice > 0 ? Math.min(1, itemCount / 5) : 0.1;

    logger.debug(
      `[Analyzer] ${listing_id}: score=${dealScore.toFixed(1)}, ` +
        `profit=$${adjustedProfit.toFixed(2)}, ` +
        `risk=${riskResult.riskMultiplier.toFixed(2)}, ` +
        `signals=[${ignoranceResult.signals.join(',')}]`,
    );

    // Step 11: Database Storage
    await saveListing({
      listing_id,
      title,
      price,
      shipping_cost: shipping_cost || 0,
      seller_feedback: seller_feedback || null,
      category,
      listing_url,
      timestamp_detected,
    });

    await saveScore({
      listing_id,
      deal_score: dealScore,
      estimated_profit: adjustedProfit,
      risk_score: riskResult.riskPenalty,
      sell_through_rate: sellThroughRate,
      confidence,
      analyzed_at: new Date().toISOString(),
    });

    if (dealScore >= 80) {
      logger.deal(
        `[Analyzer] DEAL FOUND | Score: ${dealScore.toFixed(1)} | ` +
          `Profit: $${adjustedProfit.toFixed(2)} | ` +
          `"${(title || '').substring(0, 60)}"`,
      );
    }

    return { listing_id, dealScore, profit: adjustedProfit };
  } catch (err) {
    logger.error(`[Analyzer] Error analyzing ${listing_id}: ${err.message}`);
    return null;
  }
}

/**
 * Handle a queue message with an event-based concurrency limiter.
 * Waits for a processing slot to become available before starting analysis.
 * @param {object} message
 */
async function handleMessage(message) {
  // Wait until a concurrency slot is free
  while (activeJobs >= CONCURRENCY) {
    await new Promise((resolve) => slotEmitter.once('slot-free', resolve));
  }

  // Deduplicate: skip listings we have already stored
  try {
    const exists = await listingExists(message.listing_id);
    if (exists) {
      logger.debug(`[Analyzer] Already analyzed ${message.listing_id}, skipping.`);
      return;
    }
  } catch (_err) {
    // DB may not be initialised in test contexts — proceed anyway
  }

  activeJobs++;
  try {
    await analyze(message);
  } finally {
    activeJobs--;
    slotEmitter.emit('slot-free');
  }
}

/**
 * Start the deal analyzer: initialise DB, create eBay service, and subscribe
 * to the new-listings queue.
 */
async function start() {
  logger.info('[Analyzer] Starting deal analyzer...');
  await initDb(config.database.path);
  ebayService = new EbayService(config);
  consume(QUEUE_NAME, handleMessage);
  logger.info(`[Analyzer] Listening on queue: ${QUEUE_NAME}`);
}

module.exports = { start, analyze, handleMessage };

// Standalone entry point: `node src/analyzer/dealAnalyzer.js`
if (require.main === module) {
  start().catch((err) => {
    logger.error(`[Analyzer] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
