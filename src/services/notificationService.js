'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

class NotificationService {
  constructor(config) {
    this.webhookUrl = config.discord.webhookUrl;
    this.enabled = !!this.webhookUrl;
    this.queue = [];
    this.isProcessing = false;
    this.minDelayMs = 2000; // : 2 seconds
    this.maxRetries = 3;
  }

  async queueNotification(title, body, url = null) {
    if (!this.enabled) return false;
    this.queue.push({ title, body, url });
    if (!this.isProcessing) {
      this.processQueue();
    }
    return true;
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const notification = this.queue.shift();
      await this.sendWithRetry(notification.title, notification.body, notification.url, 1);
      await new Promise(resolve => setTimeout(resolve, this.minDelayMs));
    }

    this.isProcessing = false;
  }

  async sendWithRetry(title, body, url = null, attempt = 1) {
    try {
      await this.sendPush(title, body, url);
      return true;
    } catch (err) {
      if (err.response?.status === 429 && attempt <= this.maxRetries) {
        const retryAfter = Math.ceil((err.response?.data?.retry_after || 30) * 1000);
        logger.warn(`Discord rate-limited (429). Retrying in ${retryAfter}ms... (attempt ${attempt}/${this.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        return this.sendWithRetry(title, body, url, attempt + 1);
      } else if (err.response?.status === 429) {
        logger.error(`Discord rate-limited after ${this.maxRetries} retries. Giving up on: "${title}"`);
        return false;
      } else {
        logger.error(`Failed to send Discord notification: ${err.message}`);
        return false;
      }
    }
  }

  async sendPush(title, body, url = null) {
    if (!this.enabled) return false;

    const embed = {
      title,
      description: body,
      color: 16711680, // Red
      timestamp: new Date().toISOString(),
      ...(url && { url }),
    };

    await axios.post(this.webhookUrl, { embeds: [embed] }, { timeout: 10000 });
    logger.info(`Discord notification sent: "${title}"`);
    return true;
  }

  async notifyDeal(deal) {
    const title = `🔥 Deal Alert: ${deal.title.substring(0, 50)}`;
    const body = `Price: $${deal.currentPrice.toFixed(2)}\nEst. Profit: ~$${deal.expectedProfit?.toFixed(2) || 'N/A'}`;
    return this.queueNotification(title, body, deal.url);
  }
}

module.exports = NotificationService;
