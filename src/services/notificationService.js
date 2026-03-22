'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

class NotificationService {
  constructor(config) {
    this.webhookUrl = config.discord.webhookUrl;
    this.enabled = !!this.webhookUrl;
  }

  async sendPush(title, body, url = null) {
    if (!this.enabled) {
      logger.warn('Discord webhook not configured — skipping notification.');
      return false;
    }

    const embed = {
      title,
      description: body,
      color: 16711680,
      ...(url && { url }),
    };

    try {
      await axios.post(this.webhookUrl, { embeds: [embed] }, {
        timeout: 10000,
      });
      logger.info(`Discord notification sent: "${title}"`);
      return true;
    } catch (err) {
      const status = err.response ? err.response.status : 'N/A';
      const msg = err.response ? JSON.stringify(err.response.data) : err.message;
      logger.error(`Failed to send Discord notification (status ${status}): ${msg}`);
      return false;
    }
  }

  async notifyDeal(deal) {
    const title = `🔥 Deal Alert: ${deal.title.substring(0, 50)}`;
    const profitStr = deal.expectedProfit ? `$${deal.expectedProfit.toFixed(2)}` : 'Unknown';
    const priceStr = `$${deal.currentPrice.toFixed(2)}`;
    const scoreStr = deal.dealScore.toFixed(0);

    const body =
      `Price: ${priceStr} | Est. Profit: ${profitStr}\n` +
      `Deal Score: ${scoreStr}/100 | Confidence: ${deal.confidenceScore.toFixed(0)}/100\n` +
      `Condition: ${deal.condition || 'Unknown'} | Seller: ${deal.seller || 'Unknown'}`;

    return this.sendPush(title, body, deal.url);
  }

  async notifyScanSummary(dealsFound, listingsChecked) {
    if (!this.enabled) return false;
    const title = `📊 eBay Scan Complete`;
    const body = `Found ${dealsFound} deals from ${listingsChecked} listings scanned.`;
    return this.sendPush(title, body);
  }
}

module.exports = NotificationService;
