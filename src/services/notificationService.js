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
    this.lastSendTime = 0;
    this.minGapMs = 2000; // 2 second minimum between sends
    this.sentDealIds = new Set(); // Track sent deals to avoid duplicates
  }

  async queueNotification(title, body, url = null, dealId = null) {
    if (!this.enabled) return false;
    
    // Don't queue if we've already sent this deal
    if (dealId && this.sentDealIds.has(dealId)) {
      logger.debug(`Skipping duplicate deal notification: ${dealId}`);
      return false;
    }
    
    if (dealId) this.sentDealIds.add(dealId);
    this.queue.push({ title, body, url });
    return true;
  }

  async flushQueue() {
    if (this.queue.length === 0) return false;

    const allNotifications = [...this.queue];
    this.queue = [];

    // Send in batches of 10 (Discord's max embeds per message)
    const batchSize = 10;
    let success = true;
    for (let i = 0; i < allNotifications.length; i += batchSize) {
      const batch = allNotifications.slice(i, i + batchSize);

      // Respect minimum gap between sends
      const timeSinceLastSend = Date.now() - this.lastSendTime;
      if (this.lastSendTime > 0 && timeSinceLastSend < this.minGapMs) {
        const waitTime = this.minGapMs - timeSinceLastSend;
        logger.debug(`Waiting ${waitTime}ms before next batch to avoid rate limit...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      const result = await this.sendBatchMessage(batch);
      if (!result) success = false;
    }
    return success;
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    // Wait before sending to avoid rate limits
    const timeSinceLastSend = Date.now() - this.lastSendTime;
    if (timeSinceLastSend < this.minGapMs) {
      const waitTime = this.minGapMs - timeSinceLastSend;
      logger.debug(`Waiting ${waitTime}ms before sending to avoid rate limit...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

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

      logger.info(`Sending batch to Discord: ${notifications.length} deals...`);
      await axios.post(this.webhookUrl, { embeds }, { timeout: 10000 });
      this.lastSendTime = Date.now();
      logger.info(`✅ Discord batch sent successfully!`);
      return true;
    } catch (err) {
      const status = err.response?.status;

      if (status === 429 && attempt <= this.maxRetries) {
        // Use Discord's actual retry_after value (in seconds), with a 2s floor and 30s cap
        const retryAfterRaw = err.response?.data?.retry_after;
        // Discord returns retry_after in seconds (as a float); convert to ms
        const retryAfterMs = retryAfterRaw != null ? retryAfterRaw * 1000 : 2000;
        const waitMs = Math.min(Math.max(retryAfterMs, 2000), 30000);
        logger.warn(`Discord rate-limited (429). Waiting ${waitMs}ms... (attempt ${attempt}/${this.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return this.sendBatchMessage(notifications, attempt + 1);
      } else if (status === 429) {
        logger.error(`❌ Discord rate-limited after ${this.maxRetries} retries. Giving up on ${notifications.length} deals.`);
        return false;
      } else {
        logger.error(`❌ Failed to send Discord notification (${status}): ${err.message}`);
        return false;
      }
    }
  }

  async notifyDeal(deal, soldData) {
    if (!soldData) soldData = {};
    const title = `🔥 ${deal.title.substring(0, 60)}`;

    const marketPrice = soldData.medianSoldPrice != null
      ? `$${soldData.medianSoldPrice.toFixed(2)}`
      : `~$${deal.estimatedResalePrice ? deal.estimatedResalePrice.toFixed(2) : 'N/A'} (est.)`;

    const similarityPct = soldData.bestSimilarity != null
      ? `${(soldData.bestSimilarity * 100).toFixed(1)}%`
      : 'N/A';

    const matchCount = soldData.matchCount != null ? soldData.matchCount : 0;

    const profitPct = soldData.profitPercentage != null
      ? `${soldData.profitPercentage.toFixed(1)}%`
      : (deal.expectedProfit && deal.currentPrice ? `${((deal.expectedProfit / deal.currentPrice) * 100).toFixed(1)}%` : 'N/A');

    const body =
      `💰 **Listed:** $${deal.currentPrice.toFixed(2)}\n` +
      `📈 **Market Price:** ${marketPrice}\n` +
      `💵 **Profit:** ~$${deal.expectedProfit != null ? deal.expectedProfit.toFixed(2) : 'N/A'} (${profitPct})\n` +
      `🔍 **Title Match:** ${similarityPct} (${matchCount} comparable listing${matchCount !== 1 ? 's' : ''})\n` +
      `🏆 **Deal Score:** ${deal.dealScore}/100\n` +
      `🔗 [Buy Now](${deal.url})`;

    return this.queueNotification(title, body, deal.url, deal.ebayItemId);
  }
}

module.exports = NotificationService;
