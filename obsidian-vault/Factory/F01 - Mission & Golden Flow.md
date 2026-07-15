# F01 - Mission & Golden Flow

> **What Factory OS is:** a local-first platform that runs a small Italian leather/motorcycle-apparel factory end-to-end. Separate app (`apps/factory`, port 3100) with its own SQLite DB — the same monorepo as Nexus Commerce ([[00 - Nexus Commerce MOC]]) but a **separate product** for the factory side of the business. Canonical entry: `docs/factory/PLAYBOOK.md` (any session reads it first).

Hub: [[F00 - Factory OS MOC]]

## Why it wins

Verified across 25+ competitor teardowns (`F0-TEARDOWN.md`): **nobody owns the moment an order is born.** ERPs (SAP, Odoo, Katana, MRPeasy, Fulcrum) start at a typed form; inbox tools (Front, Missive) stop at the conversation. Factory OS owns the **email → everything** chain. Constraints that are law: **$0 infrastructure** (SQLite on the Owner's machine, free API tiers), **zero-training UI**, tiny team (Owner + a few workers), depth-not-breadth.

## The golden flow (the product IS this)

1. **Email arrives** in Gmail → [[F10 - Inbox (EPI)]] threads it, auto-matches sender to a Brand/Customer ([[F16 - Contacts (EPC)]])
2. **Quote** — configurator opens pre-scoped to that party's price list ([[F15 - Products & Pricing (EPD)]]); price composes live **with margin visible**; sent into the same thread → [[F11 - Quotes (EPQ)]]
3. **Acceptance → Order** ([[F12 - Orders (EPO)]]) — deposit gate (FD13) blocks production until money lands
4. **Production** — order explodes into Work Orders (CUTTING → STITCHING → ASSEMBLY → QC → PACKING) with material reservations → [[F13 - Production (EPP)]]
5. **Materials** — immutable movement ledger; shortage → PO → [[F14 - Materials (EPM)]]
6. **Shipping** — two-click label, tracking auto-shared in the thread → [[F17 - Shipping (EPS)]]
7. **Delivered** → review requested
8. **Money** — quoted/invoiced/paid/balance + est-vs-actual margin → [[F18 - Financials (EPF)]]
9. **Rhythm** — throughput, bottlenecks, on-time, win/loss → [[F19 - Analytics (EPA)]]

Everything commented (@mentions), audited (append-only), bulk-operable, import/export-friendly. Internal team chat per order arrives with [[F21 - Chat & Order Spaces (FC)]].

## State (2026-07-16)

All 11 pages **shipped** (F0 → FP1-11, complete 2026-07-06) and the golden flow closed end-to-end — the Owner ran Q-1 → ORD-1 → IN_PRODUCTION live. The current era is the **Enterprise Program** ([[F06 - Enterprise Program (EP)]]): page-by-page hardening to "absolutely enterprise level," run by parallel sessions ([[F07 - Sessions & Coordination]]). Visual overview: `Factory OS Map.canvas` · status: `EP Status Board.canvas`.
