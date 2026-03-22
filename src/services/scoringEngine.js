'use strict';

/**
 * Deal Scoring Engine — 6 layers
 *
 * Deal Score =
 *   (Price Discount Score  * 0.35)
 * + (Liquidity Score       * 0.20)
 * + (Seller Score          * 0.15)
 * + (Listing Quality Score * 0.15)
 * + (Speed Score           * 0.15)
 * - (Risk Score            * 0.20)
 */

const WEIGHTS = {
  priceDiscount: 0.35,
  liquidity:     0.20,
  seller:        0.15,
  listingQuality: 0.15,
  speed:         0.15,
  risk:          0.20, // subtracted
};

// Price thresholds
const PRICE_VERY_LOW  = 5;
const PRICE_LOW       = 15;
const PRICE_HIGH      = 200;
const PRICE_VERY_HIGH = 500;
const PRICE_EXTREME   = 1000;

// Seller feedback thresholds
const FEEDBACK_EXCELLENT = 1000;
const FEEDBACK_GREAT     = 500;
const FEEDBACK_GOOD      = 100;
const FEEDBACK_OK        = 10;
const FEEDBACK_POOR      = 5;

// Seller positive feedback percentage thresholds
const FEEDBACK_PCT_EXCELLENT = 99;
const FEEDBACK_PCT_GREAT     = 98;
const FEEDBACK_PCT_GOOD      = 95;
const FEEDBACK_PCT_OK        = 90;
const FEEDBACK_PCT_POOR      = 85;
const FEEDBACK_PCT_VERY_POOR = 80;

/**
 * High-value category patterns for liquidity scoring.
 * Each entry is { patterns: string[], multiplier: number }.
 * A higher multiplier means the category is more liquid / resellable.
 */
const HIGH_VALUE_CATEGORIES = [
  { patterns: ['snap-on', 'mac tools', 'matco', 'snap on'],                                                        multiplier: 1.8 },
  { patterns: ['griswold', 'wagner', 'cast iron', 'cast-iron'],                                                     multiplier: 1.7 },
  { patterns: ['camera lens', 'camera lenses', 'dslr lens', 'mirrorless lens'],                                     multiplier: 1.6 },
  { patterns: ['appliance part', 'model number', 'oem part', 'replacement part'],                                   multiplier: 1.5 },
  { patterns: ['single stitch', 'vintage tee', 'vintage t-shirt', 'vintage shirt'],                                 multiplier: 1.6 },
  { patterns: ['game controller', 'game accessory', 'video game accessory', 'gaming accessory'],                    multiplier: 1.5 },
  { patterns: ['gold ring', 'silver ring', 'gold necklace', 'silver necklace', 'gold bracelet', '14k', '18k', '925 silver'], multiplier: 1.9 },
  { patterns: ['mid-century', 'midcentury', 'vintage lamp', 'vintage light', 'mcm decor'],                         multiplier: 1.6 },
  { patterns: ['milwaukee battery', 'dewalt battery', 'makita battery', 'power tool battery'],                     multiplier: 1.7 },
  { patterns: ['board game', 'incomplete game', 'missing pieces'],                                                  multiplier: 1.4 },
  { patterns: ['industrial', 'commercial equipment', 'restaurant equipment'],                                       multiplier: 1.5 },
  { patterns: ['pioneer receiver', 'marantz', 'vintage receiver', 'vintage amplifier', 'vintage stereo'],          multiplier: 1.7 },
  { patterns: ['golf iron', 'golf club', 'titleist', 'callaway iron', 'ping iron', 'taylormade iron'],             multiplier: 1.5 },
  { patterns: ['oem ink', 'oem toner', 'genuine ink', 'genuine toner', 'printer ink', 'printer toner'],           multiplier: 1.6 },
  { patterns: ['guitar', 'bass guitar', 'violin', 'trumpet', 'saxophone', 'instrument part', 'musical instrument'], multiplier: 1.7 },
];

/**
 * Detect if an item belongs to a high-value category.
 * Returns the multiplier (≥1.0) for that category, or 1.0 if none matches.
 */
function getHighValueMultiplier(item) {
  const haystack = `${(item.title || '')} ${(item.categoryName || '')}`.toLowerCase();

  for (const cat of HIGH_VALUE_CATEGORIES) {
    for (const pat of cat.patterns) {
      if (haystack.includes(pat)) {
        return cat.multiplier;
      }
    }
  }
  return 1.0;
}

/**
 * Estimate the resale value of an item.
 * Uses condition, category multipliers, and high-value category bonuses.
 */
function estimateResalePrice(item) {
  const { currentPrice, condition } = item;

  if (!currentPrice || currentPrice <= 0) return 0;

  // Base condition multiplier
  let multiplier = 1.4;

  const cond = (condition || '').toLowerCase();
  if (cond.includes('new'))                                           multiplier = 1.5;
  else if (cond.includes('like new') || cond.includes('open box'))   multiplier = 1.35;
  else if (cond.includes('excellent') || cond.includes('very good')) multiplier = 1.25;
  else if (cond.includes('good'))                                     multiplier = 1.15;
  else if (cond.includes('acceptable') || cond.includes('fair'))     multiplier = 1.05;
  else if (cond.includes('refurbished'))                              multiplier = 1.20;

  // Scale the condition multiplier up proportionally to the category's liquidity
  // premium, then add a flat bonus for highly-liquid categories.
  // BASE_CONDITION_MULTIPLIER (1.4) is the neutral "used" baseline.
  const BASE_CONDITION_MULTIPLIER = 1.4;
  // FLAT_LIQUIDITY_BONUS weights the raw liquidity premium (hvMultiplier - 1.0).
  const FLAT_LIQUIDITY_BONUS = 0.1;
  const hvMultiplier = getHighValueMultiplier(item);
  multiplier = multiplier * (hvMultiplier / BASE_CONDITION_MULTIPLIER) + (hvMultiplier - 1.0) * FLAT_LIQUIDITY_BONUS;

  return Math.round(currentPrice * multiplier * 100) / 100;
}

/**
 * Layer 1 — Price Discount Score (0–100).
 * Measures how far below estimated resale price the listing is.
 */
function calcPriceDiscountScore(currentPrice, estimatedResalePrice, minProfit) {
  if (!currentPrice || !estimatedResalePrice || estimatedResalePrice <= currentPrice) return 0;

  const profit = estimatedResalePrice - currentPrice;
  const margin = (profit / estimatedResalePrice) * 100;

  if (profit < minProfit) return 0;

  // 20 % margin → ~40 pts, 40 % → ~70 pts, 60 %+ → ~100 pts
  return Math.round(Math.min(100, margin * 1.6));
}

/**
 * Layer 2 — Liquidity Score (0–100).
 * How easily can this item be resold? High-value categories score higher.
 */
function calcLiquidityScore(item) {
  const multiplier = getHighValueMultiplier(item);

  // Multiplier range: 1.0 (generic) → 1.9 (jewelry). Map to 0–100.
  // 1.0 → 20 pts, 1.4 → 60 pts, 1.9 → 100 pts
  const score = ((multiplier - 1.0) / 0.9) * 80 + 20;
  return Math.round(Math.min(100, score));
}

/**
 * Layer 3 — Seller Score (0–100).
 * Evaluates seller reliability based on feedback count and percentage.
 */
function calcSellerScore(item) {
  let score = 50; // baseline

  const feedback = item.sellerFeedback || 0;
  if (feedback > FEEDBACK_EXCELLENT)      score += 20;
  else if (feedback > FEEDBACK_GREAT)     score += 15;
  else if (feedback > FEEDBACK_GOOD)      score += 10;
  else if (feedback > FEEDBACK_OK)        score += 5;
  else if (feedback < FEEDBACK_POOR)      score -= 20;

  const pct = item.sellerFeedbackPct || 0;
  if (pct >= FEEDBACK_PCT_EXCELLENT)      score += 20;
  else if (pct >= FEEDBACK_PCT_GREAT)     score += 15;
  else if (pct >= FEEDBACK_PCT_GOOD)      score += 10;
  else if (pct >= FEEDBACK_PCT_OK)        score += 5;
  else if (pct < FEEDBACK_PCT_VERY_POOR)  score -= 25;
  else if (pct < FEEDBACK_PCT_POOR)       score -= 15;

  return Math.max(0, Math.min(100, score));
}

/**
 * Layer 4 — Listing Quality Score (0–100).
 * BIN listings, good condition, reasonable price range all contribute.
 */
function calcListingQualityScore(item) {
  let score = 50; // baseline

  // BIN listings are higher quality (actionable immediately)
  if (item.listingType === 'FIXED_PRICE' || item.listingType === 'BUY_IT_NOW') {
    score += 20;
  } else if (item.listingType === 'AUCTION') {
    score -= 15;
  }

  // Condition bonuses
  const cond = (item.condition || '').toLowerCase();
  if (cond.includes('new'))                                           score += 15;
  else if (cond.includes('like new') || cond.includes('open box'))   score += 10;
  else if (cond.includes('excellent') || cond.includes('very good')) score += 8;
  else if (cond.includes('good'))                                     score += 4;
  else if (cond.includes('poor') || cond.includes('for parts'))      score -= 20;

  // Price range quality
  if (item.currentPrice < PRICE_VERY_LOW)   score -= 20;
  else if (item.currentPrice < PRICE_LOW)   score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Layer 5 — Speed Score (0–100).
 * How recently was the listing posted?
 */
function calcSpeedScore(item) {
  if (!item.postedAt) return 50;

  const ageMinutes = (Date.now() - new Date(item.postedAt).getTime()) / 60000;

  if (ageMinutes < 5)   return 100;
  if (ageMinutes < 15)  return 90;
  if (ageMinutes < 30)  return 80;
  if (ageMinutes < 60)  return 70;
  if (ageMinutes < 120) return 55;
  if (ageMinutes < 240) return 40;
  if (ageMinutes < 480) return 25;
  return 10;
}

/**
 * Layer 6 — Risk Score (0–100, subtracted in final formula).
 * Higher value means more risk; subtracted from the deal score.
 */
function calcRiskScore(item) {
  let score = 30; // baseline moderate-low risk

  const cond = (item.condition || '').toLowerCase();
  if (cond.includes('new'))                                           score -= 15;
  else if (cond.includes('like new') || cond.includes('open box'))   score -= 10;
  else if (cond.includes('refurbished'))                              score -= 5;
  else if (cond.includes('poor'))                                     score += 30;
  else if (cond.includes('for parts') || cond.includes('not working')) score += 40;

  // Very cheap items carry higher risk of being junk
  if (item.currentPrice < PRICE_VERY_LOW)   score += 20;
  else if (item.currentPrice < PRICE_LOW)   score += 10;

  // High-value items carry more financial risk
  if (item.currentPrice > PRICE_EXTREME)    score += 15;
  else if (item.currentPrice > PRICE_VERY_HIGH) score += 10;
  else if (item.currentPrice > PRICE_HIGH)  score += 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * Score a single eBay listing across all 6 dimensions.
 * Returns the enriched item with all score fields populated.
 */
function scoreItem(item, minProfitThreshold) {
  const estimatedResalePrice = estimateResalePrice(item);
  const expectedProfit = Math.max(0, estimatedResalePrice - item.currentPrice);

  const priceDiscountScore  = calcPriceDiscountScore(item.currentPrice, estimatedResalePrice, minProfitThreshold);
  const liquidityScore      = calcLiquidityScore(item);
  const sellerScore         = calcSellerScore(item);
  const listingQualityScore = calcListingQualityScore(item);
  const speedScore          = calcSpeedScore(item);
  const riskScore           = calcRiskScore(item);

  const dealScore = Math.round(
    priceDiscountScore  * WEIGHTS.priceDiscount +
    liquidityScore      * WEIGHTS.liquidity +
    sellerScore         * WEIGHTS.seller +
    listingQualityScore * WEIGHTS.listingQuality +
    speedScore          * WEIGHTS.speed -
    riskScore           * WEIGHTS.risk,
  );

  return {
    ...item,
    estimatedResalePrice,
    expectedProfit: Math.round(expectedProfit * 100) / 100,
    dealScore: Math.max(0, dealScore),
    priceDiscountScore,
    liquidityScore,
    sellerScore,
    listingQualityScore,
    speedScore,
    riskScore,
  };
}

module.exports = { scoreItem, estimateResalePrice, getHighValueMultiplier };

