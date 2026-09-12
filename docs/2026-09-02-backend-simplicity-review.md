# Product Edit Studio — BACKEND SIMPLICITY REVIEW (BE.1)

**Lane:** BE.1 · principal backend engineer review · `nexus-commerce-89`
**Date:** 2026-09-02 · **Status:** pass 1 delivered, review-only
**Mandate:** hub ruling #218 — the server-side twin of FE.1. Over-engineering and **lies**, across
`product-studio.routes.ts`, the studio/bulk/channel-CAS paths of `products.routes.ts`,
`services/pim/**`, the channel-ops + sync-queue services, and the publish/dry-run paths.
**Constraint honoured: NO database writes from this lane.** Everything below is a read, an HTTP
`GET`, or a structural reading of the source. Where a finding needs a write to prove, the exact
rehearsal is written out for PES.5 (`nexus-commerce-1f`) rather than run here.

**Measurement environment.** Local API `127.0.0.1:8091` (rides the production database), GALE-JACKET
parent `cmokmy3a40078pm0p1fvnu523` — id verified against `GET /api/products/:id` (200,
`sku: GALE-JACKET`, `productType: OUTERWEAR`, `isParent: true`), not taken from prose. 21-row family,
market IT. Every number below was produced on 2026-09-02 against the build running at that moment.

> **Instrument correction, on the record.** My first health probe reported the API **down** (`000`).
> That was my own `curl --max-time 5`: the first request after idle takes **5.17 s**, then 1.58 s and
> 1.29 s warm. `lsof` confirms node listening on `*:8091`. FE.1's contradicting 200 was right and
> mine was wrong. **Any probe with a ≤5 s budget reports this API as down when it is up** — a
> cold-start artefact that presents exactly as a hang. I re-ran before attributing.

**Claim kinds are labelled throughout:** ⟦measured⟧ (something ran and I read the result),
⟦set-scanned⟧ (a grep/script across the whole set, with its count), ⟦structural⟧ (read from source;
no execution — the weakest, and named as such wherever I could not execute).

---

## §1 ROUTE MAP — what the studio calls, and what guards it

### 1.1 The routes `product-studio.routes.ts` declares (11)

Mounted `app.register(productStudioRoutes, { prefix: '/api' })` (`index.ts:751`).

| Route | Guard ⟦measured⟧ | Service | Tables | Client caller ⟦set-scanned⟧ |
|---|---|---|---|---|
| `GET /products/:id/studio/columns` | products.view | `getStudioSheet` | Product, Marketplace, CategorySchema, ChannelSchema, ChannelListing | **NONE — see §2.5** |
| `GET /products/:id/studio/sheet` | products.view | `getStudioSheet` | as above + attributes | `useMasterSheet.ts:213`, `useChannelSheet.ts:67`, `drawer/useCompare.ts:49` |
| `GET /products/:id/readiness` | products.view | `getProductReadiness` | as above + FieldMappingRule | `contracts.tsx:330` |
| `GET /products/:id/studio/history` | products.view | `getCellHistory` | AuditLog / override audit | `drawer/useFieldHistory.ts:61` |
| `GET /products/:id/sync-queue` | products.view | `getProductSyncQueue` | OutboundSyncQueue, ChannelListing, Product | `channel-ops/ErrorsSyncConsole.tsx:103` |
| `GET /products/:id/listings/:listingId/snapshots` | products.view | `listSnapshots` | ListingSnapshot | drawer (Listings pane) |
| `POST …/snapshots` | products.edit | `captureSnapshot` | ListingSnapshot | drawer |
| `POST …/snapshots/:snapshotId/restore` | products.edit | `restoreToDraft` | ListingSnapshot, ChannelListing | drawer |
| `POST /products/:id/aliases` | products.edit | `createAlias` | ProductListingAlias | channel scope |
| `PATCH /products/:id/aliases/:aliasId` | products.edit | `updateAlias` | ProductListingAlias | channel scope |
| `DELETE /products/:id/aliases/:aliasId` | products.edit | `archiveAlias` | ProductListingAlias | channel scope |

### 1.2 The file's RBAC claim is TRUE — verified, not assumed ⟦measured, set-scanned 11/11⟧

`product-studio.routes.ts:5-9` claims every route inherits `RW(productsView, productsEdit,
pfx('/api/products'))`, GET → `products.view`, writes → `products.edit`. That is a comment asserting
a protection, so I ran `permissionForRoute()` over all eleven mounted patterns rather than reading
the manifest:

```
GET    /api/products/:id/studio/columns                      -> products.view
GET    /api/products/:id/studio/sheet                        -> products.view
GET    /api/products/:id/readiness                           -> products.view
GET    /api/products/:id/studio/history                      -> products.view
GET    /api/products/:id/sync-queue                          -> products.view
GET    /api/products/:id/listings/:listingId/snapshots        -> products.view
POST   /api/products/:id/listings/:listingId/snapshots        -> products.edit
POST   …/snapshots/:snapshotId/restore                        -> products.edit
POST   /api/products/:id/aliases                              -> products.edit
PATCH  /api/products/:id/aliases/:aliasId                     -> products.edit
DELETE /api/products/:id/aliases/:aliasId                     -> products.edit

mismatches: 0 of 11
```

**The comment is accurate.** Worth stating positively: this is the one class where I expected to find
a hole (`reference_family_verbs_split_permissions`, and #10's `/api/products-ai` shadowing) and did
not. Note the ordering hazard it *sits* on, though, without being bitten by it:
`permissions-manifest.ts:381` `P(F.productsImagesEdit, has('/images'))` and `:382`
`P(F.productsPriceEdit, … has('/price'))` both precede `:412`'s products rule, so any future studio
route whose path contains `/images` or `/price` silently changes permission class. None does today.

### 1.3 The write path

Cell autosave does **not** go through `product-studio.routes.ts` — deliberately, and the file says so
(`:15-17`). It goes to `PATCH /api/products/bulk` (`products.routes.ts:1098`), the single write path
shared by the sheet, the studio and bulk-ops. That is the right call and it is where §2.2 and §2.3 live.

---

## §2 RANKED FINDINGS — by harm

### ✅ BE-1 — FIXED by PES.5 at ~01:20; acceptance test PASSED. (Finding retained below as written.)

> **Status, measured 01:4x** ⟦measured⟧ **— the acceptance test in ruling #233 passes on both halves.**
> Re-running the four-hash probe against the current build:
>
> ```
> (no channel)  Master            102 cols  sha=9310b84a3442a9c2  capFrom={Amazon·IT: 36}
> AMAZON        Amazon · IT        97 cols  sha=49bb157985d0703b  capFrom={Amazon·IT: 36}
> EBAY          eBay · IT          35 cols  sha=cd9c75ae1612650f  capFrom={}
> SHOPIFY       Shopify · GLOBAL   30 cols  sha=03efb05e1a3a0088  capFrom={}
> ```
>
> **Four distinct hashes, and the eBay scope carries zero Amazon caps.** PES.5's fix is better than the one
> I proposed: rather than changing `channels` (whose force-include semantics MS.1/MS.2 depend on) they added
> a separate `only?: string[]` that narrows *before* and *independently of* `present`, so it still applies
> where `includeEmptyChannels` leaves `present` undefined — consequence (b) below, closed at the root.
>
> **I checked for over-correction and there is none:** eBay retains its own requirement
> (`brand`, `requiredBy: ['eBay · IT']`) and shows no caps because eBay's `ChannelSchema` rows declare none;
> Amazon retains its 7 required and 36 caps. An empty `capFrom` on the eBay scope is the honest answer, not a
> lost one.
>
> 🔴 **This is also why §4's 62.8 s cold figure must not be re-tested naively.** That reading was taken at
> **01:10:49**, and these files were written at **01:13:49 / 01:20:03 / 01:33:31** — so it measured the OLD,
> un-narrowed build, in which readiness ran five *full* column builds. Any cold reading taken now measures
> different code. Per #196, the two are not the same measurement and neither confirms nor refutes the other.

### 🔴 BE-1 (as filed) — `channels` is an inclusion override, not a filter; two callers use it as a filter and their comments claim the correctness it does not deliver

**Class:** a comment claiming a protection the code does not implement · **File:**
`services/pim/sheet-columns.service.ts:349-388` (`coordinatesFor`), consumed at
`services/pim/studio-sheet.service.ts:610-616` and `services/pim/scope-readiness.service.ts:236-239`
· **Lane:** PES.5

**The mechanism** ⟦structural⟧ — `coordinatesFor`, lines 375-376:

```ts
const forced = (options.channels ?? []).map((c) => c.toUpperCase()).includes(ch)
if (options.present && !forced && !options.present.has(`${ch}:${mp}`)) continue
```

`options.channels` appears exactly once, and only to **bypass** the `present` filter. It never
excludes anything. Its own doc string is correct and says so: *"Force these channels in whatever
their presence (a channel being launched)"* (`:357-358`). The parameter reads as a filter and behaves
as an inclusion override.

**Two callers read it as a filter, and both wrote down the correctness they believed they were buying:**

- `studio-sheet.service.ts:610-612` — *"Narrowing to ONE channel matters: `maxLength`/`maxBytes` are
  the TIGHTEST cap across the coordinates in the set, so **asking for every channel would show eBay's
  scope Amazon's tighter title cap and call it eBay's**."*
- `scope-readiness.service.ts:236-238` — *"Per-channel build so the caps are THAT channel's, not the
  tightest across every channel in the market."*

**The measurement — the thing the first comment says must not happen is what the endpoint returns.**
Four scopes, same market, same family; I hashed the returned `columns` array of each ⟦measured⟧:

```
studio/columns?market=IT                    scope=Master             columns=102  sha256=9310b84a3442a9c2
studio/columns?market=IT&channel=AMAZON     scope=Amazon · IT        columns=102  sha256=9310b84a3442a9c2
studio/columns?market=IT&channel=EBAY       scope=eBay · IT          columns=102  sha256=9310b84a3442a9c2
studio/columns?market=IT&channel=SHOPIFY    scope=Shopify · GLOBAL   columns=102  sha256=9310b84a3442a9c2
```

**Byte-identical.** The `scope` envelope differs; the columns do not. And on the eBay scope specifically:

- **36 of 36 capped columns carry `capFrom: "Amazon · IT"`. Zero carry eBay's.** ⟦measured⟧
  Including `item_name maxLength=200`, `bullet_point 700`, `brand 100`.
  I first wrote that `capFrom` naming the source was "the one mercy" — that the counter lies about
  applicability but not provenance. **FE.1 measured the client and that mitigation is thinner than I
  said.** ⟦set-scanned by FE.1: all 13 `capFrom` references in `apps/web/src`⟧ — `capFrom` is rendered in
  exactly two places, `sheet/master/columns.tsx:175` (header tooltip, *"Max 200 characters (Amazon · IT)"*)
  and `drawer/fields/RecordField.tsx:306`. **No site gates behaviour on it.** What actually paints a cell
  red is `columns.tsx:143`, `lengthValidation(col.maxLength ?? 4000, …)`, which takes `maxLength`
  unconditionally. So the eBay sheet **enforces** Amazon's caps and merely *names* Amazon in a tooltip the
  operator must hover to find. Cause is mine (`coordinatesFor`), surface is `columns.tsx:143`, and the
  tooltip is the only element telling the truth.
- **62 of 102 columns exist only because the Amazon schema defines them.** ⟦measured⟧
- Of the 7 required columns, **6 are `requiredBy: ['Amazon · IT']` alone** and one (`brand`) is both.
  `requiredBy` is per-coordinate and honest, so a client that filters by coordinate label is safe.

**Second consequence, and it is the expensive one** ⟦structural, from the same two lines⟧:
`scope-readiness.service.ts:239` passes `includeEmptyChannels: true`. That sets `present = undefined`,
which short-circuits the `if (options.present && …)` guard entirely — so in the readiness path
`channels` is not merely a weak filter, it has **literally no effect at all**. The five per-channel
builds (`Promise.all`, one per coordinate on market IT) therefore produce five *identical* column
sets — but `channels` **is** part of the cache key in both cache layers
(`studio-columns.ts:35-41` and `sheet-columns.service.ts:435`), so the caches never dedupe them.
**Five identical builds, five cache entries, five times the schema reads, one result.**

**Why the sheet still looks right today.** The channel sheet does not consume `requiredBy` for its
`⚠ required` marker — it builds its own columns and derives chips from server-computed
`issue.severity` (`sheet/channel/viewChips.ts:91-123`). `columnRequiredByAny` (the union form) is used
only by `sheet/master/columns.tsx:137`, and `buildMasterColumns` is imported by `MasterSheet.tsx` and
nothing else ⟦set-scanned⟧ — where the union *is* the honest question, as
`scope-readiness.service.ts:183-188` argues. **I checked this expecting to find a second defect and
did not find one.** The live harm is confined to caps, options and applicability on channel scopes,
plus the 5× cost.

**Honest form.** Make `channels` mean what both callers need, without breaking the launching-channel
case: add a separate `restrictTo?: string[]` that filters, keep `channels` as the force-include, and
fix both call sites. Or — smaller — filter in `coordinatesFor` when `channels` is given AND
`includeEmptyChannels` is set, since "force these in" and "only these" coincide there.
**Risk:** any caller relying on the current widening gets a narrower set; `master-schema.service.ts:145`
(`channels: ['AMAZON']`) is the third call site and must be checked in the same change.

**Rehearsal for PES.5 (no write needed — this one is provable with reads):** after the fix, re-run the
four-hash probe above. Expect four *different* hashes, and `capFrom` on the eBay scope to be `eBay · IT`
or absent, never `Amazon · IT`.

---

### 🔴 BE-2 — the version read-back has a `.catch(() => null)` that silently restores the computed value #201 removed, and mislabels which row it belongs to

**Class:** a value computed where it must be read back / a response that reports intent · **File:**
`routes/products.routes.ts:2460-2464` and `:2604-2605` · **Lane:** PES.5 (write granted by ruling #6)

```ts
const freshChannelVersion =
  expectedVersion !== undefined && channelListingIdsTouched.length > 0 && !hasMasterTargetedChange
    ? (await prisma.channelListing
        .findUnique({ where: { id: channelListingIdsTouched[0] }, select: { version: true } })
        .catch(() => null))?.version          // ← failure becomes `undefined`
    : undefined
…
currentVersion: freshChannelVersion ?? (expectedVersion !== undefined ? expectedVersion + 1 : undefined),
versionOf:     freshChannelVersion !== undefined ? 'channelListing'
             : expectedVersion    !== undefined ? 'product' : undefined,
```

The comment immediately above it (`:2599-2603`) is the protection claim:

> *"PES.5 — for a CHANNEL write, read the version BACK rather than computing `expectedVersion + 1`.
> The computed form was right only while exactly one statement bumped; when two did, the response said
> 16 and the row held 17, and the next write 409'd. **Reading the stored value cannot drift from it
> whatever the statements do.**"*

**It can, on one path.** `.catch(() => null)` collapses a *failed read* into the same `undefined` that
means *"this was a master write, no channel version applies."* On a channel-only write whose read-back
fails — a pool timeout is enough, and this API produces those — the response becomes:

- `currentVersion: expectedVersion + 1` — the computed form the comment condemns, and
- `versionOf: 'product'` — naming the **wrong row**.

`versionOf`'s own field comment (`:2341`) states its purpose: *"Which row `currentVersion` belongs to,
**so a client cannot apply it to the wrong one**."* On this path the field designed to prevent that
mistake is what causes it. The client stores a product version it believes is a product version, sends
it as the next `expectedVersion`, and gets the 409 storm #194/#213 were closed to stop — with nothing
in any log saying the read-back failed.

**Severity, stated honestly:** requires the read-back to fail, so it is not firing today. It is a
latent reintroduction of a defect that has already cost this programme two rulings, sitting behind a
comment that says it cannot happen. That combination is why it is ranked here rather than lower.

**Honest form (≤5 lines).** Distinguish "not applicable" from "could not read":

```ts
const readBack = … ? await prisma.channelListing.findUnique(…).then(r => r?.version ?? null, () => 'ERROR' as const) : undefined
// then: if readBack === 'ERROR' → omit currentVersion and versionOf, and set `versionUnknown: true`
```

A client that receives no version must refetch. **Never substitute a computed value for a failed read.**

**Rehearsal for PES.5 — needs a write, so I did not run it.** On GALE-JACKET, channel scope, one
coordinate: (1) read `ChannelListing.version` → `v`; (2) `PATCH /api/products/bulk` with a channel-target
change and `expectedVersion: v`; (3) assert the response's `currentVersion` **equals a fresh read** of
that row's version, and `versionOf === 'channelListing'`; (4) chain a second and third write with no
refetch, per #213's method — the third is where a computed version diverges; (5) revert both fields and
confirm server-side. Then repeat with the read-back forced to fail (stub `findUnique` to reject) and
assert the response omits `currentVersion` rather than computing one.

---

### 🔴 BE-3 — `updated` counts what was validated, not what was written — **and one path drops a write with no error at all, so the cell paints `saved`**

**Class:** a write's response reports intent, not outcome · **File:** `routes/products.routes.ts:2591`
(`updated: validated.length`), `:1362-1380` (the guard), `:1966-1981` (the fan-out) · **Lane:** PES.5

> **Promoted from 🟠 to 🔴 after FE.1 (`nexus-commerce-e7`) measured the client side and handed the
> question back.** Their finding: `useChannelSheet.ts:281` checks `errors[]` *first* and refuses on it,
> so the inflated `updated` never reaches an operator **as long as every dropped write pushes an error**.
> They asked me to put that question to the server. **The server's answer is that one path does not.**
> This is the shape §BE-1's own trap warns about: I went looking to confirm a mid ranking and the
> check that would have let me stop is the one that broke it.

`validated` is correctly spliced when a change fails *before* the write — `:1731` and `:1790` both do
`validated.splice(idx, 1)` on SKU-conflict and rename refusals, which is careful work. But **four error
sites fire after `validated` is final and none of them decrement it** ⟦set-scanned: `errors.push` inside
the handler's 1098-2620 range, 30 sites, of which these four are post-write⟧:

| line | failure | still counted in `updated` |
|---|---|---|
| 2070 | `basePrice` not a non-negative number | yes |
| 2375 | `masterPriceService.update` threw | yes |
| 2412 | `applyStockMovement` threw | yes |
| 2452 | `masterContentService.update` threw | yes |

So a batch of 5 where the stock movement throws returns `updated: 5` with one entry in `errors`.

#### BE-3b — the drop path: a channel-scoped `attr_*` write with no marketplace context is accepted, reported saved, and written nowhere

There **is** an empty-context guard, and it is correct as far as it reaches (`:1362-1380`): a change with
no `marketplaceContexts` gets `errors.push({… 'marketplaceContexts required for channel fields'})` and is
`continue`d before it ever enters `validated`. **But it is gated on `isCh`, and `isCh` is a closed set**
⟦set-scanned: the literal `CHANNEL_FIELD_MAP` at `:1245-1257`⟧:

```
isChannelField(f)     = hasOwnProperty(CHANNEL_FIELD_MAP, f)   // 6 keys, exhaustively:
                        amazon_title · amazon_description · ebay_title · ebay_description
                        amazon_variationTheme · ebay_variationTheme
                        → keys beginning `attr_`: 0
isCategoryAttrField(f) = f.startsWith('attr_')
```

**The two predicates are disjoint.** So a change with `field: 'attr_<something>'` and `target: 'channel'`
— which is what a channel-scope attribute cell edit *is* — is **not** `isCh`, never meets the guard, and
lands in `validated`. It then reaches the fan-out at `:1968-1980`:

```ts
if (v.target === 'channel') {
  for (const ctx of effectiveContexts) { …build the patch entry… }
  continue                       // ← effectiveContexts empty ⇒ loop never runs, nothing built,
}                                //   nothing pushed to errors[], change stays in `validated`
```

With `effectiveContexts` empty the loop body executes zero times. No patch entry, **no error**, and the
change is still counted by `updated`. Composing that with FE.1's client measurement: `errors` is `[]` so
`useChannelSheet.ts:281` does not fire; `updated >= 1` so `:291`'s `updated === 0` branch does not fire;
**the cell paints `saved` for a write that reached no table.** Displayed ≠ round-trip real, in the write
path — the honest-UI rule, broken at the point it matters most.

The audit trail records it too, and incoherently: `:2529-2532` writes `layer: 'channel'` with
`channel: effectiveContexts[0]?.channel ?? null` — **a channel-layer audit row naming no channel.**

This is the live form of `reference_attr_write_needs_marketplace_context`, and it sits on
`reference_bulk_patch_routes_six_channel_fields`'s six-key set — *"a PARTIAL fix presents identically to
no fix"*, which is exactly what a guard covering 6 of the channel-writable fields does.

**Reachability, stated honestly:** it needs a request carrying a channel-target `attr_*` change with
`marketplaceContexts` absent or empty. The channel sheet appears to always send the context, so this is a
client-contract-dependent hole rather than an everyday one — **but the server accepts it silently, and a
server that trusts its client for a safety property has no safety property.** I did not exercise it: that
needs a write, and this lane makes none. ⟦structural — predicates and control flow read from source; the
disjointness is a set-scan of a literal, the drop is not observed⟧

**Honest form (both halves).** (1) Gate the empty-context guard on *"this change targets a channel"*
(`c.target === 'channel' || isCh`), not on the 6-key map — one condition, and it closes the class rather
than one instance. (2) Make the fan-out refuse rather than no-op: if `effectiveContexts.length === 0`
inside the `target === 'channel'` branch, push an error. (3) `updated: validated.length - errors.length`,
or better a `written` counter incremented at the write sites. **Risk:** consumers reading `updated` as
"changes that passed validation" change meaning — FE.1 has already scanned the client trees, so the
grep exists.

---

### 🟠 BE-4 — an eBay schema read failure is invisible by construction, and *is* cached for five minutes despite a comment promising it is not

**Class:** unknown rendered as a plausible empty + a comment claiming a protection · **File:**
`services/pim/sheet-columns.service.ts:510-521`, with `studio-columns.ts:28-33` · **Lane:** PES.5

Two sibling branches in one function, twenty lines apart, handle failure differently ⟦structural⟧:

```ts
// Amazon (:504) — honest
} catch (err) { console.error(…); schemaMissing.push(...productTypes) }
// eBay   (:518) — silent
} catch (err) { console.error('[sheet-columns] eBay aspects unavailable:', …) }   // ebayAspects stays []
```

`SheetColumnSet` has **no field that can express "eBay aspects unavailable"** ⟦structural — I read the
interface at `:93-110`; `schemaMissing` is documented as *"Product types with NO cached **Amazon** schema"*⟧.
So the failure is undetectable by any client. What it produces:

- every `categoryAttributes` column with no Amazon counterpart is **dropped** (`:277-280`);
- **no column is ever marked required for eBay** (`:288`), so `requiredBy` is empty, `defaultVisible`
  loses its required-first rule (`:316`) and the required-first sort collapses;
- `scope-readiness` then reaches `total === 0` and emits the note
  **"eBay · IT declares no required fields for this product type"** (`:270`) — a factual statement about
  eBay's schema that is false when the truth is "we could not read it". The verdict half stays honest
  (`state: 'absent'`, `pct: null`); the *reason* is wrong, and the reason is the part an operator acts on.

**And it is remembered.** `studio-columns.ts:29-32` states: *"A rejected promise is evicted so a transient
failure is not remembered for five minutes."* True for a **rejection** — but this failure is caught inside
`getSheetColumns`, which then **resolves successfully** and is written to `columnSetCache` at `:525`.
So one transient timeout on the eBay query is cached in *both* layers for the full 5-minute TTL, which is
precisely what the comment promises will not happen. `reference_cached_fallback_outlives_the_blip`, with a
comment saying it doesn't.

**Not currently firing** ⟦measured⟧: `requiredBy` contains `eBay · IT` on `brand` right now, so the aspects
are loading. This is structural, not live.

**Honest form:** add `aspectsUnavailable: string[]` (or fold eBay into `schemaMissing` with a channel tag)
to `SheetColumnSet`; populate it in the eBay catch; have `scope-readiness` prefer *"eBay · IT's field schema
could not be read"* over *"declares no required fields"*; and **do not cache a set built from a failed read**
— on that catch, skip the `columnSetCache.set`.

---

### 🟡 BE-5 — `GET /studio/columns` runs the full sheet read for a caller that does not exist

**Class:** cost with no consumer · **File:** `routes/product-studio.routes.ts:85-110` · **Lane:** PES.5

⟦set-scanned, repo-wide, excluding `node_modules`/`.next`/`dist`⟧ — **zero** non-doc, non-definition
references. The only `.ts` mention is a future-tense comment in `sheet/master/views.ts:23` (*"PES.5 §3.1
**will** serve views … from `/studio/columns`"*) with no fetch. Every real client calls `/studio/sheet`,
`/readiness`, `/studio/history` or `/sync-queue`.

**Confirmed independently by FE.1**, who resolved a full import graph over all 1,341 ts/tsx files under
`apps/web/src` (`@/` and relative specifiers resolved to real files) and separately grepped the path
string: neither finds a fetch or an import, and the only occurrence in the web app is the same
future-tense comment. **Two methods, two lanes, same conclusion — this is measured, not inferred.** They
add the reason it has stayed unnoticed: the master sheet builds its column set client-side from the
`columns` array already embedded in the `studio/sheet` payload, so nothing is waiting on this route, and
whoever wires it later is adding a *second source for a fact the sheet already has*.

The route is not cheap: it calls `getStudioSheet` in full — building all 21 rows, every provenance mark and
the mapping resolution — and then returns only the column half. Measured warm: **0.42–1.43 s**, 52.8 KB.
The comment at `:94-96` justifies routing through the sheet read (*"the columns a caller is given are exactly
the columns the rows are built from"*), and that reasoning is sound; the point is that nobody is asking.

**This is not dead code — it is a published contract** (`docs/pes5-phase0-backend.md` §3.1, addressed to
PES.2 and PES.3) that has never been exercised by a consumer. The risk is adoption: whoever wires it later
inherits a full-family read to paint a column list, and the cost will look like the grid being slow.
**Honest form:** either delete it until a lane needs it, or make it a genuine column-only read that does not
build rows. **Decide before PES.2/PES.3 adopt it**, not after.

---

### 🟡 BE-6 — a publish-path error that names the wrong cause

**Class:** an error path that lies · **File:** `services/pim/publish-validator.ts:83-86` · **Lane:** PES.5

```ts
try   { rules = await getResolvedRules(channel, marketplace, product.productType) }
catch { throw new Error(`Marketplace not found: ${channel}/${marketplace}`) }
```

Every failure of `getResolvedRules` — a pool timeout, malformed rule JSON, an expression that fails to
compile — is reported to the operator as *"Marketplace not found"*. On a **publish** path, that sends
someone to check a marketplace connection that is fine. Same family as
`reference_prisma_invalid_invocation_is_a_prefix`: the whole error carries the cause and it is discarded here.
**Honest form:** rethrow with the original as `cause`, and reserve "Marketplace not found" for the case that
actually is one (a missing `Marketplace` row, which `getResolvedRules` can be asked to signal distinctly).

---

### 🟡 BE-7 — five routes take a `:id` they never enforce

**Class:** a path segment implying a scoping that does not exist · **File:**
`routes/product-studio.routes.ts:220, 231, 256, 284, 302` · **Lane:** PES.5

`GET/POST …/products/:id/listings/:listingId/snapshots`, the restore, and both alias mutations destructure
only `listingId` / `aliasId` / `snapshotId`. The product `id` is used **only in the error-log context** —
`:221` does not even destructure it. So `…/products/<any-product>/aliases/<aliasId>` edits that alias
regardless of which product owns it ⟦structural⟧.

**Honest severity:** today this is **not** a privilege escalation, because RBAC here is per-user and global —
anyone with `products.edit` may edit every product anyway, so the path segment grants nothing extra. It
becomes a real hole the day row-scoping lands (`reference_financial_field_security_exists` records that row
scoping is the open half). **Honest form:** one `where` clause per route asserting the child belongs to `:id`,
404 otherwise. Cheap now, invisible later. **This is the finding most likely to be dismissed as theoretical
and most expensive to retrofit** — it needs a decision, not a fix, so it is in §5.

---

### 🟢 BE-8 — `ChannelSchema.marketplace` is nullable inside a compound unique; the documented meaning is unreachable

**Class:** Prisma upsert trap (latent) · **File:** `packages/database/prisma/schema.prisma`,
`@@unique([channel, marketplace, fieldKey])` with `marketplace String?` · **Lane:** PES.5 / schema

The schema documents `marketplace` as *"null = applies to all marketplaces for this channel"*. Two things
follow ⟦structural⟧: Postgres treats NULLs as distinct in a unique index, so `upsert`'s `ON CONFLICT
(channel, marketplace, fieldKey)` can never match an existing NULL row and every sync would insert a
duplicate (`reference_prisma_upsert_on_conflict`); and the studio's read filters `marketplace: market`
(`sheet-columns.service.ts:513`), so a marketplace-null row would be **invisible to the sheet anyway**.

**It is not firing, and I want to be exact about why** ⟦set-scanned: both writers⟧ — `schema-sync-bridge.ts:47`
types `marketplace: string`, and `ebay-schema-sync.service.ts:22` does too, with a comment at `:15` showing the
author already knew: *"Writes use a non-null marketplace, so the plain (channel, marketplace, fieldKey) unique
targets correctly."* **No writer passes null.** So this is a documented feature that no code can produce and no
reader could see — a schema comment describing a capability that does not exist. Low harm, cheap to close:
either make the column non-nullable, or delete the comment.

---

### 🟢 BE-9 — a partial localisation failure reported as a clean fallback

**Class:** a comment describing a cleaner failure than the code delivers · **File:**
`services/pim/master-schema.service.ts:192-206` · **Lane:** PES.5

The VL.1/VL.2 block wraps a **loop over every Amazon market** in one `catch {}` commented
*"graceful — UI falls back to the wire value"*. If market 3 of 5 throws, markets 1-2 keep their localized
labels and 3-5 silently do not — a *partial* result presented as a uniform fallback, with nothing saying which
markets are missing. Same shape at `:168` (`catch { /* coordinate may have no Marketplace row — skip */ }`),
which also swallows a genuine outage as "no such coordinate". **Honest form:** catch inside the loop, collect
the markets that failed, return them.

---

### 🟠 BE-10 — an absent `maxLength` means UNCAPPED, and the client invents two different caps for it

**Class:** wire-boundary invention (`reference_wire_parse_boundary_rules`) · **Server fact:** mine ·
**Surface:** `_studio/sheet/master/columns.tsx:143` and `:272` — **FE.1's to file against PES.2**

FE.1 found the same absent value given two different invented defaults three lines apart in one file —
`col.maxLength ?? 4000` at `:143` (the one that validates) and `col.maxLength ?? 2000` at `:272` — and
asked me whether the server can legitimately omit `maxLength`, or whether absent always means uncapped.
**Answer: absent means uncapped, unambiguously.** ⟦structural + measured⟧

`sheet-columns.service.ts:283-284` starts each column's cap as `{}` and only ever widens it through
`tightest()`, whose first line is `if (candidate == null || !Number.isFinite(candidate) || candidate <= 0)
return current` (`:229`). So `maxLength` is populated **only** when some coordinate declared a positive,
finite cap. There is no path that drops a known cap on the floor. **Absent = no channel declares one.**

Measured on the live payload: **36 of 102 columns carry a `maxLength`; 66 do not.** So on the master sheet
**66 columns are validated against an invented 4000-character limit** that no channel asked for, and the
drawer shows a different invented number for the same field. The honest form for an uncapped column is
**no counter and no length validation**, not a large one — a counter with an invented cap is the same
class as `schemaMissing`'s own doc warning, *"a counter with no cap must not look like a cap of none."*

---

### 🔴 BE-11 — the publish gate was unified for Amazon and not for its two siblings; eBay and Shopify batch submits are live-by-default

**Class:** a flag whose default is unsafe / a ratified rule applied to one of three call sites ·
**Files:** `services/channel-batch/ebay-parallel-batch.service.ts:67`,
`services/channel-batch/shopify-bulk-mutation.service.ts:63`, against
`services/channel-batch/amazon-batch-feed.service.ts:217` · **Lane:** PES.7 / channel-batch

Three sibling services each define a **private function with the same name and three different
meanings** ⟦set-scanned: all 3 definitions of `isDryRunEnv` in the repo⟧:

```ts
// amazon-batch-feed.service.ts:217        DEFAULT-SAFE
return getAmazonPublishMode() !== 'live'
// ebay-parallel-batch.service.ts:67       DEFAULT-UNSAFE
return process.env.NEXUS_EBAY_BATCH_DRYRUN === '1'
// shopify-bulk-mutation.service.ts:63     DEFAULT-UNSAFE
return process.env.NEXUS_SHOPIFY_BULK_DRYRUN === '1'
```

The Amazon one carries the reason it was changed: *"PD.2 — unified onto the single publish gate. The
legacy NEXUS_AMAZON_BATCH_DRYRUN let batch feeds (image-feeds, bulk-ops) submit LIVE while the gated
paths didn't — **a dangerous split**. Only 'live' submits now."* **That unification did not reach the
other two, and the file that describes the danger is the one that no longer has it.**

Four things compound it:

1. **`getEbayPublishMode()` exists** (`services/ebay-publish-gate.service.ts:40`) and this path does not
   call it — so the layout doc's ratified rule (*publish mode from `getAmazonPublishMode()`/
   `getEbayPublishMode()`, **never re-derived from env***) is violated where a gate is available.
2. **Neither env var is set anywhere in the repo** ⟦set-scanned across `.ts`/`.json`/`.yaml`/`.yml`/
   `.env*`/`.md`, excluding `node_modules`: the only hits are the two definitions and their own comments⟧.
   An unset var makes `=== '1'` **false**, i.e. *not* a dry run — so as the tree stands both paths submit.
3. **Neither accepts a caller `dryRun`.** In both files `dryRun` appears only as an output field. So the
   "rehearse this publish" capability the Amazon path gained on 2026-09-01 **cannot be asked for on eBay or
   Shopify at all** — #176's original shape, unfixed in two of three channels.
4. **No upstream gate covers them.** The caller is `services/bulk-action.service.ts:2423/2451`, and a grep
   of that file for `PublishMode|PublishEnabled|publish-gate|dryRun|DRYRUN` returns **nothing** ⟦set-scanned⟧.
   The eBay live path resolves a real connection, calls `EbayAuthService.getValidToken()` and runs
   concurrent HTTP against `https://api.ebay.com` (`:240-247`).

**Severity.** eBay especially: `reference_ebay_draft_still_live` records that eBay DRAFT rows are live, so
there is no safe test target on that channel. **Honest form:** `return getEbayPublishMode() !== 'live'` and
the Shopify equivalent; add `input.dryRun` to both with the same one-way OR the Amazon file uses; delete both
env vars. **Risk:** if an environment was relying on the batch path submitting while the gate is closed, this
stops it — which is the point, and is why it is the Owner's call rather than a silent fix. **→ §5.**

---

### 🔴 BE-12 — a parked migration would drop a column the schema still declares and 48 call sites still read

**Class:** migration drag (`reference_migrate_deploy_drags_parked_migrations`) · **File:**
`packages/database/prisma/migrations/20260901e_pes5_aliaskey_not_null/` · **Lane:** PES.5

There are now **six untracked migration folders** ⟦measured: `git status --porcelain`⟧ — ruling #10 covered
two of them and recorded that a sibling's `migrate deploy` had already dragged both onto prod, with the rule
*"'parked' is NOT a safety state on this machine."* Four more have appeared since.

**The name is misleading and I want to clear it first:** `..._aliaskey_not_null` adds the column **with a
DEFAULT** (`ADD COLUMN IF NOT EXISTS "aliasKey" TEXT NOT NULL DEFAULT ''`), which Postgres 11+ does without
a table rewrite. **There is no P3009 risk here** — I went looking for one because of the name and did not
find it.

**The real problem is the last three statements:**

```sql
DROP INDEX IF EXISTS "ChannelListing_productId_channel_marketplace_akey_key";
DROP INDEX IF EXISTS "ChannelListing_productId_channelMarket_akey_key";
ALTER TABLE "ChannelListing" DROP COLUMN IF EXISTS "aliasKey";
```

**`schema.prisma` still declares every one of those.** `ChannelListing.aliasKey String @default("")` at
`:259`, and both `@@unique([... aliasKey], map: "ChannelListing_..._akey_key")` at `:273-274`. So the parked
migration and the schema that generates the Prisma Client are in direct conflict.

**It has not been applied — measured, and my first attempt to measure it was wrong.** I first called
`/sync-queue?limit=5` and read `aliasKey: null` on every row as evidence. That proved nothing: all five rows
had `channelListingId: null`, so `pageListingIds` was empty and the `pageListingIds.length ? … : []` ternary
**short-circuited the query I was trying to exercise** — a quiet measurement mistaken for a negative result.
Re-run at `limit=200`: **155 of 200 rows carry a non-null `channelListingId`**, so
`prisma.channelListing.findMany({ select: { id, productId, aliasId, aliasKey } })`
(`sync-queue.service.ts:205`) genuinely executed and returned `aliasKey: ''` under HTTP 200.
**The column exists in production; migration `e` is parked and unapplied.**

**What applying it does, today:** `ChannelListing.aliasKey` disappears while the generated client still selects
it — **48 `aliasKey` references across `apps/api/src`** ⟦set-scanned⟧, including `sync-queue.service.ts:205`
(the Errors & Sync console the studio ships), `products.routes.ts:2038/2217/2242`(the bulk write path) and
`listing-snapshot.service.ts:81/124`. Those become hard failures on a shipped surface, caused by a migration
nobody chose to run. The two `_akey_key` uniques also vanish while Prisma still targets them by `map:` name.

**Honest form:** land the schema change and the migration together, or move `e` out of the migrations
directory until its schema half is ready. **Given ruling #10, "we won't deploy yet" is not a mitigation.**
**→ §5, because sequencing this is the Owner's call, not a lane's.**

---

### 🟠 BE-13 — a snapshot restore rewrites listing content without advancing `version` or emitting an event, so the next CAS write silently undoes it

**Class:** a writer that changes content without advancing the token that guards it · **File:**
`services/pim/listing-snapshot.service.ts:215-224` · **Lane:** PES.5

`restoreToDraft` is careful in every other respect (see §3 item 11), but the `tx.channelListing.update()`
that lands the restored fields **does not touch `version`** — ⟦set-scanned: the string `version` appears
exactly once in the whole file, in the comment at `:64` explaining why it is excluded from
`SNAPSHOT_FIELDS`⟧. `ChannelListing.version` is `Int @default(1)`, a manual counter with no auto-increment
⟦structural, schema `:220`⟧.

Excluding `version` from the *restored* fields is right — rolling a version backwards would be worse. **But
not incrementing it means a restore is invisible to optimistic concurrency:**

1. Operator A opens the channel scope; the sheet holds `listing.version = 22`.
2. Operator B restores a snapshot. Content changes; `version` stays 22.
3. Operator A edits any cell. The CAS matches 22, the write succeeds, **and B's restore is silently
   overwritten — with no 409 shown to either operator.**

This is §5 Q1's `Product.version` blind spot reproduced on `ChannelListing`, with one difference that makes
it worse: there the un-versioned writers are background jobs, here it is a **deliberate, operator-facing undo
path**. The whole value of a restore is that it is the thing you reach for when something went wrong.

**Also emits nothing** — no `emit`/`outbox`/`productEvent` in the file ⟦set-scanned⟧ — so on the MACH outbox
architecture other replicas and any read cache do not learn the listing changed. I have not traced whether a
Prisma middleware emits on `channelListing.update` generally; if one does, disregard this half.

**Honest form:** `version: { increment: 1 }` in the same `update`, and return the new version in
`RestoreResult` so the client can adopt it (the BE-2 rule: read it back, do not compute it).
**Rehearsal for PES.5** (needs writes — not run here): on XAVIA, read `version` → capture a snapshot → change
a field → restore → assert `version` **advanced**, and that a CAS write carrying the pre-restore version now
**409s** instead of succeeding. Revert and confirm server-side.

---

### 🟢 BE-14 — `exprDependencies` returns an empty dependency list on a parse failure, and half its doc has no caller

**Class:** unknown rendered as an empty / a doc describing a use that does not exist · **File:**
`services/pim/mapping/expr.ts:716-726` · **Lane:** PES.6

`expr.ts` came through this review **well** (§3 item 12) — five of its six catch sites return the cause and
the character position rather than swallowing. The sixth is `exprDependencies`, whose `catch { return
{ attributes: [], rules: [] } }` makes "this formula does not parse" indistinguishable from "this formula
depends on nothing".

Two callers ⟦set-scanned, repo-wide: 2 non-test call sites⟧ and they disagree:
`channel-mapping.routes.ts:134` guards it — `dependencies: bad ? { attributes: [], rules: [] } : exprDependencies(expr)`
— so an invalid expression is *known* to be empty; `:393` calls it unguarded, and cannot tell the two apart.

Its doc also claims it *"lets the batch resolver prefetch"*. **No batch resolver calls it** — `exprDependencies`
appears nowhere in `mapping/resolve-batch.service.ts` ⟦set-scanned⟧. That half describes a use that does not
exist (`reference_docs_describe_deleted_code`). Low harm; the fix is a sentence and an optional
`{ ok: false }` discriminator.

---

### 🟠 BE-15 — `availableChannels` is built from the list that was already narrowed, so it is **structurally always empty** when the error fires

**Class:** an error path that lies · **File:** `services/pim/studio-sheet.service.ts:639` ·
**Lane:** PES.5 · **Found while upgrading a §3 claim from READ to WATCHED**

⚠️ **CORRECTION, inline, because I filed this with the wrong cause and the hub routed it on that basis.**
I first wrote that the message *"conflates listing PRESENCE with marketplace CONFIGURATION"* because the sheet
path filters on `present`. **That diagnosis is wrong** — the channel path passes
`includeEmptyChannels: true` (`studio-sheet.service.ts:630`), so `present` is `undefined` and plays no part
here. I checked PL's marketplace rows rather than assuming: `{channel: AMAZON, code: PL, isActive: true}`,
and all 19 rows in the table are active ⟦measured⟧ — so "Active here: none" could not be a presence artefact.
**The real mechanism is more interesting, and it is a side-effect of the fix to BE-1.**

The symptom, still reproducing on the current build ⟦measured; file mtimes 01:20/01:33 both predate the probe⟧:

```
GET /studio/sheet?market=PL&scope=channel&channel=EBAY
{"error":"scope_not_available","message":"EBAY is not an active channel on PL. Active here: none","availableChannels":[]}
```

**The chain:**
1. `studio-sheet.service.ts:630` passes `onlyChannels: ['EBAY']`.
2. `coordinatesFor:393` — `if (options.only && !options.only.includes(ch)) continue` — narrows the coordinate
   list to **EBAY only**. PL has no eBay row, so `coordinates` is `[]`.
3. `:638` finds no coordinate and throws.
4. `:639` builds the error's third argument as
   `[...new Set(coordinates.map((c) => c.channel))]` — **from the list that was just narrowed to the one
   channel now known to be missing.**

**So `availableChannels` is empty by construction every time this error fires, and "Active here: none" is
never true unless the market genuinely has nothing.** The field exists to tell a caller where they *could*
go; it is derived from a set that excludes every alternative by definition. PL actually has Amazon, and the
correct answer is `["AMAZON"]`.

**This is a consequence of BE-1's fix, and I want that stated without blame:** the `only` narrowing PES.5
added is correct and closed a real defect; it simply also narrowed the input the error message reads from.
A fix that moves a problem one line downstream is exactly what a second reader is for. Note the same file's
own comment at `:623-629` shows the author was already alert to `only` killing the create path — it fixed the
*throw*, and the *message* is the half left behind.

**Honest form** — and my original prescription survives the wrong diagnosis: derive `availableChannels` from
an **un-narrowed** view of the market (the marketplace rows, or a second `coordinatesFor` call without
`only`), never from the narrowed build. Then the create path an operator is on — "I want to list on PL" —
gets told what PL actually offers.

**Related, unverified, flagged not claimed:** three other call sites build columns *without*
`includeEmptyChannels` — `routes/products-sheet.routes.ts:59` (MS.1's catalogue sheet),
`services/pim/sheet-rows.service.ts:347`, and `services/ai/enrichment/generate.service.ts:241`. The AI one is
the one I would look at: if enrichment derives its constraints from a presence-filtered column set, a channel
with no listing yet yields no constraints. **I have not tested that and it is PES.8's surface** — recorded as
a question, not a finding.

---

### 🟡 BE-16 — two studio surfaces disagree about which channels exist (severity corrected DOWN, measured)

**Class:** two surfaces disagreeing about the same fact · **Files:**
`services/ai/enrichment/generate.service.ts:241` (+ `products-sheet.routes.ts:59`,
`sheet-rows.service.ts:347`) · **Lanes:** PES.8 / MS

I filed this as a *question, not a finding*. PES.5 measured it and described DE as "a market with real
listings"; **I declined to absorb that phrase because I had not counted, and attributed it to them rather than
to my own claim.** PES.5 then counted, and it was wrong ⟦PES.5, measured⟧:

```
AMAZON:DE 214   AMAZON:ES 123   AMAZON:FR 115   AMAZON:IT 273   EBAY:IT 252
```

**`EBAY:IT` is the only eBay coordinate carrying listings anywhere on the platform, and PL carries none.**
So `present` excluding eBay · DE is **correct for a presence view — nothing populated is being hidden**, and
the severity the original framing implied does not exist. **Downgraded 🟠 → 🟡.**

**What survives the correction, and it is the better half of the finding.** The defect is not "enrichment sees
fewer columns" — that version needed a populated coordinate to be interesting. It is that **`/readiness`
passes `includeEmptyChannels` and offers `eBay · DE` as a scope chip, while the column build behind that same
scope cannot see it** ⟦measured, two entry points⟧:

```
/studio/columns?market=DE   →  96 cols, requiredBy = [Amazon · DE]        (eBay · DE absent)
/readiness?market=DE        →  scope chip "eBay · DE", state=absent       (eBay · DE present)
```

The scope bar offers a channel the columns behind it do not know about. **That is a defect however many
listings exist**, and it is the one to lead with for PES.8. Enrichment wants the *configuration* view — it
exists to fill in channels you are not yet listed on — so `includeEmptyChannels: true` at
`generate.service.ts:241`. The other two sites are shipped surfaces where presence-filtering may be right;
they need a decision, not a sweep.

**✅ OUTCOME (PES.8, #311) — the fix landed, and my prescription was NOT the cause.** PES.8 applied
`includeEmptyChannels: true` at `:241` **and measured both ways first**. The draftable-column count was
**zero either way, even on `AMAZON:IT`** — the populated coordinate. The real defect was that
`DEFAULT_DRAFT_KEYS` contained **no channel write field at all**: channel-scope enrichment had been
non-functional since it was built, hidden by a test suite that always passed explicit column lists.

**This is the one item tonight I filed as a QUESTION rather than an asserted cause, and that is why it came
out right.** PES.8's words: *"had they asserted the cause I might have fixed the flag, seen the number stay at
zero, and gone looking in the wrong place."* My `includeEmptyChannels` reasoning was sound and would have been
a plausible, confident, **wrong** attribution — the flag genuinely was mis-set, so fixing it would have looked
like progress and produced no change in the number that mattered.

**Recorded against the rest of this document deliberately.** Everything else here that failed, failed by
asserting a cause I had not measured (the market claim, twice; the variance hypotheses; BE-15's first
diagnosis). The one finding I handed over with the cause left open is the one that reached the real defect.
**An asserted cause does not just risk being wrong — it stops the person who can measure from measuring.**

**And a consequence worth its own line ⟦PES.5's, and it is the sharpest thing in this section⟧:** the same
presence filter is why master shows **147 columns on IT and 142 everywhere else**. IT is not special — it is
simply where the eBay listings are. So the extra cap **appears the moment anyone creates a first eBay · DE
listing**: a constraint that tightens under an operator who did nothing, on a record they were already
editing. A presence-derived schema is a schema that changes when someone else sells something.

---

### ❌ BE-17 — WITHDRAWN. I reported a NULL-handling bug in a NOT NULL column, and my fix would have caused the regression

**Class:** my own error, kept in full because it is the most instructive one in this document ·
**File:** `services/product-analytics.service.ts:181` · **Status: WITHDRAWN, file correctly untouched**

I reported that `marketplace: marketplace || undefined` silently widens the buy-box lookup to "any marketplace
for this channel" for listings whose `marketplace` is `null`, and prescribed
`marketplace === '' ? null : marketplace`. **PES.5 measured before touching it. Both halves were wrong:**

⟦PES.5, measured on prod⟧ `ChannelListing.marketplace` and `BuyBoxHistory.marketplace` are **both NOT NULL**
— 977 rows, **0 nulls, 0 empties**, and no GLOBAL-coded listings exist at all. ⟦Verified independently by me
against the schema rather than relayed⟧ `ChannelListing.marketplace String @default("DEFAULT")` and
`BuyBoxHistory.marketplace String`. **So the `|| undefined` branch is dead code, and my prescribed fix would
have matched zero rows against a NOT NULL column — introducing the very defect I claimed to be removing.**

**How I got there, because the mechanism is worth more than the retraction.** Three signals agreed with each
other and all three were wrong; the only thing outside the agreement was the schema:

1. **The service's own TypeScript declares `marketplace: string | null`** on both emitted shapes (`:53-54`) —
   a hand-written local type that **relaxed** a NOT NULL column to nullable.
2. **The code is defensive against a null that cannot occur** — `l.marketplace ?? ''` at `:177`, then
   `|| undefined` at `:181`. Defensive code reads as evidence that the case is real.
3. **A banked trap made the shape feel confirmed.** I cited `reference_prisma_not_excludes_null`, and
   pattern-matching to a known trap substituted for checking the declaration. **A rich memory index can make
   a wrong reading feel *verified* rather than merely plausible** — that is a hazard of the memory system
   itself, and the defence is that a remembered pattern tells you what to check, never what is true.

**And the rule that would have caught it is one I banked a message later:** *an instruction that names an
identifier is a claim about the code — grep the declaration.* My finding named `marketplace` and asserted its
nullability without ever reading the column. `awk` on the schema was one command and I did not run it until
PES.5 had already measured.

**⚠️ The severity that matters: this is the only item in this document whose prescription would have caused
harm.** Every other error here was a wrong cause or an overstated claim; this one was a wrong *fix*, and it
was routed. It was stopped because the owning lane measured before editing — the same discipline that caught
`aliasKey`, one boundary further along.

**A real observation surfaced by PES.5's check, and it is theirs not mine:** `BuyBoxHistory` has **0 rows**, so
every buy-box price on prod today is `null`. The analytics tab's buy-box comparison currently has nothing to
compare against. Recorded as an observation for the Owner queue, unverified by me.

---

## §3 WHAT IS WELL-BUILT — do not "simplify" these

> **🔴 EVERY ITEM IS LABELLED ⟦WATCHED⟧ OR ⟦READ⟧ (programme line, ruling #288).** The distinction exists
> because item 11 below was praised on a reading and PES.5's rehearsal then found it had been **dead at
> runtime for all of wave-1**. A "well-built" entry earned by reading the code is a *design opinion*; one
> earned by watching it run is *evidence*. They are not the same claim and this section used to conflate them.
>
> **Tally after the re-audit: 4 ⟦WATCHED⟧, 2 ⟦PARTLY WATCHED⟧, 7 ⟦READ⟧.** Before the re-audit I would have
> presented all thirteen as equivalent. I upgraded six claims from READ to WATCHED with read-only `GET`s while
> doing this pass — every one of them was a probe I could have run at any point and had not.

1. ⟦PARTLY WATCHED⟧ **`product-studio.routes.ts`'s single `sendError` mapper** (`:47-62`). **Four of its
   branches fired under read-only probes:** `?market=ZZ` → `unknown_market` naming all 11 markets in both the
   message *and* a structured `knownMarkets` array; `channel=EBAY&market=PL` → `scope_not_available` with
   `availableChannels`; `scope=bogus` and `scope=channel` with no channel → both 400 with hints; and
   `sync-queue?filter=bogus` → `filter must be all | dead | retrying | stuck`. **NOT watched: the two 409
   branches** (snapshot coordinate mismatch, alias-creation blocked), which need writes. Their reasoning and specifically its two
   deliberate 409s with the reasoning written down: a snapshot coordinate mismatch is *"the request is
   well-formed, the WORLD moved"*, and `AliasCreationBlockedError` is 409-not-500 because *"a 500 would
   read as a defect rather than a sequencing state."* That is a correct distinction most codebases never make.
2. ⟦WATCHED⟧ **`missingMarket()`** (`:72-81`) — **fired, both branches.** `?marketplace=IT` →
   *"This route takes ?market=, not ?marketplace= — you sent marketplace=IT"* with `hint: "?market=IT"`;
   bare → `{error:"market is required", hint:"e.g. ?market=IT"}`. It names the mistake and hands back the
   corrected query string. A caller who sends `?marketplace=` is told exactly that, with the
   corrected query string, instead of *"market is required"* reading as *"you sent nothing"*. It cost PES.3
   real debugging time once and the fix is the cheapest possible one.
3. ⟦WATCHED⟧ **`sync-queue.service.ts`'s filter definitions** (`:168-179`) — and they survive measurement.
   `STUCK` uses `syncedAt: null` (the file records that a naive `createdAt` age filter matches 36,844 rows and
   this one matches 0) and excludes rows inside their `holdUntil` grace window with an explicit
   `OR: [{ holdUntil: null }, …]` — the nullable-comparison trap, handled. I tested whether `dead` and `stuck`
   double-count: the death transition (`outbound-sync.service.ts:2172-2181`) sets `syncStatus: 'FAILED'`
   alongside `isDead: true`, and `RUNNABLE` is `['PENDING','IN_PROGRESS']`, so a dead row cannot be stuck.
   ⟦measured on GALE-JACKET: `all 441 / dead 405 / retrying 0 / stuck 0`, and across the 50 returned rows the
   `(syncStatus, isDead)` pairs are exactly `(SUCCESS,false)×36` and `(FAILED,true)×14` — a clean partition.⟧
4. ⟦READ⟧ **`studio-sheet.service.ts:712-726`** — a mapping failure does not take the sheet down, and the reason
   travels **in the payload** as `skippedReason` rather than into a log. This is the honest form of exactly
   the thing BE-4 gets wrong twenty files away; it is the model to copy.
5. ⟦WATCHED⟧ **`scope-readiness.service.ts:246-262`** — when a coordinate has zero mapping rules the percentage is
   suppressed (`pct: null`, `state: 'absent'`) with the reason, because *"a percentage — even a true one —
   reads as 'ready' and is not."* Measured: eBay·IT had reported a true, useless 100%. `required` is still
   returned so only the verdict degrades. This is the single best piece of honesty reasoning in the tree.
6. ⟦READ — no writes from this lane⟧ **`validated.splice()` on pre-write refusals** (`products.routes.ts:1731`, `:1790`) — someone thought
   about the count. BE-3 is the four sites that came later, not a design failure.
7. ⟦PARTLY WATCHED⟧ **`studio-columns.ts`'s promise-caching** (`:28-33`) — caching the in-flight promise rather than the
   result, so six concurrent chips share one build. Correct, and the eviction-on-rejection is right as far as
   rejections go (BE-4 is that one failure mode never rejects).
8. ⟦READ⟧ **`ebay-schema-sync.service.ts:15`** — a comment that records *why* the compound unique is safe here.
   That comment is the reason BE-8 is latent rather than live.
9. ⟦READ — verifying it needs a real publish⟧ **🏆 `amazon-batch-feed.service.ts:240-268` is the best code I read in either pass.** `dryRun` is
   *derived from what happened*, never echoed: `dryRun: true` is returned **only** on the short-circuit that
   skips submission, `dryRun: false` **only** after the real `createFeed`. The gate is one-way
   (`isDryRunEnv() || callerRequestedRehearsal`) so a caller can force a rehearsal but never force a
   submission. And the comment forbids the refactor that would re-break it: *"DO NOT 'simplify' this to
   `if (isDryRunEnv())` … With the gate closed the second half looks like dead code, because the first is
   always true — which is exactly how it came to be dropped before."* **This is #176 fixed properly, with the
   trap that produced it written down.** BE-11 is that its two siblings were left behind.
11. ⟦READ — the DESIGN is sound; the CODE was dead at runtime⟧ **`listing-snapshot.service.ts`'s restore.**
   PES.5's BE-13 rehearsal found capture/restore had **never executed** in wave-1 — one field name in a string
   array, which no type could check. **Both halves are true and I originally wrote only the harsher one.**
   PES.5's objection is fair and I have adopted it: the doctrine I praised *is* right — the coordinate guard
   ("writing IT's content onto DE is not a restore, it is a corruption"), the undo snapshot written inside the
   same transaction *before* the update, the explicit allow-list with `version` deliberately excluded, and the
   forced `isPublished: false, listingStatus: 'DRAFT'` so a restore can never reach the marketplace. **A design
   review that read it favourably was not wrong about the design — it simply could not see execution.**
   What is retracted is the *evidence class*, not the verdict: this is a ⟦READ⟧ entry, and ⟦READ⟧ cannot tell
   you whether the code runs. "Reviewed favourably, never run" is the right lesson about **my method** and the
   wrong verdict on **this code**.
12. ⟦READ⟧ **`mapping/expr.ts`'s error handling.** `evaluateExpr` is documented "Never throws" and delivers it:
   a syntax error returns `error` with the character position; a failure inside a named business rule returns
   *"business rule X does not parse — <original message>"* (`:662`), naming both the rule and the cause — the
   opposite of BE-6. `:693` keeps a defence-in-depth catch with the reason it exists: *"a formula must never
   be able to take down a whole preview."*
13. ⟦READ⟧ **`routes/images/amazon-images.routes.ts:130-137`** — the audit records `dryRun: result.dryRun` (the
   server's outcome) alongside `requestedDryRun` (the caller's intent), with the comment explaining why the
   two must not be conflated. `reference_api_accepts_a_flag_it_ignores`, applied correctly. I checked whether
   `result.dryRun` was merely the request echoed back — it is not (item 9) — so the care here is real.

---

## §4 HOT-ROUTE TIMINGS at 21 rows ⟦measured⟧

GALE-JACKET, market IT, `curl`, `%{time_total}`. **Warm** = the 5-minute column cache populated.
**Cold** = a market whose column set was not yet cached (FR/ES), which is what the first operator of every
five-minute window actually pays.

| route | r1 | r2 | r3 | r4 | bytes |
|---|---|---|---|---|---|
| `studio/columns?market=IT` | 1.43 | 0.62 | 1.06 | 0.42 | 52,807 |
| `studio/sheet` master | 0.18 | 0.19 | 0.28 | 0.28 | 250,571 |
| `studio/sheet` channel=EBAY | 0.96 | 1.30 | 0.95 | 0.64 | 269,087 |
| `studio/sheet` channel=AMAZON | **8.28** | **5.12** | 1.81 | 2.12 | 329,157 |
| `readiness?market=IT` | 0.72 | 2.14 | 0.57 | 0.19 | 1,309 |
| `sync-queue` | 0.35 | 0.32 | 0.66 | 1.02 | 39,181 |
| `studio/history?limit=100` | 0.48 | 2.94 | 2.72 | 0.76 | 2,199 |

| COLD route | seconds |
|---|---|
| `readiness?market=FR` | **22.03** |
| `studio/sheet?market=FR&scope=master` | **11.58** |
| `readiness?market=ES` | **11.55** |

> **Provenance, because the stack was restarted mid-review.** Every table above was taken **00:44–01:00**
> against the API process running then. The hub reports a restart at 01:08, servers back 01:09:13; I
> confirmed it independently — the listener on :8091 now reports `started Wed Sep 2 01:08:39`, so the
> process I measured is gone. **None of my readings fall in the void window**, and none were taken after
> it. They describe the pre-restart build, and I am not restating them as current.

**The restart handed me the one measurement I could not take before: a genuinely cold cache on market IT**,
the market every lane uses. Before, IT was warm and I could only reach a cold path via FR/ES. Taken
01:10:49, against the 2-minute-old process ⟦measured⟧:

| post-restart, market IT | seconds |
|---|---|
| `readiness?market=IT` — **first touch** | **62.83** |
| `studio/sheet?market=IT&scope=master` (immediately after) | 1.35 |
| `readiness?market=IT` (second call) | 1.49 |
| `studio/sheet?market=IT&scope=channel&channel=AMAZON` | 5.10 |

**62.8 seconds for the scope-chip row on a cold process** — nearly three times my FR figure, on the family
this programme measures everything on, and it drops to 1.49 s on the very next call. That ratio (42×) is
the cache doing its job and is also the size of the cliff every process restart and every 5-minute TTL
expiry puts in front of the next operator.

**What I will not claim from it:** that 62.8 s *is* BE-1's 5× duplication. The number is a total, and a
cold process pays uncached schema reads it would pay once regardless. The 5× remains arithmetic plus the
byte-identity measurement, to be confirmed from the server log — exactly as ruling #233 records it. What
this reading *does* establish is that the cold cost is much larger than my §4 first reported, and that
fixing BE-1 is the only lever anyone has identified against it.

#### POST-FIX, under a controlled cold start ⟦measured⟧ — the reproducible numbers

Hub cold-started the API and confirmed "listening" from the process log alone (**pid 75149, 01:37:34, no
request sent**); build identity recorded first, all three service files post-fix
(`sheet-columns` 01:20:03 `079aef3c7bd5` · `scope-readiness` 01:13:49 `8e8e7c23a243` ·
`studio-sheet` 01:33:31 `cc6f33d6db89`). I verified the pid with `ps`/`lsof` before issuing call 1.

| # | call | time | http | bytes |
|---|---|---|---|---|
| 1 | `readiness?market=IT` — **COLD, first request to the process** | **12.064 s** | 200 | 1309 |
| 2 | `readiness?market=IT` — warm | **0.256 s** | 200 | 1309 |
| 3 | `/products/search?q=GALE` — different route, third | 0.702 s | 200 | 4865 |

Payload byte-identical between 1 and 2, so the 11.8 s delta is compute/IO, not content.
**The post-fix cold cost of the scope-chip row is 12.06 s, with a 47× cold/warm cliff.**

**Three things these numbers do not settle, stated so they are not over-quoted:**
- **The ordering cannot separate shared warm-up from readiness-specific cost.** `/products/search` ran
  *third*, after call 1 had already paid any shared warm-up, so its 0.702 s is consistent with both
  hypotheses. Isolating it needs `/products/search` as the **first** request on a fresh cold start.
- **12.06 s neither confirms nor refutes the 62.8 s above** — different build. The ratio
  **62.8 / 12.06 = 5.2×** does match BE-1's predicted five un-narrowed builds strikingly well, but the
  post-fix sets are also smaller (eBay 102→35 columns, Shopify 102→30), which cuts cost independently.
  Two causes, one number; these readings cannot split them. **Consistent-with, not proof.**
- **PES.1's 4.4 s cold reading is unexplained** — 2.7× below a run I watched cold-start. Probably a
  partially warm process, a different family or a different market; not resolved here.

**For anyone sizing against these:** use **12.06 s**. It is the only one of the three figures in circulation
taken under a controlled cold start with the build recorded, and the only one reproducible on demand.
**BE-1 lowered the absolute cost; it did not remove the discontinuity** — the cliff is still 47×, so the
"chips render an honest measuring state and fill in" shape is still required.

**The top three costs, named:**

1. **`readiness` cold — 22.0 s on FR, and 62.8 s on IT against a freshly restarted process.** This is
   the first thing on the page.
   `studio-columns.ts`'s own header records that the first cut took 14.9 s and that the cache is the fix —
   but the cache is **process-local with a 5-minute TTL**, so this is not a one-off: every five minutes, the
   next operator to open a product on that market pays it again, and a second API replica pays its own. **BE-1
   makes it worse by a factor of five** (§2, five identical builds under five cache keys). Fixing BE-1 should
   collapse the readiness cold path to roughly one build.
2. **`studio/sheet?channel=AMAZON` — 8.3 s warm on the first of four runs, 329 KB.** Warm-path variance of
   4.5× (8.28 → 1.81) says something upstream is not cached on the first call of a scope; the Amazon scope is
   the most expensive of the three and the one operators use most.
3. **`studio/history` — 0.48 s to 2.94 s for a 2.2 KB response.** 6× variance on the smallest payload in the
   set, which points at the query rather than the transfer. It is also the only studio read with **no
   `Server-Timing` header** (`/studio/sheet` and `/readiness` both set one), so a slow history is felt as
   "the drawer is slow" with nothing to attribute it to. Cheap fix, and it belongs with BE-4's theme: make the
   server say how long it took.

**Caveat I will not paper over:** these are single-client timings against an API that is also serving five
other lanes' sessions on a shared production database. They establish orders of magnitude and the cold/warm
ratio, not a benchmark. The 22 s cold figure reproduced on two separate markets (FR 22.0, ES 11.6), which is
why I am willing to state it.

---

## §5 QUESTIONS FOR THE OWNER

1. **`Product.version` semantics** (already in the Owner queue; BE-2 sharpens it). The CAS protects one
   editor against another editor. **124 other write sites** — sync jobs, the pricing engine, bulk ops — never
   bump `Product.version`, so a winning CAS can still overwrite a sync job's write with neither side noticing.
   The old page had the same blind spot. Making it real is an architecture decision: either every writer bumps,
   or the field is renamed to say what it actually guards (`editorVersion`). **Which?**
2. **Row-scoping and BE-7.** Should the studio's sub-resource routes enforce that `:listingId` / `:aliasId`
   belongs to `:id` **now**, before row-scoped permissions exist? It is five `where` clauses today and a
   security retrofit across a live API later. My recommendation is to do it now; it needs your word because it
   is work with no visible symptom.
3. **`GET /studio/columns` (BE-5)** — delete it, or keep the published contract and make it cheap? It has no
   caller. Keeping an unexercised contract that runs a full-family read is how PES.2/PES.3 inherit a
   performance problem they did not write.
4. **Readiness cold cost (§4) — the number got worse, not better.** My first figure was 22 s (market FR).
   After the 01:08 restart I measured the same call on **market IT at 62.8 s**, dropping to 1.49 s on the very
   next request. So on a cold process the scope-chip row — the first thing on the page — costs **over a minute**,
   and every process restart and every 5-minute TTL expiry puts that cliff in front of the next operator.
   The question is a product one: may the chips arrive *after* the sheet (render "…" and fill in), or must the
   page wait? Fixing BE-1 is the only identified lever and will not on its own get a cold build to interactive
   latency. **Hub has deferred this until BE-1's dedupe lands; recording the 62.8 s so the deferral is made
   against the real number rather than my first one.**
5. **BE-11 — eBay and Shopify batch submits are live-by-default.** Their dry-run gates read env vars that
   are set nowhere in the repo, so `=== '1'` is false and both submit; `getEbayPublishMode()` exists and is
   not consulted; neither accepts a caller `dryRun`. Amazon was unified onto the publish gate by PD.2 and its
   siblings were not. **The reason this is your call and not a lane's:** closing the gate stops any batch
   submission an environment may currently be relying on. eBay is the sharp end — there is no safe test
   target on that channel. **Do we close both gates now?**
6. **BE-12 — migration `20260901e` is parked and would break a shipped surface.** It drops
   `ChannelListing.aliasKey` and two unique indexes that `schema.prisma` still declares and that 48 call
   sites still read. It is unapplied today (measured), but ruling #10 established that parked folders get
   dragged by the next sibling's `migrate deploy` — it has already happened once, to two folders.
   **Either its schema half lands with it, or the folder comes out of the migrations directory until it is
   ready.** "We won't deploy yet" is not a mitigation under #10.
7. **Not a defect, a UI question I am routing rather than deciding** — on GALE-JACKET the **Master chip and
   the Amazon chip both read 71% (105/147, identical)** ⟦measured⟧. That is *honest*: Amazon is the only channel
   declaring required fields for OUTERWEAR·IT, so master's union and Amazon's coordinate set are the same seven
   fields. The old bug the code comment describes (every scope reporting an identical percentage) **is fixed** —
   eBay now correctly reads `absent`. But two chips showing the same number, for a reason that is invisible on
   screen, will read as the old bug to anyone who remembers it. **→ SR.1's call, not mine.**

---

## §6 WHAT I DID NOT VERIFY, AND WHY

- **Nothing was written to the database.** BE-2 and BE-3 are the two findings whose *live* behaviour needs a
  write; both carry an exact rehearsal for PES.5 above rather than a result from me.
- **BE-4 and BE-8 are structural, not observed.** Neither failure mode is firing right now — I measured that
  eBay aspects currently load (`requiredBy` contains `eBay · IT`), and that no writer passes a null marketplace.
  I could not induce either failure without a write or a DB fault injection, so they are ranked as latent and
  labelled ⟦structural⟧.
- **BE-3b is structural, not observed.** The predicate disjointness is a set-scan of a literal and the
  drop is read from control flow; I did not send the request that would prove it, because proving it requires
  a write. The rehearsal is filed to PES.5. If it does not reproduce, the finding is wrong and I would rather
  be told that than have it stand on my reading.
- **BE-1's cost multiplier is arithmetic, not a query count.** I proved the column sets are byte-identical
  ⟦measured⟧ and that `channels` cannot filter when `present` is undefined ⟦structural⟧; I did **not**
  instrument the API to count the actual duplicate schema queries. Someone with the server log should confirm
  five reads where one would do before quoting "5×" as a measured figure.
- **A direct Prisma connection from a scratch script fails on this machine** (`Connection terminated due to
  connection timeout`, pooler host). Every measurement above therefore goes through the running API over HTTP.
  That is the safer instrument anyway, but it means I could not run row counts (e.g. "how many
  `ChannelSchema` rows have a null marketplace") — BE-8 is bounded by the *writers*, which I could scan, not by
  the data, which I could not.
- **The publish/dry-run sweep is partial.** I swept `dryRun` across `routes/` and the pim services
  ⟦set-scanned, 40 hits⟧ and found no studio-path sibling of #176; the Amazon cockpit publish path OR's the
  requested flag with the env (`amazon-cockpit-publish.routes.ts:243`), which is the *safe* direction. PES.7's
  image-publish routes were not reached in this pass and are the first thing in pass 2.
- **A probe of mine short-circuited and I nearly filed its silence as a result.** Establishing whether
  migration `e` had been applied, I called `/sync-queue?limit=5`, saw `aliasKey: null` on every row and began
  writing it up as "the column is gone". All five rows had `channelListingId: null`, so the query I meant to
  exercise never ran — the `pageListingIds.length ? … : []` ternary skipped it. At `limit=200`, 155 rows carry
  a listing id and the select genuinely runs. **The corrected finding is the opposite of the one I nearly
  filed** (`reference_quiet_measurement_is_not_a_negative_result`), and it is recorded inline in BE-12 rather
  than as a footnote.
- **🔴 A standing programme claim is stale, and I am correcting it rather than repeating it: #15.2 is NOT
  open.** Both the hub's notes and my own pass-2 queue still say the resolver composition is unlanded and
  that "mapped values are ABSENT from the sheet payload". **Measured** on
  `/studio/sheet?market=IT&scope=channel&channel=AMAZON`: **15 of 21 value entries carry a non-null `mapped`
  object** — `{value, status: 'mapped', provenance: 'catalogRule', appliedTransforms, warnings, errors,
  autoCorrected, requiredByRule, …}` — with `meta.mapping.skippedReason: null` and `missingProductIds: 0`.
  The composition landed (at product granularity: `productLevelOnly: true`). #200 — a fact handed over in
  prose is unverified until something runs against it, and this one did not survive.
- **Pass 2 is COMPLETE.** PES.7's image publish/dry-run paths (BE-11, §3 items 9-10); the migration-drag
  re-check (BE-12); `mapping/expr.ts` (BE-14, and §3 item 12 — it came through well); the resolver
  composition (closed, above); the `listing-snapshot` restore path (BE-13, and §3 item 11).
- **One data observation, not a defect:** **405 of GALE-JACKET's 441 outbound sync queue rows are dead**
  (92%) ⟦measured⟧. That is a catalogue-health fact the sync console will show honestly; I am flagging it
  because nobody has said it out loud, not because the code is wrong.

---

### 🔴 CORRECTION — the 12.06 s ceiling recommendation was WRONG; size against ~4.9 s

**The reversed run (01:52, pid 79627) was CONTAMINATED and I am reporting it as such** — my
`/products/search` landed as `req-w`, the **32nd** request, with **31 requests and 79.3 s of other lanes'
server time ahead of it** ⟦measured from the process log⟧. My 0.896 s search therefore measured a fully warm
process, not the shared warm-up it was designed to isolate.

**But the intruding traffic ran the experiment for us, three times.** Other lanes' readiness calls on that
same warm process, plus mine:

| observation | market | time |
|---|---|---|
| another lane (`req-g`) | DE | 4.62 s |
| another lane (`req-m`) | DE | 4.35 s |
| another lane (`req-o`) | ES | 4.11 s |
| **mine (`req-x`)** | **IT** | **4.86 s** |

**Four independent readings of "readiness, cold for that market, on a warm process": 4.11–4.86 s** — against
the controlled **12.06 s** where readiness was the *first* request on a genuinely cold process.

**What follows — and this is the second correction in one section, because my first fix overshot.** 12.06 s
bundles one-off process warm-up that an operator pays only after a deploy or restart, so it is not the
steady-state cost. I then wrote *"size the ceiling against ~4.9 s"*. **That was a category error, corrected by
the hub (#273): a ceiling is where the client reports FAILURE, so it must sit ABOVE the worst case an
operator can hit — never at the typical one.** The two numbers answer two different questions:

| threshold | question it answers | number |
|---|---|---|
| **failure ceiling** (client gives up, reports an error) | what is the worst an operator can legitimately hit? | **above 12.06 s post-restart** — and the DE/ES sheet loads below say other markets are at least that, so with margin. PES.1's provisional 180 s already satisfies "above the measured worst case, cited"; it may tighten to ~3× the worst case **once PES.5 has measured the other markets**, and never to the steady-state figure |
| **slow-text / progressive threshold** (show "measuring…", let the sheet render first) | when does this stop feeling instant? | **~4 s**, against the measured 4.11–4.86 s steady-state cost |

**My error was symmetric with the one it replaced:** I first let one number (12.06) serve every purpose, then
corrected it by letting a different number (4.9) serve every purpose. Both are right, for different thresholds.
The cold/warm cliff splits the same way: **~7×** in steady state (4.86 → 0.67), 47× only on the first hit after
a restart.

This also **resolves PES.1's 4.4 s**, which I had listed as unexplained: it falls inside the 4.11–4.86 s band.
PES.1 and I were both right and measuring different things — theirs readiness's own cost on a warm process,
mine readiness plus warm-up on a cold one.

⟦Weaker, and labelled: **shared warm-up ≈ 12.06 − 4.5 ≈ 7.5 s** is inferred *across two processes*, not
measured within one. Only the clean reversed run settles that, and it is no longer blocking anything.⟧

**🔴 A finding I filed from another lane's traffic, and then REFUTED with my own measurement.** I reported
`/studio/sheet` master scope at **12.75 / 12.72 / 12.68 / 9.76 s** on **DE and ES** (read from the log of the
contaminated run) against 0.18–0.28 s warm for IT, and concluded *"markets other than IT are an order of
magnitude more expensive."* **That was wrong.** Measured directly on a quiet process, GALE-JACKET, cold-for-key
then warm ⟦measured⟧:

| `/studio/sheet` | cold | warm | bytes |
|---|---|---|---|
| master **DE** | 2.11 s | 1.25 s | 247 KB |
| master **ES** | 2.19 s | 0.40 s | 248 KB |
| master **IT** (control) | **4.47 s** | 0.19 s | 251 KB |

**DE and ES are FASTER than IT, not slower.** The 12.7 s figures were taken while that process was serving a
31-request burst from other lanes — **contention, not market cost.** I inherited a number from a log I had
just finished labelling contaminated and reasoned on it anyway; the control that refuted it took one command.
(`reference_claims_must_match_their_measurement`, the INHERITED-number section — my own citation, used against
me.)

**And coordinate count explains nothing between these markets:** IT, DE, ES and FR each carry exactly
**5 coordinates** — AMAZON + EBAY in-market, plus the 3 GLOBAL channels ⟦measured via `/api/marketplaces`, a
different code path from the one being timed⟧. Identical shape, which is also why the four warm readiness
readings showed no spread.

**🔴 RESOLVED BY PES.5, AND BOTH OF MY HYPOTHESES WERE WRONG — including my replacement claim.**

I reported an Amazon-channel-scope "variance" of 2.48 / 6.66 / 9.01 / 10.32 s on four identical warm requests
and offered two candidate causes: **pool contention** or **a serial await**. PES.5 instrumented *inside* the
request. It is neither. **It is the mapping enrichment's 8 s budget timing out while its Redis-backed queue
connects** — measured cold 25.9 s timeout, warm-1 18.4 s timeout, then 6.0 / 2.4 / 1.7 s once connected.
Whichever channel scope is loaded first pays it (`EBAY·IT` timed out cold too), and it decays.

**So my four "identical warm requests" were not identical: they were a decay curve, sampled in the other
direction.** And the correction I had already made — *"DE and ES are FASTER than IT"* — is **also wrong as a
causal claim.** It is true as an observation and false as a conclusion: DE was measured on an already-warm
queue. **Market is not the variable in either direction.** Queue-connection state is.

That is two retractions on the same number, in opposite directions, before the real cause was found by an
instrument I did not have. **The lesson is not "measure more", it is that outside-the-request timing could not
have answered this at all** — every explanation available from my vantage point (market, rule count, payload
size, coordinate count, contention, serial await) was wrong, and four of them were things I could measure.
A timing taken from outside a request can localise a cost to a route; it cannot tell you what the route is
waiting on.

**The Owner-facing consequence belongs to §2's BE-4 class, and closes that thread:** while the budget times
out, the derived column **renders silently empty** — an unknown presented as a plausible blank, on the scope
operators use most. Routed to PES.2 as wiring. BE-4 said an absent value must not be indistinguishable from a
measured one; this is the same defect arriving from a timeout rather than a catch.

### PENDING — the clean reversed cold-start run (agreed, ruling #258; needs a broadcast hold)

⚠ **It now needs a broadcast hold: 31 requests arrived within 43 s of "listening".** No longer blocking —
the four readings above give the number the ceiling needs — but it is the only way to measure shared warm-up
inside a single process.

The run above cannot separate shared process warm-up from readiness-specific cost, because
`/products/search` went third and call 1 had already paid the warm-up. The hub will cold-start once more
and confirm "listening" from the process log only; I then run, in this order and timed:

1. `GET /api/products/search?q=GALE&limit=10` — **FIRST request to the process.** Its time is the shared
   warm-up (pool + schema cache), attributable to nothing else.
2. `GET /api/products/:id/readiness?market=IT` — cold *for readiness*, but on an already-warmed process.
   **`(2) minus (1)` is readiness's own cost**, which is the number PES.1's ceiling actually needs.
3. The same again, warm — confirms the cache floor.

**Record the build identity again before that restart**, even though PES.2/DS.2's pending work is web-side:
that is the whole lesson of §4's 62.8 s, and it costs one `stat`. Expected shape if BE-1's de-duplication is
the dominant remaining term: (1) small, (2) close to 12 s, (3) ≈ 0.26 s. If (1) is large instead, most of
what I have been calling "readiness cold cost" is process warm-up that any first request would pay, and the
12.06 s figure should be re-attributed before anyone sizes against it.

### Pass 2 (not started)
PES.7's image publish/dry-run routes · `services/pim/mapping/**` (expr.ts's five catch sites) ·
`attribute-resolver.ts` + `resolve-channel-field.ts` composition (#15.2 is still open) ·
the `listing-snapshot` restore path · migration drag re-check against `_prisma_migrations`.
