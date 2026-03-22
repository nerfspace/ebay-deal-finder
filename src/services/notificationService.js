'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

class NotificationService {
  constructor(config) {
    this.webhookUrl = config.discord.webhookUrl;
    this.enabled = !!this.webhookUrl;
    this.queue = [];
    this.isProcessing = false;
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

    // Batch all queued notifications into a single message
    const allNotifications = [...this.queue];
    this.queue = [];

    if (allNotifications.length > 0) {
      await this.sendBatchMessage(allNotifications);
    }

    this.isProcessing = false;
  }

  async sendBatchMessage(notifications, attempt = 1) {
    try {
      // Create embeds for each deal (max 10 per message)
      const embeds = notifications.slice(0, 10).map(notif => ({
        title: notif.title,
        description: notif.body,
        color: 16711680, // Red
        timestamp: new Date().toISOString(),
        ...(notif.url && { url: notif.url }),
      }));

      await axios.post(this.webhookUrl, { embeds }, { timeout: 10000 });
      logger.info(`Discord batch sent: ${notifications.length} deals in 1 message`);
      return true;
    } catch (err) {
      if (err.response?.status === 429 && attempt <= this.maxRetries) {
        const retryAfter = Math.ceil((err.response?.data?.retry_after || 60) * 1000);
        logger.warn(`Discord rate-limited (429). Retrying in ${retryAfter}ms... (attempt ${attempt}/${this.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        return this.sendBatchMessage(notifications, attempt + 1);
      } else if (err.response?.status === 429) {
        logger.error(`Discord rate-limited after ${this.maxRetries} retries. Failed to send ${notifications.length} deals.`);
        return false;
      } else {
        logger.error(`Failed to send Discord notification: ${err.message}`);
        return false;
      }
    }
  }

  async notifyDeal(deal) {
    const title = `🔥 ${deal.title.substring(0, 60)}`;
    const body = `💰 Price: $${deal.currentPrice.toFixed(2)}\n📈 Est. Value: $${(deal.currentPrice * 1.5).toFixed(2)}\n✅ Profit: ~$${deal.expectedProfit?.toFixed(2) || 'N/A'}`;
    return this.queueNotification(title, body, deal.url);
  }
}

module.exports = NotificationService;
