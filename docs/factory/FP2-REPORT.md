# FP2 — Products & Pricing: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-05 against the approved `FP2-SPEC.md`. Five commits (FP2.1 engine → FP2.2 templates/options/constraints → FP2.3 materials/BOM/certs → FP2.4 price lists/preview → FP2.5 imports/exports). **Products & Pricing is live at `/products`.** Zero files outside `apps/factory/` + `docs/factory/` touched; no schema migration (F1 shipped every entity). Built and verified on the Opus 4.8 model per the Owner's instruction.

## Eng trans

Your factory's sellable reality now has a home — and a brain. You build a **template** (a "Custom Cowhide Suit") as a set of option groups (Leather type, Lining, Armor, Perforation…), each option carrying what it adds to the **price** and what it adds to the **cost**, in euros or as a percentage. You write plain-language rules ("Perforated panels *exclude* a waterproof liner — blocks"). You point options at **materials** (Kangaroo → 2.5 m² of kangaroo hide) and attach **EN 17092 certificates** with expiry tracking. You keep per-customer **price lists** that start as a copy of your base list and only carry the lines you actually negotiated.

Then the **Preview** tab proves it all: pick a customer, tick options, and watch the price, the cost, and the **margin** compose live — with a plain "why this price" tag on every line, the materials it'll consume, any rule that blocks it, and a **goal-seek** ("I want 50% margin" → it sets the price). This is the exact engine FP3's quoting screen will run; seeing it here means the hard part — getting the money right — is done and tested. Editing a material's cost tells you how many templates just repriced (and reminds you sent quotes never move). Everything imports and exports as CSV with a dry-run preview first.

## What was verified (headless, isolated :3199 server, real persisted data)

The pricing engine is the product's spine, so it was proven three ways: **28 unit tests** on every formula branch, plus **live composition against real DB rows** where every number matched the hand-computed expectation:

| Check | Result |
|---|---|
| Base (cowhide) | list €400 / cost €210 / margin €190 ✓ |
| Kangaroo (+€120/+€80) | list €520 ✓ |
| Kangaroo + Perforated (5%) | list €540 — **percent keyed to base, non-compounding** (not €546) ✓ |
| Perforated + Waterproof | blocking violation, correct message ✓ |
| B2B list (base −10%, kangaroo override) | list €450, source labels `list-base` + `list-option`, **cost unchanged at €290** (never party-overridden) ✓ |
| Goal-seek 50% margin | net €580, adjustment €60, margin 50.0% ✓ |
| Materials composed | Kangaroo hide 2.5 SQM ✓ |
| Role strip | a no-grains caller's preview payload loses every `*Cents`/margin key, keeps structure (unit-tested) ✓ |
| Materials CSV import | dry-run CREATE → apply → **idempotent SKIP** on re-run ✓ |
| Options CSV import | creates groups + options with €→cents / %→bp; preview then composes to €540 ✓ |
| Reprice ripple | material cost edit reports "1 template reprices" ✓ |
| Archive-not-delete | template/material referenced by a list or draw archives instead of deleting ✓ |
| Export | full pricing-model CSV incl. templates, options, list overrides ✓ |

Battery: **92/92 unit tests · 58/58 routes RBAC-covered · no-touch clean · DS parity 97/97 · build + typecheck green · zero page errors** across all five sub-phase smokes. UI screenshots reviewed at native resolution (options editor, preview waterfall) — clean, on-token, matches the rail/spacing spec.

## What lives where

| Surface | Path |
|---|---|
| Pricing engine (pure) | `src/lib/pricing.ts` (compose + goalSeek) — the only place money is computed |
| Engine ↔ DB bridge | `src/lib/products/load-engine.ts`, `material-usage.ts` |
| API (25 routes) | `src/app/api/products/*` (templates/groups/options/constraints/bom/certs/preview/reorder/starter), `materials/*`, `certificates/*`, `pricelists/*`, `parties-lite`, `imports/{materials,options}`, `exports/pricing-model` |
| CSV import/export cores | `src/lib/imports/{materials,options}.ts` |
| UI | `src/app/(app)/products/_components/*` (ProductsClient + Templates/PriceLists/Materials tabs, TemplateDetail, Options/Constraints/Bom/Certificates editors, PreviewPanel, CsvImportModal, money helpers) |
| Registry | `materials.manage` added (catalog CRUD ≠ FP7 `materials.adjust`; WORKER excluded, asserted) |

## Deviations from spec (flagged, not silent)

1. **Reorder is ↑/↓ buttons, not drag-and-drop.** The spec named `@dnd-kit`; I chose deterministic, keyboard-accessible arrow-reorder (same `/api/products/reorder` persistence) because a flaky drag is not "perfect" and headless drag testing is fragile. Trivial to add drag later if you want the flourish — say the word.
2. **No schema migration** — the spec anticipated this (F1 shipped every entity). Only a code-level registry addition.
3. **Preview recomposes server-side on every toggle** (debounced 150 ms). Correct for the security boundary (cost/margin never reach a browser lacking the grain) and instant on local SQLite; the spec's "client-side" phrasing would have leaked money to future roles.

## Your click-through (the FP2 gate)

1. Restart the app (`Ctrl+C`, `npm run dev -w @nexus/factory`) — five commits, no migration.
2. **Products → Templates → Starter structure** → your Cowhide Suit appears with the six canonical groups. Set base cost/price; give Kangaroo a €120 price / €80 cost; make Perforation 5% (toggle the € to %); watch the "→ +€20.00" resolved hint.
3. **Constraints tab** → add "Perforated *excludes* Waterproof — blocks".
4. **Materials tab** → New material (Kangaroo hide, m², €90), or **Import CSV** (download the template, paste, dry-run, apply). **BOM & draws tab** → give Kangaroo a 2.5 m² draw of kangaroo hide.
5. **Certificates tab** → New certificate (Class AA, a number, an expiry) → see the validity chip.
6. **Price lists tab** → New list "Listino B2B" → override the suit base −10%, assign a contact.
7. **Preview tab** (the payoff) → switch between Listino base and Listino B2B, tick options, watch the waterfall + margin + source tags + materials change; trip the perforated/waterproof block; type a target margin and watch the price fill.
8. **Export model CSV** (top-right of Templates) → open it in a spreadsheet.

## Rollback

`git revert` the five FP2 commits (factory-scoped). No migration, no commerce surface, no data written except what you create in the UI.

## Deferred (recorded in PLAYBOOK backlog)

Drag reorder (arrow-reorder ships); price-list effective-dating; certificate PDF upload (metadata + Drive link ride the FP-later Drive flow); options CSV that also sets base cost/price; visual/CAD option config (IGNORE verdict).

**Next on approval: FP3 — Quotes (the configurator + golden flow to "quote sent"), spec first. FP3 mounts exactly this engine behind a Gmail-thread-born quote.**
