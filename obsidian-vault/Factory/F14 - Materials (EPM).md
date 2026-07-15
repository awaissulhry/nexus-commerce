# F14 - Materials (EPM)

> **Route:** `/materials` · **EP code:** EPM · **Status:** ⚪ open — unclaimed; FP7 base shipped & verified.
> Canonical docs: `FP7-SPEC.md` / `FP7-REPORT.md` · charter: `F0-IA.md` §5

Part of [[F00 - Factory OS MOC]] · flow position: [[F01 - Mission & Golden Flow]] step 5

## Charter

Raw materials on the **immutable movement ledger** — stock is always a derived fold, never a stored number (FD8, [[F04 - Domain Model & Money Invariants]]). Katana four-column math (**In stock / Committed / Expected / Available**), lot-aware (hide/dye batches), suppliers + POs, shortage pressure visible before it bites. "Undo" = compensating movement; the ledger IS the audit.

## As built (FP7)

Four-column fold (`materialStock`) · signed ADJUST with mandatory reason · detail drawer (movements timeline + lots + where-used) · Purchase Orders DRAFT→SENT→PARTIAL→RECEIVED, receive → lot → IN movement · one-click **"+ Buy"** from a shortage (FP6's red light becomes a PO) · supplier-cost **reprice ripple** ("N templates + M open quotes reference this") · ledger CSV export · cost-blind for workers (test-pinned).

## Known open items for the future EPM session

- FP7 deferred: opening-stock CSV import; dedicated lot→WO traceability view (ledger records it; no surface).
- Carrier-invoice↔shipment reconciliation was raised in [[F18 - Financials (EPF)]] research (teardown L969) — ownership EPF vs [[F17 - Shipping (EPS)]] is an open Owner question; EPM owns none of it but the supplier-side analog (PO price vs invoice) may surface here.
- Material-consumption trends deferred from FP10 ([[F19 - Analytics (EPA)]]).
- Any grid growth adopts FS3 `VirtualDataGrid` ([[F22 - Substrate FS Series]]), never hand-rolled windowing.
