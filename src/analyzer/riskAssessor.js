'use strict';

/**
 * Keywords in listing titles that signal elevated resale risk.
 * Each matched keyword increases the risk penalty.
 */
const RISK_KEYWORDS = [
  'untested', 'for parts', 'as-is', 'as is', 'not working', 'broken',
  'damaged', 'defective', 'spares', 'repair', 'cracked', 'faulty',
];

/**
 * Assess risk signals for a listing and return a risk multiplier (0.5–1.0).
 *
 * Risk factors:
 *   - Low seller feedback count (< 10): +0.25 penalty
 *   - New seller account (10–49 feedback): +0.10 penalty
 *   - Up to 3 matched risk keywords in title: +0.15 each (max 0.45 from keywords)
 *
 * @param {{ title: string, seller_feedback: number|null }} listing
 * @returns {{ riskMultiplier: number, riskPenalty: number, flags: string[] }}
 */
function assess(listing) {
  const flags = [];
  let penalty = 0;

  const titleLower = (listing.title || '').toLowerCase();

  // Check title for risk keywords — cap at 3 matches
  let keywordMatches = 0;
  for (const kw of RISK_KEYWORDS) {
    if (keywordMatches >= 3) break;
    if (titleLower.includes(kw)) {
      flags.push(`keyword:${kw}`);
      penalty += 0.15;
      keywordMatches++;
    }
  }

  // Evaluate seller feedback count
  const feedback = listing.seller_feedback;
  if (feedback !== null && feedback !== undefined) {
    if (feedback < 10) {
      flags.push('low_feedback');
      penalty += 0.25;
    } else if (feedback < 50) {
      flags.push('new_seller');
      penalty += 0.1;
    }
  }

  // Clamp: maximum penalty is 0.5, so multiplier never drops below 0.5
  penalty = Math.min(penalty, 0.5);

  return {
    riskMultiplier: 1.0 - penalty,
    riskPenalty: penalty,
    flags,
  };
}

module.exports = { assess, RISK_KEYWORDS };
