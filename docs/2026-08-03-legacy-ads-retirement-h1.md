# H1 — retiring the legacy ads trees: the audit before the delete

**Status:** AUDIT COMPLETE · PROPOSAL AWAITING GATE · 2026-08-03
**Nothing has been deleted, moved or changed.** This is read-only analysis.

---

## The headline

H1 was described in the DPS/RDX plans as *"remove the two live cross-links, then delete the legacy dayparting surfaces."* **That description is wrong, and acting on it would delete working pages people can currently reach from the main menu.**

Measured today:

| Tree | Pages | Status |
|---|---|---|
| `/marketing/advertising` | **41** | oldest |
| `/marketing/ads-console` | **11** | middle |
| `/marketing/ads` | **49** | current — everything this engagement built |

101 pages across three generations. But they are **not three versions of one product** — they are partially disjoint, and the migration was never finished.

---

## Finding 1 — the main navigation points at the legacy tree

```
apps/web/src/app/_shared/app-nav.ts:205
  { label: 'Advertising', href: '/marketing/advertising/campaigns', Icon: Megaphone }
```

The primary app nav sends every operator to the **oldest** tree. `/marketing/ads` — the console with the rank schedules, change log, coverage, trust and everything else — **is not in the main navigation at all.**

`nav-permissions.ts:11` also maps the `pages.advertising` permission to `/marketing/advertising`, so RBAC is bound to the legacy path too.

## Finding 2 — eleven live inbound links from outside the legacy trees

| From | To |
|---|---|
| `_shared/app-nav.ts:205` | `/marketing/advertising/campaigns` |
| `marketing/campaigns/page.tsx:18` | permanent **redirect** → `/marketing/advertising/campaigns` |
| `marketing/campaigns/MarketingCampaignsClient.tsx:278` | `/marketing/advertising` |
| `products/[id]/edit/tabs/AdsTab.tsx` | campaigns ×2, reports, search-terms, analytics, insights (**6 links**) |
| `marketing/reviews/automation/page.tsx` | `/advertising/automation/:id`, `/advertising/automation/executions` |
| `fulfillment/replenishment/StorageAgeTile.tsx:113` | `/marketing/advertising/storage-age` |
| `components/layout/AppShell.tsx:26` | `/marketing/ads-console` |
| `lib/auth/nav-permissions.ts:11` | RBAC mapping |

The product edit page's Ads tab alone links into legacy six times.

## Finding 3 — 25 legacy areas have no equivalent in the current console

**7,881 lines** with nowhere to land:

| Size | Areas |
|---|---|
| **Large** (>400 lines) | `automation` (2,168) · `budget-pools` (993) · `reports` (593) · `search-terms` (515) · `debug` (456) · `storage-age` (402) |
| **Medium** (100–400) | `insights` (396) · `feeds` (257) · `profit` (241) · `create` (196) · `dayparting` (190) · `funnel` (160) · `dsp` (128) · `architect` (126) · `audiences` (116) · `goals` (116) · `share-of-voice` (111) · `retail-readiness` (110) · `incrementality` (107) |
| **Small** (<100) | `harvest` (97) · `bid-optimizer` (90) · `events` (90) · `momentum` (87) · `pacing` (73) · `ngrams` (63) |

Only 5 legacy areas have a same-named counterpart in `/marketing/ads`: `analytics`, `autopilot`, `budget-manager`, `campaigns`, `recommendations` — and same-name does not prove same-capability.

`/marketing/ads-console` is closer to dead: of its 10 areas only `bulk`, `campaign-builder` and `campaigns` exist in the current console; `activity`, `automation`, `overview`, `products`, `rank`, `settings`, `targeting` do not.

---

## What H1 actually is

Not a cleanup. **Finishing a migration that stopped halfway**, in four phases:

| # | Phase | What it is | Risk |
|---|---|---|---|
| **H1.1** | **Classify the 25 orphans** | For each: port · replace (a current surface already covers it under another name) · drop (dead or superseded). Needs your product judgement, not mine — I can say `ngrams` is 63 lines, not whether you use it. | none, read-only |
| **H1.2** | **Port or replace what survives** | The real work. `automation` (2,168 lines) is the big one, though `rules-automation` may already cover it. | high, per area |
| **H1.3** | **Repoint the 11 inbound links + RBAC** | Main nav → `/marketing/ads`, redirect, AdsTab's six, reviews, replenishment, AppShell, `nav-permissions`. Only safe once H1.2 leaves nothing stranded. | medium |
| **H1.4** | **Delete both trees** | 52 pages. Only after H1.3 proves nothing routes in. | low by then |

**H1.1 is the only phase I can drive alone**, and even then the port/replace/drop call on each area is yours.

---

## What I recommend

**Do H1.3 partially, now, and defer the rest.**

One change is defensible immediately and independent of everything else: **put `/marketing/ads` in the main navigation.** Right now the console we have spent this entire engagement building is unreachable from the app's own menu, while the oldest generation is the front door. That is a one-line nav change, reversible, and it does not require deciding anything about the other 51 pages.

Everything else waits on H1.1, which is a product conversation.

---

## What I am NOT proposing

- Deleting anything. 52 pages with 11 live inbound links is not a cleanup task.
- Treating "no equivalent in `/marketing/ads`" as "dead". `storage-age` is linked from replenishment and may be the only surface for it.
- Doing H1.2 blind. Porting `automation`'s 2,168 lines before checking whether `rules-automation` already replaced it would be the most expensive possible mistake here.
