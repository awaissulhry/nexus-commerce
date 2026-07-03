# E4 — Campaign Management (writes)

> eBay Ads workstream, Phase E4. Every mutation flows through ONE audited layer: `ebay-ads-write.service.ts` — validate → **margin guardrail** → **write gate** → live eBay call OR sandbox → local mirror → `CampaignAction` audit (before/after + `_mode`). With `NEXUS_MARKETING_WRITES_EBAY` unset (today), everything runs **sandbox**: validated, guardrail-checked, mirrored, audited — **zero external calls**. Flipping the env after E4 acceptance makes the same code drive eBay live. Deliberate deviation from the Amazon queue+grace pattern (documented in-code): volumes are tiny and the console wants immediate per-item results; E5 automation applies through this same service.

## Capabilities

| Area | Ops | Guardrails |
|---|---|---|
| **Promote (product-first)** | `POST /api/ebay-ads/promote` — productIds → resolver → every live item ID (+ manual/preselected listingIds) → dedupe vs existing ads → chunked (500) `bulkCreateAdsByListingId` → per-item results | rate 2–100%; **rate > break-even BLOCKED** unless explicit named override (audited); missing-COGS → allowed with warning (manual-only binds automations, not operators) |
| **Builder** | `POST /campaigns` — General fixed / General **dynamic (hard cap required)** / General **rules-based** (selection rules + auto-select, with a labeled local match preview over the listing index) / Priority manual / Priority **smart** (maxCpc) | ES: Priority rejected server-side + hidden in UI; dynamic without cap rejected; smart without maxCpc rejected |
| **Lifecycle** | pause / resume / end / **clone** (the only way to "edit" immutable selection rules) | state machine enforced (DRAFT can't pause; ENDED can't resume — clone) |
| **Rates** | per-ad + bulk `ad-rates` (rate-at-ad-level truth); campaign-level `rate-strategy` (FIXED↔DYNAMIC with cap) | same break-even guardrail per listing |
| **Budget (CPC)** | `budget` | **15/day/campaign quota enforced our side first** (counter on the campaign, surfaced in UI) |
| **CPC structure** | ad groups; keywords (bulk add w/ 100-char/10-word validation, bid+status updates); negatives (EXACT/PHRASE) | bid €0.02–€100 |
| **CSV round-trip** | `GET /export.csv` (campaigns+ads+keywords with break-evens) → edit → `POST /import` (**dry-run diff default**, then apply valid rows with per-row results) | every applied row goes through the same write service (guardrails included) |
| **Safety rails** | `MarketingSpendCeiling.killSwitch` + `MarketingAutomationState.halted` checked before EVERY write | audit trail at `GET /ebay-ads/actions` |

Suggestion passthroughs (live, read-side): `suggest/max-cpc`, `suggest/keywords`, `suggest/bids`.

## UI (all inside /marketing/ads/ebay)

Products: row selection (products AND unmatched listings) → **Promote** modal (campaign picker, rate, override reason, per-item results). Campaign detail: lifecycle buttons, **Set rate (n)** / **Remove (n)** on selected ads, **Add listings**, **Budget** (with x/15 meter), **Keywords** / **Negatives** modals, **Clone**. Campaigns grid: **New campaign** (builder page), **Export CSV**, **Import CSV** (paste → dry-run diff grid → apply → per-row results). Every write surface shows the **Sandbox banner** while the gate is closed.

## Verification (sandbox E2E on prod DB — `apps/api/scripts/_e4-verify.mts`)

**23/23 assertions green**, including: gate closed → sandbox; ES-Priority rejected; **rate>break-even BLOCKED** / override unlocks (audited) / <2% rejected; sandbox ads mirrored (`status=SANDBOX`, exempt from stale pass); DRAFT→pause rejected + full legal walk DRAFT→ACTIVE→PAUSED→ENDED + ENDED→resume rejected; budget on CPS rejected + **quota trips on the 16th edit**; keyword add (invalid rejected) + pause + negative; CSV export/dry-run/apply per-row; **28 `CampaignAction` audit rows** all carrying `_mode:"sandbox"`; sandbox entities cleaned up. Unit suite: 104 tests green; tsc clean both workspaces.

## Go-live (after your E4 acceptance)

1. Set `NEXUS_MARKETING_WRITES_EBAY=1` on Railway (the P9 gate — same one documented in MARKETING-OS.md).
2. First live action recommendation: a clearly-labeled **test campaign at minimal rate** (builder → General fixed 2%, one cheap listing), verify it appears in Seller Hub, then end it.
3. The kill switch is `MarketingSpendCeiling(channel EBAY, marketplace, killSwitch=true)` or halting `MarketingAutomationState(channel='EBAY')` — both stop every write instantly.
