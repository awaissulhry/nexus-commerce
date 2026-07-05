# FP8 — Shipping: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-05 against the approved `FP8-SPEC.md`. Four build commits (FP8.1 adapter + core + migration → FP8.2 queues + buy-and-print → FP8.3 tracking poll + share + void → FP8.4 manifest + pickup + bulk-buy + export). **`/shipping` is live — the golden flow's last leg is closed.** A Ready order becomes a bought label in two clicks, the tracking goes back into the customer's Gmail thread on a click, and the carrier's own events drive the order **SHIPPED → DELIVERED**. The F1 `CarrierAdapter` scaffolding is alive. Built on Opus 4.8. **Additive migration `fp8_shipping`** (Shipment shipTo/parcel/labelFormat + Party.addressJson); no new dependency (pdfkit + @dnd-kit already present); no new permission (all seeded in F1).

## Eng trans

When the floor finished a garment it went **Ready** and then… nothing — you marked it shipped by hand. Now open **Shipping**: every Ready order sits in a queue with a **Buy label** button. Two clicks — pick a parcel size, glance at the address (it remembers each customer), pick a rate (the cheapest is already ticked) — and you get a **printable label**, the order moves to **Shipped**, and the cost is captured. Hit **Share tracking** and a tidy Italian note with the tracking link drops straight into the same email thread the order was born from (you send it — nothing goes out behind your back). From then on the app quietly asks the carrier where each parcel is and, when it lands, moves the order to **Delivered** on its own. Bought the wrong service? **Void** it before it ships and the order goes back to Ready. End of day, print a **day-sheet** of every parcel for the driver, and **Export** the lot to a spreadsheet.

## The Sendcloud reality (as designed)

You haven't connected Sendcloud yet, so everything above was **built behind a `FakeCarrierAdapter`** and proven end-to-end headless — rates, a real PDF label, tracking that advances to delivered, order flips — **with zero network and zero spend**. The instant you connect Sendcloud in Settings (the wizard + capability-probe already exist), the real adapter takes over. **Your one live step at this gate:** connect it, then buy a single **€0 "unstamped-letter"** label to confirm the real path. The build re-runs the capability probe; if your plan gates tracking polls (the Growth boundary, FD6), labels still work and tracking degrades to manual with a note — nothing blocks.

## What was verified (headless, isolated `:3199`, fake carrier, zero spend)

| Check | Result |
|---|---|
| **Buy-and-print** | Ready order → preset → rates (cheapest **free** pre-selected) → **Confirm** → real **%PDF** label, order **READY → SHIPPED**, cost captured ✓ |
| **Ship-to memory** | address saved on the party → next order **prefilled** ✓ |
| **Tracking poll → delivered** | 3 polls: Announced → **IN_TRANSIT** → **DELIVERED**; order flips **DELIVERED**; then leaves the poll set ✓ |
| **Share tracking** | composes a cost-free **Italian** note with the tracking; refuses (400) when there's **no linked thread**; sandbox never sends a real email ✓ |
| **Void** | pre-dispatch void → shipment **CANCELLED**, order back to **READY** ✓ |
| **Bulk-buy** | 3 boxes → **3 shipments**, each its own tracking number, order SHIPPED ✓ |
| **Day-sheet** | today's parcels → **PDF** manifest ✓ |
| **Export** | shipments **CSV**; cost column present for the Owner, **stripped** for a cost-blind caller ✓ |
| **Pickup** | guarded — records intent when a carrier is connected; **400** ("connect a carrier") without one ✓ |
| **Re-buy guard** | a shipped order can't be bought again (400) ✓ |

Battery: **179/179 unit tests · 108/108 routes RBAC-covered · DS parity byte-identical · no-touch clean · tsc + build green · 21 headless assertions across FP8.2–8.4 · zero page errors.** The queues, buy panel, rates, shipment detail with its tracking timeline, and the day-sheet modal were each reviewed at native resolution — clean, full-width, on-token (the rate radio recoloured to the primary to match the preset cards). Test data swept; your real data (ORD-1 in production, party AWA) is untouched.

The risk lives in the pure core and is pinned: `mapCarrierStatus` (delivered vs "out for delivery" vs failed), forward-only `advanceShipmentState`, `orderStateFromShipment`, `cheapestRate`, `parcelFromPreset`, the cost-free `trackingEmail`, and the `FakeCarrierAdapter` contract — 17 tests in `shipping.test.ts`.

## Deviations from spec (flagged)

1. **Real Sendcloud path is unexercised until you connect it** — by design (the fake proves the flow; the €0 label is your gate step, exactly like the live email send in FP1/FP3). The `SendcloudAdapter` is built to Sendcloud v2 (`/parcels`, `/tracking`) but its first real run is yours.
2. **Pickup records intent, doesn't call the carrier's pickup API** — it writes a `Pickup` row (requested / outside-system) once a carrier is connected; real carrier-side booking + window management is a follow-up (the record captures the day). Never blocks (the "arranged outside the system" path always exists).
3. **Fully-automatic tracking email is deferred** — Share tracking is one click by you (the send-guard); background auto-send on a delivery event is a future opt-in.
4. **True multicollo is out** — a size-run of N boxes buys **N shipments** (bulk-buy), not one multi-parcel shipment; the manifest and tracking treat each as its own parcel.
5. **Tracking-email auto-send / a Contacts address editor are not built** — FP8 *persists* `Party.addressJson` at pack time so the next order prefills; a dedicated address field on the Contacts page is a later polish (no FP5 page changes were made).

## What lives where

| Surface | Path |
|---|---|
| Carrier contract + adapters | `src/lib/carriers/` (types · fake · sendcloud-adapter · resolve) |
| Pure core (tested) | `src/lib/shipping/` (shipment-state · parcel · tracking-email · poll-tracking · label-store · render-label · render-manifest · validation) |
| API | `src/app/api/shipping/*` (queues · rates · buy · [id] · [id]/label · [id]/share-tracking · [id]/void · manifest · pickup) + `exports/shipments` |
| Worker | `worker/index.ts` — the 15-min tracking tick |
| UI | `src/app/(app)/shipping/_components/*` (ShippingClient — queues + buy panel + shipment drawer + day-sheet) + a "Buy label" button on the FP4 order detail |

## Your click-through (the FP8 gate)

**In the app (works today, test carrier):** open `/shipping` → on a **Ready** order click **Buy label** → pick **Medium** → the address is there → **Get rates** → **Confirm & print** → the label opens and the order goes **Shipped** → click the order in **In flight** → the tracking timeline → **Void** (if still pre-dispatch) returns it to Ready → **Day-sheet** prints today's parcels → **Export** downloads the CSV. (To see delivery, the worker's poll advances it over its next ticks — or it's instant on a real carrier's scans.)

**Live (your one real step):** Settings › Integrations → **connect Sendcloud** → back on a Ready order, buy one **€0 unstamped-letter** label → confirm the real PDF + tracking number → **Share tracking** to drop it into the thread.

## Rollback

`git revert` the four FP8 commits (factory-scoped) + the additive `fp8_shipping` migration is harmless to leave (nullable columns).

## Deferred (PLAYBOOK backlog)

Real carrier pickup-API booking; auto-send tracking; true multicollo; returns/RMA labels; a second carrier (MyDHL, FD6); customs docs (CN22/CN23) + insurance; a Contacts address editor.

**Next on approval: FP9 — Financials (`/financials`): order-level money truth — per-order quoted/invoiced/paid/balance, est-vs-actual margin, deposits outstanding, and the period export for the commercialista. Explicitly NOT accounting.**
