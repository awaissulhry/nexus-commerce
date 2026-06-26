# API Layer — Fastify

→ [[00 - Nexus Commerce MOC]] | [[01 - System Architecture Overview]]

## Stack

| Property | Value |
|----------|-------|
| Framework | Fastify 5.0.0 |
| Language | TypeScript (ES modules) |
| Runtime | Node.js |
| ORM | Prisma 6.19.3 via `@nexus/database` |
| Entry | `apps/api/src/server.ts` |
| Port | 3001 (default, configurable) |

---

## Route Modules (147 total, ~1,438 endpoints)

### Core Product & Listing

| File | Size | Scope |
|------|------|-------|
| `products.routes.ts` | 178.9 KB | Product CRUD, families, variants, bulk operations |
| `listing-wizard.routes.ts` | 202.8 KB | Multi-step listing wizard, AI enrichment, validation |
| `listings-syndication.routes.ts` | 157.9 KB | Multi-channel publish engine + SSE events |
| `pim.routes.ts` | 30.4 KB | Product Information Master — field registry, schema |

### Amazon

| File | Size | Scope |
|------|------|-------|
| `amazon.routes.ts` | 95.8 KB | SP-API catalog, listings, inventory sync |
| `amazon-flat-file.routes.ts` | 62 KB | Amazon Flat File Editor (**UNTOUCHABLE**) |

### eBay

| File | Size | Scope |
|------|------|-------|
| `ebay-cockpit.routes.ts` | 79.5 KB | eBay Inventory API + Listing Cockpit (12 endpoints) |
| `ebay-flat-file.routes.ts` | 79.5 KB | eBay Flat File Editor (**UNTOUCHABLE**) |

### Fulfillment & Stock

| File | Size | Scope |
|------|------|-------|
| `fulfillment.routes.ts` | 690 KB | Stock, replenishment, inbound/outbound, carriers |
| `stock.routes.ts` | 149.7 KB | Inventory management, reservations, bins, lots |
| `returns.routes.ts` | 105 KB | Return/refund workflows |
| `orders.routes.ts` | 83.8 KB | Order management, fulfillment, returns |

### Analytics & Marketing

| File | Size | Scope |
|------|------|-------|
| `advertising.routes.ts` | 395.5 KB | Amazon Ads SP-API + ad automation (⚠️ has € char — use `grep -a`) |
| `dashboard.routes.ts` | 156.9 KB | Analytics widgets + real-time SSE streams |
| `marketing-os.routes.ts` | 39.8 KB | Unified marketing campaigns |
| `pricing.routes.ts` | 67.4 KB | Price history, repricing rules, live pricing |
| `reviews.routes.ts` | 79.2 KB | Review pipeline, request templates, sentiment |

### Operations

| File | Size | Scope |
|------|------|-------|
| `bulk-operations.routes.ts` | 30.9 KB | Bulk CSV/Excel import, exports, templates |
| `sync-logs.routes.ts` | 55.2 KB | Outbound sync queue monitoring + DLQ |
| `reconciliation.routes.ts` | 14.6 KB | Data accuracy audit trails |
| `connections.routes.ts` | 12.6 KB | Channel connection management (OAuth + env) |

> Plus 100+ additional modules covering: catalog, DAM, insights, AI, automation, webhooks, field mapping, GTIN exemption, A+ Content, Brand Story/Kit, channel-specific ops

---

## Services Directory (`apps/api/src/services/`)

302 folders, 677+ TypeScript files. Key service areas:

| Area | Description |
|------|-------------|
| `amazon/` | SP-API wrapper, catalog sync, order/financial sync, suppressions |
| `ebay/` | Inventory API, flat-file sync, token refresh, returns polling |
| `shopify/` | Inventory/orders push, webhook ingestion |
| `products/` | Product CRUD, variant sync, family mgmt, bulk upload, image publishing |
| `amazon-pushback/` | Bidirectional write-back (titles, prices, inventory) |
| `ebay-pushback/` | eBay Inventory API push + variation updates |
| `ai/` | LLM-powered (list-wizard, product titles, descriptions — Gemini) |
| `advertising/` | Ad sync, campaign mgmt, bid optimization, performance reporting |
| `listings/` | Listing state machine, health scoring, quality checks |
| `listing-wizard/` | Multi-step wizard, validation, AI enrichment |
| `marketing-os/` | Campaign orchestration across Amazon/eBay/Shopify |
| `reviews/` | Email campaigns, sentiment analysis, response mgmt |
| `pim/` | Field registry, schema resolution, variant attribute system |
| `field-resolution/` | Cross-channel/marketplace field linking |
| `saved-views/` | Canned filters + alert system |
| `forecast/` | Demand forecasting, accuracy tracking |
| `replenishment/` | Auto-PO engine, lead-time tracking, safety stock |
| `images/` | DAM integration, publish reconciliation, quality checks |
| `inventory/` | Stock sync, ATP calculation, reservations, lot tracking |
| `agents/` | AI control plane, task execution, tool definitions |
| `automation/` | Bulk rule engine, approval workflows |

---

## Workers (BullMQ — 8 files)

| Worker | Purpose |
|--------|---------|
| `bullmq-sync.worker.ts` | Main sync queue processor |
| `channel-sync.worker.ts` | Per-channel publish orchestrator |
| `bulk-job.worker.ts` | Bulk operation processor |
| `bulk-list.worker.ts` | Bulk list sync |
| `ads-sync.worker.ts` | Advertising sync flow |
| `read-cache.worker.ts` | ProductReadCache refresh |
| `search-index.worker.ts` | Typesense index updates |

See [[06 - Background Jobs & Workers]] for cron job inventory.

---

## Middleware & Utilities

| File | Purpose |
|------|---------|
| `api-key-auth.ts` | API key verification (bcrypt / legacy SHA-256), scopes, IP allowlist, grace windows |
| `api-key-hook.ts` | Fastify hook for per-route API key gating |
| `sse.ts` | SSE headers (`text/event-stream`, CORS, no-cache) |
| `error-handler.ts` | Standardised HTTP error responses |
| `rate-limiter.ts` | `@fastify/rate-limit` configuration |
| `ttl-cache.ts` | In-memory cache with TTL (template + schema caching) |
| `request-context.ts` | Request ID tracking for distributed tracing |
| `server-timing.ts` | `Server-Timing` header for perf monitoring |
| `logger.ts` | Structured JSON logging |
| `cors-origins.js` | CORS allowlist (Vercel web origin + internal) |
| `cron-observability.ts` | Cron step tracking for boot diagnostics |
| `otel-setup.ts` | OpenTelemetry SDK bootstrap (HTTP tracing backend) |
| `data-transformer.ts` | Common transforms (currency, dates, locales) |
| `marketplace-code.ts` | `MARKETPLACE_ID ↔ CODE` lookups |
| `image-publish-audit.ts` | Image publish auditing helpers |

---

## External SDK Clients

| File | SDK | Purpose |
|------|-----|---------|
| `amazon-sp-api.client.ts` (49 KB) | `amazon-sp-api` v1.2.1 | SP-API wrapper + request signing (LWA + IAM) |
| `amazon-fba-inbound-v2.client.ts` (12.5 KB) | Custom | FBA Inbound Shipment V2 API |
| `ebay.provider.ts` | Custom wrapper | eBay REST API (OAuth 2.0) |

---

## Key Libraries

| Package | Version | Use |
|---------|---------|-----|
| `fastify` | 5.0.0 | HTTP server |
| `@prisma/client` | 6.19.3 | Database ORM |
| `@prisma/adapter-pg` | 6.19.3 | Pooled PG connections |
| `bullmq` | 5.76.2 | Job queue + scheduler |
| `ioredis` | 5.10.1 | Redis client |
| `@aws-sdk/client-s3` | — | File storage |
| `@aws-sdk/client-sqs` | — | Amazon SQS (order events) |
| `@google/generative-ai` | 0.24.1 | Gemini AI |
| `cloudinary` | 2.10.0 | DAM / CDN |
| `sharp` | — | Image processing |
| `pdfkit` / `pdf-lib` | — | PDF generation |
| `exceljs` | — | Excel import/export |
| `jszip` | — | ZIP archive handling |
| `bcryptjs` | — | API key hashing |
| `@opentelemetry/sdk-node` | — | Distributed tracing |

---

## SSE Event Streams

| Endpoint | Purpose |
|----------|---------|
| `GET /api/dashboard/events` | Command Center real-time stream |
| `GET /api/listings/events` | Listing publish status updates |
| `GET /api/fulfillment/events` | Inbound/outbound events |
| `GET /api/orders/events` | Order state changes |
| `GET /api/marketing/os/events` | Campaign events |
| `GET /api/bulk-operations/events` | Bulk job progress |

See [[07 - Real-time Architecture]] for full SSE detail.

---

## Related Notes

- [[05 - Database Schema]] — Prisma models the API reads/writes
- [[06 - Background Jobs & Workers]] — cron jobs inventory
- [[07 - Real-time Architecture]] — SSE + BullMQ deep-dive
- [[11 - Amazon SP-API Integration]] — SP-API client details
- [[25 - Authentication & Authorization]] — API key system
