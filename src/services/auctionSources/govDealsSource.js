'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const BaseAuctionSource = require('./baseSource');
const logger = require('../../utils/logger');

// GovDeals RSS feed — category 0 returns all categories
const RSS_BASE = 'https://www.govdeals.com/rss/index.cfm';

// Default time-left in minutes when end date cannot be parsed (GovDeals auctions typically run for days)
const DEFAULT_TIME_LEFT_MINUTES = 1440;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
};

class GovDealsSource extends BaseAuctionSource {
  constructor(config) {
    super('GovDeals', config);
  }

  /**
   * Fetch auctions ending soon from GovDeals RSS feeds.
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
        const items = await this._fetchRss(keyword, timeWindowMinutes);
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

  async _fetchRss(keyword, timeWindowMinutes) {
    const params = {
      fa: 'Main.CategorySearchRSS',
      category: '0',
    };
    if (keyword) params.kWord = keyword;

    const response = await axios.get(RSS_BASE, {
      params,
      headers: HEADERS,
      timeout: 15000,
      responseType: 'text',
    });

    logger.debug(`[${this.name}] Response status: ${response.status}, size: ${(response.data || '').length} bytes`);

    return this._parseRss(response.data, timeWindowMinutes);
  }

  _parseRss(xml, timeWindowMinutes) {
    const items = [];

    // Simple regex-based RSS item extraction to avoid heavy XML dependency
    const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

    // Multiple date patterns to handle GovDeals' various formats:
    // "Bid Closing Date: 03/25/2026 3:00 PM ET"
    // "Closes: March 25, 2026"
    // "Sale Closing Date: 3/25/2026"
    const datePatterns = [
      /(?:closing|closes?|end(?:ing)?)\s*(?:date)?[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?(?:\s*[A-Z]{2,4})?)?)/i,
      /(?:closing|closes?|end(?:ing)?)\s*(?:date)?[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
      /(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*[A-Z]{2,4})/i,
      /ends?[:\s]+([A-Za-z]+ \d+,?\s*\d{4}[^<]*)/i,
    ];

    for (const block of itemBlocks) {
      try {
        const title = this._extractTag(block, 'title');
        const link = this._extractTag(block, 'link');
        const description = this._extractTag(block, 'description');
        const pubDate = this._extractTag(block, 'pubDate');

        if (!title || !link) continue;

        // Try to extract item ID from link
        const idMatch = link.match(/itemNo=(\d+)/i) || link.match(/\/(\d+)\/?$/);
        const itemId = idMatch ? idMatch[1] : crypto.createHash('sha1').update(link).digest('hex').slice(0, 16);

        let endTime = '';
        let timeLeftMinutes = 0;
        let dateParsed = false;

        // Try each date pattern against the description
        if (description) {
          for (const pattern of datePatterns) {
            const match = description.match(pattern);
            if (match) {
              // Strip timezone abbreviations before parsing (Date() handles UTC offsets not tz names)
              const dateStr = match[1].replace(/\s+[A-Z]{2,4}$/, '').trim();
              const parsed = new Date(dateStr);
              if (!isNaN(parsed.getTime())) {
                endTime = parsed.toISOString();
                timeLeftMinutes = this.calcTimeLeftMinutes(endTime);
                dateParsed = true;
                break;
              }
            }
          }

          if (!dateParsed) {
            logger.debug(`[${this.name}] Could not parse end date. Description sample: ${description.slice(0, 200)}`);
          }
        }

        // If no end date extracted from description, use pubDate as a fallback estimate
        if (!endTime && pubDate) {
          const parsed = new Date(pubDate);
          if (!isNaN(parsed.getTime())) {
            endTime = parsed.toISOString();
            timeLeftMinutes = this.calcTimeLeftMinutes(endTime);
          }
        }

        // If still no parseable end time, use generous default so items aren't silently dropped
        if (!endTime || timeLeftMinutes < 0) {
          timeLeftMinutes = DEFAULT_TIME_LEFT_MINUTES;
          endTime = new Date(Date.now() + DEFAULT_TIME_LEFT_MINUTES * 60000).toISOString();
        }

        if (timeLeftMinutes > timeWindowMinutes) continue;

        // Current bid from description
        const bidMatch = description && description.match(/current bid[:\s]+\$?([\d,.]+)/i);
        const currentBid = bidMatch ? parseFloat(bidMatch[1].replace(/,/g, '')) : 0;

        items.push({
          sourceId: `govdeals-${itemId}`,
          source: this.name,
          title: this._decodeHtmlEntities(title),
          currentBid,
          endTime,
          timeLeftMinutes,
          url: link,
          imageUrl: null,
          category: null,
          bidCount: 0,
          ebayMedianSoldPrice: null,
          projectedProfit: null,
          profitPercentage: null,
          titleSimilarity: null,
          ebayMatchCount: 0,
        });
      } catch (err) {
        logger.debug(`[${this.name}] Failed to parse RSS item: ${err.message}`);
      }
    }

    return items;
  }

  _extractTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i')) ||
                  xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return match ? match[1].trim() : null;
  }

  _decodeHtmlEntities(str) {
    return str
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  normalizeItem(raw) {
    return raw; // Already normalized in _parseRss
  }
}

module.exports = GovDealsSource;
