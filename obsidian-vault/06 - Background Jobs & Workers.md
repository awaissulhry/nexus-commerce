# Background Jobs & Workers

→ [[00 - Nexus Commerce MOC]] | [[04 - API Layer (Fastify)]]

## Architecture

All async work goes through **BullMQ** backed by **Redis** (`REDIS_URL`).

```
BullMQ Scheduler (102 cron jobs)
     │
     ▼
Job Queue (Redis)
     │
     ▼
Workers (8 processors)
     │
     ▼
Services → External APIs / Prisma
```

---

## Workers (8 files)

| Worker | File | Purpose |
|--------|------|---------|
| Main sync | `bullmq-sync.worker.ts` | Main sync queue processor |
| Channel sync | `channel-sync.worker.ts` | Per-channel publish orchestrator |
| Bulk jobs | `bulk-job.worker.ts` | Bulk operation processor (CSV/Excel) |
| Bulk list | `bulk-list.worker.ts` | Bulk listing sync |
| Ads sync | `ads-sync.worker.ts` | Advertising sync flow |
| Read cache | `read-cache.worker.ts` | `ProductReadCache` refresh |
| Search index | `search-index.worker.ts` | Typesense index updates |

---

## Cron Jobs (102 `.job.ts` files)

### Amazon SP-API Crons

| Job | Schedule | Purpose |
|-----|----------|---------|
| `amazon-orders-sync.job.ts` | Frequent | Pull new orders from SP-API |
| `amazon-sqs-poll.job.ts` | 15 min (+ SQS push) | Poll `ORDER_CHANGE` events via SQS for ~30s latency |
| `amazon-inventory-sync.job.ts` | Hourly | Sync FBA inventory levels |
| `amazon-financial-events.job.ts` | Daily | Pull settlement/transaction data |
| `amazon-zero-totals-backfill.job.ts` | Periodic | Backfill orders with $0 totals via `getOrder` |
| `amazon-attribute-hydration.job.ts` | Periodic | Hydrate category attributes from SP-API |
| `amazon-flat-file-feed-poll.job.ts` | Frequent | Poll flat-file feed submission status |
| `amazon-aplus-sync.job.ts` | Daily | Sync A+ Content status |
| `amazon-mcf-status.job.ts` | Frequent | Check MCF shipment status |
| `amazon-settlement-sync.job.ts` | Daily | Ingest settlement reports |
| `amazon-suppressions-sync.job.ts` | Hourly | Pull suppressed listings |

### eBay Crons

| Job | Purpose |
|-----|---------|
| `ebay-token-refresh.job.ts` | Refresh OAuth tokens before expiry |
| `ebay-orders-sync.job.ts` | Pull new eBay orders |
| `ebay-status-reconciliation.job.ts` | Reconcile listing status |
| `ebay-financial-sync.job.ts` | Pull eBay financial transactions |
| `ebay-returns-poll.job.ts` | Poll eBay returns API |

### Stock & Inventory Crons

| Job | Purpose |
|-----|---------|
| `stock-drift-detection.job.ts` | Detect stock discrepancies vs channel |
| `reservation-sweep.job.ts` | Expire stale soft reservations |
| `cycle-count-schedule.job.ts` | Trigger scheduled cycle counts |
| `lot-expiry-alerts.job.ts` | Alert on lots nearing expiry (EU GPSR) |
| `fba-flip-guard.job.ts` | Fail-closed guard against FBA→FBM flips |
| `pan-eu-sync.job.ts` | Sync inventory across 11 EU Amazon markets |
| `fba-drift-detection.job.ts` | Detect FBA inventory drift |

### Fulfillment Crons

| Job | Purpose |
|-----|---------|
| `restock-ingestion.job.ts` | Ingest FBA restock recommendations |
| `late-shipment-flagging.job.ts` | Flag orders at risk of late shipment |
| `tracking-pushback.job.ts` | Push tracking numbers to marketplaces |
| `carrier-sync.job.ts` | Sync carrier service availability |

### Pricing Crons

| Job | Purpose |
|-----|---------|
| `pricing-hourly-refresh.job.ts` | Refresh competitive prices hourly |
| `repricing-evaluation.job.ts` | Run repricing rule engine |
| `pricing-watchdog.job.ts` | Alert on price anomalies |
| `buy-box-tracking.job.ts` | Poll Buy Box ownership |

### Advertising Crons

| Job | Purpose |
|-----|---------|
| `ads-sync.job.ts` | Sync campaigns + ad groups from SP-API |
| `campaign-reconciliation.job.ts` | Reconcile 338→169 dedup (marketplace ID split fix) |
| `budget-enforcement.job.ts` | Enforce daily budget caps |
| `dayparting.job.ts` | Adjust bids by time-of-day rules |
| `rank-defense.job.ts` | Defend organic rank with bid boosts |
| `ads-automation-rules.job.ts` | Execute automation rule conditions |
| `keyword-resync.job.ts` | Resync keyword/target bids via SP-API v3 |

### Orders Crons

| Job | Purpose |
|-----|---------|
| `order-sync.job.ts` | General order sync (Amazon + eBay) |
| `refund-retry.job.ts` | Retry failed refund requests |
| `refund-deadline-tracking.job.ts` | Alert approaching refund deadlines |
| `sales-accuracy-drift.job.ts` | Detect accuracy drift vs marketplace totals |

### Analytics Crons

| Job | Purpose |
|-----|---------|
| `sales-report-ingest.job.ts` | Ingest Amazon T+1 sales reports (~03:00 UTC) |
| `dashboard-digest.job.ts` | Aggregate daily stats for dashboard |
| `forecast-accuracy.job.ts` | Score forecast model accuracy |
| `abc-classification.job.ts` | ABC inventory classification |

### Data Integrity Crons

| Job | Purpose |
|-----|---------|
| `retention-sweep.job.ts` | Apply data retention policies |
| `soft-delete-purge.job.ts` | Hard-delete soft-deleted records after retention window |
| `orphan-cleanup.job.ts` | Remove orphaned records |
| `schema-refresh.job.ts` | Refresh cached Prisma schemas |
| `observability-retention.job.ts` | Purge old telemetry logs |

### Compliance Crons

| Job | Purpose |
|-----|---------|
| `certification-expiry-alerts.job.ts` | Alert on expiring product certifications |
| `circular-dependency-check.job.ts` | Detect circular bundle dependencies |

### Bulk & Automation Crons

| Job | Purpose |
|-----|---------|
| `automation-tick.job.ts` | Evaluate automation rule conditions |
| `scheduled-actions.job.ts` | Execute bulk scheduled actions |
| `wizard-cleanup.job.ts` | Expire abandoned listing wizards |

### Returns

| Job | Purpose |
|-----|---------|
| `auto-po-replenishment.job.ts` | Auto-create POs for returned-and-destroyed items |

---

## BullMQ Job Flow

```
1. Scheduler triggers job (cron expression)
2. Job added to named queue in Redis
3. Worker picks up job
4. Worker calls service method
5. Service updates DB (Prisma)
6. If channel write needed → adds to OutboundSyncQueue
7. channel-sync.worker processes OutboundSyncQueue
8. Calls marketplace API (SP-API / eBay / Shopify)
9. Updates ChannelListing status
10. Broadcasts SSE event
```

---

## Related Notes

- [[07 - Real-time Architecture]] — SSE events triggered by workers
- [[11 - Amazon SP-API Integration]] — SP-API cron details
- [[17 - Inventory & Fulfillment]] — stock/FBA worker flows
- [[27 - Bidding Engine Microservice]] — separate BullMQ consumer
