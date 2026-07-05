# Flat File v2 — FF0 deliverables

Phase FF0 (audit, field census & fidelity architecture — **read-only, zero product code**). Verified against the live codebase 2026-07-05 via six parallel subsystem audits. Awaiting Owner approval at the FF0 gate.

| Deliverable | What it is |
|---|---|
| [FF0-CURRENT-STATE.md](./FF0-CURRENT-STATE.md) | Teardown of today's export/import/grid/surfaces/market pipeline, with `file:line` refs; what survives vs. is replaced. |
| [FF0-FIELD-CENSUS.md](./FF0-FIELD-CENSUS.md) | Exhaustive field inventory (editable/readonly/derived, shared/market-scoped) proving zero gaps. Built on the corrected `Product + ChannelListing` model. |
| [FF0-MARKET-DISCOVERY.md](./FF0-MARKET-DISCOVERY.md) | Live channel×market matrix + the dynamic-discovery query guaranteeing new markets auto-appear; 20-site hardcode inventory. |
| [FF0-WORKBOOK-SPEC.md](./FF0-WORKBOOK-SPEC.md) | Finalized sheet/column layout, naming, sort keys, fingerprints, Excel-proofing. |
| [FF0-SAMPLE-WORKBOOK.xlsx](./FF0-SAMPLE-WORKBOOK.xlsx) | **Gate artifact** — a real, openable workbook demonstrating the structure (3 representative products). Illustrative data, production-shaped formatting. |
| [FF0-sample-generator.mjs](./FF0-sample-generator.mjs) | Reproducible generator for the sample (`node docs/flat-file/v2/FF0-sample-generator.mjs`). |
| [FF0-DECISIONS.md](./FF0-DECISIONS.md) | FFD1–FFD14 register. FFD9 + FFD10 need an Owner call; the rest have safe defaults. |
| [FF0-FINDINGS.md](./FF0-FINDINGS.md) | 16 discovered defects/risks (🔴/🟡/🟢) with recommended dispositions. Nothing fixed (read-only). |

**Two decisions gate FF1:** FFD9 (build on `Product + ChannelListing`, exclude the deprecated chain?) and FFD10 (how the per-market follow-master resolver is represented in the file). See FF0-DECISIONS.
