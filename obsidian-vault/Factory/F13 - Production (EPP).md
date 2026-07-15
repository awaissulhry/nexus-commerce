# F13 - Production (EPP)

> **Route:** `/production` · **EP code:** EPP · **Status:** ⚪ open — unclaimed in [[F06 - Enterprise Program (EP)]]; FP6 base shipped & verified.
> Canonical docs: `FP6-SPEC.md` / `FP6-REPORT.md` · charter: `F0-IA.md` §4

Part of [[F00 - Factory OS MOC]] · flow position: [[F01 - Mission & Golden Flow]] step 4

## Charter

Work orders through **CUTTING → STITCHING → ASSEMBLY → QC → PACKING**, two faces: the Owner's board and a zero-training worker shop-floor view (LAN phone/tablet, `FACTORY_LAN=1`). Best-in-class commitments: Odoo shop-floor cards + MRPeasy kiosk (Start/Pause/Finish, "my next task"), est-vs-actual per WO recalculating live (the margin-truth loop), **operators never see costs**, QC = checklist + photos + the FD14 **EN 17092 cert gate** blocking PACKING.

## As built (FP6)

5-stage board with live per-stage timers · WO drawer · pure engines in `src/lib/production/` (stage-timer, reserve/allocateByPriority, cert-gate) · material reservations at start → 🟢🟡🔴 coverage lights, priority-reallocated on reorder · CUTTING actual-use prompt → OUT+RELEASE + est-vs-actual diff · scrap + reason · cost-blind worker kiosk (strip-verified) · order flips READY when all WOs done.

## Known open items for the future EPP session

- **C2 (from [[F12 - Orders (EPO)]]):** FP6's stage-done→READY driver writes `order.state` directly, bypassing `canTransition` — EPO.1's `transition-service` reroutes it; EPP consumes that service forever after.
- `/production?wo=` deep-link reader arrives via EPO D-1 (EPO adds it since EPP is unclaimed).
- FP6 deferred: qty-scaled (vs per-garment) reservations, labor-cost capture, QC photos-per-item, free-drag priority.
- Est-vs-actual actuals feed [[F18 - Financials (EPF)]] margin truth and [[F11 - Quotes (EPQ)]] EPQ.4's quote-vs-actual loop — schema changes here must respect both.
- Worker kiosk is the RBAC showcase: any new surface must stay cost-blind ([[F04 - Domain Model & Money Invariants]]).
