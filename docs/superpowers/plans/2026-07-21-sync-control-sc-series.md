# Sync Control (SC series) — per-location, per-market, per-product routing & muting

**Date:** 2026-07-21 · **Status: PROPOSAL — AWAITING OWNER GATE. No code changed.**
**Owner ask:** total, precise control over what syncs where — route a location's stock to chosen channel-markets (e.g., location X → Amazon IT only + all eBay), exclude any product/variant from real-time sync, bulk actions from a Stock-page tab, spreadsheet import/export parity, full history, zero data breach, 100% accuracy. Owner's Amazon-native spreadsheets must NEVER overwrite the pool. Simple yet effective.

---

## 0. Design principles (locked before any wiring)

1. **Pool stays the single source of truth.** This is routing and muting — deciding *which listings follow the pool from which locations* — NOT per-channel quantity allocation (allocation was rejected 2026-06-24 and stays rejected; nothing here splits the pool into buckets).
2. **Default = today's behavior.** Every rule ships with "empty means everything" semantics: a location with no routing serves all markets; a listing with no override follows all routed warehouse stock. Zero rules = byte-identical current system. No migration of behavior, only of possibility.
3. **FBA untouchable, everywhere.** Every new surface renders FBA as `—`; every new write path passes the canonical fail-closed guard. No exceptions, ever.
4. **Listing-level writes only.** No control action ever writes `StockLevel`/`totalStock` (FM Phase-1 invariant). Controls change *derivation*, never *stock*.
5. **Every change audited + recascaded.** A control change without an immediate deterministic recascade of the affected listings is a lie waiting to surface; every mutation lands in an audit trail with actor, before→after, and scope.
6. **Verification closes every loop.** The read-backs (Amazon daily, eBay 30-min) already compare channel-actual vs intended; "intended" becomes routing/mute-aware in the same commit that introduces each control, so drift detection can never disagree with the control model.

## 1. The control model (three layers, smallest possible)

**Layer A — Location routing (`StockLocation.servesMarketplaces`, already in schema, dormant).**
Tokens `CHANNEL` or `CHANNEL:MARKET` (`AMAZON:IT`, `EBAY`, `SHOPIFY`). Empty array (today's state) = serves every channel-market. The cascade computes each listing's available as the sum over WAREHOUSE locations *whose routing includes that listing's channel+market*. Owner example becomes literally: location X `["AMAZON:IT", "EBAY"]`.
- Uncounted semantics per listing: if a listing's *routed* location set has zero ledger rows → UNCOUNTED for that listing (P0 guard applies per-listing, not globally).
- Reservations stay per-location rows, so routed available is reservation-correct by construction.

**Layer B — Listing/membership scope (surgical overrides).**
- `ChannelListing`: existing `followMasterQuantity` (Follow/Pinned) + `stockBuffer` stay the per-listing controls; NEW `syncMode` refinement: `FOLLOW` (default) | `PINNED` (frozen at value, pushable) | `PAUSED` (no outbound pushes at all — not even manual edits — until resumed; read-back reports but never heals it). Pause action offers two entries: *freeze at current* or *safe-zero first* (push 0, then pause) — the oversell-safe option for "stop selling this here."
- `SharedListingMembership`: NEW `followPool Boolean @default(true)` (+ optional `stockBuffer Int @default(0)`) — the missing per-variant control on multi-listing eBay: exclude one variant of one listing from fan-out without touching its siblings.
- Optional per-listing `sourceLocationCodes String[]` (empty = all routed locations) — only if a real case needs finer-than-Layer-A routing; ships dark in SC.0 schema, wired only when needed (kept out of UI until then).

**Layer C — Channel/market master switches.**
Per channel-market pause (env-independent, DB-backed `SyncChannelPolicy`: channel, marketplace, pushesPaused, newListingDefaultMode). One click mutes ALL pushes to e.g. Amazon DE during an incident, with a banner everywhere it matters; new-listing default mode answers "listings born on FR start PAUSED until I say otherwise."

**Audit:** one `SyncControlAudit` table (actor, scope: location/listing/membership/policy, field, before, after, reason?, createdAt) written by every mutation above; surfaced in the new tab and joinable from the existing followMasterQuantity journaling.

## 2. The surface — Stock page → new **Sync Control** tab

`/fulfillment/stock/sync-control` (sibling of control-tower/locations/import), Salesforce/Airtable density:
- **Matrix view:** rows = products (variants are products; expandable family grouping), columns = channel×market chips showing per-listing state (mode F/P/⏸ + effective qty + buffer + routed-locations badge). FBA cells `—`.
- **Filters:** channel, market, mode, family, location, drifted-only, paused-only.
- **Bulk actions** (selection × market picker): Set Follow / Set Pinned / Pause (freeze|safe-zero) / Resume / Set buffer / Set locations — every bulk behind a typed-count confirm modal, every result toast with updated/skipped-FBA/unchanged, every action audited.
- **Locations panel:** per-location routing editor (checkbox grid channel×market) — Layer A's UI.
- **History drawer:** per-product and global audit timeline (who/what/when/before→after).
- **Row detail:** effective computation shown transparently: routed locations → summed available − buffer → per-market intended, plus last push, last read-back verdict.

## 3. Import/export parity

- **Stock-import wizard (IM.3):** optional columns `follow`, `buffer`, `pause` per market — bulk control by spreadsheet with the same server-side validation + FBA skip + audit as the tab. Export (Excel round-trip) emits current control state so the sheet is a faithful snapshot.
- **Flat-file editors:** already carry Follow + Buffer columns; PAUSED joins the Follow enum (renders in both editors; save routes through the same endpoint).
- **Owner's Amazon-native spreadsheets (the standing workflow):** the guarantee *"your uploaded quantities never overwrite the pool"* is already structural (pull adopts listings without pinning since P0; listing saves never write pool since FM.1) — SC locks it with a dedicated test battery + a visible **"Your upload vs pool"** diff card (read-back data) so takeover is observable, not implicit. Uploading a sheet with different quantities shows: Amazon momentarily has yours → cascade/read-back restores pool truth → diff card documents both sides. Nothing new to remember, everything visible.

## 4. What I researched/added that wasn't asked

- Per-membership (eBay variant-on-listing) control — without it, "except one variant" is impossible on shared listings (today's gap).
- **Pause ≠ Pin distinction** with the safe-zero option (pausing at qty>0 leaves oversell exposure; the modal makes the choice explicit).
- New-listing default mode per market (else every new listing silently Follows everywhere — control must cover births, not just existing rows).
- Read-back/self-heal awareness: paused/pinned/routing-scoped listings verify against *their* intended value; heals never fight the controls (the heal loop and the control model share one derivation function).
- Kill-switch layer (C) as the incident lever the env flags can't give the operator.
- Guard interactions: janitor/coalescing/claims treat PAUSED rows as CANCELLED-equivalent (no queue rot); flip-guard & FBA stack unaffected by construction.
- Explicit non-goal restated: no per-channel quantity allocation.

## 5. Phases (each: implement → tests → deploy → prod-verify → commit/push → owner check)

- **SC.0 — Schema + derivation core (dark).** Fields/tables (§1) + ONE pure function `resolveIntendedQuantity(listing|membership, controls, ledger)` used by cascade, dispatch re-read, read-backs, and the future UI — the single place "intended" is defined. Empty-rules behavior proven byte-identical (regression battery + shadow diff on prod data: expect zero differences). No UI, no behavior change.
- **SC.1 — Engine adoption.** Cascade, shared fan-out, dispatch re-reads, both read-backs, drift self-heal all consume the core; PAUSED semantics enforced end-to-end; membership followPool honored; routing math live (still zero rules configured → still identical). Recascade-on-control-change wired. Full battery + net-zero prod canaries.
- **SC.2 — Sync Control tab, read-only first.** Matrix + filters + row detail + history + locations panel (display). Screenshot self-verified; you validate the truth of what it shows before anything can mutate.
- **SC.3 — Actions.** Single + bulk mutations (§2) + audit writes + confirm modals; net-zero prod verification per action type (the FM playbook); then your first real routing rule (your location→IT+eBay example) executed together and verified by read-backs.
- **SC.4 — Import/export parity.** Wizard columns + export snapshot + flat-file PAUSED + the upload-vs-pool diff card + the takeover-guarantee test battery.
- **SC.5 — Policies & rails.** Channel/market kill-switches + new-listing defaults + banners.
- **SC.6 — Proof & runbook.** Your two examples as permanent E2E tests (location→AMAZON:IT+EBAY routing; all-real-time-except-one-variant), scenario battery, `docs/SYNC-CONTROL.md` runbook, Control-Tower cross-links.

**Sequencing rationale:** truth core before engine, engine before eyes, eyes before hands, hands before policies — each phase independently shippable and verifiable, controls never half-honored anywhere.

## 6. Open decisions for the gate

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve SC.0–SC.6 | as above |
| D2 | Pause default entry: freeze vs safe-zero | modal asks every time (no silent default) |
| D3 | Membership-level buffer now or later | field in SC.0, UI later if needed |
| D4 | `sourceLocationCodes` per-listing (finest routing) | schema-dark in SC.0; wire only on real need |
| D5 | Wizard control-columns naming | `follow` / `buffer` / `pause` per active market, mirroring flat-file editors |
