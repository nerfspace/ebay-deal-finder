'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const { titleSimilarity } = require('../utils/similarity');

/**
 * Compute the median of an array of prices, excluding outliers
 * (values more than 2× the mean).
 */
function computeMedianPrice(prices) {
  if (prices.length === 0) return 0;
  if (prices.length === 1) return prices[0];

  var mean = prices.reduce(function(sum, p) { return sum + p; }, 0) / prices.length;
  var filtered = prices.filter(function(p) { return p <= mean * 2; });
  var validPrices = filtered.length > 0 ? filtered : prices;

  var sorted = validPrices.slice().sort(function(a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

const BROWSE_API_BASE = 'https://api.ebay.com/buy/browse/v1';
const SANDBOX_API_BASE = 'https://api.sandbox.ebay.com/buy/browse/v1';

class EbayService {
  constructor(config) {
    this.authToken = config.ebay.authToken;
    this.sandbox = config.ebay.sandbox;
    this.baseUrl = config.ebay.sandbox ? SANDBOX_API_BASE : BROWSE_API_BASE;
    this.pageSize = 200;
    this.keywords = config.scan.keywords || [];
    this.condition = config.scan.condition || 'NEW';
    this.minPrice = config.scan.minPrice || 10;
    this.maxPrice = config.scan.maxPrice || 5000;
    this.minTitleSimilarity = config.deals.minTitleSimilarity || 0.95;
    this.soldItemsPerCheck = config.deals.soldItemsPerCheck || 10;
    // Circuit breaker: track consecutive 429s across checkSoldItems calls
    this.consecutiveRateLimitErrors = 0;
    this.circuitBreakerThreshold = 5;
    this.circuitBreakerWaitMs = 60000; // 60s pause when circuit trips
  }

  async _headers() {
    return {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    };
  }
  async delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }
  
  async fetchRecentListings(total = 500) {
    var listings = [];
    var offset = 0;
    var searchTerms = [
      'tools', 'vintage', 'collectible', 'audio', 'camera', 'game',
      'electronics', 'jewelry', 'watches', 'coins', 'stamps', 'sports',
      'toys', 'art', 'antique', 'furniture', 'books', 'memorabilia',
      'musical instruments', 'photography', 'records', 'comic',
      'gaming', 'automation', 'industrial', 'machinery', 'scientific'
    ];

    logger.info('[EBAY] Fetching ' + total + ' most recent NEW listings...');
    
    while (listings.length < total) {
      var limit = Math.min(this.pageSize, total - listings.length);
      var retryCount = 0;
      var maxRetries = 3;
      var backoffMs = 1000;

      var success = false;
      var itemSummaries = [];
      var apiTotal = 0;

      while (retryCount < maxRetries && !success) {
        try {
          logger.debug('Fetching eBay listings: offset=' + offset + ', limit=' + limit + ', retry=' + retryCount);
          var filter = 'price:[' + this.minPrice + '..' + this.maxPrice + '],priceCurrency:USD,condition:{' + this.condition + '},buyingOptions:{FIXED_PRICE}';
          var q = searchTerms[Math.floor(Math.random() * searchTerms.length)];
          logger.info('[EBAY] Searching for: "' + q + '"');

          var response = await axios.get(this.baseUrl + '/item_summary/search', {
            headers: await this._headers(),
            params: { q: q, sort: 'newlyListed', limit: limit, offset: offset, fieldgroups: 'MATCHING_ITEMS', filter: filter },
            timeout: 15000,
          });

          itemSummaries = response.data.itemSummaries || [];
          apiTotal = response.data.total || 0;
          success = true;

          if (itemSummaries.length === 0) {
            logger.debug('No more listings returned by eBay API.');
            break;
          }

          listings.push.apply(listings, itemSummaries.map(this._normalizeItem.bind(this)));
          offset = offset + itemSummaries.length;
          
          await this.delay(1500);
          
          if (offset >= apiTotal || listings.length >= total) {
            break;
          }
        } catch (err) {
          var status = err.response ? err.response.status : 'N/A';
          var message = err.response ? JSON.stringify(err.response.data) : err.message;

          if (status === 429) {
            logger.warn('Rate limited (429). Waiting ' + backoffMs + 'ms before retry...');
            retryCount = retryCount + 1;
            if (retryCount < maxRetries) {
              await new Promise(function(resolve) { setTimeout(resolve, backoffMs); });
              backoffMs = backoffMs * 2;
            } else {
              logger.error('eBay API rate limit - max retries exceeded');
              throw err;
            }
          } else {
            logger.error('eBay API request failed (status ' + status + '): ' + message);
            throw err;
          }
        }
      }

      if (!success) {
        break;
      }
    }

    logger.debug('Fetched ' + listings.length + ' NEW listings from eBay.');
    return listings;
  }

  _normalizeItem(item) {
    const price = item.price ? parseFloat(item.price.value) : 0;
    const sellerFeedback = item.seller && item.seller.feedbackScore ? parseInt(item.seller.feedbackScore, 10) : null;
    const sellerFeedbackPct = item.seller && item.seller.feedbackPercentage ? parseFloat(item.seller.feedbackPercentage) : null;

    return {
      ebayItemId: item.itemId,
      title: item.title || '',
      currentPrice: price,
      currency: item.price ? item.price.currency : 'USD',
      url: item.itemWebUrl || '',
      condition: item.condition || 'Unknown',
      listingType: item.buyingOptions ? item.buyingOptions[0] : 'FIXED_PRICE',
      seller: item.seller ? item.seller.username : null,
      sellerFeedback: sellerFeedback,
      sellerFeedbackPct: sellerFeedbackPct,
      categoryId: item.categories ? item.categories[0].categoryId : null,
      categoryName: item.categories ? item.categories[0].categoryName : null,
      imageUrl: item.image ? item.image.imageUrl : null,
      postedAt: item.itemCreationDate || null,
    };
  }

  /**
   * Fetch comparable sales for a product query and return prices plus the median.
   * Uses the same Browse API search-by-title approach as checkSoldItems.
   * @param {string} query - product name or title to search for
   * @param {number} [limit=10] - max results to request
   * @returns {Promise<{ prices: number[], medianPrice: number, itemCount: number, totalListed: number }>}
   */
  async fetchComparableSales(query, limit) {
    if (!limit) limit = this.soldItemsPerCheck;

    const emptyResult = { prices: [], medianPrice: 0, itemCount: 0, totalListed: 0 };

    // Circuit breaker: if too many consecutive 429s, pause before continuing
    if (this.consecutiveRateLimitErrors >= this.circuitBreakerThreshold) {
      logger.warn(
        'Circuit breaker triggered after ' + this.consecutiveRateLimitErrors +
        ' consecutive 429 errors. Pausing ' + (this.circuitBreakerWaitMs / 1000) + 's...'
      );
      await this.delay(this.circuitBreakerWaitMs);
      this.consecutiveRateLimitErrors = 0;
    }

    var maxRetries = 3;
    var retryCount = 0;

    while (retryCount <= maxRetries) {
      try {
        logger.debug('Fetching comparable sales for: "' + (query || '').substring(0, 50) + '"');

        const response = await axios.get(this.baseUrl + '/item_summary/search', {
          headers: await this._headers(),
          params: {
            q: query,
            sort: 'price',
            limit: limit,
            filter: 'priceCurrency:USD',
          },
          timeout: 10000,
        });

        // Successful call — reset circuit breaker counter
        this.consecutiveRateLimitErrors = 0;

        const itemSummaries = response.data.itemSummaries || [];
        const totalListed = response.data.total || itemSummaries.length;

        if (itemSummaries.length === 0) return emptyResult;

        const prices = itemSummaries
          .map(function(item) { return item.price ? parseFloat(item.price.value) : null; })
          .filter(function(p) { return p && p > 0; });

        const medianPrice = computeMedianPrice(prices);

        return {
          prices: prices,
          medianPrice: medianPrice,
          itemCount: prices.length,
          totalListed: totalListed,
        };
      } catch (err) {
        var status = err.response ? err.response.status : null;

        if (status === 429 && retryCount < maxRetries) {
          this.consecutiveRateLimitErrors++;
          var retryAfterHeader = err.response.headers && err.response.headers['retry-after'];
          var retryAfterBodySecs = err.response.data && err.response.data.retry_after;
          var waitSecs = retryAfterHeader
            ? parseFloat(retryAfterHeader)
            : (retryAfterBodySecs ? parseFloat(retryAfterBodySecs) : null);
          var backoffMs = Math.pow(2, retryCount + 1) * 1000;
          var waitMs = waitSecs ? Math.max(waitSecs * 1000, backoffMs) : backoffMs;
          retryCount++;
          logger.warn(
            'Rate limited (429) on comparable sales. Waiting ' + waitMs + 'ms before retry ' +
            retryCount + '/' + maxRetries + '...'
          );
          await this.delay(waitMs);
        } else if (status === 429) {
          this.consecutiveRateLimitErrors++;
          logger.warn('Error fetching comparable sales (429 - max retries exceeded): ' + (query || '').substring(0, 50));
          return emptyResult;
        } else {
          logger.warn('Error fetching comparable sales: ' + err.message);
          return emptyResult;
        }
      }
    }

    return emptyResult;
  }

  async checkSoldItems(title, currentPrice, minPriceDifference, limit) {
    if (!minPriceDifference) minPriceDifference = 50;
    if (!limit) limit = this.soldItemsPerCheck;

    var emptyResult = { hasSoldItems: false, medianSoldPrice: null, matchCount: 0, bestSimilarity: 0, priceDifference: 0, profitPercentage: 0, meetsThreshold: false };

    // Circuit breaker: if too many consecutive 429s, pause before continuing
    if (this.consecutiveRateLimitErrors >= this.circuitBreakerThreshold) {
      logger.warn(
        'Circuit breaker triggered after ' + this.consecutiveRateLimitErrors +
        ' consecutive 429 errors. Pausing ' + (this.circuitBreakerWaitMs / 1000) + 's...'
      );
      await this.delay(this.circuitBreakerWaitMs);
      this.consecutiveRateLimitErrors = 0;
    }

    var maxRetries = 3;
    var retryCount = 0;

    while (retryCount <= maxRetries) {
      try {
        logger.debug('Checking market prices for: "' + title.substring(0, 50) + '"');

        // The Browse API does not support buyingOptions:{SOLD}. Instead we search
        // active listings with the same title and use their prices as market price.
        // Items that match the listing title with ≥95% similarity give us a reliable
        // market price to compare against.
        var response = await axios.get(this.baseUrl + '/item_summary/search', {
          headers: await this._headers(),
          params: {
            q: title,
            sort: 'price',
            limit: limit,
            filter: 'priceCurrency:USD',
          },
          timeout: 10000,
        });

        // Successful call — reset circuit breaker counter
        this.consecutiveRateLimitErrors = 0;

        var itemSummaries = response.data.itemSummaries || [];

        if (itemSummaries.length === 0) {
          logger.debug('No market items found for: "' + title.substring(0, 50) + '"');
          return emptyResult;
        }

        // Filter items by title similarity threshold
        var matchingPrices = [];
        var bestSimilarity = 0;

        for (var i = 0; i < itemSummaries.length; i++) {
          var soldItem = itemSummaries[i];
          var soldTitle = soldItem.title || '';
          var similarity = titleSimilarity(title, soldTitle);

          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
          }

          if (similarity >= this.minTitleSimilarity) {
            var price = soldItem.price ? parseFloat(soldItem.price.value) : null;
            if (price && price > 0) {
              matchingPrices.push(price);
            }
          }
        }

        if (matchingPrices.length === 0) {
          logger.debug(
            'No matching market items (best similarity: ' + (bestSimilarity * 100).toFixed(1) + '%) for: "' +
            title.substring(0, 50) + '"'
          );
          return Object.assign({}, emptyResult, { bestSimilarity: bestSimilarity });
        }

        var medianSoldPrice = computeMedianPrice(matchingPrices);
        var priceDifference = medianSoldPrice - currentPrice;
        var profitPercentage = currentPrice > 0 ? (priceDifference / currentPrice) * 100 : 0;
        var meetsThreshold = priceDifference >= minPriceDifference;

        logger.debug(
          'Market check: ' + matchingPrices.length + ' matches | Median: $' + medianSoldPrice.toFixed(2) +
          ' | Listed: $' + currentPrice.toFixed(2) +
          ' | Diff: $' + priceDifference.toFixed(2) +
          ' | Margin: ' + profitPercentage.toFixed(1) + '%' +
          ' | Best similarity: ' + (bestSimilarity * 100).toFixed(1) + '%'
        );

        return {
          hasSoldItems: true,
          medianSoldPrice: medianSoldPrice,
          matchCount: matchingPrices.length,
          bestSimilarity: bestSimilarity,
          priceDifference: priceDifference,
          profitPercentage: profitPercentage,
          meetsThreshold: meetsThreshold,
        };
      } catch (err) {
        var status = err.response ? err.response.status : null;

        if (status === 429 && retryCount < maxRetries) {
          this.consecutiveRateLimitErrors++;
          // Read Retry-After header (in seconds) or fall back to exponential backoff
          var retryAfterHeader = err.response.headers && err.response.headers['retry-after'];
          var retryAfterBodySecs = err.response.data && err.response.data.retry_after;
          var waitSecs = retryAfterHeader
            ? parseFloat(retryAfterHeader)
            : (retryAfterBodySecs ? parseFloat(retryAfterBodySecs) : null);
          // Exponential backoff: 2s, 4s, 8s — use Retry-After if larger
          var backoffMs = Math.pow(2, retryCount + 1) * 1000;
          var waitMs = waitSecs ? Math.max(waitSecs * 1000, backoffMs) : backoffMs;
          retryCount++;
          logger.warn(
            'Rate limited (429) on market check. Waiting ' + waitMs + 'ms before retry ' +
            retryCount + '/' + maxRetries + '...'
          );
          await this.delay(waitMs);
        } else if (status === 429) {
          this.consecutiveRateLimitErrors++;
          logger.warn('Error checking market prices (429 - max retries exceeded): ' + title.substring(0, 50));
          return emptyResult;
        } else {
          logger.warn('Error checking market prices: ' + err.message);
          return emptyResult;
        }
      }
    }

    return emptyResult;
  }
}

module.exports = EbayService;
