'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const PUSHBULLET_PUSH_URL = 'https://api.pushbullet.com/v2/pushes';

class NotificationService {
  constructor(config) {
    this.apiKey = config.pushbullet.apiKey;
    this.enabled = !!this.apiKey && this.apiKey !== 'your_pushbullet_api_key_here';
  }

  /**
   * Send a push notification to all linked Pushbullet devices.
   */
  async sendPush(title, body, url = null) {
    if (!this.enabled) {
      logger.warn('Pushbullet API key not configured — skipping notification.');
      return false;
    }

    const payload = { type: 'note', title, body };
    if (url) {
      payload.type = 'link';
      payload.url = url;
    }

    try {
      await axios.post(PUSHBULLET_PUSH_URL, payload, {
        headers: {
          'Access-Token': this.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });
      logger.info(`Push notification sent: "${title}"`);
      return true;
    } catch (err) {
      const status = err.response ? err.response.status : 'N/A';
      const msg = err.response ? JSON.stringify(err.response.data) : err.message;
      logger.error(`Failed to send Pushbullet notification (status ${status}): ${msg}`);
      return false;
    }
  }

  /**
   * Format and send a deal alert notification.
   */
  async notifyDeal(deal) {
    const truncated = [...deal.title].slice(0, 50).join('');
    const title = `🔥 Deal Alert: ${truncated}`;
    const profitStr = deal.expectedProfit ? `$${deal.expectedProfit.toFixed(2)}` : 'Unknown';
    const priceStr = `$${deal.currentPrice.toFixed(2)}`;
    const scoreStr = deal.dealScore.toFixed(0);

    const body =
      `Price: ${priceStr} | Est. Profit: ${profitStr}\n` +
      `Deal Score: ${scoreStr}/100 | Confidence: ${deal.confidenceScore.toFixed(0)}/100\n` +
      `Condition: ${deal.condition || 'Unknown'} | Seller: ${deal.seller || 'Unknown'}`;

    return this.sendPush(title, body, deal.url);
  }

  /**
   * Send a scan summary notification (used occasionally for status updates).
   */
  async notifyScanSummary(dealsFound, listingsChecked) {
    if (!this.enabled) return false;
    const title = `📊 eBay Scan Complete`;
    const body = `Found ${dealsFound} deals from ${listingsChecked} listings scanned.`;
    return this.sendPush(title, body);
  }
}

module.exports = NotificationService;
