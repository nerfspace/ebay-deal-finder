'use strict';

/**
 * Dictionary of known brands used for product identification.
 * Ordered roughly by frequency to short-circuit the search early.
 */
const KNOWN_BRANDS = [
  'Apple', 'Samsung', 'Sony', 'Canon', 'Nikon', 'DeWalt', 'Milwaukee',
  'Snap-on', 'Snap-On', 'LG', 'HP', 'Dell', 'Lenovo', 'Asus', 'Acer',
  'Microsoft', 'Bose', 'JBL', 'Dyson', 'iRobot', 'Makita', 'Bosch',
  'Ryobi', 'Craftsman', 'Black+Decker', 'GoPro', 'DJI', 'Leica',
  'Fujifilm', 'Olympus', 'Panasonic', 'Philips', 'Garmin', 'Fitbit',
  'Nintendo', 'Logitech', 'Motorola', 'OnePlus', 'Google', 'Amazon',
  'Vitamix', 'KitchenAid', 'Cuisinart', 'Breville', 'Nespresso', 'Keurig',
  'Tiffany', 'Rolex', 'Omega', 'Seiko', 'Casio',
];

/**
 * Regex pattern for common alphanumeric model numbers.
 * Matches patterns like: A2894, SM-G998U, DCF887, RTX3080, M1 Pro
 */
const MODEL_PATTERN = /\b([A-Z]{1,5}-?[0-9]{2,6}[A-Z0-9]*|[0-9]{2,4}[A-Z]{1,5}[0-9]{0,4})\b/g;

/**
 * Identify brand and model number from a listing title using pattern matching.
 * @param {string} title
 * @returns {{ brand: string|null, model: string|null, productName: string|null }}
 */
function identify(title) {
  if (!title) return { brand: null, model: null, productName: null };

  const upperTitle = title.toUpperCase();

  // Find the first known brand present in the title
  let brand = null;
  for (const b of KNOWN_BRANDS) {
    if (upperTitle.includes(b.toUpperCase())) {
      brand = b;
      break;
    }
  }

  // Find model number(s) — reset lastIndex each time since we reuse the regex
  MODEL_PATTERN.lastIndex = 0;
  const models = title.match(MODEL_PATTERN);
  MODEL_PATTERN.lastIndex = 0;
  const model = models && models.length > 0 ? models[0] : null;

  const productName = brand && model
    ? `${brand} ${model}`
    : brand || null;

  return { brand, model, productName };
}

module.exports = { identify, KNOWN_BRANDS, MODEL_PATTERN };
