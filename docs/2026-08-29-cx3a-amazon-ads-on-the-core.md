# CX.3a — Amazon Ads onto the connection core (exact change)

Programme: `docs/2026-08-29-cx-channel-connections.md` §4 row **CX.3**, first half. Owner, 2026-08-29: *"Go ahead, I'll go with your recommendation."*
Depends on CX.1 (`61774d222`) and CX.2. **The SP-API OAuth half of CX.3 is NOT in this unit** — it is blocked on the Owner registering the public app in Seller Central, and nothing here waits on that.

## 0. Why this is the right next unit, and why it stops where it stops

Amazon Ads is the last channel running its own private connection universe, and it is the one that spends real money: the bid engine writes to Amazon through it every day (`lastWriteAt` on four production profiles, most recent this morning). So the unit is scoped by risk, not by tidiness.

**Measured on prod (read-only, 2026-08-29):**

| Fact | Reading |
|---|---|
| `AmazonAdsConnection` rows | **9** — 4 `production` (DE, ES, FR, IT), 5 `sandbox` (IE, NL, PL, SE, UK) |
| Distinct credential blobs across those 9 | **1** — the same `{clientId, clientSecret, refreshToken}` encrypted into all nine rows |
| `lastVerifiedAt` | **2026-05-18 on every row** — 3 months stale; nothing verifies them |
| `tokenExpiresAt` | 2027-05-17, with `tokenIssuedAtIsEstimate = true` — an **estimate**, not a measurement |
| Credential chokepoint | **one**: `resolveCredentials` (`ads-api-client.ts:389`) feeding `liveCall` (:399); every live Ads call goes through it. One deliberate bypass in `ads-debug-probe.service.ts:472` |
| Read sites of the row | 75 in production code; the dominant shape is `findFirst({ where: { marketplace, isActive: true }, select: { profileId, region } })` |
| Write sites | **6** (auth callback upsert, the orphaned `POST /connections`, enable/disable-writes, set-mode, DELETE) + `recordSuccessfulWrite` |

The engine's 75 read sites are **not** converted here. This unit changes exactly one function on the credential path — the chokepoint every live call already funnels through — and leaves the row itself as the fallback. That is the change that can be proven with one real Amazon call and reverted with one flag.

## 1. Target shape

One grant covers N profiles, so: **one `ChannelConnection` + nine `ConnectionScope` rows**, not nine connections.

```
ChannelConnection { channelType: 'AMAZON_ADS', managedBy: 'oauth', region: 'EU',
                    externalAccountId: <Ads account id>, identity: {...},
                    credentialsEnc: <envelope: the ONE refresh token>, grantedScopes: [...] }
  └── ConnectionScope { kind: 'profile', externalId: <profileId>, label: '<accountLabel> · <market>',
                        region: 'EU'|'NA'|'FE', isActive: <mode = production>,
                        metadata: { marketplace, marketplaceStringId, mode, writesEnabledAt, lastWriteAt, legacyRowId } }  × 9
ChannelApp { channelKey: 'AMAZON_ADS' }  ← already seeded from env at boot (verified in the CX.1 logs)
```

Constraint check (from the migration that created them, `20260819a_map2_account_dimension`): `ChannelConnection_active_account_key` is `(channelType, COALESCE(marketplace,'~'), COALESCE(externalAccountId,'~')) WHERE isActive` — one row with a set `externalAccountId` is legal; `ChannelConnection_channelType_primary_key` allows the one `isPrimary`. `ConnectionScope` is unique on `(connectionId, kind, externalId)`, which nine distinct profile ids satisfy. **No constraint is touched or added.**

## 2. Migration `20260831a_cx3a_amazon_ads_scopes` (additive, idempotent)

No column added, no table created, **no write to `AmazonAdsConnection`**. It derives:

1. One `ChannelConnection` for `AMAZON_ADS` when none exists: `managedBy 'oauth'`, `isActive true`, `authStatus 'unknown'` (the heartbeat decides within 15 min — never stamped healthy by a migration), `region 'EU'`, `displayName` and `externalAccountId` from the most common `accountLabel`, `apiVersion 'ads-v1 · reporting-v3'`, `isPrimary true` (it is the only one).
2. Nine `ConnectionScope` rows from `AmazonAdsConnection`, `ON CONFLICT DO NOTHING`, carrying mode/marketplace/writesEnabledAt/lastWriteAt/legacy row id in `metadata`.
3. A gate: `RAISE` unless the scope count equals the count of `AmazonAdsConnection` rows — a partial fan-out must fail loudly, not silently under-report the account's reach.

Credentials are **not** moved by SQL (the envelope needs the service): a one-shot registry job does it, as in CX.1.

## 3. The connector spec — `services/cx/connectors/amazon-ads/spec.ts`

Today it is a stub: `available: false`, `identity: () => null`, a canned "moves in CX.3" heartbeat failure, **no `discoverScopes`**, and auth hosts that disagree with the live route (`eu.account.amazon.com` + `api.amazon.co.uk` vs the live `www.amazon.com` + `api.amazon.com`). Replaced with the measured truth:

- `available: true`; auth hosts **matching the flow that actually works today** (`https://www.amazon.com/ap/oa`, `https://api.amazon.com/auth/o2/token`), PKCE S256, `requiredScopes: ['profile', 'advertising::campaign_management']` — the two the live flow requests. `advertising::test:create_account` and `advertising::audiences` are declared in `reviewGatedScopes`, so the UI says "2 need channel review" instead of showing drift against scopes we never ask for.
- `identity(handle)` — `GET /v2/profiles` on the region host; the account id and label from `accountInfo`.
- `heartbeat(handle)` — the same call, timed. This is what makes `lastVerifiedAt` mean something again after three months.
- `discoverScopes(handle)` — profiles **across all three regional hosts** (EU, NA, FE), not EU only. The live callback hard-codes `advertising-api-eu` (`amazon-ads-auth.routes.ts:42`), so NA/FE profiles are invisible today; the heartbeat will surface them if they exist.
- `refreshTokenLifetimeSec` 365 d, `rotatesRefreshToken: false`, `tokenExpirationBufferSec` 600.

## 4. The credential path — the one function that changes

`resolveCredentials` (`ads-api-client.ts:389`) today: read the row → `decryptSecret(credentialsEncrypted)` → `{clientId, clientSecret, refreshToken}`.

After: **ask the connection core first, fall back to the row.**

```
1. the AMAZON_ADS ChannelConnection has credentialsEnc  → clientId/secret from ChannelApp,
                                                            refresh token from the envelope
2. otherwise (or NEXUS_CX_ADS_CREDENTIALS=0)             → today's row blob, unchanged
```

`getLwaToken`'s in-process cache and in-flight dedupe stay exactly as they are — this unit does not move Ads onto the leased refresh (that is CX.3b, once the core path has a day of green heartbeats). One function, one flag, one revert.

The deliberate bypass in `ads-debug-probe.service.ts` is left alone on purpose: its comment says it must not share the production token cache, and a debug probe that reads the same source as production is a worse probe.

## 5. Keeping the legacy connect flow working (the Owner's console setting is not blocked on)

The Ads console's allowed return URL points at the legacy callback and only the Owner can change it. So `GET /api/amazon-ads/auth/callback` **keeps working** and gains a dual-write: after its existing per-profile upsert, it calls the core (`storeGrant` + scope upsert) so a reconnect updates both. Three defects in that route are fixed while it is open:

- it renders the **first 10 characters of the access token** into an HTML page (`:254-282`) → removed; no token material reaches a response body (the CX.0 rule).
- the success page links to `https://nexus-commerce-web.up.railway.app/settings/advertising`, a **dead host** → it redirects to the live web app's `/settings/channels?tab=accounts`.
- `MARKETPLACE_COUNTRY` (`:64-75`) maps `A1PA7PVP2ZEA0 → 'IT'`, `A1RKKUPIHCS9HS → 'DE'`, `APJ6JRA9NG5V4 → 'ES'` — **two of those are wrong** (`A1RKKUPIHCS9HS` is ES, `APJ6JRA9NG5V4` is IT). Replaced by the canonical map already in `utils/`, which is the single source the rest of the codebase uses.

`POST /api/advertising/connections` — the credential-paste route the web form used to call — has had no caller since CX.2 removed the form. It becomes **410 Gone**: a route that accepts a client secret over JSON and has no caller is a liability, not a feature.

## 6. The UI

`/api/advertising/connections` keeps its exact response shape — nine web call sites depend on it (`MarketplaceContext`, the ads console chrome, overview, activity, automation, rank, and the settings page). Nothing about the engine's surfaces changes.

What changes is that Amazon Ads becomes a **real account** in Settings → Channels:
- Accounts tab: an `Amazon Ads` row with its status pill from `authStatus`, region, and **nine profile chips** (`XAVIA · DE · production`), the permissions line, and the four timestamps — the same row shape as eBay and Amazon.
- Connect tab: the bespoke Ads card is deleted; with `available: true` the catalogue card serves it, and CX.2's note "Ads profiles keep their own health for now … CX.3 folds them into Accounts" is removed **because it is no longer true**.
- The Advertising page keeps every engine control (mode, writes, allowlist) and drops the stale line claiming credentials are stored there.

## 7. Files

Migration `20260831a_cx3a_amazon_ads_scopes`. New: `jobs/cx3a-ads-credentials.job.ts` (one-shot adopt, registry-triggered). Touched: `services/cx/connectors/amazon-ads/spec.ts` (real spec), `services/advertising/ads-api-client.ts` (`resolveCredentials` only), `routes/amazon-ads-auth.routes.ts` (dual-write + the three fixes), `routes/advertising.routes.ts` (`POST /connections` → 410), `apps/web/.../ConnectTab.tsx` (bespoke card out), `apps/web/.../settings/advertising/page.tsx` (stale copy), tests.

## 8. Verification on prod

1. Migration applies; the gate passes; **nine** `ConnectionScope` rows with the right modes and markets.
2. The one-shot job reports `adopted=1`; the connection's `credentialsEnc` is set and `credentialsKeyId` recorded. The nine row blobs are **left in place** as the fallback (CX.3b removes them).
3. Within 15 minutes the heartbeat flips `authStatus` to `connected` and writes `lastHeartbeatAt` — the first real verification of these credentials since 2026-05-18.
4. **The honesty round-trip:** trigger a real Ads read (`ebay`-style: `ads-v1-sync` or `advertising/connections/test`) and confirm it succeeds *through the core credential path* — then flip `NEXUS_CX_ADS_CREDENTIALS=0`, confirm it still succeeds through the row blob, and flip it back. Both paths proven, not assumed.
5. The bid engine's write gate is unaffected: `checkAdsWriteGate` still reads the row, and `lastWriteAt` keeps advancing on the four production profiles.
6. Screenshots: Amazon Ads as an account row with nine profile chips; the Connect tab with one Ads card and no "CX.3 folds them" caveat.

## 9. Risks · rollback

The only behaviour change on the money path is which store the refresh token is read from, behind `NEXUS_CX_ADS_CREDENTIALS`. Everything else is additive (a connection row, nine scopes, a heartbeat) or removes something with no caller. Rollback: set the flag to `0` — the row blobs are untouched and the engine reads exactly what it reads today. The migration is additive and needs no down-step.

**Not in this unit, and deliberately:** the 75 read sites (CX.3b), the leased refresh for Ads (CX.3b), nulling the nine duplicate blobs (CX.3b, after the core path has a day of green), and Amazon SP-API OAuth (blocked on the Owner's Seller Central app registration).

## 10. Verified on prod (2026-08-29) — and what the verification found

Migration applied at 10:38Z, gate passed. `cx3a-ads-credentials` → `adopted=1 identity=yes appClientId=yes regions=EU,NA,FE`. The connection reads **Xavia Racing Italia**, `authStatus connected`, envelope present. The nine legacy rows: **9 rows, 9 credentials, untouched** — the rollback is real, not theoretical.

**Both credential paths proven live, in sequence, without a flag flip:**

| Time | `[ADS-LIVE] credential source` | Meaning |
|---|---|---|
| 10:40:01Z | `{"source":"row","flag":null}` | before adoption the fallback served real traffic — the rollback path, proven |
| 10:45:01Z | `{"source":"core"}` | after adoption the core serves it |

and a live Amazon call through the core returned `{ok:true, mode:"live", profileCount:9}`.

### The account reaches 14 profiles, not 9

`discoverScopes` swept all three regional hosts and found **five profiles this system has never been able to see**, because the legacy callback hard-codes `advertising-api-eu`:

| Region | Profiles |
|---|---|
| EU | 9 (the ones we knew) |
| NA | **3 — Xavia Racing Usa · US, XAVIA · CA, XAVIA · MX** |
| FE | **2 — XAVIA · AU, XAVIA · JP** |

Nothing was wrong with the nine; the reach was simply never measured. This is the phase's own thesis landing: *ask the channel what it has, do not assume the shape you stored.*

### Two defects the verification then exposed, both fixed

1. **Discovery erased the operator's own scope metadata.** The heartbeat's scope upsert *replaced* `metadata`, so the mode / `writesEnabledAt` / `lastWriteAt` the migration recorded were wiped on the first heartbeat. Discovery knows what the channel says; it does not know what *we* decided. It now **merges** — and a test pins it, because this would have silently returned on any future channel with `discoverScopes`.
2. **The Accounts panel rendered the raw `AMAZON_ADS`.** It carried its own second copy of the channel-label map. Deleted; there is one spelling now, exported from `AccountSwitcher`.
