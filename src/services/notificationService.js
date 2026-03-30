'use strict';

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

class NotificationService {
  constructor(config) {
    this.emailTo = config.email.to;
    this.enabled = !!this.emailTo;
    this.emailFrom = config.email.from || this.emailTo;
    this.transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port || 587,
      secure: (config.email.port || 587) === 465,
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
    });
    this.queue = [];
    this.isProcessing = false;
    this.maxRetries = 3;
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

    return this.sendBatchMessage(allNotifications);
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const allNotifications = [...this.queue];
    this.queue = [];

    if (allNotifications.length > 0) {
      await this.sendBatchMessage(allNotifications);
    }

    this.isProcessing = false;
  }

  async sendBatchMessage(notifications, attempt = 1) {
    const subject = notifications.length === 1
      ? `Deal Alert: ${notifications[0].title}`
      : `Deal Alert: ${notifications.length} new deals found`;

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    const rows = notifications.map(notif => {
      const linkHtml = notif.url
        ? `<a href="${escapeHtml(notif.url)}" style="color:#e44;">View Deal</a>`
        : '';
      const bodyHtml = escapeHtml(notif.body).replace(/\n/g, '<br>');
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #eee;">
            <strong style="font-size:15px;">${escapeHtml(notif.title)}</strong><br>
            <span style="color:#444;line-height:1.6;">${bodyHtml}</span><br>
            ${linkHtml}
          </td>
        </tr>`;
    }).join('');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#c0392b;">🔥 eBay Deal Finder — ${notifications.length} deal${notifications.length !== 1 ? 's' : ''} found</h2>
        <table style="width:100%;border-collapse:collapse;">
          ${rows}
        </table>
        <p style="color:#999;font-size:12px;margin-top:16px;">Sent by eBay Deal Finder</p>
      </div>`;

    try {
      logger.info(`Sending email: ${notifications.length} deal${notifications.length !== 1 ? 's' : ''}...`);
      await this.transporter.sendMail({
        from: this.emailFrom,
        to: this.emailTo,
        subject,
        html,
      });
      logger.info(`✅ Email sent successfully!`);
      return true;
    } catch (err) {
      if (attempt <= this.maxRetries) {
        const waitMs = Math.min(Math.pow(2, attempt) * 1000, 30000);
        logger.warn(`Failed to send email (attempt ${attempt}/${this.maxRetries}): ${err.message}. Retrying in ${waitMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return this.sendBatchMessage(notifications, attempt + 1);
      }
      logger.error(`❌ Failed to send email after ${this.maxRetries} retries: ${err.message}`);
      return false;
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
      `💰 Listed: $${deal.currentPrice.toFixed(2)}\n` +
      `📈 Market Price: ${marketPrice}\n` +
      `💵 Profit: ~$${deal.expectedProfit != null ? deal.expectedProfit.toFixed(2) : 'N/A'} (${profitPct})\n` +
      `🔍 Title Match: ${similarityPct} (${matchCount} comparable listing${matchCount !== 1 ? 's' : ''})\n` +
      `🏆 Deal Score: ${deal.dealScore}/100`;

    return this.queueNotification(title, body, deal.url, deal.ebayItemId);
  }

  async notifyAuctionDeal(item, window) {
    if (!this.enabled) return false;

    const dealId = item.sourceId;
    if (this.sentDealIds.has(dealId)) {
      logger.debug(`Skipping duplicate auction deal notification: ${dealId}`);
      return false;
    }
    this.sentDealIds.add(dealId);

    const urgencyLabel = `${window.emoji} ${window.label} | ${item.source}`;
    const title = `${urgencyLabel} — ${item.title.substring(0, 80)}`;

    const medianPrice = item.ebayMedianSoldPrice != null
      ? `$${item.ebayMedianSoldPrice.toFixed(2)} (median of ${item.ebayMatchCount} comp${item.ebayMatchCount !== 1 ? 's' : ''})`
      : 'N/A';

    const profit = item.projectedProfit != null
      ? `$${item.projectedProfit.toFixed(2)} (${item.profitPercentage != null ? item.profitPercentage.toFixed(0) : '?'}%)`
      : 'N/A';

    const similarity = item.titleSimilarity != null
      ? `${(item.titleSimilarity * 100).toFixed(1)}%`
      : 'N/A';

    const timeLeft = item.timeLeftMinutes != null
      ? this._formatTimeLeft(item.timeLeftMinutes)
      : 'Unknown';

    const body =
      `💰 Current Bid: $${item.currentBid.toFixed(2)}\n` +
      `📈 eBay Sold Price: ${medianPrice}\n` +
      `💵 Projected Profit: ${profit}\n` +
      `🔍 Title Match: ${similarity}\n` +
      `⏰ Ends: ${timeLeft}`;

    this.queue.push({ title, body, url: item.url });
    return true;
  }

  _formatTimeLeft(minutes) {
    if (minutes < 1) return 'less than 1m';
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    const d = Math.floor(h / 24);
    const hRem = h % 24;
    return hRem > 0 ? `${d}d ${hRem}h` : `${d}d`;
  }
}

module.exports = NotificationService;
