# eBay Deal Finder

A real-time eBay deal scanner that detects newly listed items within **5–15 seconds** and evaluates them for profitable resale opportunities using a 12-step analysis pipeline.

## Architecture

The system is structured as **four independent, composable components** that can run together in a single process or be deployed and scaled separately.

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐    ┌──────────────┐
│  Listing Poller │───▶│   Queue System   │───▶│  Deal Analyzer  │───▶│   API Layer  │
│  (poller/)      │    │  (queue/)        │    │  (analyzer/)    │    │  (api/)      │
└─────────────────┘    └──────────────────┘    └─────────────────┘    └──────────────┘
  Polls eBay every        In-memory queue         12-step scoring         GET /deals
  5–15 s, detects         (BullMQ-compatible       pipeline → DB           endpoint
  new listing IDs         interface)
```

### Component 1 — Listing Poller (`src/poller/listingPoller.js`)
- Queries the eBay Browse API sorted by newest listings (`sort: 'newlyListed'`)
- Parses **only the first page** (50 results) so newly listed items are seen first
- Runs on a **randomised 5–15 second interval** to avoid detection
- **Rotates user-agent strings** on every request
- Supports an optional **proxy pool** via `PROXY_URLS`
- Maintains an **in-memory `Set` of seen listing IDs**; only new IDs are enqueued
- First poll seeds the seen-ID set; subsequent polls emit new listings to the queue

### Component 2 — Queue System (`src/queue/queueManager.js`)
- Lightweight **in-memory EventEmitter** queue with `enqueue(name, msg)` / `consume(name, handler)` API
- BullMQ-compatible interface — swap to Redis/BullMQ by replacing only this module
- Queue name: `new-listings`

### Component 3 — Deal Analyzer (`src/analyzer/dealAnalyzer.js`)
Consumes queue messages and runs a **12-step pipeline**:

| Step | Description |
|------|-------------|
| 1 | Feature extraction (title, price, shipping, condition, category, seller feedback) |
| 2 | Product identification — brand + model via `productIdentifier.js` |
| 3 | Comparable sales lookup — median resale price via `ebayService.fetchComparableSales()` |
| 4 | True purchase cost = `price + shipping_cost` |
| 5 | Net resale value = `median − 16% fees − category shipping` (via `feeCalculator.js`) |
| 6 | Profit = `net_resale_value − true_cost` |
| 7 | Risk adjustment — multiplier 0.5–1.0 via `riskAssessor.js` |
| 8 | Liquidity score — `items_sold / items_listed` sell-through rate |
| 9 | Ignorance signals — vague titles, missing model numbers, extreme discounts (`ignoranceDetector.js`) |
| 10 | Deal score (0–100): `(0.4 × profit) + (0.3 × discount) + (0.2 × sell-through) − (0.1 × risk)` |
| 11 | Persist to `listings` + `scores` tables |
| 12 | Log deals scoring ≥ 80 |

Score interpretation: **90–100** elite · **80–89** strong flip · **70–79** moderate · **< 70** ignore

### Component 4 — API Layer (`src/api/server.js`)
- `GET /deals?min_score=80` — returns top deals from the database
- `GET /health` — health check
- `POST /ebay/webhook` — eBay notification endpoint (existing functionality)

## Project Structure

```
ebay-deal-finder/
├── src/
│   ├── index.js                    # Orchestrates all four components (development mode)
│   ├── config/
│   │   └── config.js               # Env-based configuration with validation
│   ├── poller/
│   │   └── listingPoller.js        # Component 1: eBay listing poller
│   ├── queue/
│   │   └── queueManager.js         # Component 2: in-memory queue
│   ├── analyzer/
│   │   ├── dealAnalyzer.js         # Component 3: 12-step analysis pipeline
│   │   ├── productIdentifier.js    # Brand/model NLP detection
│   │   ├── feeCalculator.js        # Marketplace fee & shipping estimates
│   │   ├── riskAssessor.js         # Risk multiplier (0.5–1.0)
│   │   └── ignoranceDetector.js    # Seller ignorance signal detection
│   ├── api/
│   │   └── server.js               # Component 4: Express API server
│   ├── services/
│   │   ├── ebayService.js          # eBay Browse API + fetchComparableSales()
│   │   ├── scoringEngine.js        # Legacy 6-layer scoring (preserved)
│   │   ├── filterEngine.js         # Legacy pre-filter + deal filter (preserved)
│   │   ├── notificationService.js  # Discord/Pushbullet notifications
│   │   └── auctionScanner.js       # Multi-source auction scanner
│   ├── database/
│   │   ├── db.js                   # SQLite init (listings, scores + legacy tables)
│   │   └── queries.js              # CRUD helpers (saveListing, saveScore, getTopDeals…)
│   ├── routes/
│   │   └── ebayWebhook.js          # eBay webhook endpoint
│   └── utils/
│       ├── logger.js               # Color-coded console logger
│       └── similarity.js           # Dice-coefficient title similarity
├── package.json
├── .env.example
└── README.md
```

## Prerequisites

- Node.js ≥ 20
- An [eBay Developer](https://developer.ebay.com/) account with a Browse API OAuth token
- A Discord webhook URL (for deal notifications)

## Setup

1. **Clone and install:**

   ```bash
   git clone https://github.com/nerfspace/ebay-deal-finder.git
   cd ebay-deal-finder
   npm install
   ```

2. **Configure environment:**

   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Run all components together (recommended for development):**

   ```bash
   npm start
   ```

4. **Run each component independently:**

   ```bash
   npm run start:poller    # Listing Poller only
   npm run start:analyzer  # Deal Analyzer only
   npm run start:api       # API Layer only
   ```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EBAY_APP_ID` | eBay application ID | *required* |
| `EBAY_CERT_ID` | eBay certificate ID | *required* |
| `EBAY_AUTH_TOKEN` | eBay OAuth token | *required* |
| `EBAY_SANDBOX` | Use eBay sandbox | `false` |
| `DISCORD_WEBHOOK_URL` | Discord webhook for notifications | *required* |
| `SCAN_INTERVAL_MINUTES` | Legacy scan loop interval | `10` |
| `MIN_PRICE` | Minimum listing price | `20` |
| `MAX_PRICE` | Maximum listing price | `2000` |
| `MIN_PROFIT_THRESHOLD` | Minimum profit in USD | `20` |
| `DATABASE_PATH` | SQLite database file path | `./data/deals.db` |
| `LOG_LEVEL` | Logging level (debug/info/warn/error) | `info` |
| `POLL_INTERVAL_MIN_MS` | Minimum poller interval (ms) | `5000` |
| `POLL_INTERVAL_MAX_MS` | Maximum poller interval (ms) | `15000` |
| `PROXY_URLS` | Comma-separated proxy URLs (optional) | — |
| `MIN_DEAL_SCORE_API` | Minimum score for `GET /deals` | `80` |
| `MARKETPLACE_FEE_RATE` | Fee rate for net resale calculation | `0.16` |
| `QUEUE_TYPE` | Queue backend (`memory` or `redis`) | `memory` |

## API

### `GET /deals?min_score=80`

Returns qualifying deals ordered by score descending.

**Response:**
```json
[
  {
    "listing_id": "v1|123456789|0",
    "title": "Apple MacBook Pro M3 14-inch 2023",
    "price": 850.00,
    "deal_score": 87.4,
    "estimated_profit": 142.30,
    "listing_url": "https://www.ebay.com/itm/123456789"
  }
]
```

### `GET /health`

```json
{ "status": "ok", "timestamp": "2024-01-15T10:30:00.000Z" }
```

## Database Schema

```sql
-- Legacy tables (preserved for backward compatibility)
CREATE TABLE deals ( … );
CREATE TABLE filter_keywords ( … );
CREATE TABLE scan_history ( … );
CREATE TABLE auction_deals ( … );

-- New event-driven pipeline tables
CREATE TABLE listings (
  listing_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  price REAL NOT NULL,
  shipping_cost REAL DEFAULT 0,
  seller_feedback INTEGER,
  category TEXT,
  listing_url TEXT,
  timestamp_detected TEXT NOT NULL
);

CREATE TABLE scores (
  listing_id TEXT PRIMARY KEY REFERENCES listings(listing_id),
  deal_score REAL NOT NULL,
  estimated_profit REAL,
  risk_score REAL,
  sell_through_rate REAL,
  confidence REAL,
  analyzed_at TEXT NOT NULL
);
```

## Scoring System

| Component | Weight | Description |
|-----------|--------|-------------|
| Normalized profit | 40% | Adjusted profit / median price (risk-adjusted) |
| Discount vs market | 30% | How far below median the listing is priced |
| Sell-through rate | 20% | Items sold / items listed (liquidity indicator) |
| Risk penalty | −10% | Penalizes risky keywords, low feedback, etc. |
| Ignorance boost | +0–20 | Bonus for signs of seller mispricing |

## Deployment on Render

1. Push the repository to GitHub.
2. Create a **Background Worker** service on Render.
3. Set the **Start Command** to `npm start`.
4. Add all required environment variables.
5. Configure a **persistent disk** mounted at `./data` to preserve the SQLite database.

## License

MIT

## Features

- Scans up to 500 of the most recent eBay listings per cycle
- Scores each deal on 5 layers: **Value**, **Confidence**, **Speed**, **Risk**, and **Execution**
- Smart filtering with configurable include/exclude keywords
- Instant push notifications via [Pushbullet](https://www.pushbullet.com/)
- Local deal history and scan log stored in SQLite
- Deployment-ready for [Render](https://render.com/)

## Project Structure

```
ebay-deal-finder/
├── src/
│   ├── index.js                  # Main entry point with scan loop
│   ├── config/
│   │   └── config.js             # Configuration loader with validation
│   ├── services/
│   │   ├── ebayService.js        # eBay Browse API integration
│   │   ├── scoringEngine.js      # 5-layer deal scoring logic
│   │   ├── filterEngine.js       # Keyword matching and confidence filters
│   │   └── notificationService.js # Pushbullet push notifications
│   ├── database/
│   │   ├── db.js                 # SQLite initialization
│   │   └── queries.js            # Database helper functions
│   └── utils/
│       └── logger.js             # Color-coded logging utility
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Prerequisites

- Node.js >= 18
- An [eBay Developer](https://developer.ebay.com/) account with a Browse API OAuth token
- A [Pushbullet](https://www.pushbullet.com/) account and API key

## Setup

1. **Clone the repository and install dependencies:**

   ```bash
   git clone https://github.com/nerfspace/ebay-deal-finder.git
   cd ebay-deal-finder
   npm install
   ```

2. **Copy `.env.example` to `.env` and fill in your credentials:**

   ```bash
   cp .env.example .env
   ```

   | Variable | Description | Default |
   |---|---|---|
   | `EBAY_APP_ID` | eBay application ID | *required* |
   | `EBAY_CERT_ID` | eBay certificate ID | *required* |
   | `EBAY_AUTH_TOKEN` | eBay OAuth token | *required* |
   | `EBAY_SANDBOX` | Use sandbox environment | `false` |
   | `SCAN_INTERVAL_MINUTES` | Minutes between scans | `10` |
   | `PUSHBULLET_API_KEY` | Pushbullet API key | *required* |
   | `MIN_PROFIT_THRESHOLD` | Minimum profit in USD | `20` |
   | `DATABASE_PATH` | SQLite database file path | `./data/deals.db` |
   | `LOG_LEVEL` | Logging level (debug/info/warn/error) | `info` |

3. **Run the application:**

   ```bash
   npm start
   ```

## Scoring System

Each listing is evaluated on five independent axes and combined into a weighted final score (0–100):

| Layer | Weight | Description |
|---|---|---|
| Value | 35% | Profit margin vs estimated resale price |
| Confidence | 25% | Seller reliability and data quality |
| Speed | 15% | How recently the listing was posted |
| Risk | 15% | Condition, price range, and listing quality |
| Execution | 10% | Ease of purchase and resale |

Deals scoring **75 or above** with an expected profit above `MIN_PROFIT_THRESHOLD` trigger a push notification.

## Database Schema

The SQLite database contains three tables:

- **`deals`** — all detected deals with full scoring data
- **`filter_keywords`** — configurable include/exclude keyword lists
- **`scan_history`** — log of every completed scan

## Deployment on Render

1. Push the repository to GitHub.
2. Create a new **Background Worker** service on Render pointed at this repository.
3. Set the **Start Command** to `npm start`.
4. Add all required environment variables in the Render dashboard.
5. The `data/` directory is excluded from git; configure a persistent disk on Render to preserve the SQLite database across deploys.

## License

MIT

