# External Services

→ [[00 - Nexus Commerce MOC]] | [[01 - System Architecture Overview]]

## Service Map

| Service | Package | Version | Purpose |
|---------|---------|---------|---------|
| **Amazon SP-API** | `amazon-sp-api` | 1.2.1 | Marketplace operations | 
| **eBay APIs** | Custom provider | — | eBay marketplace |
| **Shopify** | Built-in routes | — | Shopify channel |
| **Google Gemini** | `@google/generative-ai` | 0.24.1 | AI content generation |
| **Cloudinary** | `cloudinary` | 2.10.0 | DAM / image CDN |
| **AWS S3** | `@aws-sdk/client-s3` | — | File storage |
| **AWS SQS** | `@aws-sdk/client-sqs` | — | Amazon order push events |
| **Redis** | `ioredis` | 5.10.1 | Cache, BullMQ, rate-limiting |
| **PostgreSQL** | `pg` + Prisma | 8.20.0 | Primary database |
| **Typesense** | `typesense` | — | Search index (DORMANT) |
| **OpenTelemetry** | `@opentelemetry/sdk-node` | — | Distributed tracing |

---

## Google Gemini AI

**Package:** `@google/generative-ai` v0.24.1  
**Env var:** `GOOGLE_API_KEY`

### Used In

| Feature | Purpose |
|---------|---------|
| Listing Wizard | AI-powered product title/description generation |
| Product descriptions | Auto-generate from attributes |
| A+ Content | AI-assisted content modules |
| Brand Voice | Style-matched content generation |
| Category Browse | AI browse node suggestions |
| Ads Suggestions | AI-generated bid/keyword suggestions |
| AI Brief | Automated business intelligence brief |

---

## Cloudinary (DAM)

**Package:** `cloudinary` v2.10.0  
**Env var:** `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

### Features Used

| Feature | Notes |
|---------|-------|
| Asset upload | Direct upload from browser via signed URL |
| Image transformation | Resize, crop, format conversion |
| CDN delivery | Global CDN for product images |
| Webhook | `cloudinary-webhook.routes.ts` — asset lifecycle events |
| Folder structure | Mirrored in `AssetFolder` DB model |

### Image Dedup Gate (IE-series)

- Dedup before upload via perceptual hash comparison
- Backfill + collapse: 4,626 → 2,063 ProductImage rows
- Master auto-seed from DAM
- Drift modal for mismatches

---

## AWS S3

**Package:** `@aws-sdk/client-s3`  
**Env vars:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

### Used For

- Bulk import/export file storage
- Flat-file feed downloads
- Settlement report storage
- PDF/label generation output

---

## AWS SQS

**Package:** `@aws-sdk/client-sqs`  
**Env vars:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

### Used For

- Amazon SP-API order push notifications (`ORDER_CHANGE`)
- ~30 second order latency (vs 15-minute cron fallback)
- Polled by `amazon-sqs-poll.job.ts`

---

## Redis

**Package:** `ioredis` v5.10.1  
**Env var:** `REDIS_URL`

### Used For

| Use Case | Notes |
|----------|-------|
| BullMQ job queues | 102 cron jobs + 8 workers |
| Rate-limit counters | `@fastify/rate-limit` state |
| Session cache | Auth token caching |
| Token-bucket throttling | Bidding engine 429 protection |
| In-memory locks | Distributed job coordination |

---

## Typesense (DORMANT)

**Package:** `typesense`  
**Status:** Built but **DORMANT BY CHOICE** since 2026-05-30

### Reason for Dormancy

279 SKU scale doesn't justify managed Typesense provisioning. Postgres FTS fallback (`GET /api/products/search`) is sufficient.

### When to Activate

Provision Typesense when SKU count makes Postgres FTS too slow (estimated: 1,000+ SKUs).

### Architecture (When Active)

```
Product update → search-index.worker.ts
    │
    ▼
Typesense index update (CDC-driven)
    │
    ▼
GET /api/products/search → Typesense
```

---

## OpenTelemetry

**Packages:** `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`  
**Env var:** `NEXUS_OTEL_ENABLED=1`

### Traces

- HTTP request spans (all Fastify routes)
- Prisma query spans (DB operations)
- BullMQ job spans (job lifecycle)

### Export

HTTP OTLP exporter — backend configurable (Jaeger, Datadog, etc.)

---

## Bidding Engine (Internal Microservice)

Separate Railway service — not strictly "external" but separate process:
- Communicates with main API via REST
- Uses BullMQ + Redis
- Inventory-elasticity formula for bid optimization

See [[27 - Bidding Engine Microservice]] for full detail.

---

## Related Notes

- [[11 - Amazon SP-API Integration]] — SP-API + SQS deep-dive
- [[12 - eBay Integration]] — eBay provider detail
- [[13 - Shopify Integration]] — Shopify detail
- [[27 - Bidding Engine Microservice]] — bidding engine detail
- [[25 - Authentication & Authorization]] — OAuth + API key auth
