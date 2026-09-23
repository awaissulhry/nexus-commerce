# Step 2.4b — which family each product should get. A proposal, FOR APPROVAL.

**2026-09-22. Nothing is written by this document.** It proposes families for live parent products
that have none, so the products grid can later let the family decide its Shared columns (Step 2.4
move 2, grid half, R-14). Every assignment needs the Owner's approval before any write.

## How a suggestion is made

For each business, parents without a family are grouped by their product type:

| Case | Suggestion |
|---|---|
| Other parents of the same type already have a family | The family most of them use. When that type is split across families, the split is shown and a person confirms |
| No parent of that type has a family | **None.** A new family, or a person's choice. Never invented by a script — a family carries requirements (R-10), so a wrong family is a wrong requirement |
| No product type at all | **None.** A person decides |
| `EBAY_LISTING_SHELL` | **Excluded.** A shell is an extra eBay listing of a product that already exists (`list-products.service.ts:109-111`). It belongs to the eBay flat-file area, which is a no-touch zone for this lane. Proposed: a shell follows its source product's family — **a ruling for the Owner**, not an assignment |

## Local dry run — `nexus_development`, read only

Same script as production, `--local`. Role bypasses row security; 355 product rows visible
(positive control).

| | |
|---|---|
| live parents | **42** |
| without a family | **28** — 23 of them listed on a channel |
| of those, `EBAY_LISTING_SHELL` | **22** |
| of those, `OUTERWEAR` | **4** — `GALE-JACKET-VPF-*` |
| of those, no product type | **2** — `GALE-JACKET-VPF-ADD-ONE`, `NEW-20260729-L5C8` |

| Type | Without | Suggestion | Basis |
|---|---|---|---|
| `EBAY_LISTING_SHELL` | 22 | excluded — follows its source product (ruling) | shells are flat-file listings |
| `OUTERWEAR` | 4 | **`jackets`** (Jackets), a person confirms | 7 OUTERWEAR parents use `jackets`, 1 uses `rainwear` — split |
| none | 2 | none — a person decides | no type |

So locally, only **4** products have a family suggestion at all; **22** are shells, and **2** need
a person.

🟠 **The grid notice counts shells.** The products grid shows shell rows, and A-20's
*"N without family"* counts them. If shells follow their source's family, the notice should say
so rather than count them as missing. Carried as a question, not changed.

## Production — measured 2026-09-22, read only

Run by the Owner (this session's safety check refuses a production read by the agent). Host
`ep-purple-river-…eu-central-1.aws.neon.tech`, db `neondb`; `transaction_read_only = on`; role
`neondb_owner` bypasses row security; **360 product rows visible** (positive control).

| Business | Live parents | Without a family | Listed | What they are |
|---|---|---|---|---|
| **Xavia Racing** (legacy) | 32 | **18** | 18 | **all 18 are `EBAY_LISTING_SHELL`** (`AIREON-ALT1…3`, `AIRMESH-JACKET-ALT1`, …) |
| **Motovento** | 2 | **1** | 0 | `NEW-20260917-AEJN` — no product type, not listed |

**Every real product in Xavia Racing already has a family** (OUTERWEAR → `jackets` 7 / `rainwear` 1;
COAT → `jackets`; GLOVES → `gloves`; AUTO_ACCESSORY → `accessories`; SUIT → `suits`). Motovento's
one OUTERWEAR parent has `jackets`.

### So the assignment list is empty

| Type | Without | Suggestion |
|---|---|---|
| `EBAY_LISTING_SHELL` (Xavia Racing) | 18 | none — shells are extra eBay listings of products that already have a family (ruling below) |
| no type (Motovento) | 1 | none — an unlisted draft; a person sets its type and family when it is finished |

🔴 **This changes Step 2.4b's premise.** The grid's move 2 is not blocked by missing families on
production. It is blocked only by one question: **what the grid does with shells.**

### The ruling needed

| # | Option | |
|---|---|---|
| **a** | **Treat shells the way the product list already does** (`list-products.service.ts:109-111` hides them by default): the grid's *"without family"* count skips shells, and the grid's move 2 (A-20 (b)'s build) goes ahead. Columns belong to the whole page, so a shell row shows the family columns of the real products beside it; its eBay-only fields stay where they are edited today, on the eBay scope | 🟢 **Recommended.** No write to any product; the flat-file area is not touched |
| b | Give each shell its source product's family | Needs the shell→source link, which lives in the eBay flat-file area — a no-touch zone for this lane; a separate ruling and a data write |
