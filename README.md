# eBay Deal Finder

A real-time eBay deal scanner that monitors new listings every 5–15 minutes and sends instant mobile push notifications when high-confidence deals are detected.

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

