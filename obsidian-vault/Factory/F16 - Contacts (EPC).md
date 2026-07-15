# F16 - Contacts (EPC)

> **Route:** `/contacts` · **EP code:** EPC · **Status:** ⚪ open — unclaimed; FP5 base shipped & verified.
> Canonical docs: `FP5-SPEC.md` / `FP5-REPORT.md` · charter: `F0-IA.md` §7

Part of [[F00 - Factory OS MOC]] · feeds [[F01 - Mission & Golden Flow]] steps 1-2 (party matching, price-list scoping)

## Charter

Brands/customers/suppliers as **one `Party` model** with kind-specific faces: emails (the [[F10 - Inbox (EPI)]] match keys, incl. `matchDomain`), price-list assignment (FD7), terms + deposit defaults (FD13), **versioned measurement profiles** (Tailornova pattern — new version supersedes, prior immutable), full history. The Owner's stated must-have: **side-by-side price comparison** per party (pure pricing-engine calls).

## As built (FP5)

List by kind → ContactDetail (Overview inline-autosave + emails manager + price-list assignment) · versioned MeasurementProfiles · history tabs (conversations/quotes/orders/reviews, deep-linked, money grain-gated) · compare-pricing tool (`/api/contacts/compare`) · parties CSV extended.

## Known open items for the future EPC session

- FP5 deferred: merge-duplicates (audited FK relink), per-party configurator defaults, measurement photos, bulk archive.
- **Party-360 lives HERE** — [[F12 - Orders (EPO)]] D-5 explicitly keeps brand-360 on `/contacts` (orders gets a `?party=` chip only); an EPC session builds that 360 view.
- [[F18 - Financials (EPF)]] EPF.3/EPF.4 add party money data (opening balances, ledger, statements, days-to-pay) — those folds are EPF-owned; EPC *surfaces* them via EPF's API, never re-implements.
- [[F11 - Quotes (EPQ)]] EPQ.5 adds tax-mode/SDI fields per party (Natura, codice destinatario/PEC/CF) — schema lands with EPQ; EPC gets the editing surface later.
- Payment-behavior stats (avg days-to-pay) from EPF.4 will inform FD13 deposit defaults per party.
