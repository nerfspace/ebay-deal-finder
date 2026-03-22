'use strict';

/**
 * Deal Scoring Engine — 5 layers
 *
 * 1. Value Score      — How far below estimated resale price is the listing?
 * 2. Confidence Score — How reliable is the data and seller?
 * 3. Speed Score      — How recently was the listing posted?
 * 4. Risk Score       — How risky is the deal (inverted — lower risk = higher score)?
 * 5. Execution Score  — How easy is it to buy and resell?
 *
 * Final deal score = weighted average of all 5 layers (0–100).
 */

const WEIGHTS = {
  value: 0.35,
  confidence: 0.25,
  speed: 0.15,
  risk: 0.15,
  execution: 0.10,
};

// Price thresholds for scoring adjustments
const PRICE_VERY_LOW = 5;
const PRICE_LOW = 15;
const PRICE_HIGH = 200;
const PRICE_VERY_HIGH = 500;
const PRICE_EXTREME = 1000;

// Seller feedback thresholds
const FEEDBACK_EXCELLENT = 1000;
const FEEDBACK_GREAT = 500;
const FEEDBACK_GOOD = 100;
const FEEDBACK_OK = 10;
const FEEDBACK_POOR = 5;

// Seller positive feedback percentage thresholds
const FEEDBACK_PCT_EXCELLENT = 99;
const FEEDBACK_PCT_GREAT = 98;
const FEEDBACK_PCT_GOOD = 95;
const FEEDBACK_PCT_OK = 90;
const FEEDBACK_PCT_POOR = 85;
const FEEDBACK_PCT_VERY_POOR = 80;

/**
 * Estimate the resale value of an item based on heuristics.
 * In production this would call a pricing API or historical data.
 * Here we apply reasonable multipliers based on category and condition.
 */
function estimateResalePrice(item) {
  const { currentPrice, condition, categoryName } = item;

  if (!currentPrice || currentPrice <= 0) return 0;

  // Base multiplier: new items tend to sell at near retail; used at a discount
  let multiplier = 1.4;

  const cond = (condition || '').toLowerCase();
  if (cond.includes('new')) multiplier = 1.5;
  else if (cond.includes('like new') || cond.includes('open box')) multiplier = 1.35;
  else if (cond.includes('excellent') || cond.includes('very good')) multiplier = 1.25;
  else if (cond.includes('good')) multiplier = 1.15;
  else if (cond.includes('acceptable') || cond.includes('fair')) multiplier = 1.05;
  else if (cond.includes('refurbished')) multiplier = 1.2;

  // Category adjustments
  const cat = (categoryName || '').toLowerCase();
  if (cat.includes('electronics') || cat.includes('computer')) multiplier += 0.05;
  else if (cat.includes('collectible') || cat.includes('antique')) multiplier += 0.1;
  else if (cat.includes('clothing') || cat.includes('shoes')) multiplier -= 0.1;

  return Math.round(currentPrice * multiplier * 100) / 100;
}

/**
 * Score how much value (profit potential) a listing represents.
 * Returns 0–100.
 */
function calcValueScore(currentPrice, estimatedResalePrice, minProfit) {
  if (!currentPrice || !estimatedResalePrice || estimatedResalePrice <= currentPrice) {
    return 0;
  }

  const profit = estimatedResalePrice - currentPrice;
  const margin = (profit / estimatedResalePrice) * 100;

  if (profit < minProfit) return 0;

  // Score increases with margin percentage (capped at 100)
  // 20% margin → ~40 points, 40% → ~70, 60%+ → near 100
  const score = Math.min(100, margin * 1.6);
  return Math.round(score);
}

/**
 * Score the confidence in the listing data and seller reliability.
 * Returns 0–100.
 */
function calcConfidenceScore(item) {
  let score = 50; // baseline

  // Seller feedback score bonus
  const feedback = item.sellerFeedback || 0;
  if (feedback > FEEDBACK_EXCELLENT) score += 20;
  else if (feedback > FEEDBACK_GREAT) score += 15;
  else if (feedback > FEEDBACK_GOOD) score += 10;
  else if (feedback > FEEDBACK_OK) score += 5;
  else if (feedback < FEEDBACK_POOR) score -= 20;

  // Seller positive feedback percentage
  const pct = item.sellerFeedbackPct || 0;
  if (pct >= FEEDBACK_PCT_EXCELLENT) score += 20;
  else if (pct >= FEEDBACK_PCT_GREAT) score += 15;
  else if (pct >= FEEDBACK_PCT_GOOD) score += 10;
  else if (pct >= FEEDBACK_PCT_OK) score += 5;
  else if (pct < FEEDBACK_PCT_POOR) score -= 15;
  else if (pct < FEEDBACK_PCT_VERY_POOR) score -= 25;

  // Fixed-price listings are more reliable than auctions
  if (item.listingType === 'FIXED_PRICE' || item.listingType === 'BUY_IT_NOW') {
    score += 10;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Score how recently the listing was posted (time-sensitive deals).
 * Returns 0–100.
 */
function calcSpeedScore(item) {
  if (!item.postedAt) return 50;

  const now = Date.now();
  const postedMs = new Date(item.postedAt).getTime();
  const ageMinutes = (now - postedMs) / 60000;

  if (ageMinutes < 5) return 100;
  if (ageMinutes < 15) return 90;
  if (ageMinutes < 30) return 80;
  if (ageMinutes < 60) return 70;
  if (ageMinutes < 120) return 55;
  if (ageMinutes < 240) return 40;
  if (ageMinutes < 480) return 25;
  return 10;
}

/**
 * Score the risk level of the deal (inverted — low risk → high score).
 * Returns 0–100.
 */
function calcRiskScore(item) {
  let score = 70; // baseline moderate-low risk

  const cond = (item.condition || '').toLowerCase();

  // Condition risk
  if (cond.includes('new')) score += 15;
  else if (cond.includes('like new') || cond.includes('open box')) score += 10;
  else if (cond.includes('refurbished')) score += 5;
  else if (cond.includes('for parts') || cond.includes('not working')) score -= 30;

  // Very cheap items carry higher risk of being junk
  if (item.currentPrice < PRICE_VERY_LOW) score -= 20;
  else if (item.currentPrice < PRICE_LOW) score -= 10;

  // High-value items carry more financial risk
  if (item.currentPrice > PRICE_VERY_HIGH) score -= 10;
  else if (item.currentPrice > PRICE_HIGH) score -= 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * Score how easy the deal is to execute (buy + resell).
 * Returns 0–100.
 */
function calcExecutionScore(item) {
  let score = 60; // baseline

  // Fixed-price = easy to buy immediately
  if (item.listingType === 'FIXED_PRICE' || item.listingType === 'BUY_IT_NOW') {
    score += 20;
  } else if (item.listingType === 'AUCTION') {
    score -= 10;
  }

  // Items that are too cheap are hard to resell for meaningful profit
  if (item.currentPrice < PRICE_LOW) score -= 15;

  // Very expensive items require more capital
  if (item.currentPrice > PRICE_EXTREME) score -= 20;
  else if (item.currentPrice > PRICE_VERY_HIGH) score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Score a single eBay listing across all 5 dimensions.
 * Returns the enriched item with all score fields populated.
 */
function scoreItem(item, minProfitThreshold) {
  const estimatedResalePrice = estimateResalePrice(item);
  const expectedProfit = Math.max(0, estimatedResalePrice - item.currentPrice);

  const valueScore = calcValueScore(item.currentPrice, estimatedResalePrice, minProfitThreshold);
  const confidenceScore = calcConfidenceScore(item);
  const speedScore = calcSpeedScore(item);
  const riskScore = calcRiskScore(item);
  const executionScore = calcExecutionScore(item);

  const dealScore = Math.round(
    valueScore * WEIGHTS.value +
    confidenceScore * WEIGHTS.confidence +
    speedScore * WEIGHTS.speed +
    riskScore * WEIGHTS.risk +
    executionScore * WEIGHTS.execution,
  );

  return {
    ...item,
    estimatedResalePrice,
    expectedProfit: Math.round(expectedProfit * 100) / 100,
    dealScore,
    valueScore,
    confidenceScore,
    speedScore,
    riskScore,
    executionScore,
  };
}

module.exports = { scoreItem, estimateResalePrice };
