# Real-time Architecture

→ [[00 - Nexus Commerce MOC]] | [[01 - System Architecture Overview]]

## Overview

Nexus Commerce uses **Server-Sent Events (SSE)** for server-to-client push, **Amazon SQS** for marketplace event ingestion, and **BullMQ** for internal async fan-out.

---

## Server-Sent Events (SSE)

### How SSE Works in This Codebase

```
Client (Next.js)                     Server (Fastify)
   │                                      │
   │── GET /api/[domain]/events ──────────►│
   │◄── text/event-stream (long-lived) ───│
   │                                      │
   │   [background event occurs]          │
   │◄── data: {"type":"order.created"} ───│
   │◄── data: {"type":"stock.updated"} ───│
   │                                      │
   │   (connection kept open indefinitely)│
```

### SSE Utility (`middleware/sse.ts`)
Sets headers:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- CORS headers (manually set, bypasses `@fastify/cors`)
- Uses `resolveAllowedOrigin()` for cross-origin validation

### Active SSE Endpoints

| Endpoint | Events Broadcast |
|----------|-----------------|
| `GET /api/dashboard/events` | Order created/updated, sales snapshots, stock alerts |
| `GET /api/listings/events` | Publish status changes, feed progress, reconciliation |
| `GET /api/fulfillment/events` | Inbound shipment updates, stock movements |
| `GET /api/orders/events` | Order state transitions |
| `GET /api/marketing/os/events` | Campaign start/pause/budget alerts |
| `GET /api/bulk-operations/events` | Bulk job progress, completion |

### Client-Side SSE Hooks (Next.js)

| Hook | File | Subscribes To |
|------|------|---------------|
| `useOrderEventsRefresh` | `use-order-events-refresh.ts` | `/api/orders/events` — order updates |
| `useReviewEventsRefresh` | `use-review-events-refresh.ts` | Review pipeline events |

---

## Amazon SQS → Real-time Orders

### Flow

```
Amazon → SQS Queue (ORDER_CHANGE notification)
    │
    ▼
amazon-sqs-poll.job.ts
(15-min cron as fallback)
    │
    ▼  (SQS message received)
amazon.routes.ts / order ingester
    │
    ▼
Prisma upsert → Order, OrderItem tables
    │
    ▼
SSE broadcast → /api/dashboard/events
    │
    ▼
Next.js EventSource → UI update
```

### Latency
- **SQS push path:** ~30 seconds (SQS polling interval)
- **Cron fallback:** 15 minutes (catches missed events)

### Event Type
- `ORDER_CHANGE` — new or updated Amazon order
- `ORDER_STATUS_CHANGE` — status-only change (parallel processing)

---

## BullMQ Internal Event Fan-out

```
User saves product
    │
    ▼
listings-syndication.routes.ts
    │
    ▼
OutboundSyncQueue.add(job)  ← BullMQ
    │
    ▼
channel-sync.worker.ts picks up job
    │
    ├─► Amazon SP-API call
    ├─► eBay Inventory API call
    └─► Shopify REST call
          │
          ▼
     ChannelListing.status updated
          │
          ▼
     SSE broadcast on /api/listings/events
```

---

## LiveSyncBadge

A UI component on `/orders` that shows:
- **Green dot:** SQS connected, receiving push events
- **Orange dot:** Falling back to 15-min cron
- **Red dot:** SQS disconnected

---

## Real-time Components (Next.js)

| Component | Purpose |
|-----------|---------|
| `LiveSyncBadge` | SQS connection health indicator on /orders |
| `GlobalDlqBanner` | Banner when Dead Letter Queue has items |
| `GlobalAccountHealthBanner` | Amazon account health alert |
| `PushHealthChip` | Per-channel publish health indicator |
| `BulkProgressBanner` | Live bulk job progress |
| `NotificationsBell` | Browser notification opt-in + real-time alerts |
| `CompetitiveAlertWatcher` | Competitive pricing alert monitor |

---

## SSE vs WebSocket — Why SSE

| Concern | SSE | WebSocket |
|---------|-----|-----------|
| Direction | Server → Client only ✓ | Bidirectional |
| HTTP proxies | Works through standard proxies ✓ | Requires upgrade |
| Reconnection | Built-in auto-reconnect ✓ | Manual |
| Complexity | Simple — plain HTTP ✓ | More complex |
| Use case | Dashboard updates, publish status ✓ | Chat, collaborative editing |

All Nexus real-time use cases are server-push only → SSE is correct choice.

---

## DLQ (Dead Letter Queue) Monitoring

```
channel-sync.worker.ts
    │
    ▼  (job fails after max retries)
DLQ (Redis key: nexus:dlq)
    │
    ▼
GlobalDlqBanner (Next.js) shows warning
    │
    ▼
/sync-logs/live tail-f view for investigation
```

---

## salesReport.refreshed Event

```
sales-report-ingest.job.ts (runs ~03:00 UTC)
    │
    ▼
S3 download → parse → DailySalesAggregate upsert
    │
    ▼
salesReport.refreshed SSE event
    │
    ▼
/analytics/portfolio auto-reloads
(dual-source toggle: live preview vs Amazon T+1)
```

---

## Related Notes

- [[06 - Background Jobs & Workers]] — cron jobs that trigger SSE events
- [[11 - Amazon SP-API Integration]] — SQS ORDER_CHANGE detail
- [[18 - Orders & Sales]] — order real-time flow
- [[16 - Listing Management]] — listing publish SSE events
