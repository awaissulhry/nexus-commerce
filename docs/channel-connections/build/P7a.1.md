# P7a.1 — the channel-sync worker refuses rather than guesses

**Found by:** P7a's census, not by a plan row. `build/P7a.md` §4 item 2 named it: *"E16
`channel-sync` deserves its own look, as a defect and not as clean-up."* This is that look.

`RESEARCH.md` A5 §1.1 calls this engine dead. It is **started** (`index.ts:487`) and has a **live
producer** (`routes/catalog.routes.ts` → `POST /api/catalog/sync/bulk`, one job per product per
channel).

## 1. Measured first — development database, 2026-09-21

| fact | value |
|---|---|
| `ChannelListing` rows | **1003** |
| 🟢 **control** — `channelMarket` values | AMAZON_IT 273, EBAY_IT 253, AMAZON_DE 214, AMAZON_ES 123, AMAZON_FR 115, EBAY_DE 21, SHOPIFY_GLOBAL 2, ETSY_GLOBAL 2 |
| rows with a `_US` market | **0** |
| rows with `region = 'US'` | **0** |
| rows stuck at `SYNCING` | **0** (spread: PENDING 431, IDLE 365, SYNCED 207) |
| 🔴 products with **more than one** listing on one channel | **214 Amazon, 21 eBay** |

Both defects below were therefore **latent** — and 235 products are loaded for the first one.
Same shape as P4.3a: a wrong writer one button-press away.

## 2. The two defects

### 🔴 It picked "the first"

```ts
channelListing = await prisma.channelListing.findFirst({ where: { productId, channel: targetChannel } })
```

No marketplace, no `orderBy`. For a product with AMAZON_IT, AMAZON_DE, AMAZON_ES and AMAZON_FR
listings, that is **an arbitrary one** — and the worker then wrote `syncStatus: 'SYNCING'` to it.

The Owner's P1.4 ruling is explicit that Nexus never picks the first (it was made about Shopify
locations and it is the same rule). It now **refuses**, naming the markets it found, so an
operator reads *"SKU-1 has 4 AMAZON listings (AMAZON_IT, AMAZON_DE, AMAZON_ES, AMAZON_FR), so
this sync must name one"* instead of getting a silent wrong-market pick.

### 🔴 It invented a market

```ts
const channelMarket = `${targetChannel}_US` // Default to US region
…
channelListing = await prisma.channelListing.create({ data: { …, channelMarket, region: 'US', … } })
```

A listing in a market this seller does not sell in. Every real row is IT, DE, ES, FR or GLOBAL;
`_US` appears **0 times**. The create is **gone**, not guarded — P4.3c's rule, that the engine
refuses an unnamed row rather than filling in a default.

### And a third, smaller one: the row was left stranded

STEP 3 set `syncStatus: 'SYNCING'`; the noop path then said *"leave the listing's status
untouched"* and returned. That instinct was right about `IN_SYNC` and **wrong about `SYNCING`**,
because the status had already been touched two steps earlier. The previous value is now
remembered and put back.

## 3. 🔴 What a positive control found: the `IN_SYNC` branch is unreachable

A case was written as *"a real publish still marks IN_SYNC"*. **It failed** — the row came back
`IDLE`.

All three handlers inside this worker hardcode `status: 'noop'` on their **success** path
(~287, ~317, ~347). Phase 0.3 went further than *"do not claim success on a noop"*: it made
**every** path a noop, so the `else` branch that writes `IN_SYNC` and `lastSyncStatus` can never
be taken. Mocking the underlying service does not change it — the handler discards that result's
status and returns its own.

That is asserted rather than worked around, because it is the fact that matters for P7:

> **With the two defects above fixed, this worker now writes nothing that survives its own run.**
> It sets `SYNCING`, builds a payload, logs it, and puts the status back.

So it becomes a **genuine P7 deletion candidate** — the first one this programme has that is
proven inert rather than assumed. It must go **with its producer** (`POST /api/catalog/sync/bulk`
and the `channelSyncQueue`), never alone: removing the consumer while the route still enqueues
leaves jobs accumulating in Redis. That is a deletion for the Owner to approve, not this session.

## 4. Proof — 10 tests, 5 mutations, **5 killed**

The worker **had no test at all**, which is how a branch that invents a market and one that
strands a row both survived: nothing could run them. `processChannelSyncJob` is now exported so
its guards can be driven directly; the BullMQ wiring is unchanged.

| # | Mutation | Result |
|---|---|---|
| M1 | ambiguity guard off (picks the first again) | **KILLED** |
| M2 | no-listing guard off | **KILLED** |
| M3 | status not restored | **KILLED** |
| M4 | restored to a hardcoded default instead of the old value | **KILLED** |
| M5 | the noop branch claims success | **KILLED** |

🟢 A null-mutation control correctly SURVIVED. A second positive control asserts the restore is a
real second `update` call, so *"the status came back"* cannot pass because nothing was written.

Gates: `tsc` clean; `src/workers` + `src/services/outbound-sync*` = **20 files, 259 passed**, 1
skipped. `check-push-lock.mjs`: the one failure is `services/pim/studio-publication-amazon.ts`,
the same pre-existing one the P1.6 record names (another session's file), unchanged by this slice.

## 5. Open

- **The deletion itself.** The worker is now provably inert. Removing it *and* its producer is a
  P7 decision for the Owner.
- `POST /api/catalog/sync/bulk` sends only `productId` and `targetChannel`. After this change it
  can only succeed for a product with **exactly one** listing on that channel — 235 products will
  now get a clear refusal where they used to get a silent wrong-market pick. That is the intended
  behaviour, and it is named here so the change is not a surprise.
