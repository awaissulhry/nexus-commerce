# Presence wire — PR.1, 2026-09-13

Contract for Waves 2–3. `W2-READ-SHAPE` makes this contract consumable; it does **not** declare the routes implemented. Reads of new columns wait for `W2-SCHEMA-APPLIED`, and the implementation waits for W1.1–W1.6 and M1. Channel-writing plan/apply, relaunch, release and scheduling execution remain outside these waves.

## Shared types and authority

The source of the three unions is **`apps/web/src/design-system/grid/renderers/presence.ts`**, published by PR.6 at `W2-DS-TYPES DONE` (2026-09-13T16:53:57.652356+00:00). Import `PresenceIntent`, `ChannelFact` and `PresenceVerdict`; do not restate their members in an API or studio union. PR.6 also exports `presenceVerdict`, with intent-change and observation timestamps as separate inputs.

The source of `Reach`, `ActionReversal`, `ActionHandoff` and `ActionRefusal` is **`apps/web/src/design-system/grid/actions/registry.ts`**. The API uses erased type imports through the existing `@nexus/web` workspace package. A compiler probe with the actual API options reports zero diagnostics; relative imports (including `.d.ts` spelling) resolve back to source and produce three `rootDir` errors. No declaration is copied or maintained by PR.1. No `RowReadinessState` declaration is introduced. Readiness and presence remain separate fields.

```ts
// In services/presence/types.ts; these resolve to the canonical DS source.
import type { PresenceIntent, ChannelFact, PresenceVerdict }
  from '@nexus/web/src/design-system/grid/renderers/presence'
import type { Reach, ActionReversal, ActionHandoff }
  from '@nexus/web/src/design-system/grid/actions/registry'
import type { ListingCoordinate } from '../../lib/listing-coordinate.js'
```

Every endpoint below has an explicit in-file session permission guard, independent of `NEXUS_RBAC_MODE`. Reads and verify require `products.view`; local lifecycle writes require `products.edit`. The destructive legacy routes retain their `products.delete` guards. A request-supplied actor is never authoritative. Database access uses the request's verified workspace context; neither a product ID nor an account ID grants cross-workspace access.

## Coordinates and errors

`ListingCoordinate` is imported from `apps/api/src/lib/listing-coordinate.ts` (PR.3). Its five required properties are `productId`, `channel`, `marketplace`, `channelConnectionId` and `aliasKey`.

- `channelConnectionId: null` explicitly addresses an unattributed legacy row. Omission and `undefined` are errors; they never mean the primary account.
- `aliasKey: ''` explicitly addresses the primary listing. Omission, `undefined` and `null` are errors. `aliasId` is a different, nullable foreign key.
- JSON bodies use the five property names above. A coordinate's `productId` must equal the route's `:id` where one is present.
- Single-coordinate GETs use `channel`, `market`, `accountId`, `aliasKey`. `market` maps to `marketplace`, `accountId` maps to `channelConnectionId`. The exact query value `accountId=null` represents the explicit null account. An empty account is invalid; `aliasKey=` is valid. Missing query keys do not receive defaults.
- Validate with PR.3's `whereCoordinate` before reading or writing. `requireCoordinate` gains a presence-specific strict option so widening these endpoints does not silently change the older projection callers' contract.

An omitted `accountId`, for example, returns HTTP 400:

```json
{
  "error": "LISTING_COORDINATE_MISSING_LEVEL",
  "code": "LISTING_COORDINATE_MISSING_LEVEL",
  "level": "channelConnectionId",
  "message": "channelConnectionId (accountId) is required. Name the account explicitly."
}
```

Every missing or invalid dimension is named. Other errors carry `{code, message}`; unavailable verbs also carry `refusal`, the server's operator sentence. HTTP 403 means permission or session refusal. A failed read is an error or an explicitly unavailable source, never an empty successful list. HTTP 409 carries `{code:'version_conflict', message, current}` with the current coordinate read and its version.

## GET /api/products/:id/studio/presence

No coordinate query is required. By default the response covers the requested product. The explicit query `includeFamily=true` covers the root product and all its direct children, resolving a child's root first. A family read names every covered product in `coverage.products`; it never silently truncates the family or substitutes a parent-only result. The family ceiling is 200 products; exceeding it returns HTTP 400 with `code: 'presence_family_too_large'` and the server's sentence. A product read has one coverage member. Both modes batch each source across the selected product IDs, with no per-child HTTP calls or per-child source queries.

Consumers derive family roll-ups only from a successful family read and its named coverage. A product-only result must be labelled as that product's coverage. `fanOut` separately enumerates any additional coordinates a later verb would affect; it is not a claim that those products were read. Every stored listing is included regardless of publication status, connection state or participation. Retired identities remain visible where the listing row has gone. Openings are explicit connected-account × served-market × applicable-active-alias coordinates with no listing or retained identity; no guessed account, alias or Shopify-market rows are fabricated.

The existing all-listings reader's grouped `Record<channel, listings[]>` shape must be flattened at the service boundary. Its workspace-scoped query can be reused; its missing route guard cannot. Openings and connection metadata are additional reads, not conclusions drawn from absence in that grouped object.

```ts
interface NamedCoordinate {
  coordinate: ListingCoordinate
  label: string                 // SKU · channel · market · account · alias
  sku: string | null            // Product.sku, never labelled seller SKU
  sellerSku: string | null
  sellerSkuSource: string | null // e.g. Offer.sku or explicit legacy Product.sku fallback
  accountLabel: string | null
  aliasLabel: string | null
}
interface IntentRead {
  value: PresenceIntent | null  // null: never stated by an operator
  at: string | null
  by: string | null
  reason: string | null
  provisional: null | {
    value: PresenceIntent
    source: 'legacy-columns'
    fields: Array<{ name: string; value: unknown }>
    sentence: string
  }
}
interface FactRead {
  value: ChannelFact            // persisted null is projected as UNKNOWN
  asOf: string | null           // channelFactAt, never lastSyncedAt
  via: string | null
  detail: Record<string, unknown> | null
}
interface VerbAvailability {
  available: boolean
  reach: Reach
  reversal: ActionReversal | null
  refusal: string | null        // render verbatim; no client reconstruction
  errorCode: string | null
  handoffs: ActionHandoff[]
  fanOut: NamedCoordinate[]     // never just a count
}
interface PresenceRow extends NamedCoordinate {
  kind: 'listing' | 'opening' | 'retired'
  listingId: string | null
  aliasId: string | null        // actual alias FK for the alias-status route
  version: number | null        // ChannelListing.version; no row means null
  productVersion: number | null // Product.version, independently named
  externalListingId: string | null
  lastChange: null | {
    eventId: string
    at: string
    actorUserId: string | null
    summary: string
  }
  intent: IntentRead
  fact: FactRead
  verdict: PresenceVerdict      // derived on read, never persisted
  inFlight: boolean
  gate: { mode: string | null; sentence: string | null; canVerify: boolean }
  connection: {
    state: 'connected' | 'not-connected' | 'unknown'
    asOf: string | null
    via: string | null
    refusal: string | null
    authStatus: string | null    // actual stored status; not inferred from a failed read
    accessTokenExpiresAt: string | null
    lastErrorAt: string | null
    lastError: string | null     // sanitized operator detail, no credentials
  }
  participation: {
    isParticipating: boolean | null
    participationStatus: string | null
    checkedAt: string | null
  }
  local: {
    syncPaused: boolean | null
    variationExcluded: boolean | null
    offerActive: boolean | null
    offerActiveHonoured: boolean | null
    offerClosedAt: string | null
    offerClosedBy: string | null
    offerCloseReason: string | null
    lastSyncedAt: string | null
    presenceEffectiveFrom: string | null
    presenceUntil: string | null
    scheduleSentence: 'A note, not an alarm. Nothing executes these dates.'
  }
  verbs: Record<string, VerbAvailability>
}
interface PresencePage {
  product: { id: string; sku: string; version: number; deletedAt: string | null }
  coverage: {
    scope: 'product' | 'family'
    requestedProductId: string
    rootProductId: string
    products: Array<{ id: string; sku: string; version: number; deletedAt: string | null }>
    complete: true             // partial source failure is named in sources, never omitted members
  }
  readAt: string
  freshnessMs: number           // server policy, supplied to verdict derivation
  verifyPolicy: {
    maxCoordinatesPerCall: number
    maxAttemptsPerWorkspaceHour: number
    sentence: string            // render the server's cap sentence verbatim
  }
  rows: PresenceRow[]
  sources: Array<{
    source: string
    status: 'ok' | 'unavailable'
    asOf: string | null
    refusal: string | null
  }>
}
```

Dates are ISO-8601 strings or explicit null. `presenceUntil` is the schema's upper-bound column (the brief's “until”), not a second `presenceEffectiveUntil` column. All stored scheduling dates are returned; no timer, cron or delayed channel action is armed.

For a null intent, provisional derivation gives terminal legacy `listingStatus` precedence over a missing external ID. In particular `{listingStatus:'ENDED', offerActive:false, externalListingId:null}` derives provisional `ENDED`, with those contributing columns named; it never becomes “never published.” No derived value is backfilled. A missing fact is `UNKNOWN` even if a legacy intent looks clear.

Verdict derivation uses the stated intent, or the explicitly provisional value when no intent was stated. A fact older than the last intent change with nothing in flight yields `unknown`. Unknown/invalid timestamps and stale observations also yield `unknown`; `REFUSED` yields `unreachable`. A send hold does not establish whether the channel is selling. `freshnessMs` is stated on the wire so a renderer cannot invent a second timeout.

Connection state is three-valued. A failed connection read or failed health observation yields `unknown`; only successful evidence of a disconnected connection yields `not-connected`. Missing participation evidence stays null. Shopify is one connected webstore; no Marketplace rows per Shopify market are created.

Gate sentences come from the single `gateNote` definition in `packages/shared/publish-gate.ts`, imported through `@nexus/shared/publish-gate`. The existing `apps/web/src/app/products/[id]/edit/_studio/channel-ops/syncQueue.ts` re-exports it. Etsy additionally states “Etsy presence is READ-ONLY through Wave 4 by decision D9.” WooCommerce states its containment policy. Neither missing publish mode becomes `live`.

Wave 3 advertises hold/resume, exclude-child/include-child and discontinue/undiscontinue with local reach. An unavailable local verb still has its reversal and refusal. Channel verbs remain unavailable, with the server's gate sentence and applicable named handoffs. Openings do not link directly to the listing-preset writer. Retired identities cannot silently authorize recreation.

## GET …/presence/one

`GET /api/products/:id/studio/presence/one?channel=EBAY&market=IT&accountId=<id>&aliasKey=` returns `{readAt, freshnessMs, verifyPolicy, row: PresenceRow}` for exactly the supplied five-level key. A configured Opening can be returned; an unknown coordinate returns 404. No nearest-market/account/alias fallback is allowed.

## GET …/presence/history

The same four required query dimensions, plus optional `limit` (default 50, maximum 100) and opaque `cursor`.

```ts
interface PresenceHistory {
  coordinate: ListingCoordinate
  readAt: string
  events: Array<{
    id: string
    aggregateId: string
    aggregateType: 'ChannelListing'
    eventType: string
    createdAt: string
    data: Record<string, unknown> | null
    actor: { userId: string | null; source: string | null }
  }>
  identities: Array<{
    id: string
    coordinate: ListingCoordinate
    sku: string
    externalListingId: string
    externalParentId: string | null
    firstSeenAt: string
    lastSeenAt: string
    retiredAt: string | null
    retiredReason: string | null
    retiredBy: string | null
    doNotRecreate: boolean
    lastSnapshotId: string | null
  }>
  nextCursor: string | null
}
```

Read `ProductEvent` by current listing aggregate IDs **and** the full coordinate in event `data.coordinate`; include retired `ListingIdentity` rows even after their listing/product was purged. Historical events without a complete coordinate can be attributed through a known aggregate ID; a partial JSON address cannot widen the match. A retained identity's external ID is history, not evidence of current selling. No `ListingPresenceEvent` store is added. No `EbayListingIndex` write occurs.

## GET …/presence/amazon-posture

Requires the same complete coordinate, with `channel=AMAZON`. Returns `{coordinate, readAt, offers, fbaInventory, suppressions, gate, sharedQuantityIntent, checks}`.

- `offers`: actual Offer IDs, seller SKU, fulfilment method and observed timestamps; an absent row is not an invented FBM/FBA offer. Offer-scoped verbs are exposed only if M2 supports them.
- `fbaInventory`: condition/fulfilment-centre detail and its timestamps, with provenance and pooled-market information when known. An unavailable snapshot never becomes zero units.
- `suppressions`: active stored suppression rows with their observation times; no rows means only that this stored check found none.
- `sharedQuantityIntent`: an array of **named coordinates**, with each stored intent/close source; never a market count standing in for membership.
- `checks`: source status, scope/granularity, provenance and unavailable sentence for each leg. The gate reflects the API's actual flags. This endpoint performs no channel mutation.

Exact posture shape (the arrays never imply that their backing source was readable without its `checks` entry):

```ts
interface AmazonPosture {
  coordinate: ListingCoordinate
  readAt: string
  offers: Array<{
    id: string; sellerSku: string; fulfillmentMethod: string
    isActive: boolean; quantity: number | null; lastSyncedAt: string | null
  }>
  fbaInventory: Array<{
    id: string; productId: string | null; sellerSku: string; asin: string | null
    marketplaceId: string; fulfillmentCenterId: string; condition: string
    quantity: number; lastSyncedAt: string
    matchedBy: 'productId' | 'sku' | 'asin'
  }>
  suppressions: Array<{
    id: string; listingId: string; suppressedAt: string; resolvedAt: string | null
    reasonCode: string | null; reasonText: string; severity: string; source: string
  }>
  gate: PresenceRow['gate']
  sharedQuantityIntent: Array<NamedCoordinate & {
    intent: IntentRead; offerClosedAt: string | null; offerActive: boolean | null
  }>
  checks: {
    offers: ImpactCheck
    fbaPosture: ImpactCheck
    suppressions: ImpactCheck
    sharedQuantityIntent: ImpactCheck
  }
}
```

`checks.fbaPosture.rows` carries `{isFba:boolean|null, via:string[], pooled:boolean|null, pooledAcross:NamedCoordinate[], units:number|null}`. If pooled, `units` is the shared pool, never repeated as per-market stock. `Offer.lastSyncedAt` is labelled last sync, not a new observed timestamp. Offer-scoped observation columns belong to a later adapter wave.

## POST …/presence/verify

```ts
interface VerifyRequest { coordinates: ListingCoordinate[]; reason: string }
interface VerifyResult {
  coordinate: ListingCoordinate
  outcome: 'selling' | 'not-selling' | 'absent' | 'could-not-ask'
  fact: FactRead
  persisted: boolean
  refusal: string | null
  errorCode: string | null
}
interface VerifyResponse { readAt: string; results: VerifyResult[] }
```

This is an operator-triggered **channel read**, extending the ChannelTruthPanel/live-channel-images read path. It reuses `getListingsItem`, `getItemListingStatus` and the existing Shopify product reader. It is not a publishing permission or channel write. Suppression is a `SUPPRESSED` fact under the `not-selling` outcome. An unpublished Inventory offer is not selling merely because an offer object exists. Ambiguous eBay “invalid/inaccessible item,” HTTP/auth/transport failures and missing answers are `could-not-ask`, never `absent` or success.

The only persisted listing fields are `channelFact`, `channelFactAt`, `channelFactVia`, `channelFactDetail`. No intent, version, publication flag, offer flag or sync timestamp is changed by verify. Rate/gate refusals before an attempt have `persisted:false` and preserve the stored observation. An explicit channel authentication, scope or access refusal can persist `REFUSED` with its source, time and reason. A timeout, rate limit, network failure or missing local configuration is not evidence of channel refusal or absence: it returns `could-not-ask`, preserves the previous observation and its as-of, and has `persisted:false`. The current attempt's refusal remains separate from the previous fact returned with it.

Initial limits: at most **10 distinct coordinates per call** and **60 channel attempts per workspace per rolling hour**, shared by manual verification and the local writers' verify enqueue hook. Duplicate coordinates or an oversized call return 400 before work. Exhausted capacity returns 429 with a retry time; no hidden channel call occurs. Amazon attempts execute serially. A limiter or enqueue failure is visible, never an inferred channel answer. These are operational limits, not counts of products.

The rolling ceiling uses the existing workspace-scoped `RateLimitLog` as operational bookkeeping, with a transaction lock around reservation of the attempt budget. These counters survive process restarts and are shared by API replicas; no in-memory-only ceiling or new table is introduced. They do not change any product/listing lifecycle field. Amazon read attempts serialize through a database advisory lock for the verified account. Enqueued verification uses a dedicated read job and the existing verified workspace-job envelope, never a fabricated `OutboundSyncQueue.syncType`.

An unsupported/read-only adapter or a mode that cannot answer the live question refuses with `could-not-ask` and the gate sentence. An unattributed account cannot borrow primary-account credentials. A missing external ID alone does not prove absence. Results are per coordinate with no aggregate `success` boolean.

`verbs.verify.reach` is `'channel'`: it names where the observation comes from, not permission to write. Verify is a channel read guarded by `products.view`, with `reversal:null`. Consumers use the server's `available`/`refusal`; they must not disable it merely because Wave 4 channel writes are unavailable.

After every Wave 3 local mutation the service invokes the same verify enqueue hook. The mutation receipt states whether the read was queued and names any enqueue refusal. A queued read is not a verified channel fact. The required rehearsal uses GALE's live eBay·IT coordinate against the **local** database only, with the four fact columns read back after eight seconds.

## POST /api/products/operational-impact

Explicit `products.view` guard and manifest entry before `/api/products`; the POST is read-only. Body `{verb, targets}` has a 200-target cap shared with the legacy GET. Each target either names only `productId` for a product-scoped verb, or contains the complete `ListingCoordinate`. A partial coordinate is 400, not a product-level expansion. Optional `offerScope` is accepted only when M2 supports it.

```ts
interface ImpactCheck {
  status: 'ok' | 'unavailable'
  scope: 'product' | 'coordinate'
  dimensions: string[]
  asOf: string | null
  provenance: string[]
  blocking: boolean
  refusal: string | null
  rows: Array<Record<string, unknown>>
}
interface OperationalImpactResponse {
  readAt: string
  targets: Array<{
    target: { productId: string } | ListingCoordinate
    checks: {
      channelListings: ImpactCheck
      openOrders: ImpactCheck
      activeBundles: ImpactCheck
      fbaPosture: ImpactCheck
      stockHolds: ImpactCheck
      advertising: ImpactCheck
    }
  }>
}
```

Extract the existing five queries (ChannelListing, OrderItem, Bundle, BundleComponent, FbaInventoryDetail) once. Query each check by the indexed product set and partition in memory; only ChannelListing may use a composite coordinate predicate. Order evidence cannot claim an alias dimension it lacks, and null market evidence is included and marked unknown. No 200-way coordinate OR is built against the other tables.

Stock holds and advertising are **advisory in this programme**: `blocking:false` even when rows exist or a read fails. Failure is `status:'unavailable'` inside that check; it never refuses the verb or fails an otherwise readable legacy preflight. Advertising spend is cumulative recorded spend with an as-of, never a daily budget. FBA posture names its sources and cannot turn an unpopulated detail table into “no exposure.”

`GET /api/products/hard-delete-preflight?ids=…` keeps the legacy `channelListings`, `openOrders`, `activeBundles`, `fbaInventory` arrays and existing error behaviour for its five original queries. Its listing predicate remains unchanged until D6's paired Wave 4 widening. Additive `confirmPhrase:string|null` and `refusal:string|null` use the real, case-sensitive SKU for one product; plural typed confirmation is refused with per-product action offered. New advisory failures never give that GET a new all-or-nothing 500 arm.

## Additive studio and queue projection

The studio's listing projection gains `offerClosedAt`, `offerClosedBy`, `offerCloseReason`, `syncPaused`, `channelFactDetail` and `offerActiveHonoured`, with Product `deletedAt` and marketplace participation carried independently. New columns enter `LISTING_SELECT` only after the applied-schema gate. Existing nullable fields preserve null. Shopify/eBay/Woo local offer toggles do not imply that their adapters honour `offerActive`.

The sync-queue read gains a `sources` block explicitly naming `OutboundSyncQueue` as queried and `ListingIssue`, `AmazonSuppression`, and `ChannelListing.validationStatus` as not queried by that console. Each source has `queried:boolean`, `status:'ok'|'unavailable'|'not-queried'`, and a sentence. A quiet queue does not claim those sources are empty.

```ts
interface SyncQueueSource {
  source: 'OutboundSyncQueue' | 'ListingIssue' | 'AmazonSuppression' | 'ChannelListing.validationStatus'
  queried: boolean
  status: 'ok' | 'unavailable' | 'not-queried'
  sentence: string
}
// Add to existing SyncQueuePage without altering its scope/count/row fields:
// sources: SyncQueueSource[]
```

The existing `StudioRow`/`SheetListing` gets only the explicitly named additive listing fields, not an embedded full `PresenceRow`. The presence loader owns the full coordinate read and its `readAt`/refresh state; join by all five dimensions when needed. This avoids multiplying full histories/fan-out into every sheet cell. Connection revocation and expiry are carried by the connection fields above; marketplace suspension remains `participation.participationStatus`, never an invented boolean connection failure.

## Wave 3 local writer contract

After all Wave 2 gates, `POST /api/products/:id/studio/presence/local` accepts `{coordinate, verb, expectedVersion, reason?, presenceEffectiveFrom?, presenceUntil?}`. The local verbs are hold/resume, exclude-child/include-child, discontinue/undiscontinue. Every request validates all five dimensions. `expectedVersion` is the observed `ChannelListing.version` returned by the coordinate read; it is never substituted with `Product.version` or a sheet row token. A missing listing cannot invent version zero. HTTP 409 returns `current` for review.

The receipt is `{coordinate, current, eventId, verification:{status:'queued'|'could-not-enqueue', refusal:string|null}}`. The transaction writes a real actor, a `ProductEvent` with `aggregateType:'ChannelListing'`, aggregate ID and full coordinate in `data`. Hold changes `syncPaused`; exclusion uses the raw-SQL variation helper in both directions; discontinuation changes intent metadata and blocks recreation. Re-inclusion must remove the exclusion's send block without overriding an independent hold or terminal intent. No statement merges two presence axes. Stored scheduling dates execute nothing.

The alias availability/action IDs are exactly `archive-alias` and `restore-alias`; neither is named `archive` or `restore` without its subject.

`PATCH /api/products/:id/aliases/:aliasId` adds `status:'ACTIVE'|'ARCHIVED'`, full coordinate and `expectedVersion` for the product aggregate (the alias has no version column). The existing label/position contract remains compatible. Archive/restore is refused while the alias holds identity with non-terminal intent, and remains inert while PES.5-ii's legacy indexes remain. Its response/refusal says: “Listing aliases are unavailable until the listing setup is updated. Contact your administrator, then try again.” `restoreAlias` is a real inverse beside `archiveAlias`; neither fabricates channel restoration.

Recreation uses one `assertRecreateAllowed(coordinate, {override?:boolean})` helper over `ListingIdentity`; a released identity or `doNotRecreate` refuses without an explicit override. This is independent of the enqueue/push lock. No local verb invokes an outbound channel transport; tests install the fetch stub before import and assert zero calls.
