# CX.3b — the Ads engine on the connection core (exact change)

Programme: `docs/2026-08-29-cx-channel-connections.md` §4 row **CX.3**, second half. Owner, 2026-08-29: *"Let's actually start it."*
Depends on CX.3a (`2d269c6f7`, `4be9d2c53`), live and verified.

## 0. The concern I raised, and what replaces it

CX.3a's §9 said this unit should follow **a day of green heartbeats**. It has had about twenty minutes: 4 consecutive `heartbeat_ok` (10:45 → 11:08Z), one `adopt`, and the single pre-adoption `heartbeat_failed` that was expected because no credential existed yet. The Owner has asked to start now, so time is not the gate — **evidence is**, step by step:

- every step keeps a fallback and a flag, and none is merged on faith;
- the step that is genuinely irreversible — removing the duplicate credentials — ships **with its inverse job**, so "delete the fallback" becomes "move the fallback", and is run last, after the core path has served real Amazon traffic in this session;
- the write path to Amazon is proven by the gate's own refusal codes, not by a green test run.

That is a stricter bar than waiting a day would have been on its own, because a day of heartbeats proves the *read* path and says nothing about the *write* path.

## 1. What is actually left

CX.3a moved the credential. Three things still make Amazon Ads a private universe:

| # | Today | After |
|---|---|---|
| A | ~75 sites resolve a profile with `prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive } })` | one shim, `adsProfileFor(marketplace)`, backed by `ConnectionScope`, falling back to the row |
| B | `getLwaToken` keeps its own per-profile token cache and in-flight map, with **no cross-replica coordination** | the CX leased refresh (`token.service.getAccessToken`), one token for the account |
| C | The same `{clientId, clientSecret, refreshToken}` is encrypted into **all nine** `AmazonAdsConnection` rows | one envelope on the connection; the nine columns emptied, reversibly |

**B is the substantive one.** The profile id travels in the `Amazon-Advertising-API-Scope` *header* (`ads-api-client.ts:30`), so the token is **account-level**: one refresh token yields one access token valid for every profile. The per-profile cache key is redundant — it holds fourteen entries for one token, and two replicas refreshing at once have nothing to stop them. The leased refresh already solves both.

## 2. A — the resolver shim

New `services/advertising/ads-profile-resolver.ts`:

```ts
adsProfileFor(marketplace: string): Promise<AdsProfileRef | null>
// { profileId, region, connectionId, mode, writesEnabledAt, lastWriteAt, source: 'scope' | 'row' }
listAdsProfiles(opts?): Promise<AdsProfileRef[]>
```

- reads `ConnectionScope{kind:'profile'}` on the one `AMAZON_ADS` connection, matching `metadata->>'marketplace'` **through `utils/marketplace-code.ts`** — the legacy column holds a 2-letter code on some rows and a marketplace string id on others (the HB.8 sweep), so the shim normalises both sides rather than trusting either;
- falls back to `amazonAdsConnection` when the scope is absent, and reports which source answered (`source`), so a silent divergence is visible;
- `NEXUS_CX_ADS_RESOLVER=0` forces the row, the same revert shape as CX.3a.

**The write gate is converted first and alone.** `checkAdsWriteGate` (`ads-write-gate.ts:180`) is what stands between the engine and real spend; it needs exactly `mode === 'production'` and a non-null `writesEnabledAt`, and refuses with `connection` / `connection_writes`. Both live in the scope metadata the CX.3a migration seeded. Converting it first means the riskiest reader is the one that gets the most attention, not the one that gets swept along in a batch of 75.

The remaining read sites follow in shape groups, ingestion before writes. Sites that select `credentialsEncrypted` are **not** converted here — those are C.

## 3. B — the leased refresh

`getLwaToken(profileId, creds)` → `getAccessToken(connectionId)` from the token service, behind `NEXUS_CX_ADS_LEASED_TOKEN`:

- one cache entry for the account instead of fourteen for one token;
- the DB lease means two replicas cannot both POST to LWA — today they can;
- the `authStatus` state machine sees Ads failures, so a dead Ads grant shows on the Channels page as `needs_reauth` instead of only in a log line;
- `ads-debug-probe.service.ts` keeps its deliberate bypass — a debug probe that shares production's cache is a worse probe, and its comment says so.

Kept exactly: the `Amazon-Advertising-API-Scope` header per call, `REGION_ENDPOINT`, the retry/quota ledger, and `recordSuccessfulWrite`.

## 4. C — the nine duplicate secrets, moved rather than deleted

`cx3b-ads-credentials-archive` nulls `credentialsEncrypted` on the nine rows **after** re-reading the core envelope and confirming it decrypts to the same credential. `cx3b-ads-credentials-restore` writes them back from the envelope. Both are registry-triggered, never scheduled.

The credential is not destroyed by this: the identical refresh token lives in the connection's envelope, which is where CX.3a put it. What the archive removes is **eight redundant copies of a live secret**, which is the security finding that started this phase.

**Ordering is the safeguard**: C runs last, only after A and B have served real Amazon traffic on prod in this session.

## 5. Files

New: `services/advertising/ads-profile-resolver.ts` (+ tests), `jobs/cx3b-ads-credentials-archive.job.ts` (+ restore).
Touched: `ads-write-gate.ts`, `ads-api-client.ts` (`getLwaToken` only), the read sites in shape groups, `cron-registry.ts`, tests.
Untouched: `ads-debug-probe.service.ts`, the Ads API surface, every UI contract (`/api/advertising/connections` keeps its shape — nine web call sites depend on it).

## 6. Verification on prod

1. After A: `checkAdsWriteGate` still allows the four production markets and still refuses the five sandbox ones with `connection` — the gate's own codes, read from a real call, not a unit test.
2. After B: a live Ads read succeeds; `[ADS-LIVE]` reports the leased path; the connection's `lastRefreshAt` advances; two concurrent calls produce **one** LWA exchange.
3. After C: the nine `credentialsEncrypted` columns are null, a live Ads call still succeeds, and `cx3b-ads-credentials-restore` puts one back and is then re-archived — the inverse proven, not assumed.
4. Throughout: `lastWriteAt` keeps advancing on the four production profiles. The engine writing to Amazon is the fact that matters; everything else is plumbing.

## 7. Risks · rollback

| Risk | Guard |
|---|---|
| The shim resolves a different profile than the row did | `source` is reported; the write gate is converted alone and first; `NEXUS_CX_ADS_RESOLVER=0` reverts |
| The leased refresh misbehaves on the money path | `NEXUS_CX_ADS_LEASED_TOKEN=0` reverts to the in-process cache, which is today's behaviour |
| The archive removes a credential we still need | the inverse job restores it from the envelope; C runs only after A and B are proven live |
| A marketplace code mismatch silently resolves nothing | the shim normalises both sides through the canonical map and returns `null` rather than guessing; the gate then refuses with `connection` rather than writing to the wrong market |

## 8. Verified on prod (2026-08-29)

All three steps shipped and were verified in order, each gating the next.

**A — the resolver and the write gate.** `cx3b-ads-decisions-reseed` → `profiles=9 written=9`. The gate-field diff then agreed for **every market where writes are enabled** (DE, ES, FR, IT — all `production`, all `writes ON`) and for four of the five sandbox markets. Gate decisions read back correctly from prod: IT and DE `already_enabled` with real timestamps, UK refused as `connection_mode_not_production`.

**B — the leased refresh.** A live Amazon call returned `{ok:true, mode:"live", profileCount:9}`, and the log named both sources rather than leaving it to inference:

```
[ADS-LIVE] credential source  {"source":"core"}
[ADS-LIVE] access token source {"source":"leased"}
```

**C — the duplicate secrets.** `rows=9 archived=9 mismatched=0 unreadable=0`. **Zero credentials remain in `AmazonAdsConnection`; one envelope remains on the connection.** Then, because an inverse that has never run is not a rollback: `cx3b-ads-credentials-restore` → `restored=9` (nine rows, one distinct blob, exactly as before), a live call still succeeded, and the archive was re-run to leave prod in the intended state. Both directions are in the ledger.

And the failure this step was designed around, proven *not* to happen: `POST /advertising/v1/export-cycle` → **`created=9 · skipped=0`** with no row holding a credential. Before the `adsAccountHasCredential()` change that would have been `created=0` — no error, no failing test, just an ingestion pipeline quietly producing nothing.

### The mismatch was real data, and its root cause was ours

One market disagreed: the row said profile `4392237479209848` was **IE**; Amazon's own `/v2/profiles` says `countryCode: BE`, `Europe/Brussels`, `AMEN7PMS3EDWL`. There is no Irish profile on this account.

`AMEN7PMS3EDWL` is amazon.com.be. Four files already had it right; `utils/marketplace-code.ts` — the map **38 call sites normalise through** — was the only one calling it Ireland, and Ireland's real id (`A28R8C7NBKEWEA`) was missing entirely. Fixed in `2c209a0c5`. The old code would have resolved an "IE" request to a *Belgian* profile; the new code resolves nothing and the gate refuses.

That is the third wrong marketplace id this phase has turned up, after the two in the Ads callback. All three were found the same way: asking the channel what it has instead of trusting what we stored.

## 9. Not done, and why

The other ~39 read sites stay on the legacy row. The inventory showed the scope metadata does not carry `accountLabel`, `lastError` or the token timestamps that four endpoints select, and that the CX.3a migration and the OAuth callback write **different metadata shapes**. Reconciling that is its own unit; converting blind would have broken `/api/advertising/connections`, which nine web call sites depend on.
