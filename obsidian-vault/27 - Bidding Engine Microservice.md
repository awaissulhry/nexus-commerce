# Bidding Engine Microservice

→ [[00 - Nexus Commerce MOC]] | [[01 - System Architecture Overview]]

## Overview

A separate Fastify microservice (`services/bidding-engine`) running on Railway alongside the main API. Handles inventory-elasticity bid optimization and 429 rate-limit protection for Amazon Ads API calls.

---

## Architecture

| Property | Value |
|----------|-------|
| Package | `@nexus/bidding-engine` |
| Framework | Fastify 5.0.0 |
| Queue | BullMQ 5.76.2 + ioredis |
| Pattern | **Sidekick** — no direct DB access |
| Communication | REST calls to/from main API |
| Deployment | Separate Railway service |
| Location | `services/bidding-engine/` |

---

## Communication Pattern

```
Main API (apps/api)
    │
    ├─► POST /bidding-engine/optimize
    │   { productId, currentBid, stockLevel, targetAcos }
    │        │
    │        ▼
    │   Bidding Engine
    │   (inventory-elasticity formula)
    │        │
    │        ▼
    │   { recommendedBid, reason }
    │        │
    │   ◄────┘
    │
    └─► PUT /bidding-engine/batch
        [{ adGroupId, targetId, newBid }]
        (rate-limited by token bucket)
```

---

## Inventory-Elasticity Formula

The core algorithm adjusts bids based on stock levels:

```
baseMultiplier = stockLevel / safetyStockThreshold

if stockLevel > safetyStock:
    bid = targetBid × baseMultiplier  (more stock → bid more aggressively)
else if stockLevel < lowStockThreshold:
    bid = targetBid × 0.5  (protect margin, reduce ad spend)
else:
    bid = targetBid  (normal range)

bid = clamp(bid, minBid, maxBid)
```

**Principle:** More inventory → more aggressive bidding (convert stock to sales). Low inventory → reduce bids (protect from stockout).

---

## Token-Bucket 429 Throttling

Amazon Ads API has strict rate limits. The token bucket prevents hitting 429 errors:

```
TokenBucket {
  capacity: 100 tokens
  refillRate: 10 tokens/second
  
  beforeRequest():
    if bucket.tokens >= 1:
      bucket.tokens -= 1
      proceed()
    else:
      queue request (BullMQ)
      wait for token
}
```

- Redis-backed token counter (atomic operations)
- BullMQ queue for overflow requests
- Exponential backoff on actual 429 responses

---

## REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/optimize` | Single bid recommendation |
| `PUT` | `/batch` | Batch bid update (rate-limited) |
| `GET` | `/health` | Health check |
| `GET` | `/metrics` | Current token bucket state |

---

## BullMQ Queue

- **Queue name:** `bidding-optimizer`
- **Job types:** `optimize`, `batch-update`
- **Processing:** FIFO with concurrency limit
- **Redis:** Shared `REDIS_URL` with main API

---

## Dry-Run Mode

The service supports dry-run mode:
- `X-Dry-Run: true` header
- Logs what it *would* do, doesn't actually update bids
- Used for testing rule changes before live deployment

---

## No Direct DB Access

The bidding engine follows the **sidekick pattern**:
- Does NOT import `@nexus/database`
- Does NOT connect to PostgreSQL
- All data comes via REST from main API
- Main API is the single point of DB truth

This means:
- Bidding engine can be updated/restarted without DB concerns
- Clean separation of concerns
- Can be scaled independently of the main API

---

## Deployment

- Separate Railway service (same project as main API)
- Environment variables:
  - `REDIS_URL` — shared Redis
  - `PORT` — service port
  - `MAIN_API_URL` — main API base URL for callbacks
  - `DRY_RUN` — enable dry-run mode

---

## Integration Points

| Integrates With | How |
|----------------|-----|
| Main API | REST calls in both directions |
| Redis | Token bucket + BullMQ queues |
| Amazon Ads API | Via main API's SP-API client (not directly) |
| Advertising crons | `ads-automation-rules.job.ts` calls bidding engine |

---

## Related Notes

- [[20 - Advertising]] — uses bidding engine for bid optimization
- [[19 - Pricing & Repricing]] — inventory-elasticity also informs repricing
- [[06 - Background Jobs & Workers]] — cron jobs that trigger bidding engine
- [[14 - External Services]] — Redis used by bidding engine
