# eBay Ads Console v2 — Refinement Workstream (ER0–ER4)

Master prompt: page-by-page elevation of the eBay console to the internal Amazon console's
structural standard, beating H10 Adtomic / Pacvue / Teikametrics / Rithum / Seller Hub per
surface. Double gate per page: spec → approval → build → verification → approval.

## ER0 deliverables (this directory)

| Doc | Deliverable |
|---|---|
| [AMAZON-PATTERN-LANGUAGE.md](AMAZON-PATTERN-LANGUAGE.md) | §PL-1…§PL-10 — the verified pattern language (shell, grid, DetailsTab contract, drill-down, builder/stepper, css vocabulary, write idioms) |
| [COMPETITOR-TEARDOWN.md](COMPETITOR-TEARDOWN.md) | H10 Adtomic · Pacvue · Teikametrics · Rithum · eBay Seller Hub + eBay API fact verification, with adopt/adapt/beat/ignore verdicts |
| [CURRENT-STATE-CRITIQUE.md](CURRENT-STATE-CRITIQUE.md) | Honest findings per existing eBay page (X1–X9 cross-cutting, per-page tables, root causes, keep-list) |
| [SPEC-campaign-detail.md](SPEC-campaign-detail.md) | ER1 redesign spec — detail v2 + ad-group drill-down + editable Details + Automation tab |
| [SPEC-campaign-builder.md](SPEC-campaign-builder.md) | ER2 redesign spec — type-card chooser + per-type stepper wizards + Rate Discovery |
| [DECISIONS.md](DECISIONS.md) | Owner decision register D1–D7 with recommendations + proposed ER3 page order |

Phase status: **ER0 delivered — awaiting Owner review of specs + decisions (gate).**
ER1 (campaign detail) → ER2 (builder) → ER3 (page sweep) → ER4 (consistency/benchmark pass).
