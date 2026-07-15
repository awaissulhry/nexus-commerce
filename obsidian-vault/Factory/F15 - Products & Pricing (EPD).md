# F15 - Products & Pricing (EPD)

> **Route:** `/products` · **EP code:** EPD · **Status:** ⚪ open — unclaimed; FP2 base shipped & verified.
> Canonical docs: `FP2-SPEC.md` / `FP2-REPORT.md` · charter: `F0-IA.md` §6

Part of [[F00 - Factory OS MOC]] · feeds [[F01 - Mission & Golden Flow]] step 2 (the configurator)

## Charter

The **pricing model's home** — everything the [[F11 - Quotes (EPQ)]] configurator consumes: templates, option groups/options with cost+price deltas (ABS cents / PCT basis points), ONE constraint table with human explanations (BEAT Salesforce's two engines), BOM + per-option material draws, base costs/prices, **EN 17092 certificate registry** (FD14), sparse per-party price lists over "Listino base" (FD7). The option sheet IS the spec: selections compile into the WO material list + tech-pack-lite PDF (render, don't author).

## As built (FP2)

Template CRUD → detail tabs (Options / Constraints / BOM & draws / Certificates / **Preview-as-configurator** dry-run panel) · the pure pricing engine `src/lib/pricing.ts::compose()` — exhaustively unit-tested, **it is the product** · price-list sparse-override editor · SAP "Price Source" line (every price says why) · Craftybase-style reprice ripple · CSV imports with dry-run.

## Known open items for the future EPD session

- **Price-list effective-dating** (playbook backlog) — [[F18 - Financials (EPF)]] D-8 asks for it (the Owner's workbook had two rate generations coexisting by copy-paste accident); if approved it needs an EPD-territory **registry grant** recorded in [[F06 - Enterprise Program (EP)]].
- [[F11 - Quotes (EPQ)]] EPQ.3/EPQ.4 will lean on quantity-break tables and a structured cost model (leather m² + wastage, labor, overhead) — the entities likely live here; coordinate before EPQ.4 specs.
- Goal-seek engine functions (`goalSeekByNet`/`goalSeekByMargin`) exist; UI wiring is EPQ.3's.
- Per-product ACTUAL margin (FP10 deferral) needs a per-line consumption allocation fold — EPF/EPA/EPD coordination.
