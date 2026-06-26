# System Architecture Overview

→ [[00 - Nexus Commerce MOC]]

## Bird's-Eye View

Nexus Commerce is a **TypeScript monorepo** structured as:

```
nexus-commerce/
├── apps/
│   ├── api/          ← Fastify 5 backend (Node.js, ES modules)
│   └── web/          ← Next.js 16 frontend (App Router)
├── packages/
│   ├── database/     ← Prisma 6 schema + generated client
│   └── shared/       ← Validation utils, config vault
├── services/
│   └── bidding-engine/ ← Fastify microservice (BullMQ + inventory elasticity)
├── docs/             ← 108 markdown spec docs
├── plans/            ← 52+ blueprint planning files
├── scripts/          ← 334+ utility/automation scripts
├── docker-compose.yml
├── turbo.json
├── railway.toml
└── vercel.json
```

---

## Architectural Layers

```
┌─────────────────────────────────────────────────────┐
│                    VERCEL (fra1)                     │
│           Next.js 16 App Router  (apps/web)          │
│     40+ route groups, design-system, SSE clients     │
└─────────────────┬───────────────────────────────────┘
                  │ HTTPS / REST / SSE
┌─────────────────▼───────────────────────────────────┐
│                  RAILWAY (europe-west4)               │
│          Fastify 5 API  (apps/api)                   │
│    147 route modules · 1,438 endpoints               │
│    102 cron jobs · 8 BullMQ workers                  │
└──────┬──────────────────────────────┬────────────────┘
       │                              │
┌──────▼──────┐             ┌─────────▼──────────────┐
│  Neon PG    │             │   Redis (Railway)       │
│  PostgreSQL │             │   BullMQ queues         │
│  416 models │             │   Rate-limit counters   │
│  Prisma ORM │             │   Session cache         │
└─────────────┘             └────────────────────────┘
       │                              │
┌──────▼──────────────────────────────────────────────┐
│              EXTERNAL SERVICES                       │
│  Amazon SP-API · eBay Inventory API · Shopify REST   │
│  Amazon SQS · AWS S3 · Cloudinary · Google Gemini    │
└─────────────────────────────────────────────────────┘
       │
┌──────▼─────────────────────────┐
│  BIDDING ENGINE (Railway)      │
│  Fastify microservice          │
│  BullMQ consumer               │
│  Inventory-elasticity formula  │
│  Token-bucket 429 throttle     │
└────────────────────────────────┘
```

---

## Data Flow Patterns

### 1. Inbound — Marketplace → Nexus
```
Amazon SQS (ORDER_CHANGE)
  → amazon-sqs-poll.job.ts (15-min cron, ~30s live)
  → Order table (Prisma upsert)
  → SSE broadcast on /api/dashboard/events
  → Next.js EventSource → UI update
```

### 2. Outbound — Nexus → Marketplace
```
User action (save product / publish listing)
  → products.routes.ts / listings-syndication.routes.ts
  → OutboundSyncQueue (BullMQ job)
  → channel-sync.worker.ts
  → SP-API / eBay Inventory API / Shopify REST
  → ChannelListing table updated
  → SSE broadcast on /api/listings/events
```

### 3. Cron-driven Sync
```
102 cron jobs (BullMQ scheduler)
  → Per-channel sync workers
  → SP-API polls (orders, inventory, financial)
  → Drift detection / reconciliation
  → Dashboard aggregates refreshed
```

---

## Key Design Principles

| Principle | Implementation |
|-----------|---------------|
| **Fail-closed guards** | FBA→FBM flip guard; flat-file feed guard |
| **Ship live, not dark** | Features enabled by default; diff+budget = safety |
| **SSE over WebSocket** | Simpler for one-way server push; 5 active streams |
| **BullMQ for all async** | Unified queue abstraction; 102 cron + 8 workers |
| **Prisma for all DB** | Single schema source of truth; 310 migrations tracked |
| **Design system mandatory** | All UI from `apps/web/src/design-system` primitives |

---

## Related Notes

- [[02 - Monorepo Structure]] — workspace layout, turbo pipelines
- [[03 - Deployment Architecture]] — Railway, Vercel, Neon details
- [[04 - API Layer (Fastify)]] — route modules, services, middleware
- [[05 - Database Schema]] — all 416 Prisma models
- [[07 - Real-time Architecture]] — SSE + BullMQ + SQS deep-dive
