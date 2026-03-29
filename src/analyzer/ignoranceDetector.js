'use strict';

const { MODEL_PATTERN } = require('./productIdentifier');

/**
 * Title keywords that suggest the seller is unaware of the item's true value.
 */
const VAGUE_KEYWORDS = [
  'old thing', 'lot', 'parts', 'stuff', 'misc', 'unknown', 'junk',
  'random', 'assorted', 'bundle', 'untitled', 'something',
];

/**
 * Detect signals that a seller may not know the true value of an item.
 * A higher ignorance score means the listing is more likely to be mispriced.
 *
 * Signals checked:
 *   - Vague title keywords (e.g. "lot", "misc", "old thing"): +5
 *   - Missing model number: +3
 *   - Price more than 60 % below median comparable sales: +10
 *
 * @param {{ title: string, price: number, category: string }} listing
 * @param {number} medianPrice - median comparable sales price (0 if unknown)
 * @returns {{ ignoranceBoost: number, signals: string[] }}
 */
function detect(listing, medianPrice) {
  const signals = [];
  let boost = 0;

  const titleLower = (listing.title || '').toLowerCase();

  // Check for vague title keywords
  for (const kw of VAGUE_KEYWORDS) {
    if (titleLower.includes(kw)) {
      signals.push(`vague_keyword:${kw}`);
      boost += 5;
      break; // Count only once per listing
    }
  }

  // Check for missing model number
  MODEL_PATTERN.lastIndex = 0;
  const hasModel = MODEL_PATTERN.test(listing.title || '');
  MODEL_PATTERN.lastIndex = 0;

  if (!hasModel) {
    signals.push('no_model_number');
    boost += 3;
  }

  // Unusually low price relative to comps (> 60 % below median)
  if (medianPrice > 0 && listing.price > 0) {
    const discount = (medianPrice - listing.price) / medianPrice;
    if (discount > 0.6) {
      signals.push('extreme_discount');
      boost += 10;
    }
  }

  return { ignoranceBoost: Math.min(boost, 20), signals };
}

module.exports = { detect, VAGUE_KEYWORDS };
