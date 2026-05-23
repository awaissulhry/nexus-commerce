# Purchase orders (PO-series)

End-to-end documentation of the 18-phase `/fulfillment/purchase-orders` rebuild
shipped 2026-05-23 → 2026-05-24. This document is the canonical reference for
operators, future agents working on the surface, and anyone wiring an external
integration to the PO API.

## What lives where

| Surface                          | Path                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| List + table + cards             | `/fulfillment/purchase-orders`                                |
| Detail page                      | `/fulfillment/purchase-orders/[id]`                           |
| Supplier ack (public, no auth)   | `/po/ack/[token]`                                             |
| Settings (approval ladder)       | `/settings/company` → "Purchase order approval" section       |
| Backend                          | `apps/api/src/routes/fulfillment.routes.ts`                   |
| Workflow service                 | `apps/api/src/services/po-workflow.service.ts`                |
| Factory PDF                      | `apps/api/src/services/factory-po-pdf.service.ts`             |
| Supplier email                   | `apps/api/src/services/po-supplier-email.service.ts`          |
| SSE event bus                    | `apps/api/src/services/po-events.service.ts`                  |
| Frontend shared                  | `apps/web/src/app/fulfillment/purchase-orders/_shared/`       |

## Data model

```text
Supplier (existing)
  ├─ products      SupplierProduct[]    SKU / cost / MOQ / case-pack per product
  └─ purchaseOrders PurchaseOrder[]

PurchaseOrder
  ├─ items                    PurchaseOrderItem[]   per-line qty + cost + note + lineOrder
  ├─ inboundShipments         InboundShipment[]     receive batches
  ├─ attachments              PurchaseOrderAttachment[]  PO.1 — quote / contract / art
  ├─ revisions                PurchaseOrderRevision[]    PO.8 — post-SUBMITTED change chain
  ├─ comments                 PoComment[]                PO.7 — threaded with @-mentions
  ├─ supplierAckToken         String? @unique             PO.9 — public ack URL
  ├─ supplierAckExpiresAt     DateTime?
  ├─ supplierConfirmedDeliveryDate / supplierConfirmedAt  PO.9
  └─ version                  Int — optimistic lock for PO.6 edits

BrandSettings
  ├─ requireApprovalForPo            Boolean  PO.7
  ├─ poApprovalThresholdCents        Int?     PO.7 — value ladder
  ├─ poApprovalApproverEmail         String?  PO.7
  └─ piva / codiceFiscale / sdiCode  String?  Italian fiscal (PO.12)
```

## State machine

```text
DRAFT ──submit-for-review──▶ REVIEW ──approve──▶ APPROVED ──send──▶ SUBMITTED ──acknowledge──▶ ACKNOWLEDGED
  │                            │                    │                    │                          │
  └────────cancel──────────────┴────────cancel──────┴────────cancel──────┘                          │
                                                                                                    │
  PARTIAL ◀── inbound.received (partial) ───────────────────────── ACKNOWLEDGED / CONFIRMED ────────┤
  RECEIVED ◀─ inbound.received (full, within tolerance) ──────────────────────────────────────────  ┘
```

- Forward only. The only backward edge is `cancel`, allowed up to APPROVED.
- Auto-advance through REVIEW when **all** conditions hold:
  - `BrandSettings.requireApprovalForPo` is false **AND**
  - `BrandSettings.poApprovalThresholdCents` is null OR `totalCents ≤ threshold`
- Above-threshold POs stop at REVIEW. Approver email (when set) surfaces in the
  UI; PO.9 email automation for approvers is out of scope.
- `PARTIAL`/`RECEIVED` are driven by `inbound.service.syncPoState()` after each
  goods receipt, not by the workflow service.

## Auto-close tolerance + PPV (PO.10)

Configured by env vars (no schema migration):

| Var                                       | Default | Effect                                                                                     |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `NEXUS_PO_AUTO_CLOSE_TOLERANCE_UNITS`     | `0`     | When `ordered − received ≤ tolerance`, PO closes to RECEIVED instead of staying PARTIAL.    |
| `NEXUS_PO_PPV_WARNING_BP`                 | `200`   | Per-line price-variance threshold in basis points (200 = 2%). UI flags lines above this.    |

## Real-time (PO.4)

In-process event bus + SSE endpoint:

- `publishPoEvent({ type, poId, … })` from `po-events.service.ts`
- `GET /api/fulfillment/purchase-orders/events` — SSE stream, 25s heartbeat
- Event types: `po.created`, `po.updated`, `po.transitioned`, `po.deleted`,
  `po.restored`, `po.received`

Frontend subscriber: `apps/web/src/lib/sync/use-po-events.ts`. Events re-emit
through the shared `nexus:invalidations` BroadcastChannel so every open tab
refreshes within ~200ms of a peer mutation.

## API surface

### Read

| Method | Path                                                       | Purpose                                                                 |
| ------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/fulfillment/purchase-orders`                             | List with filters: status, supplierIds, warehouseId, currencyCode, minValueCents, maxValueCents, expectedFrom, expectedTo, lateOnly, deleted |
| GET    | `/fulfillment/purchase-orders/:id`                         | Detail + items + supplier + warehouse + attachments + revisions + comments + fiscal block |
| GET    | `/fulfillment/purchase-orders/:id/audit`                   | Chronological transition trail                                          |
| GET    | `/fulfillment/purchase-orders/:id/factory.pdf`             | Factory-ready PDF (locale: en / it / zh; fiscal block when brand.piva set) |
| GET    | `/fulfillment/purchase-orders/:id/match`                   | Three-way match analysis (PO.10) + landed cost rollup (PO.11)           |
| GET    | `/fulfillment/purchase-orders/spend-summary`               | Spend tile aggregation: open, in-transit, aging buckets, top suppliers   |
| GET    | `/fulfillment/purchase-orders/export.csv`                  | CSV of filtered (or `ids=`-selected) POs, one row per line item          |
| GET    | `/fulfillment/purchase-orders/cost-history?supplierId=&sku=` | Trailing-N cost samples for anomaly detection (PO.17)                  |
| GET    | `/fulfillment/purchase-orders/eoq-hint?productId=`         | Most-recent ReplenishmentRecommendation (PO.17)                         |
| GET    | `/fulfillment/purchase-orders/events`                      | SSE stream (PO.4)                                                       |
| GET    | `/fulfillment/suppliers/:id/catalog?q=`                    | SupplierProduct catalog feed for the smart-create autocomplete (PO.5)    |
| GET    | `/fulfillment/fx-rate?from=&to=`                           | Point-in-time FX rate (PO.5)                                            |

### Write

| Method | Path                                                        | Purpose                                                                  |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| POST   | `/fulfillment/purchase-orders`                              | Create a DRAFT PO                                                        |
| PATCH  | `/fulfillment/purchase-orders/:id`                          | Edit header (notes / expectedDeliveryDate / supplier / warehouse) with optimistic lock (PO.6) |
| PATCH  | `/fulfillment/purchase-orders/:id/lines`                    | Bulk-replace line items under a transaction + version check (PO.6)        |
| POST   | `/fulfillment/purchase-orders/:id/transition`               | Workflow transition (submit-for-review / approve / send / acknowledge / cancel) |
| POST   | `/fulfillment/purchase-orders/:id/receive`                  | Create an InboundShipment skeleton tied to this PO                       |
| POST   | `/fulfillment/purchase-orders/:id/comments`                 | Post a comment (with @-mentions) (PO.7)                                  |
| DELETE | `/fulfillment/purchase-orders/:id/comments/:commentId`      | Delete a comment (PO.7)                                                   |
| POST   | `/fulfillment/purchase-orders/:id/revisions`                | Open a revision on a SUBMITTED+ PO (PO.8)                                |
| PATCH  | `/fulfillment/purchase-orders/:id/revisions/:revisionId`    | Overwrite the proposed items (PO.8)                                       |
| POST   | `/fulfillment/purchase-orders/:id/revisions/:revisionId/apply`  | Apply the revision to the parent PO (PO.8)                            |
| POST   | `/fulfillment/purchase-orders/:id/revisions/:revisionId/cancel` | Cancel a pending revision (PO.8)                                       |
| POST   | `/fulfillment/purchase-orders/bulk-soft-delete`             | Soft-delete N POs                                                        |
| POST   | `/fulfillment/purchase-orders/bulk-restore`                 | Restore from recycle bin                                                 |
| POST   | `/fulfillment/purchase-orders/bulk-transition`              | Run a transition across N selected POs; returns per-id result (PO.16)     |
| POST   | `/fulfillment/purchase-orders/import-preview`               | Parse + validate a CSV without writes (PO.15)                            |
| POST   | `/fulfillment/purchase-orders/import`                       | Create POs from CSV (PO.15)                                              |
| POST   | `/fulfillment/purchase-orders/ai-draft`                     | LLM-parsed PO draft from natural language (PO.17)                        |

### Public (token-gated)

| Method | Path                                  | Purpose                                                       |
| ------ | ------------------------------------- | ------------------------------------------------------------- |
| GET    | `/po/ack/:token`                      | Supplier-side read-only view of the PO (PO.9)                  |
| POST   | `/po/ack/:token/confirm`              | Supplier confirms with optional ETA (PO.9)                     |
| POST   | `/po/ack/:token/decline`              | Supplier declines (PO.9)                                       |

## CSV format (PO.15)

Required columns:

```
groupKey, sku, quantityOrdered
```

Optional columns:

```
supplierName, supplierId, warehouseCode, expectedDeliveryDate (YYYY-MM-DD),
currencyCode, unitCostCents, lineNote
```

- Rows with the same `groupKey` form one PO. The first row of each group sets
  the supplier / warehouse / expected date / currency; subsequent rows in the
  same group only contribute their line item.
- Blank `groupKey` rows carry over to the most-recently-seen group within the
  upload.
- Suppliers are matched by name (case-insensitive); unknown names create a PO
  without a supplier and the preview surfaces a warning.

## Italian fiscal (PO.12)

The factory PDF and detail page both render an Imponibile / IVA / Totale block
when `BrandSettings.piva` is set. Configuration:

| Field                         | Where                       | Effect                                                       |
| ----------------------------- | --------------------------- | ------------------------------------------------------------ |
| `piva`                        | BrandSettings               | P.IVA shown on PDF letterhead + detail strip                  |
| `codiceFiscale`               | BrandSettings               | C.F. shown alongside P.IVA                                    |
| `sdiCode`                     | BrandSettings               | SDI code shown alongside P.IVA                                |
| `vatScheme`                   | BrandSettings               | Tag on the detail strip                                       |
| `NEXUS_DEFAULT_IVA_RATE_BP`   | env (default 2200)          | IVA rate in basis points (2200 = 22% standard)                |

Reverse-charge logic (DPR 633/72 Art. 17(6)):

- Supplier in IT → standard IVA at rate
- Supplier in EU-non-IT (DE, FR, etc.) → reverse charge: IVA = 0, banner shown
- Supplier in extra-EU (CN, US) → IVA = 0 (customs-handled)

PDF locales:

- Italian suppliers → `it`
- CN / HK / TW suppliers → `zh`
- Everything else → `en`

Override with `?locale=en|it|zh` on the factory PDF URL.

Deferred from PO.12:

- DDT (Documento di Trasporto) printable for supplier returns
- Nota di credito hookup

## Approval ladder (PO.7)

The pre-PO.7 boolean `requireApprovalForPo` is preserved. PO.7 layered a
value-based threshold on top of it.

Resolution order (in `po-workflow.service.ts:transitionPo`):

1. `requireApprovalForPo === true` → always stop at REVIEW
2. `poApprovalThresholdCents !== null && totalCents > threshold` → stop at REVIEW
3. Otherwise → auto-advance REVIEW → APPROVED on submit-for-review

Approver email (`poApprovalApproverEmail`) surfaces in the company-settings UI;
explicit notification email to the approver is deferred to a follow-up (would
naturally live in `po-supplier-email.service.ts` as a sibling template).

## Supplier ack URL (PO.9)

When the operator transitions APPROVED → SUBMITTED via `transition('send')`:

1. `po-supplier-email.service:sendPoToSupplier` mints a 256-bit URL-safe token
2. Writes `supplierAckToken` + `supplierAckExpiresAt` (default 30d via
   `NEXUS_PO_ACK_TTL_DAYS`)
3. Sends an HTML+text email via the existing shared `sendEmail` transport
   (Resend; dry-run unless `NEXUS_ENABLE_OUTBOUND_EMAILS=true`)
4. Returns the ack URL on the transition response so the detail page can
   surface it inline (Copy button)

Supplier-side `/po/ack/:token` page:

- No auth, no app chrome — just the PO summary + confirm/decline panel
- Confirm flips PO to ACKNOWLEDGED + writes `supplierConfirmedDeliveryDate`
- Decline flips PO to CANCELLED + revokes the token

Token rotates on every send. PO.8 revisions don't auto-rotate the token; the
operator must hit Send again on the revised PO to mint a fresh URL.

## Saved views + filters (PO.14)

Built-in view chips on the toolbar (no per-user persistence yet):

- **Late POs** — `?lateOnly=true`
- **Awaiting approval** — `?status=REVIEW`
- **Deliveries this week** — `?expectedFrom=<today>&expectedTo=<+7d>` (computed at apply-time)
- **Drafts** — `?status=DRAFT`
- **Received** — `?status=RECEIVED`

Advanced filters popover handles supplier multi-select, warehouse, currency,
value range, expected-delivery range, and the late-only toggle. Every filter is
URL-state-driven; share the URL to share the view.

## AI assists (PO.17)

Gated by `NEXUS_AI_KILL_SWITCH` (truthy = AI off for all surfaces). Provider
selection via `AI_PROVIDER` env (anthropic / gemini); falls back to whichever
is configured.

- **Natural-language draft** — purple banner at the top of the Create-PO modal.
  Calls `POST /ai-draft`, fuzzy-matches supplier name, resolves dates
  ("Friday", "next Tuesday") to YYYY-MM-DD, pre-fills the form.
- **Cost-anomaly chip** — per line, when current unit cost deviates from the
  trailing-N PO average by > 5%. Click to apply the average.
- **EOQ chip** — per line, when SKU is bound to a catalog product. Reads
  `ReplenishmentRecommendation.reorderQuantity`. Click to apply.

Deferred from PO.17: EN↔IT bilingual translation of operator notes.

## Permissioning

V0 is permissive — any operator can:

- Approve / send / cancel any PO
- Delete any comment (including others')
- Open / apply / cancel revisions
- Send POs to suppliers (rotates the ack token; old URLs invalidate)

PO.18 polish defers per-action authorization until a user model + roles ship
across the rest of the app.

## Deferred items (across the series)

These remain backlog. Each is a meaningful engagement on its own.

| Item                                          | Originally scoped in | Why deferred                                      |
| --------------------------------------------- | -------------------- | ------------------------------------------------- |
| Recurring + template POs                      | PO.15                | Needs `PoTemplate` + `PoSchedule` models + cron    |
| RFQ pre-PO flow (multi-supplier compare)      | PO.15                | Parallel-track feature, deserves its own series   |
| Bulk re-assign supplier                       | PO.16                | Nuanced (different currencies, warehouses, SKUs)  |
| Bulk merge POs                                | PO.16                | Same; SKU dedup semantics                          |
| EN↔IT bilingual notes (auto-translate)        | PO.17                | Lower-value than the three shipped surfaces       |
| Push landed cost to product/SupplierProduct   | PO.11                | Conflates supplier-quoted vs landed cost          |
| DDT / nota di credito                          | PO.12                | Touches inbound-return + supplier-credit flow      |
| Approver email notification                   | PO.7                 | Out-of-band; PO.9-pattern would extend cleanly    |
| User-saved + named views (persisted)          | PO.14                | Built-ins cover the documented operator workflows |
| Per-action authorization                      | PO.18                | Waiting on user-role model                         |
| Mobile-responsive scanner receive flow        | PO.18                | Desktop-first ops; revisit when receive volume grows |

## PO-Plus engagement (post-series follow-up)

After the original 18-phase PO-series shipped, an 8-phase PO-Plus
engagement closed out the documented deferred items + the operator-
spotted attachments gap:

| Phase | Topic                                                  | Commit       |
| ----- | ------------------------------------------------------ | ------------ |
| 1     | Attachments upload + viewer (Cloudinary)                | `f7767257`   |
| 2     | Approver email + `/po/approve/[token]` page             | `71639600`   |
| 3     | Quick-receive against PO from detail page               | `b1051345`   |
| 4     | Supplier scorecard drill from rows + identity strip     | `c200ef23`   |
| 5     | Bulk re-assign supplier + bulk merge POs                | `927dbf3a`   |
| 6     | Templates + recurring schedules + cron                  | `ce8d5cfd`   |
| 7     | User-saved named views + push landed cost to catalog    | `705d9591`   |
| 8     | Shortcuts + ship-to override + persisted event log      | `<this>`     |

### New endpoints (PO-Plus)

| Method | Path                                                              | Purpose                                  |
| ------ | ----------------------------------------------------------------- | ---------------------------------------- |
| POST   | `/fulfillment/purchase-orders/:id/attachments`                    | multipart upload to Cloudinary           |
| PATCH  | `/fulfillment/purchase-orders/:id/attachments/:attachmentId`      | rename / relabel                         |
| DELETE | `/fulfillment/purchase-orders/:id/attachments/:attachmentId`      | hard-delete                              |
| GET    | `/po/approve/:token`                                              | approver-side public view                |
| POST   | `/po/approve/:token/approve` `/decline`                           | one-click approve / decline              |
| POST   | `/fulfillment/purchase-orders/:id/quick-receive`                  | create + receive shipment in one shot    |
| POST   | `/fulfillment/purchase-orders/bulk-reassign-supplier`             | DRAFT/REVIEW supplier swap               |
| POST   | `/fulfillment/purchase-orders/bulk-merge`                         | combine multiple DRAFTs into one         |
| GET / POST / PATCH / DELETE | `/fulfillment/po-templates(/:id/instantiate?)` | Template CRUD + instantiate          |
| POST / PATCH / DELETE | `/fulfillment/po-templates/:id/schedules` / `/po-schedules/:id`  | recurring schedule CRUD |
| POST   | `/fulfillment/purchase-orders/:id/push-landed-cost`               | push landed cost → SupplierProduct       |
| GET    | `/fulfillment/purchase-orders/:id/event-log`                      | persisted PoEventLog rows for forensics  |

### Shortcuts (PO-Plus.8)

When the detail page has focus and the operator isn't typing in an input:

- `R` — submit DRAFT for review
- `A` — approve a REVIEW PO
- `S` — send an APPROVED PO to its supplier
- `K` — mark a SUBMITTED PO as acknowledged
- `/` — jump to the Comments tab
- `?` — toggle the shortcut sheet

### Still deferred after PO-Plus

| Item                                          | Why                                                    |
| --------------------------------------------- | ------------------------------------------------------ |
| RFQ pre-PO flow                               | 5–8 phases on its own; low leverage for single-source Xavia |
| Per-line warehouseId (multi-warehouse split)  | touches edit grid + receive flow + factory PDF; own engagement |
| DDT / nota di credito                         | needs the supplier-return flow (its own engagement)    |
| EN↔IT auto-translation                        | operators write in target language today               |
| Mobile scanner-friendly receive flow          | desktop-first; revisit when warehouse headcount grows  |
| Per-action authorization                      | waiting on user-roles model across the app             |

## Environment variables

| Var                                       | Default                             | Used by             |
| ----------------------------------------- | ----------------------------------- | ------------------- |
| `NEXUS_PO_AUTO_CLOSE_TOLERANCE_UNITS`     | `0`                                 | PO.10               |
| `NEXUS_PO_PPV_WARNING_BP`                 | `200`                               | PO.10               |
| `NEXUS_DEFAULT_IVA_RATE_BP`               | `2200`                              | PO.12               |
| `NEXUS_PO_ACK_TTL_DAYS`                   | `30`                                | PO.9                |
| `NEXUS_PUBLIC_WEB_URL`                    | `http://localhost:3000`             | PO.9 (ack URL base) |
| `NEXUS_ENABLE_OUTBOUND_EMAILS`            | `false` (dry-run)                   | PO.9                |
| `NEXUS_AI_KILL_SWITCH`                    | unset (off)                         | PO.17               |
| `AI_PROVIDER`                             | `gemini` (or whichever configured)  | PO.17               |
| `RESEND_API_KEY`                          | unset                               | PO.9 email send     |
| `NEXUS_EMAIL_FROM`                        | `Xavia <ship@xavia.it>`             | PO.9 default from   |
| `NEXUS_PO_APPROVER_ACK_TTL_DAYS`          | `14`                                | PO-Plus.2           |
| `NEXUS_ENABLE_SCHEDULED_PO`               | unset (off)                         | PO-Plus.6 cron      |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | unset                    | PO-Plus.1 uploads   |
