# Listing Management

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

Listing Management covers publishing products to marketplace channels (Amazon/eBay/Shopify), tracking listing health, and recovery workflows.

---

## Data Flow

```
Product (master catalog)
    │
    ▼
Listing Wizard (AI-assisted creation)
    │
    ▼
DraftListing (validated, pending)
    │
    ▼
OutboundSyncQueue (BullMQ)
    │
    ├─► Amazon SP-API → ASIN/SKU listing
    ├─► eBay Inventory API → Item listing
    └─► Shopify REST → Product listing
          │
          ▼
     ChannelListing (status updated)
     VariantChannelListing (per-variant)
          │
          ▼
     SSE broadcast → /api/listings/events
```

---

## Listing Wizard

6-step AI-powered wizard (`listing-wizard.routes.ts` — 202.8 KB):

| Step | Purpose |
|------|---------|
| 1 | Select product + target channel |
| 2 | Category selection (AI browse node suggestions) |
| 3 | Attributes/aspects completion |
| 4 | AI-generated title + description |
| 5 | Images selection |
| 6 | Review + publish |

26 commits in SP+AB+AET+BV+CR arcs closing end-to-end. 15 verifier test cases.  
Closes TECH_DEBT #14 + #15 (brand-voice) + #44.

---

## Listing State Machine

```
DRAFT → PENDING_PUBLISH → ACTIVE → (INACTIVE | SUPPRESSED | ERROR)
                                         │
                                         ▼
                                   RECOVERY WORKFLOW
                                         │
                                         ▼
                                      ACTIVE
```

States tracked in `ChannelListing.status`.

---

## Listing Health Scoring

`ListingQualitySnapshot` — point-in-time quality score:

Factors:
- Title completeness + keyword density
- Image count + quality
- Description completeness
- Required attributes filled
- Price competitiveness
- A+ Content presence

Health issues tracked in `ListingIssue` (code, severity, message).

---

## Multi-Channel Syndication (`listings-syndication.routes.ts` — 157.9 KB)

Handles publish engine + SSE events:
- `OutboundSyncQueue` → `channel-sync.worker.ts`
- Per-channel push logic
- SSE event broadcast on publish status change

---

## Amazon Listing Cockpit (AC-series, 14 phases)

All 14 phases shipped 2026-05-24 on `/products/[id]/edit?tab=amazon`:

| Phase | Feature |
|-------|---------|
| AC.1 | Shell |
| AC.2 | PDP preview |
| AC.3 | Health chips |
| AC.4 | Health score |
| AC.5 | Draft bus |
| AC.6 | Variation matrix |
| AC.7 | Category AI |
| AC.8 | A+ Content card |
| AC.9 | Pricing + Buy Box |
| AC.10 | Suppression handling |
| AC.11 | Smart Auto-Fill |
| AC.12 | Publish Flow |
| AC.13 | Cockpit shortcuts |
| AC.14 | ARIA + telemetry |

HARD CONSTRAINT: `/products/amazon-flat-file` routes/page untouched throughout.

---

## eBay Listing Cockpit (EC-series, 15 phases)

See [[12 - eBay Integration]] for full detail.

---

## Amazon Flat-File Editor

Route: `apps/api/src/routes/amazon-flat-file.routes.ts`  
Page: `apps/web/src/app/products/amazon-flat-file/`

**UNTOUCHABLE** — zero edits to page or routes without explicit approval.

### Market Switch (FF-MS-series, 6 commits)

| Feature | Commit |
|---------|--------|
| URL-first nav + AbortController + skeleton | FF-MS.1+2+3 |
| SWR cache + hover prefetch | FF-MS.4 |
| Dirty-flush + per-market badge | FF-MS.5 |
| Status-aware Retry | FF-MS.6 |
| Alt+1..5 keyboard shortcuts | FF-MS.7 |
| Switch-latency telemetry | FF-MS.9 |

---

## eBay Flat-File Editor

Route: `apps/api/src/routes/ebay-flat-file.routes.ts`  
Page: `apps/web/src/app/products/ebay-flat-file/`

**UNTOUCHABLE** — same constraint as Amazon.

---

## Listing Recovery

`/listings/recovery` route:
- Reactivation workflows (suppressed → active)
- Deactivation (remove from channel)
- `ListingRecoveryEvent` audit trail

---

## Reconciliation

`/api/reconciliation` routes:
- Compare Nexus listing state vs live marketplace data
- `ListingReconciliation` model stores diff
- Reconcile cron: heals `DONE`-but-`DRAFT` image states

---

## Real-time Listing Events (L-RT series)

4 phases shipped 2026-05-22:
- **L-RT.1:** Per-channel SSE pipe
- **L-RT.2:** Publish-status reactivity
- **L-RT.3:** `PushHealthChip` + `BulkProgressBanner` mounted
- **L-RT.4:** `wizard.submitted` cross-tab toast

---

## Listing Accuracy (ALA-series)

Closes 7 Amazon listing-accuracy gaps:
- **P0 byte-length:** Shipped 2026-06-23 — enforce byte limits on listing attributes
- **FFC (flat-file creation):** Shipped 2026-06-23 — create NEW products from flat-file editor
- 5 more gaps tracked in plan `fizzy-gathering-goblet.md`

---

## Field Linking (Deferred)

Cross-market/channel cell linking scoped 2026-05-20, user holds saved prompt. Resume from Phase L.0+L.1.

---

## Key Models

| Model | Purpose |
|-------|---------|
| `ChannelListing` | Per-product per-channel listing record |
| `VariantChannelListing` | Per-variant channel state |
| `DraftListing` | Draft before publish |
| `ListingWizard` | In-progress wizard state |
| `ListingIssue` | Health issues |
| `ListingRecoveryEvent` | Recovery action log |
| `ListingReconciliation` | Reconciliation diff |
| `ListingQualitySnapshot` | Quality score history |
| `OutboundSyncQueue` | Publish job queue (BullMQ) |

---

## Related Notes

- [[15 - Product Management]] — products that get listed
- [[11 - Amazon SP-API Integration]] — Amazon publish path
- [[12 - eBay Integration]] — eBay publish path
- [[13 - Shopify Integration]] — Shopify publish path
- [[07 - Real-time Architecture]] — SSE for listing events
