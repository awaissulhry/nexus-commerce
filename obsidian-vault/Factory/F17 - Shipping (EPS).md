# F17 - Shipping (EPS)

> **Route:** `/shipping` · **EP code:** EPS · **Status:** ⚪ open — unclaimed; FP8 base shipped & verified (headless at $0 behind FakeCarrier).
> Canonical docs: `FP8-SPEC.md` / `FP8-REPORT.md` · charter: `F0-IA.md` §8

Part of [[F00 - Factory OS MOC]] · flow position: [[F01 - Mission & Golden Flow]] step 6

## Charter

Label queue + tracking timelines that push status back into orders **and the Gmail thread**. Strictly fewer clicks than the bar: purchase+review+print collapsed into one confirm (BEAT Shippo's 4 screens); rate comparison inside the purchase moment; tracking by polling (local-first constraint); estimated total incl. surcharges shown at purchase.

## As built (FP8)

`CarrierAdapter` (Fake + Sendcloud + resolve; always fake under `FACTORY_FORCE_FAKE_CARRIER`) · two-click buy-and-print (preset → prefilled ship-to → cheapest-selected rates → confirm) · label PDF stored + streamed behind `guarded()` · READY→SHIPPED · worker 15-min tracking poll → DELIVERED · Owner-initiated Share-tracking into the thread (cost-free, IT) · void · day-sheet manifest · bulk-buy · CSV export (grain-gated).

## Known open items for the future EPS session

- **The Owner's live gate step is still open:** connect real Sendcloud + one €0 unstamped label (FD6 capability probe — Lite-vs-Growth tracking is empirical).
- **C1/C2 (from [[F12 - Orders (EPO)]]):** the stale mark-shipped modal bypass dies in EPO.1; FP8's buy→SHIPPED and tracking→DELIVERED drivers get rerouted through EPO's `transition-service` — EPS consumes it thereafter.
- FP8 deferred: real pickup-API booking, auto-send tracking, true multicollo, returns/RMA (EPO.5 spawns rework WOs + credit; the return *label* flow is EPS territory), second carrier (MyDHL documented).
- **Carrier-invoice ↔ shipment monthly reconciliation** (teardown L969 BEAT) — ownership open between EPS and [[F18 - Financials (EPF)]] (EPF D-5 question); decide at whichever claims first.
