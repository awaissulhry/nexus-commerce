# FP5 — Contacts: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-05 against the approved `FP5-SPEC.md`. Four commits (FP5.1 CRUD + Overview → FP5.2 versioned measurements → FP5.3 history tabs → FP5.4 compare-pricing + export). **`/contacts` is live — the CRM spine the golden flow already leaned on now has a face, and the Owner's side-by-side price comparison is in.** Built on Opus 4.8. **Migration-free** (Party / PartyEmail / MeasurementProfile all existed); no new dependency; no new permission (`contacts.manage` seeded in F1); no commerce surface touched.

## Eng trans

The thin party records the app has been making since FP1 — a name and an email scraped from a sender — are now real contacts. Open **Contacts** and every party is there by kind (Customer / Supplier / Brand). Open one and you edit its identity inline (terms, default deposit, notes — autosaved), manage its **emails** (and flip *match domain* so every address at a B2B domain resolves to one party — the key FP1 uses to route mail), and set its **price list**.

Give a customer **measurement profiles** per garment — and when their size changes, editing makes a **new version that supersedes the old one without ever overwriting it**, so a customer's size history is a paper trail. The **History** tab pulls their whole relationship into one place — conversations, quotes (won/lost), orders, reviews — each a click from the owning page.

And the piece you named as a must-have: **Compare pricing.** Pick a product, configure it once, and see — side by side — what every customer would pay and their discount vs the base list, every number composed through the same engine that writes your quotes.

## What was verified (headless, isolated `:3199` prod build, real persisted data)

| Check | Result |
|---|---|
| Create contact + inline edit (terms/deposit/notes) | persisted ✓ |
| Emails: add 2, flip **matchDomain**, duplicate rejected | 409 on duplicate ✓ |
| Archive → restore | soft-archive + restore ✓ |
| **Measurement versioning** | v1 chest 100 → edit → v2 chest 102, **v1 stays immutable at 100** ✓ |
| Delete a measurement in use by a quote | refused (409) ✓ |
| **History aggregate** | 1 conversation / order / review (★5) + correct nets, deep-linked ✓ |
| **Compare pricing** | VIP customer **€460 (-11.5%** via list override) vs base **€520**, sorted cheapest-first, margin shown ✓ |
| CSV export | header gained `price_list` + `deposit_pct` ✓ |
| Grain strip | terms/deposit/margin/discount removed by name for a no-grains caller — **+3 tests pin the boundary** ✓ |

Battery: **126/126 unit tests · 85/85 routes RBAC-covered · no-touch clean · DS parity 97/97 · tsc + build green · zero page errors.** List, Overview, Measurements, History, and Compare reviewed at native resolution — clean, full-width/centered per the convention, on-token. All test data swept; the Owner's real data (the AWA brand, Q-1 draft, Cowhide Suit template) is untouched.

## Bug found and fixed during verification

**The Compare-pricing page crashed** ("This page couldn't load") the moment a template was picked. The template-detail endpoint exposes its groups as **`optionGroups`**, not `groups` — the configurator was calling `.map` on `undefined`. Caught by the screenshot pass *before* it could reach the Owner (exactly why the render check exists); fixed to read `optionGroups`, re-verified with a populated comparison table.

## Deviations from spec (flagged)

1. **Merge-duplicates deferred** — relinking FKs across quotes/orders/threads + the audit trail is its own careful cycle; in the backlog.
2. **Per-party configurator defaults deferred** — the `Party.configuratorDefaults` field + its consumption in the already-shipped FP3 configurator is a separate follow-up; FP5 added no schema.
3. **Measurement photo attachments deferred** — the fields + versioning + fit notes are in; photo upload (local/Drive) is flagged for a follow-up.
4. **Bulk archive deferred** — individual archive/restore works; the multi-select bar is a minor convenience (same call as the orders batch, also deferred).

## What lives where

| Surface | Path |
|---|---|
| Measurement organizing (pure) | `src/lib/contacts/measurements.ts` (head + history chain, loop-safe, +4 tests) |
| API (7 routes) | `src/app/api/contacts/*` (list/create, [id] detail+history+PATCH+archive, emails, measurements), `contacts/compare`, `exports/parties` (extended) |
| UI | `src/app/(app)/contacts/_components/*` (ContactsClient list, ContactDetail, ContactMeasurements, ContactHistory, ComparePricing) |
| Boundary test | `src/lib/__tests__/contacts-strip.test.ts` (terms/deposit grain strip) |

## Your click-through (the FP5 gate)

1. Restart the app → **Contacts**. Open the **AWA** party (or **New contact**) → edit its terms + default deposit (autosaves), add an email and flip **match domain**.
2. **Measurements** → New profile for "Jacket" with a few sizes → save → **Edit → new version**, change a size, save → watch **v2** appear and "1 older" keep v1.
3. **History** → the linked quote/order/review (once this party has some).
4. **Compare pricing** (top of the list) → pick your Cowhide Suit, tick options → see each customer's price and discount side by side.
5. Archive a test contact and restore it; **Export CSV** and note the terms/deposit columns.

Full detail + rollback in `docs/factory/FP5-REPORT.md`.

## Rollback

`git revert` the four FP5 commits (factory-scoped). No migration, no dependency — nothing else to undo.

## Deferred (PLAYBOOK backlog)

Merge-duplicates; per-party configurator defaults (+ FP3 wiring); measurement photo upload; bulk archive; supplier-specific deep views (Materials/PO own those).

**Next on approval: FP6 — Production (`/production`): the Work Order board where the stages this cycle's Start-production created finally get run — Start/Pause/Finish, QC checklist + the EN 17092 cert gate, and the material reservations the deposit gate has been waiting for.**
