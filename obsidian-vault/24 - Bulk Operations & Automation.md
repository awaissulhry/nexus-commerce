# Bulk Operations & Automation

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

CSV/Excel bulk import/export, bulk action templates, scheduled execution, and if-then automation rules.

---

## Bulk Operations Route (`/bulk-operations`)

Route file: `bulk-operations.routes.ts` (30.9 KB)

### Sub-routes

| Route | Purpose |
|-------|---------|
| `/bulk-operations` | Job list (status, progress, results) |
| `/bulk-operations/import` | CSV/Excel import wizard |
| `/bulk-operations/templates` | Import/export templates |
| `/bulk-operations/scheduled` | Scheduled bulk tasks |

---

## Import Flow

```
User uploads CSV/Excel
    │
    ▼
ImportJob created (status: PENDING)
    │
    ▼
bulk-job.worker.ts processes rows
    │
    ├── Validate each row (ImportJobRow)
    ├── Apply transformations
    └── Upsert records (Product, Price, Stock, etc.)
          │
          ▼
     ImportJob.status = COMPLETED / FAILED_PARTIAL
          │
          ▼
     SSE broadcast → /api/bulk-operations/events
     (BulkProgressBanner updates in UI)
```

---

## Data Models

| Model | Purpose |
|-------|---------|
| `ImportJob` | Bulk import job |
| `ImportJobRow` | Per-row result (success / error + message) |
| `ExportJob` | Bulk export job |
| `ScheduledExport` | Recurring export schedule |
| `ScheduledImport` | Recurring import schedule |
| `DataExportRequest` | User-initiated export request |
| `BulkActionJob` | Bulk action job (e.g. bulk price update) |
| `BulkActionItem` | Per-item result |
| `BulkOperation` | Generic bulk operation |
| `ScheduledBulkAction` | Scheduled bulk action |
| `BulkAutomationApproval` | Approval required before execution |
| `FlatFilePullJob` | Flat-file pull from marketplace |

---

## Supported Import Types

| Type | Fields |
|------|--------|
| Products | SKU, title, description, category, brand |
| Pricing | SKU, price, channel, marketplace |
| Inventory | SKU, warehouse, quantity |
| Listings | SKU, ASIN, status |
| Flat file | Amazon/eBay feed format (per-channel) |

---

## Export Types

| Type | Formats |
|------|---------|
| Products | CSV, Excel |
| Orders | CSV, Excel, JSON |
| Inventory | CSV, Excel |
| Analytics | CSV, Excel, PDF |
| Fiscal invoices | PDF, CSV |

---

## Workers

| Worker | File | Purpose |
|--------|------|---------|
| `bulk-job.worker.ts` | BullMQ worker | Bulk import/export processor |
| `bulk-list.worker.ts` | BullMQ worker | Bulk listing sync |

---

## Automation Rules

Route: `/marketing/automation`  
Model: `AutomationRule`, `AutomationRuleTemplate`

### Rule Engine

```
AutomationRule {
  trigger: "order.delivered" | "stock.low" | "review.received" | "schedule"
  conditions: [{ field, operator, value }]
  actions: [{ type, params }]
  approvalRequired: boolean
}
```

### Available Triggers

| Trigger | Example |
|---------|---------|
| `order.delivered` | When order delivered |
| `stock.low` | When stock < threshold |
| `review.received` | When negative review posted |
| `schedule` | Daily/weekly cron |
| `listing.suppressed` | When listing suppressed |
| `buy_box.lost` | When Buy Box lost |

### Available Actions

| Action | Example |
|--------|---------|
| Update listing | Fix suppression |
| Send email | Notify team |
| Create task | Assign follow-up |
| Adjust price | Price match |
| Create purchase order | Restock trigger |
| Pause campaign | Budget protection |

---

## Approval Workflows

`BulkAutomationApproval`:
- Destructive actions require manager approval
- `approver-email.job.ts` — email notification
- Approval UI in `/bulk-operations`
- After approval → job executes

---

## Scheduled Tasks

`ScheduledBulkAction`:
- Schedule any bulk action on a cron expression
- Example: weekly price refresh, daily inventory export
- Managed via `/bulk-operations/scheduled`

Cron: `scheduled-actions.job.ts`

---

## Command Palette (Cmd+K)

Global command search:
- Open anywhere with `Cmd+K` (or `Ctrl+K`)
- Access any bulk action directly
- Navigate to any page
- Trigger common operations
- `CommandPalette` component in AppShell

---

## Real-time Progress

SSE stream: `GET /api/bulk-operations/events`  
Component: `BulkProgressBanner`

Shows:
- Current job progress (row X of Y)
- Estimated completion time
- Error count
- Download results link on completion

---

## Related Notes

- [[04 - API Layer (Fastify)]] — `bulk-operations.routes.ts`
- [[06 - Background Jobs & Workers]] — bulk workers
- [[07 - Real-time Architecture]] — SSE for progress
- [[15 - Product Management]] — bulk product import
- [[17 - Inventory & Fulfillment]] — bulk stock import
