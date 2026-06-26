# Marketing & Content

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

Digital Asset Management (DAM) hub, A+ Content, Brand Story, Brand Kit, content automation, and multi-channel publish orchestration.

---

## MC-series (Marketing Content — 46 commits)

All major waves shipped 2026-05-10. Remaining: MC.4/5 (AI), MC.7 (video), MC.13 (storage analytics), MC.14 (polish).

| Wave | Feature |
|------|---------|
| MC.1/2 | DAM hub + library |
| MC.3 | Filters + drawer |
| MC.6 | Bulk + saved views |
| MC.8 | Timeline + tags + folders |
| MC.9 | Upload + dedup |
| MC.10 | Quality + retry |
| MC.11 | Variants |
| MC.12 | A+ Content full stack |
| MC.12b | Brand Story full stack |
| MC.12c | Brand Kit full stack |
| MC.12d | Automation full stack |
| MC.12e | Channel publish (4-channel sandbox + dashboard + cascade fan-out via OutboundSyncQueue) |

---

## Digital Asset Management (DAM)

Route: `/marketing/content`

Features:
- Asset library with filters (type, tag, folder, date)
- Asset drawer (preview + metadata)
- Bulk operations (download, tag, move, delete)
- Saved views (canned filter combinations)
- Timeline view
- Folder tree (`AssetFolder`)
- Upload with deduplication (perceptual hash)
- Quality scoring
- Retry failed uploads
- Asset variants (different sizes/formats)

### Asset Models

| Model | Purpose |
|-------|---------|
| `DigitalAsset` | DAM asset (url, type, cloudinaryId, metadata) |
| `AssetFolder` | Folder tree for organisation |
| `AssetUsage` | Tracks where each asset is used |

### Cloudinary Integration

- Upload via Cloudinary SDK
- Transformation pipeline (resize, format, optimize)
- CDN delivery globally
- Webhook: `cloudinary-webhook.routes.ts` — lifecycle events

---

## A+ Content

Route: `/marketing/content/aplus`  
Model: `APlusContent`

Features:
- Module-based authoring (image + text, comparison table, highlight bar, etc.)
- Version control
- Marketplace-specific content (per Amazon market)
- Status tracking (DRAFT → SUBMITTED → PUBLISHED)
- Publish via Amazon Ads API A+ endpoint

---

## Brand Story

Route: `/marketing/content/brand-story`  
Model: `BrandStory`

- Amazon Brand Story (appears in product detail page brand section)
- Full authoring workflow
- Status: DRAFT → PUBLISHED

---

## Brand Kit

Route: `/marketing/content/brand-kit`  
Model: `BrandKit`

- Brand colors, fonts, logos
- Used as reference for AI content generation
- Enforces brand voice consistency

---

## AI Content Generation

> AI work partially deferred to `docs/MC-AI-DEFERRED.md`

Uses **Google Gemini** (`@google/generative-ai`):

| Feature | AI Role |
|---------|---------|
| Product titles | Generate channel-optimised titles |
| Descriptions | Generate from attributes + brand voice |
| A+ Content | Draft module content |
| Listing Wizard | 6-step AI-assisted creation |
| Brand Voice | Style-matched content enforcement |
| Ads Suggestions | Bid/keyword recommendations |

### Italian Terminology Glossary

- Giacca vs Giubbotto (jacket types) — important distinction for Italian market
- Future glossary entries for AI content guardrails
- Operators don't read Italian — UI stays English; Italian is content-only

---

## Channel Publish (Cascade Fan-out)

```
Content approved → publish trigger
    │
    ▼
OutboundSyncQueue (BullMQ)
    │
    ├─► Amazon (A+ Content API)
    ├─► eBay (description update)
    └─► Shopify (body_html update)
          │
          ▼
     4-channel sandbox dashboard
     (tracks publish status per channel)
```

---

## Automation

Route: `/marketing/automation`  
Model: `AutomationRule`

- If-then rule engine
- Triggers: product updated, review received, stock level, time-based
- Actions: update listing, send email, create task, adjust price
- `automation-tick.job.ts` — evaluates conditions on schedule
- Approval workflows for destructive actions

---

## Purchase Orders (PO-series)

18-phase + 8-phase PO-Plus. All shipped 2026-05-23/24.

| Feature | Detail |
|---------|--------|
| PO CRUD | Create, edit, approve, receive |
| Attachments | File uploads per PO |
| Approver email | Email notification on approval request |
| Quick receive | Scan-to-receive workflow |
| Scorecard chips | Supplier performance KPIs |
| Bulk reassign/merge | Bulk operations on POs |
| Templates/recurring | Reusable PO templates + scheduled POs |
| Saved views | Canned filter sets |
| Push landed cost | Apply landed cost to stock layers |
| Shortcuts | Keyboard shortcuts |
| Ship-to addresses | Multiple destination addresses |
| Event log | Persisted action history |

Spec: `docs/PURCHASE_ORDERS.md`

---

## Related Notes

- [[14 - External Services]] — Cloudinary + Gemini AI
- [[11 - Amazon SP-API Integration]] — A+ Content API
- [[16 - Listing Management]] — content feeds into listings
- [[05 - Database Schema]] — DigitalAsset, APlusContent, BrandStory models
