'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const BaseAuctionSource = require('./baseSource');
const logger = require('../../utils/logger');

const SEARCH_BASE = 'https://www.ha.com/c/search.zx';

const MAX_CONSECUTIVE_FAILURES = 2;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

class HeritageSource extends BaseAuctionSource {
  constructor(config) {
    super('Heritage Auctions', config);
  }

  /**
   * Fetch auctions ending soon from Heritage Auctions.
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
    let consecutiveBlocks = 0;

    for (const keyword of searchTerms) {
      try {
        const items = await this._fetchPage(keyword, timeWindowMinutes);
        consecutiveBlocks = 0;
        for (const item of items) {
          if (!seen.has(item.sourceId)) {
            seen.add(item.sourceId);
            results.push(item);
          }
        }
        await this.delay();
      } catch (err) {
        consecutiveBlocks++;
        logger.warn(`[${this.name}] Error fetching keyword "${keyword}": ${err.message}`);
        if (consecutiveBlocks >= MAX_CONSECUTIVE_FAILURES) {
          logger.warn(`[${this.name}] Multiple consecutive failures — pausing remaining keywords for this scan.`);
          break;
        }
      }
    }

    return results;
  }

  async _fetchPage(keyword, timeWindowMinutes) {
    const params = {
      N: '0',
      type: 'auction',
    };
    if (keyword) params.Ntt = keyword;

    let response;
    try {
      response = await axios.get(SEARCH_BASE, {
        params,
        headers: HEADERS,
        timeout: 15000,
      });
    } catch (err) {
      if (err.response && err.response.status === 403) {
        logger.warn(`[${this.name}] Received 403 Forbidden — site may be blocking automated requests. Skipping.`);
        return [];
      }
      throw err;
    }

    logger.debug(`[${this.name}] Response status: ${response.status}, size: ${(response.data || '').length} bytes`);

    const items = this._parseHtml(response.data, timeWindowMinutes);

    if (items.length === 0) {
      logger.debug(`[${this.name}] 0 items parsed for keyword "${keyword}". HTML sample: ${String(response.data).slice(0, 500)}`);
    } else {
      logger.debug(`[${this.name}] First item sample: ${JSON.stringify(items[0]).slice(0, 200)}`);
    }

    return items;
  }

  _parseHtml(html, timeWindowMinutes) {
    const $ = cheerio.load(html);
    const items = [];

    // Heritage Auctions lot listing selectors
    $('[class*="lot-item"], [class*="item-card"], [class*="search-result"], li.lot').each((_, el) => {
      try {
        const $el = $(el);

        const titleEl = $el.find('[class*="title"], [class*="lot-title"], h2, h3').first();
        const title = titleEl.text().trim();
        if (!title) return;

        const linkEl = $el.find('a[href*="/itm/"], a[href*="/auction/"]').first();
        const relUrl = linkEl.attr('href') || titleEl.closest('a').attr('href') || '';
        const url = relUrl.startsWith('http') ? relUrl : `https://www.ha.com${relUrl}`;

        const idMatch = relUrl.match(/\/(\d+)\/?(?:[?#]|$)/);
        const itemId = idMatch ? idMatch[1] : crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);

        // Current bid
        const bidEl = $el.find('[class*="bid"], [class*="price"], [class*="estimate"]').first();
        const bidText = bidEl.text().replace(/[^0-9.]/g, '');
        const currentBid = parseFloat(bidText) || 0;

        // Time remaining
        const timeEl = $el.find('[class*="time"], [class*="countdown"], [class*="ends"]').first();
        const timeText = timeEl.text().trim();
        const timeLeftMinutes = this._parseTimeRemaining(timeText);

        if (timeLeftMinutes === null || timeLeftMinutes < 0 || timeLeftMinutes > timeWindowMinutes) return;

        const endTime = new Date(Date.now() + timeLeftMinutes * 60000).toISOString();

        const imgEl = $el.find('img').first();
        const imageUrl = imgEl.attr('src') || imgEl.attr('data-src') || null;

        items.push({
          sourceId: `heritage-${itemId}`,
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
   * Handles: "2h 15m", "5m", "1d 3h", "45s", "Closes in 2 hours"
   */
  _parseTimeRemaining(text) {
    if (!text) return null;

    const lower = text.toLowerCase();
    if (lower.includes('ended') || lower.includes('closed') || lower.includes('expired')) return -1;
    if (lower.includes('ending soon') || lower.includes('closes soon')) return 1;

    let totalMinutes = 0;
    let matched = false;

    const days = lower.match(/(\d+)\s*d(?:ay)?s?/);
    const hours = lower.match(/(\d+)\s*h(?:our|r)?s?/);
    const minutes = lower.match(/(\d+)\s*m(?:in(?:ute)?s?)?(?!\s*o)/); // avoid "months"
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

module.exports = HeritageSource;
