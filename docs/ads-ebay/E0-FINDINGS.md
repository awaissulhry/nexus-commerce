# E0 — Findings (urgent / gate-relevant)

> eBay Ads workstream, Phase E0 deliverable 6 (per master prompt §6 "Findings"). Compiled 2026-07-03 from live read-only probes (`scripts/_e0-ebay-probe*.mjs`) + the four research documents in this folder. Ordered by urgency.

## F1 — BLOCKER for E2+: the live eBay token does NOT carry `sell.marketing`

`GET /sell/marketing/v1/ad_campaign` → **403 "Insufficient permissions"** (probe, 2026-07-03). The consent URL in code already requests the scope (`ebay-auth.service.ts:74-83`, UM.9), but scopes only attach at consent time and refresh tokens can never widen scope (verified — capability matrix §18).

- **Operator action (one-time, ~2 minutes):** Settings → Channels → reconnect eBay (or `POST /api/ebay/auth/initiate` → open `authUrl` → approve). After re-consent: `POST /api/marketing/os/sync/ebay` should return `upserted ≥ 0` instead of the 403 hint.
- **Side effect worth knowing:** the existing eBay **markdown** (`ebay-markdown.service.ts`) and **volume-pricing** (`ebay-volume-pricing-push.service.ts`) push features POST to `sell/marketing` endpoints — they cannot have been working against prod either. The same re-consent unblocks them.
- Until re-consent we cannot see whether **Seller Hub campaigns already exist** (the seller may have created some manually; the E2 backfill will reveal and adopt them).

## F2 — Product-first ads is impossible today: 19 of 20 live listings are invisible to Nexus

Live probe: the account has **20 active listings (all eBay IT)**; Nexus tracks **1** (`257584954808`, the shared-SKU GALE listing). The GALE jacket alone runs ~5 concurrent duplicate listings; 11 of 20 items have **no SKUs** (legacy, hand-created). Additionally `SharedListingMembership.status` is never flipped to `ENDED` by any code path, and `ebay-status-reconcile` is daily/default-OFF/Inventory-API-only.

**Consequence:** the E2 listing-discovery sync + unified resolver (`E0-PRODUCT-LISTING-MAP.md` §6) is a hard prerequisite, ad attachment must be listingId-based, and ads need STALE-marking when itemIds die. Also: eBay rejected the `ItemRevised` notification subscription for this seller's Trading permission level, so end/relist detection must poll — it cannot rely on push.

## F3 — Apparel size-standardization (June–July 2026): jackets look compliant, but scope must be probed before July

- Policy (verified): **June 2026** auto-normalization + removal of custom size values; **July 2026** listings with non-standard/missing **size and/or condition** values are **blocked or hidden**. Scope = "Apparel & Footwear" item specifics; **no published category list** — motorcycle-apparel trees are neither confirmed in nor out.
- Live spot-check of our items: all jacket listings carry `Taglia` variation specifics with standard tokens (XS–4XL); sliders/back-protectors have no size aspect (plausibly out of scope). One anomaly: item `255137162735` sits in the **US eBay Motors apparel tree priced in USD** while Site=Italy — review this listing regardless.
- DB hygiene note: stored `itemSpecifics` mix `Size` and `Taglia` keys for the same market — harmless today, but normalize when the E2 listing index lands.
- **Action (cheap, read-only, before July 2026):** Taxonomy-API probe (`getItemAspectsForCategory`) of categories 177104/177101/177106/183507/177117 on IT/DE/FR/ES: if Size still accepts custom values on new listings after June, the tree is out of scope; remediate anything in fashion-tree categories. Proposed home: an E2 compliance check inside the listing-discovery sync (we'll hold every listing's aspects locally).

## F4 — "easy boost" collision hazard (new, June 2026)

eBay's mobile-app "easy boost" flow promotes ALL eligible listings at one ad rate and **silently replaces existing General ad rates**. Two consequences: (a) the operator should not tap easy boost once Nexus manages campaigns; (b) the console's hourly entity sync diff-alerts on rate changes Nexus didn't make (architecture §0.8). Zero code needed now — awareness item.

## F5 — Spain: Priority campaigns do not exist

Verified in docs ("Priority campaigns are not currently supported in the ES marketplace") even though the Account API eligibility probe returns `PROMOTED_LISTINGS_ADVANCED: ELIGIBLE` for ES — a live eBay inconsistency; the docs are binding. The console ships a hard ES branch: General + Offsite only. (Also: Offsite allows only **one campaign per seller**, account-wide.)

## F6 — Master-prompt assumptions corrected by verification (design already updated)

| Assumed (§3 of the master prompt) | Verified reality |
|---|---|
| Any-click attribution starts Jan 13, 2026 | That was US/CA. **DE: Feb 2025; IT/FR/ES: June 2025** — all our markets ~1 year in; fee = rate **at time of sale** (rate raises hit already-clicked inventory) |
| Campaign ad rate can never change after creation | **`updateAdRateStrategy` exists since 2022** (+ ad-level `updateBid`/bulk). Only selection **rules** are immutable (clone-or-recreate) |
| Negative keywords exact-only | **EXACT + PHRASE** |
| Suggested ad rates available via API | **No CPS suggested-rate endpoint at all**; Recommendation API covers **DE only** (needs `sell.inventory`). IT/FR/ES fallback = DYNAMIC strategy with our margin-derived `adRateCapPercent` |
| Sandbox can't run PL reports | Exclusion removed from docs; sandbox *responds* but its report data is untrustworthy — verify on production read-only |
| Reports quota ≈200/hr is the main constraint | Also **Marketing "Ads" API: 10,000 calls/day per application** (default) — the entity-sync cadence must budget for it |

## F7 — Pre-existing issues in the Amazon/ads codebase (flagged, not touched)

1. `SpSuperWizard.tsx:116-129` — AutopilotPlan provisioning after launch is fire-and-forget with a swallowed `catch {}`; campaigns can go live with their AI plan silently missing.
2. `/listings/ebay/campaigns` labels eBay funding "CPM / CPC" and the `EbayCampaign` schema comment calls STANDARD "CPM" — eBay General is cost-per-**sale**. Cosmetic but wrong; fixed by the E2/E3 modernization.
3. Channel-neutral detail tables (`AmazonAdsCampaignDetail`, `EbayPromotedDetail`, `CampaignTarget`, `ExternalAdsDetail`) are **defined but have zero references** — the UM spine is partly paper; E1 adds characterization tests before relying on it.
4. `amazon.adapter.ts` normalization is manually mirrored in `scripts/um2-amazon-backfill.mjs` (self-documented fork-drift hazard).
5. The repo's rate limiter (`utils/rate-limiter.ts`) is **in-process per container** — fine for one instance, wrong for multi-instance; E2's Redis-backed quota ledger addresses it for eBay ads.
6. 8 stale inactive eBay `ChannelConnection` rows (from the 2026-05-20 wipe/restore) — cosmetic; the active row + 30-min refresh cron are healthy (probe: token refreshed on schedule, expiry advancing hourly).

## F8 — Token health: GOOD

Active eBay connection `…61qf6z`: `managedBy=oauth`, token expiring ~hourly and refreshed by the 30-min cron (last refresh 23:00Z, expiry 01:00Z at probe time), refresh token present. The only problem is scope (F1), not health.

---

### Asks at this gate

1. Approve the **operator re-consent** (F1) — read-only unblocking action; no writes follow until E4 approval.
2. Approve **E1 start** per `E0-EXISTING-ADS-AUDIT.md` §4 (extraction plan) — or adjust its scope.
3. Decide the **UI placement** option in `E0-ARCHITECTURE.md` §6 (sibling section inside `/marketing/ads` shell — recommended — vs standalone `/marketing/ebay-ads`).
4. Note F3's July-2026 size deadline — the Taxonomy probe can run in E2, well ahead of it.
