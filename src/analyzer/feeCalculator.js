'use strict';

/**
 * Estimated outbound shipping costs by category keyword.
 * Used to compute net resale value after marketplace fees and shipping.
 */
const CATEGORY_SHIPPING = {
  Electronics: 12,
  Computers: 12,
  Cameras: 12,
  Phones: 8,
  Jewelry: 5,
  Watches: 8,
  Furniture: 35,
  Clothing: 6,
  Shoes: 8,
  Toys: 10,
  Books: 4,
  Coins: 5,
  Stamps: 4,
  Art: 20,
  Tools: 15,
  Music: 10,
  Sports: 12,
  default: 10,
};

/**
 * Calculate marketplace fees as a percentage of the resale price.
 * Default rate is 16 % (eBay + payment processor combined).
 * @param {number} resalePrice
 * @param {number} [feeRate=0.16]
 * @returns {number}
 */
function calculateFees(resalePrice, feeRate) {
  const rate = typeof feeRate === 'number' ? feeRate : 0.16;
  return resalePrice * rate;
}

/**
 * Estimate outbound shipping cost based on the item's category.
 * @param {string} category
 * @returns {number}
 */
function estimateShipping(category) {
  if (!category) return CATEGORY_SHIPPING.default;
  const catUpper = category.toUpperCase();
  for (const [key, cost] of Object.entries(CATEGORY_SHIPPING)) {
    if (key === 'default') continue;
    if (catUpper.includes(key.toUpperCase())) return cost;
  }
  return CATEGORY_SHIPPING.default;
}

/**
 * Calculate net resale value after deducting marketplace fees and shipping.
 * @param {number} medianPrice
 * @param {string} category
 * @param {number} [feeRate=0.16]
 * @returns {number}
 */
function calculateNetResaleValue(medianPrice, category, feeRate) {
  const fees = calculateFees(medianPrice, feeRate);
  const shipping = estimateShipping(category);
  return medianPrice - fees - shipping;
}

module.exports = { calculateFees, estimateShipping, calculateNetResaleValue, CATEGORY_SHIPPING };
