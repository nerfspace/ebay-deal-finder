'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const BaseAuctionSource = require('./baseSource');
const logger = require('../../utils/logger');

const SEARCH_BASE = 'https://www.bidspotter.com/en-us/search';

const HEADERS = {
  'User-Agent': 'ebay-deal-finder/1.0 (auction-scanner)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

class BidSpotterSource extends BaseAuctionSource {
  constructor(config) {
    super('BidSpotter', config);
  }

  /**
   * Fetch auctions ending soon from BidSpotter.
   *
   * @param {number} timeWindowMinutes
   * @param {string[]} keywords
   * @returns {Promise<NormalizedItem[]>}
   */
  async fetchEndingSoon(timeWindowMinutes, keywords = []) {
    if (!this.enabled) return [];

    const searchTerms = keywords.length > 0 ? keywords : [''];
    const results = [];
    const seen = new Set();

    for (const keyword of searchTerms) {
      try {
        const items = await this._fetchPage(keyword, timeWindowMinutes);
        for (const item of items) {
          if (!seen.has(item.sourceId)) {
            seen.add(item.sourceId);
            results.push(item);
          }
        }
        await this.delay();
      } catch (err) {
        logger.warn(`[${this.name}] Error fetching keyword "${keyword}": ${err.message}`);
      }
    }

    return results;
  }

  async _fetchPage(keyword, timeWindowMinutes) {
    const params = {};
    if (keyword) params.query = keyword;

    const response = await axios.get(SEARCH_BASE, {
      params,
      headers: HEADERS,
      timeout: 15000,
    });

    return this._parseHtml(response.data, timeWindowMinutes);
  }

  _parseHtml(html, timeWindowMinutes) {
    const $ = cheerio.load(html);
    const items = [];

    // BidSpotter lot listing selectors
    $('[class*="lot"], [class*="item-card"], [class*="result-item"], article').each((_, el) => {
      try {
        const $el = $(el);

        const titleEl = $el.find('[class*="title"], [class*="lot-title"], h2, h3').first();
        const title = titleEl.text().trim();
        if (!title) return;

        const linkEl = $el.find('a[href*="/auctions/"]').first();
        const relUrl = linkEl.attr('href') || '';
        const url = relUrl.startsWith('http') ? relUrl : `https://www.bidspotter.com${relUrl}`;

        const idMatch = relUrl.match(/\/lots?\/(\d+)/i) || relUrl.match(/\/(\d+)\/?(?:[?#]|$)/);
        const itemId = idMatch ? idMatch[1] : crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);

        // Current bid
        const bidEl = $el.find('[class*="bid"], [class*="price"], [class*="current"]').first();
        const bidText = bidEl.text().replace(/[^0-9.]/g, '');
        const currentBid = parseFloat(bidText) || 0;

        // Time remaining
        const timeEl = $el.find('[class*="time"], [class*="countdown"], [class*="ends"], time').first();
        const timeText = timeEl.attr('datetime') || timeEl.text().trim();
        let timeLeftMinutes;

        // If it's an ISO datetime, calculate from it
        if (timeText && timeText.match(/^\d{4}-\d{2}-\d{2}/)) {
          timeLeftMinutes = this.calcTimeLeftMinutes(timeText);
        } else {
          timeLeftMinutes = this._parseTimeRemaining(timeText);
        }

        if (timeLeftMinutes === null || timeLeftMinutes < 0 || timeLeftMinutes > timeWindowMinutes) return;

        const endTime = new Date(Date.now() + timeLeftMinutes * 60000).toISOString();

        const imgEl = $el.find('img').first();
        const imageUrl = imgEl.attr('src') || imgEl.attr('data-src') || null;

        items.push({
          sourceId: `bidspotter-${itemId}`,
          source: this.name,
          title,
          currentBid,
          endTime,
          timeLeftMinutes,
          url,
          imageUrl,
          category: null,
          bidCount: 0,
          ebayMedianSoldPrice: null,
          projectedProfit: null,
          profitPercentage: null,
          titleSimilarity: null,
          ebayMatchCount: 0,
        });
      } catch (err) {
        logger.debug(`[${this.name}] Failed to parse listing element: ${err.message}`);
      }
    });

    return items;
  }

  /**
   * Parse time remaining string into minutes.
   */
  _parseTimeRemaining(text) {
    if (!text) return null;

    const lower = text.toLowerCase();
    if (lower.includes('ended') || lower.includes('closed') || lower.includes('expired')) return -1;
    if (lower.includes('ending soon')) return 1;

    let totalMinutes = 0;
    let matched = false;

    const days = lower.match(/(\d+)\s*d(?:ay)?s?/);
    const hours = lower.match(/(\d+)\s*h(?:our|r)?s?/);
    const minutes = lower.match(/(\d+)\s*m(?:in(?:ute)?s?)?(?!\s*o)/);
    const seconds = lower.match(/(\d+)\s*s(?:ec(?:ond)?s?)?/);

    if (days) { totalMinutes += parseInt(days[1], 10) * 1440; matched = true; }
    if (hours) { totalMinutes += parseInt(hours[1], 10) * 60; matched = true; }
    if (minutes) { totalMinutes += parseInt(minutes[1], 10); matched = true; }
    if (seconds) { matched = true; }

    if (!matched) return null;
    if (totalMinutes === 0 && seconds) totalMinutes = 1;

    return totalMinutes;
  }

  normalizeItem(raw) {
    return raw; // Already normalized in _parseHtml
  }
}

module.exports = BidSpotterSource;
