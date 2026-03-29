'use strict';

const express = require('express');
const config = require('../config/config');
const logger = require('../utils/logger');
const { initDb } = require('../database/db');
const { getTopDeals } = require('../database/queries');
const ebayWebhookRouter = require('../routes/ebayWebhook');

const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// eBay webhook route (existing functionality)
app.use('/ebay', ebayWebhookRouter);

/**
 * GET /deals?min_score=80
 *
 * Returns top deals from the listings + scores tables.
 * Query params:
 *   - min_score {number} minimum deal score (default: config.api.minDealScore or 80)
 *   - limit     {number} max results to return (default: 50)
 *
 * Response shape:
 * [
 *   {
 *     "listing_id": "string",
 *     "title": "string",
 *     "price": 0.00,
 *     "deal_score": 85,
 *     "estimated_profit": 45.00,
 *     "listing_url": "string"
 *   }
 * ]
 */
app.get('/deals', async (req, res) => {
  try {
    const minScore = parseFloat(req.query.min_score) ||
      (config.api ? config.api.minDealScore : 80);
    const limit = parseInt(req.query.limit, 10) || 50;
    const deals = await getTopDeals(minScore, limit);
    res.json(deals);
  } catch (err) {
    logger.error(`[API] GET /deals error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

let server = null;

/**
 * Start the API server.
 * @param {number} [port] - port to listen on; falls back to PORT env var or 3000
 * @returns {Promise<http.Server>}
 */
async function start(port) {
  await initDb(config.database.path);
  const listenPort = port || parseInt(process.env.PORT, 10) || 3000;
  return new Promise((resolve) => {
    server = app.listen(listenPort, () => {
      logger.info(`[API] Server listening on port ${listenPort}`);
      logger.info('[API] Endpoints: GET /deals, GET /health, POST /ebay/webhook');
      resolve(server);
    });
  });
}

/** Stop the API server (useful for tests). */
function stop() {
  if (server) {
    server.close();
    server = null;
    logger.info('[API] Server stopped.');
  }
}

module.exports = { start, stop, app };

// Standalone entry point: `node src/api/server.js`
if (require.main === module) {
  start().catch((err) => {
    logger.error(`[API] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
