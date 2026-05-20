# Cost master import — operator guide

**Status:** infrastructure already shipped (`import-wizard.service.ts`, `/catalog/import` UI). This doc just documents the existing flow.

**Why this matters:** As of 2026-05-20, **0 of 268 products have `costPrice` set**. Until costs land, every margin/COGS/repricing-floor/true-profit calculation defaults to 0. The Insights ▸ Profit dashboard, repricing engine, year-end inventory valuation, and FBA fee analysis all need real costs to be useful.

## CSV template

Minimum required columns: `sku`, `costPrice`. Other fields the import-wizard accepts (per `apps/api/src/services/import-wizard.service.ts` ALLOWED_FIELDS):

```csv
sku,costPrice
XAV-JACKET-001,42.50
XAV-HELMET-FULL-002,67.00
XAV-GLOVES-WINTER-003,15.75
...
```

Optional extra columns you can include in the same file:

| Column | Type | Notes |
|---|---|---|
| `costPrice` | decimal | Your cost in EUR (master currency). e.g. `42.50` |
| `minMargin` | decimal | Acceptable margin floor as percent. e.g. `15` = 15% |
| `minPrice` | decimal | Hard floor for repricing engine (EUR) |
| `maxPrice` | decimal | Hard ceiling for repricing engine (EUR) |
| `hsCode` | string | Italian customs tariff code (used in fiscal invoices + CN22/CN23) |
| `countryOfOrigin` | ISO-2 | e.g. `IT`, `CN`, `VN`. Used on commercial invoices |

The wizard auto-maps columns to fields; `sku` is the lookup key (a row with no matching `sku` is reported as a failed row, others still apply).

## How to upload (3 clicks)

1. Open Nexus → **Catalog ▸ Import** (`/catalog/import`)
2. Drop your CSV → preview screen shows mapped columns + sample rows
3. Click **Apply** → import-wizard processes rows, surfaces success/failures per row, lets you retry failed-only

Alternative for a single field bulk-edit (no CSV needed): **Products ▸ select N rows ▸ "Set field…" ▸ costPrice**. Useful when you just want to set a flat cost across a category.

## Verification

After upload, run:

```sh
node scripts/data-wipe-2026-05-20-audit.mjs
# look for: "Product → channel-identity coverage" section
# `with_cost_price` should equal the number of products you just costed
```

Once `with_cost_price` > 0, the **Insights ▸ Profit** dashboard, repricing engine, and year-end snapshot all start producing real numbers.

## What this unblocks

- **Insights ▸ Profit** — P&L waterfall, margin per channel/SKU, true profit per order
- **Repricing engine** — minPrice floors now have meaning relative to cost
- **Replenishment EOQ** — economic order quantity formula reads `Product.costPrice`
- **FBA storage age + restock recommendations** — value-at-risk uses cost
- **Year-end fiscal snapshot** — Italian inventory valuation requires per-unit cost
- **`StockCostLayer` accounting** — per-receive FIFO/LIFO layers seed from `costPrice` until real receipts land

## Future automation (not built yet)

A scheduled supplier-pricelist sync is on the backlog (item not yet in TECH_DEBT). For now the import is operator-triggered. Frequency: re-upload whenever your supplier sends a new pricelist (typically quarterly or per-campaign).
