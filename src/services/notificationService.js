'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

class NotificationService {
  constructor(config) {
    this.webhookUrl = config.discord.webhookUrl;
    this.enabled = !!this.webhookUrl;
    this.delayMs = (config.notifications && config.notifications.delayMs) || 1500;
    this.maxRetries = (config.notifications && config.notifications.maxRetries) || 3;

    // Internal queue for batched notifications
    this._queue = [];
    this._processing = false;
  }

  /**
   * Sleep for a given number of milliseconds.
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send a single Discord embed with exponential backoff on HTTP 429.
   */
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

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        await axios.post(this.webhookUrl, { embeds: [embed] }, { timeout: 10000 });
        logger.info(`Discord notification sent: "${title}"`);
        return true;
      } catch (err) {
        const status = err.response ? err.response.status : null;

        if (status === 429) {
          // Exponential backoff on rate-limit
          const retryAfterMs = (err.response.data && err.response.data.retry_after)
            ? Math.ceil(err.response.data.retry_after * 1000)
            : Math.pow(2, attempt) * 1000;
          logger.warn(`Discord rate-limited (429). Retrying after ${retryAfterMs}ms (attempt ${attempt + 1}/${this.maxRetries})...`);
          await this._sleep(retryAfterMs);
          attempt++;
          continue;
        }

        const msg = err.response ? JSON.stringify(err.response.data) : err.message;
        logger.error(`Failed to send Discord notification (status ${status || 'N/A'}): ${msg}`);
        return false;
      }
    }

    logger.error(`Giving up on Discord notification after ${this.maxRetries} retries: "${title}"`);
    return false;
  }

  /**
   * Enqueue a deal notification. Notifications are sent sequentially
   * with a 1.5s delay between each to avoid Discord rate-limiting.
   */
  async notifyDeal(deal) {
    return new Promise((resolve) => {
      this._queue.push({ deal, resolve });
      if (!this._processing) {
        this._processQueue();
      }
    });
  }

  /**
   * Process the notification queue sequentially with inter-message delay.
   */
  async _processQueue() {
    this._processing = true;

    while (this._queue.length > 0) {
      const { deal, resolve } = this._queue.shift();

      const title = `🔥 Deal Alert: ${deal.title.substring(0, 50)}`;
      const profitStr = deal.expectedProfit ? `$${deal.expectedProfit.toFixed(2)}` : 'Unknown';
      const priceStr = `$${deal.currentPrice.toFixed(2)}`;
      const scoreStr = deal.dealScore.toFixed(0);

      const body =
        `Price: ${priceStr} | Est. Profit: ${profitStr}\n` +
        `Deal Score: ${scoreStr}/100\n` +
        `Condition: ${deal.condition || 'Unknown'} | Seller: ${deal.seller || 'Unknown'}`;

      const sent = await this.sendPush(title, body, deal.url);
      resolve(sent);

      // Delay between notifications to avoid Discord rate-limiting
      if (this._queue.length > 0) {
        await this._sleep(this.delayMs);
      }
    }

    this._processing = false;
  }

  async notifyScanSummary(dealsFound, listingsChecked) {
    if (!this.enabled) return false;
    const title = `📊 eBay Scan Complete`;
    const body = `Found ${dealsFound} deals from ${listingsChecked} listings scanned.`;
    return this.sendPush(title, body);
  }
}

module.exports = NotificationService;

