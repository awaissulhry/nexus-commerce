import { variationAttributePatch } from '../pim/shared-variation-values.js'
import type { SheetChannel } from '../pim/sheet-columns.service.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import type { FastifyBaseLogger } from 'fastify'
import { activeDatabaseTransaction, afterDatabaseCommit } from '../../lib/database-context.js'
import { currentFormulaWrite } from '../pim/mapping/formula-write-context.js'
import { validateShopifyField, shopifyDefinitionApplicability } from '@nexus/shared/shopify-linked-products'
import { nativeFieldValueError, type NativeEdit } from '@nexus/shared/shopify-information'
import { writeChannelOverrideMerge } from '../pim/channel-value-write.js'
import { isReferenceField } from '@nexus/shared/reference-values'
import { createReferenceResolver } from '../pim/reference-values.service.js'
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { getFieldDefinition } from '../pim/field-registry.service.js'
import { readStoredChannelValue } from '../pim/channel-inheritance.js'
import { applyPlatformMutations, channelValueMutation, type ChannelValueMutation } from '../pim/channel-value-mutation.js'
import { CHANNEL_FIELD_MAP, FOLLOW_FLAG_FOR_COLUMN, channelOverrideKeys } from '../pim/channel-field-map.js'
import { coerceForShape, parseSlotField, readListValue, readPath, withSlotValue, type ShapeWriteFacts } from '../pim/sheet-values.js'
import { ALLOWED_MASTER_FIELDS, MASTER_FIELD_OPTIONS } from '../pim/master-field-gate.js'
import { validationMarketplace } from '../pim/validation-marketplace.js'
import { auditLogService } from '../audit-log.service.js'
import { reevaluateDependents } from '../pim/mapping/cell-formula.service.js'
import { masterPriceService } from '../master-price.service.js'
import { masterContentService } from '../master-content.service.js'
import { applyStockMovement } from '../stock-movement.service.js'
import { productEventService } from '../product-event.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { isPrimaryChannelConnection, primaryConnectionIds, resolveConnection } from '../connection-resolver.service.js'
import { normalizeEbayListingValue } from '../pim/ebay-listing-values.js'
import { numericStorageError } from '../pim/numeric-storage.js'

export interface ProductBulkInput {
  changes: Array<{
    id: string
    field: string
    value: unknown
    cascade?: boolean
    /**
     * PES.5 / #169 — WHERE this change lands.
     *
     * `master` (the default, and today's behaviour for every existing
     * caller) writes the Product. `channel` writes the ChannelListing's
     * `overrideData` bag for the coordinate(s) in `marketplaceContexts`.
     *
     * Deliberately a target rather than a field-name prefix: the existing
     * 6-entry CHANNEL_FIELD_MAP would need an `ebay_attr_<name>` per
     * attribute, exploding the namespace. This makes the write contract the
     * mirror of the studio read contract — a client echoes back the
     * `writeTarget` it was given instead of deriving a name.
     */
    target?: 'master' | 'channel'
    intent?: 'set' | 'pin' | 'reset'
  }>
  marketplaceContext?: {
    accountId?: string
    locale?: string
    channel: SheetChannel
    marketplace: string
  }
  /** R.1 — multi-target fan-out. When set (and non-empty), every
   *  channel-field upsert runs once per matching context, so a
   *  single edit lands on AMAZON:IT + AMAZON:DE + AMAZON:FR in
   *  one PATCH. Falls back to `marketplaceContext` (singular) for
   *  backwards compat. */
  marketplaceContexts?: Array<{
    accountId?: string
    locale?: string
    channel: SheetChannel
    marketplace: string
    /**
     * PES.5 — which listing ALIAS the write targets. `''` = the product's
     * primary listing. Absent is treated as `''` ONLY here, where the
     * caller supplied a context and simply omitted the field; a change that
     * names no context at all still cannot reach the channel layer.
     */
    aliasKey?: string
  }>
  /** W1.2 — optimistic concurrency for single-product callers
   *  (MasterDataTab on /products/[id]/edit). Caller passes the
   *  Product.version it read with via the If-Match header
   *  (preferred) or this body field (fallback). When supplied:
   *
   *    - all `changes` must target the same product id (else 400),
   *    - the transaction CAS-bumps version inside the same tx as
   *      the field updates, so concurrent writers see VERSION_
   *      CONFLICT instead of silently overwriting,
   *    - the response includes `currentVersion`, READ BACK from the
   *      row (never `expectedVersion + 1` — #600(6) removed the
   *      computed form; see the response builder below for why),
   *      so the client can keep its local copy in sync without a
   *      refetch.
   *
   *  Multi-product bulk-ops PATCHes (which may legitimately span
   *  hundreds of products in a single call) still pass nothing here
   *  and behave exactly as before.
   *
   *  ⚠ CORRECTED 2026-09-01, and CORRECTED AGAIN 2026-09-02 (#689(3)).
   *  THIS ROUTE does not bump `Product.version` without a token: measured
   *  by PES.2 (a PATCH without expectedVersion returned updated:1 and left
   *  v5 at v5), and by construction the CAS update below — inside
   *  `if (expectedVersion !== undefined)` — is the only bump IN THIS FILE'S
   *  bulk path. No Prisma middleware or client extension bumps it either.
   *
   *  🔴 The 2026-09-01 correction ALSO claimed that CAS was "the ONLY
   *  `version: { increment: 1 }` on Product in the entire API". That is
   *  FALSE, and a correction is the last place a false claim should hide.
   *  Grepped and read 2026-09-02, there are five others:
   *    - `products-catalog.routes.ts:1299` — CAS bump (token path)
   *    - `products-catalog.routes.ts:1317` — bumps with NO token AT ALL,
   *      deliberately: "still bump version so the field is a useful
   *      freshness signal even for callers that don't send If-Match".
   *      This is the direct contradiction: that path does what this
   *      comment said nothing does.
   *    - `products-catalog.routes.ts:1552` — bulk lowStockThreshold
   *      `updateMany` bump
   *    - `services/pim/mapping/cell-formula.service.ts:250` — master
   *      formula writes bump
   *    - `products.routes.ts:846` — the restore path bumps
   *  So: a version that moved under you did NOT necessarily move through
   *  the path you are testing, and "no token means no bump" is a fact
   *  about this handler, never about the API.
   *
   *  ── What `Product.version` actually is ───────────────────────
   *  NOT a row version. It is a CAS token maintained ONLY by the
   *  single-product edit path. Product rows are updated from 124
   *  other call sites across 45 files — the catalog-refresh and
   *  sync-drift jobs, inventory, pim-global, flat-file, the pricing
   *  engine — and NONE of them bump it.
   *
   *  So a consumer must read it as: "nobody has edited this product
   *  through the single-product editor since I read it." It does NOT
   *  mean "this row is unchanged". A CAS that SUCCEEDS can still be
   *  overwriting a sync job's or a bulk-op's write.
   *
   *  That gap is not closed by making this branch bump: that fixes
   *  1 of 125 writers while adding an UPDATE per row to bulk-ops
   *  spanning hundreds of products. Making the token trustworthy is
   *  an architecture decision (bump it in a Prisma extension, or
   *  accept the narrow meaning and rename it) — deliberately not
   *  taken here. Consumers that must not over-trust it: the Product
   *  Edit Studio's cell autosave, products-catalog's inline grid
   *  edit (~:1213), and PES.8's AI draft-apply. */
  expectedVersion?: number
  /**
   * D15.4 / item 8 — validate and report, write NOTHING.
   *
   * The import diff needs the write path's own verdicts, not a second
   * implementation of them: a validator written to "do what this does"
   * passes the day it is written and drifts the first time either copy is
   * edited. So the preview calls THIS handler and stops before the
   * transaction.
   *
   * ⚠ This codebase has already shipped a `dryRun` that was accepted,
   * logged, echoed back and never forwarded — the flag read as honoured
   * while the write happened anyway. The guarantee here is therefore
   * structural, not a promise in a field: the early return below sits above
   * every write in this handler, including the `BulkOperation` row the
   * empty-validation branch creates. A dry run that leaves an audit row is
   * not a dry run.
   */
  dryRun?: boolean
}

export interface ProductBulkChangeError {
  id: string
  field: string
  error: string
}

export interface ProductBulkContext {
  ifMatch?: string | string[]
  formulaWriteToken?: string | string[]
  formulaCascade: boolean
  userId?: string | null
  ip?: string | null
  logger: Pick<FastifyBaseLogger, 'warn' | 'error'>
}

export class ProductBulkError extends Error {
  constructor(readonly statusCode: number, readonly details: Record<string, unknown>) {
    super(typeof details.error === 'string' ? details.error : 'Product edit failed')
  }
}

/** Validate, preview or atomically apply product edits, including their formula dependencies. */
export async function applyProductBulkEdits(input: ProductBulkInput, context: ProductBulkContext) {
  const { changes, marketplaceContext, marketplaceContexts } =
    input ?? {}
  // Effective context list: prefer the new array, fall back to the
  // singular form, dedupe.
  const rawContexts: Array<{ channel: SheetChannel; marketplace: string; accountId?: string; aliasKey?: string; locale?: string }> =
    Array.isArray(marketplaceContexts) && marketplaceContexts.length > 0
      ? marketplaceContexts
      : marketplaceContext
      ? [marketplaceContext]
      : []
  // One row commit has one account per channel. Mixed-account files use catalog transfer,
  // which resolves each explicit destination independently.
  const namedAccounts = new Map<string, string | undefined>()
  for (const ctx of rawContexts) {
    if (!ctx?.channel || !ctx.marketplace) continue
    if (ctx.locale !== undefined && (typeof ctx.locale !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(ctx.locale))) throw new ProductBulkError(400, { error: 'Choose a valid destination locale.' })
    if (ctx.channel === 'SHOPIFY' && rawContexts.some(other => other.channel === 'SHOPIFY' && other.locale !== ctx.locale)) throw new ProductBulkError(400, { error: 'Submit each Shopify language separately.' })
    if (ctx.accountId !== undefined && (typeof ctx.accountId !== 'string' || !ctx.accountId.trim())) throw new ProductBulkError(400, { error: 'accountId must name an account, or be omitted for the primary account.' })
    if (namedAccounts.has(ctx.channel) && namedAccounts.get(ctx.channel) !== ctx.accountId) throw new ProductBulkError(400, { error: 'Conflicting accounts for one channel. Submit each destination separately.' })
    namedAccounts.set(ctx.channel, ctx.accountId)
  }
  // Resolve only requested, unnamed destinations. An explicit account or a Shared
  // edit must not depend on another channel having a unique primary account.
  const connFor = await primaryConnectionIds([...namedAccounts].filter(([, id]) => id === undefined).map(([channel]) => channel))
  for (const [channel, accountId] of namedAccounts) {
    if (accountId === undefined) continue
    const account = await resolveConnection({ accountId })
    if (account.channelType !== channel || !account.isActive) throw new ProductBulkError(400, { error: 'Account is not active on the requested channel' })
    connFor.set(channel, account.id)
  }
  const effectiveContexts = (() => {
    const seen = new Set<string>()
    const out: typeof rawContexts = []
    for (const c of rawContexts) {
      if (!c?.channel || !c?.marketplace) continue
      const k = `${c.channel}:${c.marketplace}:${(c as { aliasKey?: string }).aliasKey ?? ''}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(c)
    }
    return out
  })()
  // First context drives schema lookups (registry validation needs ONE
  // marketplace; rule of thumb is the schema is consistent across the
  // selected fan-out targets — selectors that mix incompatible
  // schemas get rejected per change anyway).
  const primaryContext = effectiveContexts[0] ?? null
  // #569 — the registry marketplace comes from the RAW contexts, before the
  // channel filter above drops a master scope's channel-less context.
  const registryMarketplace = validationMarketplace(rawContexts) ?? primaryContext?.marketplace ?? null
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new ProductBulkError(400, { error: 'No changes provided' })
  }
  if (changes.length > 1000) {
    throw new ProductBulkError(400, { error: 'Max 1000 changes per request' })
  }

  // W1.2 — pick up the optimistic-concurrency hint. If-Match takes
  // precedence over the body field; both must parse as a positive
  // integer to be honoured.
  const ifMatchHeader = context.ifMatch
  const headerVersion =
    typeof ifMatchHeader === 'string' && /^\d+$/.test(ifMatchHeader)
      ? Number(ifMatchHeader)
      : undefined
  const bodyExpectedVersion =
    typeof input?.expectedVersion === 'number' &&
    Number.isFinite(input.expectedVersion) &&
    input.expectedVersion >= 0
      ? Math.floor(input.expectedVersion)
      : undefined
  // #689(2) — a token that is PRESENT but unreadable is refused, never
  // dropped. Measured cost of the drop: PES.2's AIREON probe carried a token
  // this parser could not read, so no CAS statement was built and a write the
  // caller believed was version-guarded ran unguarded — and `BulkOperation`
  // does not record the token, so nothing afterwards could show it.
  //
  // `null` is treated as ABSENT, not as malformed. It is what a client means
  // by "I have no version"; PES.3's channel writer omits on `!== undefined`,
  // so a `listing.version: null` would serialise as null and a strict rule
  // would 400 every save on such a row. The fix for a silent defect must not
  // create a loud one one branch down — this file has already made exactly
  // that mistake once (the #675 400 on an all-no-op request).
  //
  // Safe to refuse the rest, measured 2026-09-02: the master writer's
  // `versions` Map is typeof-guarded and `masterWrite.ts:140` omits the key
  // when undefined; the channel writer spreads on `!== undefined` and 21/21
  // fixture rows carry a numeric `listing.version`; the import path
  // (`product-studio.routes.ts:500`) never constructs the key at all.
  if (ifMatchHeader !== undefined && headerVersion === undefined) {
    throw new ProductBulkError(400, {
      error:
        'If-Match must be a non-negative integer — the version you read — or be omitted. It was present but unreadable, and a write that believes it is version-guarded must not run unguarded.',
      received: String(ifMatchHeader).slice(0, 80),
    })
  }
  const rawBodyExpectedVersion = input?.expectedVersion
  if (
    rawBodyExpectedVersion !== undefined &&
    rawBodyExpectedVersion !== null &&
    bodyExpectedVersion === undefined
  ) {
    throw new ProductBulkError(400, {
      error:
        'expectedVersion must be a non-negative number — the version you read — or be omitted (null counts as omitted). It was present but unreadable, and a write that believes it is version-guarded must not run unguarded.',
      received: String(rawBodyExpectedVersion).slice(0, 80),
    })
  }
  const expectedVersion = headerVersion ?? bodyExpectedVersion
  if (expectedVersion !== undefined) {
    const ids = new Set(changes.map((c) => c?.id).filter(Boolean))
    if (ids.size !== 1) {
      throw new ProductBulkError(400, {
        error:
          'expectedVersion / If-Match requires every change to target the same product id',
      })
    }
  }

  // #775 — moved to `services/pim/master-field-gate.ts` so the FORMULA path
  // and the sheet contract read the same gate this handler enforces. Same
  // members; it was unreachable here, which is why the formula writer kept a
  // narrower list of its own and the contract advertised that narrower list.
  const ALLOWED_FIELDS = ALLOWED_MASTER_FIELDS
  // D.3d: prefixed channel fields write to ChannelListing instead of
  // Product. Only the suffixes in this set are wired today; the rest
  // of amazon_*/ebay_* are still read-only in the registry.
  // #758 — moved to `services/pim/channel-field-map.ts` so the FORMULA writer
  // reads the same map. Same members, same behaviour; it was unreachable here
  // and the formula path merged raw keys into `overrideData` as a result.
  const isChannelField = (f: string) =>
    Object.prototype.hasOwnProperty.call(CHANNEL_FIELD_MAP, f)
  const channelOf = (f: string): 'AMAZON' | 'EBAY' | null =>
    f.startsWith('amazon_') ? 'AMAZON' : f.startsWith('ebay_') ? 'EBAY' : null
  const isCategoryAttrField = (f: string) => f.startsWith('attr_')
  /**
   * #693 — THE routing predicate: does this change land on the ChannelListing?
   * Defined once, beside the map it consults, and called by the write and by
   * every reader of the write. Three sites had re-derived it and two of them
   * disagreed; a fourth would have been found by whoever paid for it.
   *
   * ⚠ It is NOT `isChannelField(f) || target === 'channel'`. The two field
   * classes route differently and the difference is load-bearing:
   *   - `attr_*` routes on TARGET (:2317) — the same attribute is a listing
   *     override or a product categoryAttribute depending on the scope asked
   *     for;
   *   - everything else routes on the FIELD NAME (:2398) and IGNORES target —
   *     `amazon_title` is always a listing write; `brand` is always a master
   *     column, even with `target: 'channel'`, because `CHANNEL_FIELD_MAP`
   *     has no entry for it and `upsertChannelListings` returns [] for a
   *     field it cannot map. Treating `brand` + `target:'channel'` as a
   *     channel change would route it to a writer that silently drops it.
   */
  const isChannelChange = (v: { field: string; target?: string }) =>
    isCategoryAttrField(v.field) ? v.target === 'channel' : isChannelField(v.field)
  const NUMERIC_FIELDS = new Set([
    'basePrice',
    'costPrice',
    'minMargin',
    'minPrice',
    'maxPrice',
    'weightValue',
    // D.3j
    'dimLength',
    'dimWidth',
    'dimHeight',
  ])
  const INTEGER_FIELDS = new Set(['totalStock', 'lowStockThreshold'])
  const STATUS_VALUES = new Set(['ACTIVE', 'DRAFT', 'INACTIVE'])
  const CHANNEL_VALUES = new Set(['FBA', 'FBM'])
  // D.3j: unit enums for the editable weightUnit / dimUnit fields.
  const WEIGHT_UNIT_VALUES = new Set(['kg', 'g', 'lb', 'oz'])
  const DIM_UNIT_VALUES = new Set(['cm', 'mm', 'in'])
  // Locale-tolerant numeric coercion: accept Italian / European
  // decimal commas ("5,5") alongside the canonical period.
  const numericFromLocale = (raw: unknown): number => {
    if (typeof raw === 'number') return raw
    if (raw == null) return NaN
    const s = String(raw).trim()
    if (s === '') return NaN
    // Only swap commas to periods when there's no period already
    // (avoids "1,000.00" → "1.000.00"). For our domain, raw user
    // inputs like "5,5" or "5.5" are the common cases.
    if (s.includes('.') || !s.includes(',')) return Number(s)
    return Number(s.replace(',', '.'))
  }

  interface Validated {
    id: string
    field: string
    value: any
    cascade: boolean
    /**
     * PES.5 — carried through validation. It was omitted here first, and the
     * change silently fell through to the master path: the rehearsal wrote
     * "channel only" into `Product.categoryAttributes`. Nothing failed; the
     * value simply landed on the wrong layer. Typed (not read through a cast)
     * so a future push site that forgets it does not compile.
     */
    target?: 'master' | 'channel'
    /**
     * AM.1 — the 1-based slot of a LIST field this change addresses (`bulletPoints[3]`). Present
     * only until the expansion pass below turns the change into a whole-array write.
     */
    slot?: number
    reset?: boolean
  }

  const validated: Validated[] = []
  const errors: ProductBulkChangeError[] = []

  // ── #489 — the server enforces the caps the SHEET shows ──────────────
  // Measured 2026-09-02: this path enforced closed lists and NO length cap at
  // all, in either unit, on either layer. A 5,000-character `name` stored at
  // 5,000 where Amazon caps at 200. The client gate is a convenience; nothing
  // behind it was a guard, so a paste or a fill-handle drag wrote over-cap
  // values straight to the database to fail later at publish.
  //
  // The caps come from `getSheetColumns` — the SAME function the sheet
  // displays from — never a second cap table. If the two ever disagreed, an
  // operator would be refused against a limit their screen never showed,
  // which is worse than no guard at all.
  //
  // Market: the request's own context when it has one. A master change with
  // no context has no single market and therefore no single cap, so the
  // tightest across the markets the product is ACTUALLY listed on is used and
  // `capFrom` names which one — see the note in the reply to #489, this half
  // is stricter than any one market's sheet and is flagged, not assumed.
  const capMarket = primaryContext?.marketplace ?? null
  const changeIds = [...new Set(changes.map((c) => c?.id).filter((v): v is string => !!v))]
  const capsByKey = new Map<string, { maxLength?: number; maxBytes?: number; capFrom?: string }>()
  /**
   * AM.1 — the CHANNEL scope's own columns for the primary context: where a channel field's value
   * lives (`channels[coord].store`), so an `attr_*` write to an eBay item specific or listing
   * setting lands on `platformAttributes` — the store the eBay push reads — and not in the override
   * bag. The channel spec is also the REGISTRY for these keys: `getFieldDefinition` only knows
   * Amazon's cached schemas, so without this an eBay aspect write was refused as "unknown".
   */
  type ChannelStoreFact = { kind: 'listingColumn'; column: string; followFlag?: string } | { kind: 'platformAttributes'; path: string[]; unitPath?: string[] }
  const channelStoreByKey = new Map<string, ChannelStoreFact>()
  /**
   * Every column the CONTRACT serves for these product types (channel scope of the primary context,
   * then the master builds) with its editability — the registry for `attr_*` writes. The old
   * registry (`getFieldDefinition` over `schema-to-fields`) never knew a measure or a compound leaf
   * (it skipped them), so `attr_item_weight` on master was refused as "unknown" (dry-run, 2026-09-05).
   */
  const channelColumnKeys = new Set<string>()
  const contractEditableByKey = new Map<string, boolean>()
  /**
   * AM.1 — the SHAPE facts of every column the write can address (channel scope first, then the
   * master builds), so an `attr_*` value is coerced INTO its column's shape or refused — never
   * stringified. Measured before this (b0, 2026-09-05): an array to a list attribute would have
   * landed in the bag as `"a,b"`, a measure as `"[object Object]"`.
   */
  const columnFactsByKey = new Map<string, ShapeWriteFacts>()
  const variationOwners = new Map<string, { categoryAttributes: unknown; variantAttributes: unknown; variationAxes: string[] }>()
  const rowContract = new Map<string, Map<string, import('../pim/sheet-columns.service.js').SheetColumn>>()
  const rowCategoryById = new Map<string, string | null>()
  const masterRowContract = new Map<string, Map<string, import('../pim/sheet-columns.service.js').SheetColumn>>()
  const storeFor = (id: string, key: string) => {
    const col = rowContract.get(id)?.get(key)
    return col ? Object.values(col.channels ?? {})[0]?.store : channelStoreByKey.get(key)
  }

  const factsOf = (col: { key: string; label: string; maxLength?: number; maxBytes?: number; validation?: Record<string, unknown>; kind?: string; shape?: string; cardinality?: { min: number; max: number | null }; unitOptions?: string[]; options?: string[]; mode?: 'strict' | 'open' }): ShapeWriteFacts =>
    ({ key: col.key, label: col.label, maxLength: col.maxLength, maxBytes: col.maxBytes, validation: col.validation, kind: col.kind, shape: (col.shape ?? 'scalar') as ShapeWriteFacts['shape'], cardinality: col.cardinality, unitOptions: col.unitOptions, options: col.options, mode: col.mode })
  if (changeIds.length > 0) {
    try {
      const [ptRows, mkRows] = await Promise.all([
        prisma.product.findMany({ where: { id: { in: changeIds } }, select: { id: true, parentId: true, isParent: true, productType: true, familyId: true, categoryAttributes: true, parent: { select: { familyId: true } } } }),
        capMarket ? Promise.resolve([]) : prisma.channelListing.findMany({
          where: { productId: { in: changeIds } }, select: { marketplace: true }, distinct: ['marketplace'],
        }),
      ])
      const productTypes = [...new Set(ptRows.map((r) => r.productType).filter((v): v is string => !!v))]
      const markets = capMarket || registryMarketplace
        ? [capMarket ?? registryMarketplace!]
        : [...new Set(mkRows.map((r) => r.marketplace).filter(Boolean))]
      const familyIds = [...new Set(ptRows.map(r => r.familyId ?? r.parent?.familyId).filter((v): v is string => !!v))]
      // Studio exposes saved fields across the entire parent/variation group. Build that same
      // schema for a child edit, including fields currently stored only on its parent or sibling.
      const rootIds = [...new Set(ptRows.map(r => r.parentId ?? r.id))]
      const schemaFamilyRows = rootIds.length ? await prisma.product.findMany({
        where: { OR: [{ id: { in: rootIds } }, { parentId: { in: rootIds } }], deletedAt: null },
        select: { id: true, parentId: true, categoryAttributes: true, variantAttributes: true, variationAxes: true },
      }) : []
      for (const row of schemaFamilyRows) variationOwners.set(row.id, { ...row, variationAxes: row.variationAxes?.length ? row.variationAxes : schemaFamilyRows.find(parent => parent.id === row.parentId)?.variationAxes ?? [] })
      if (ptRows.length > 0) {
        const { getSheetColumns } = await import('../pim/sheet-columns.service.js')
        if (primaryContext) {
          const { productCategoryContext } = await import('../pim/product-category-context.js')
          const { columnForCategory, columnApplies } = await import('@nexus/shared/master-sheet')
          const context = await productCategoryContext(changeIds, primaryContext.channel, primaryContext.marketplace, connFor.get(primaryContext.channel) ?? null)
          const channelSet = await getSheetColumns({
            locale: primaryContext.locale,
            accountId: context.connectionId,
            market: primaryContext.marketplace, productTypes: primaryContext.channel === 'AMAZON' ? context.categories : productTypes,
            ebayCategoryIds: primaryContext.channel === 'EBAY' ? context.categories : [], includeEmptyChannels: true,
            etsyCategoryIds: primaryContext.channel === 'ETSY' ? context.categories : [],
            onlyChannels: [primaryContext.channel], scopeKind: 'channel',
          })
          const label = channelSet.coordinates.find((c) => c.channel === primaryContext.channel)?.label
          for (const id of changeIds) {
            const aliasKey = (primaryContext as { aliasKey?: string }).aliasKey ?? ''
            const category = context.byRow.get(`${id}:${aliasKey}`)?.channelCategoryId ?? context.defaults[id]?.channelCategoryId ?? null
            rowCategoryById.set(id, category)
            const row = new Map<string, import('../pim/sheet-columns.service.js').SheetColumn>()
            for (const header of channelSet.columns) {
              const col = label ? columnForCategory(header, label, category) : header
              const owner = ptRows.find(p => p.id === id)
              const shopifyApplies = !col.shopifyField || (col.shopifyField.owner === 'PRODUCT' ? !owner?.parentId : !owner?.isParent)
              row.set(col.key, { ...col, editable: col.editable && shopifyApplies && columnApplies(col, { isParent: !!owner?.isParent, productType: category }) })
              if (col.slot && !row.has(col.slot.of)) row.set(col.slot.of, { ...col, key: col.slot.of, slot: undefined, shape: 'list', cardinality: { min: 0, max: col.channels?.[label!]?.cardinality?.max ?? col.slot.max } })
            }
            rowContract.set(id, row)
          }
          for (const col of channelSet.columns) {
            channelColumnKeys.add(col.key)
            contractEditableByKey.set(col.key, col.editable)
            if (!columnFactsByKey.has(col.key)) columnFactsByKey.set(col.key, factsOf(col))
            const store = label ? col.channels?.[label]?.store : undefined
            if (store) channelStoreByKey.set(col.key, store as ChannelStoreFact)
          }
        }
        for (const mk of markets) {
          const set = await getSheetColumns({ market: mk, productTypes, familyIds, savedFields: (await import('../pim/family-sheet-schema.js')).savedAttributeFields(schemaFamilyRows.map(r => r.categoryAttributes)), includeEmptyChannels: true })
          const { columnApplies } = await import('@nexus/shared/master-sheet')
          for (const product of ptRows) {
            const row = new Map<string, import('../pim/sheet-columns.service.js').SheetColumn>()
            const shape = { isParent: product.isParent, productType: product.productType, familyId: product.familyId ?? product.parent?.familyId }
            for (const col of set.columns) row.set(col.key, { ...col, editable: col.editable && columnApplies(col, shape) })
            masterRowContract.set(product.id, row)
          }
          for (const col of set.columns) {
            if (!columnFactsByKey.has(col.key)) columnFactsByKey.set(col.key, factsOf(col))
            if (!contractEditableByKey.has(col.key)) contractEditableByKey.set(col.key, col.editable)
            if (col.maxLength === undefined && col.maxBytes === undefined) continue
            const prev = capsByKey.get(col.key)
            // Tightest across markets wins, and `capFrom` travels with the
            // cap that won so the message names the coordinate that refused.
            const takeL = prev?.maxLength === undefined || (col.maxLength !== undefined && col.maxLength < prev.maxLength)
            const takeB = prev?.maxBytes === undefined || (col.maxBytes !== undefined && col.maxBytes < prev.maxBytes)
            capsByKey.set(col.key, {
              maxLength: takeL ? col.maxLength : prev?.maxLength,
              maxBytes: takeB ? col.maxBytes : prev?.maxBytes,
              capFrom: takeL || takeB ? col.capFrom : prev?.capFrom,
            })
          }
        }
      }
    } catch (error) {
      context.logger.warn({ err: error }, 'Attribute write contract unavailable')
      if (changes.some(c => isCategoryAttrField(c.field))) {
        throw new ProductBulkError(503, { error: 'Could not load attribute requirements. Reload the sheet before saving attributes.' })
      }
    }
  }
  /** `n > cap` is over; a value exactly AT the cap is accepted. */
  const capViolation = (field: string, value: unknown, id?: string): string | null => {
    if (typeof value !== 'string' || value.length === 0) return null
    const cap = (id ? rowContract.get(id)?.get(field.replace(/^attr_/, '')) : undefined) ?? capsByKey.get(field) ?? capsByKey.get(field.replace(/^attr_/, ''))
    if (!cap) return null
    const where = cap.capFrom ? `the ${cap.capFrom} cap` : 'the cap (source not stated)'
    if (cap.maxLength !== undefined && value.length > cap.maxLength) {
      return `${value.length} characters — over ${where} of ${cap.maxLength}`
    }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (cap.maxBytes !== undefined && bytes > cap.maxBytes) {
      return `${bytes} bytes — over ${where} of ${cap.maxBytes} bytes`
    }
    return null
  }

  for (const raw of changes) {
    // AM.1 — a SLOT write (`bulletPoints[3]`, `attr_material[2]`, `amazon_bulletPoints[3]`) is
    // validated as its BASE field and lands as ONE array write: the slot index rides along, and the
    // expansion pass before the transaction reads the current array, sets that position and keeps
    // every other one (Owner ruling 2026-09-05: slots are independent cells, holes are kept).
    const slotOf = raw?.field ? parseSlotField(raw.field) : null
    const c = slotOf ? { ...raw, field: slotOf.base } : { ...raw }
    if (c.target === 'channel' && primaryContext?.channel === 'EBAY' && c.field?.startsWith('attr_')) {
      c.value = normalizeEbayListingValue(c.field.slice(5), c.value)
    }
    if (!c?.id || typeof c.id !== 'string') {
      errors.push({ id: c?.id ?? '', field: c?.field ?? '', error: 'Missing id' })
      continue
    }
    const isCh = isChannelField(c.field ?? '')
    const isAttr = isCategoryAttrField(c.field ?? '')
    if (
      !c.field ||
      (!ALLOWED_FIELDS.has(c.field) && !isCh && !isAttr)
    ) {
      errors.push({ id: c.id, field: c.field ?? '', error: 'Field not editable' })
      continue
    }
    // For attr_* fields, the registry must have it AND be editable.
    // D.3g: getFieldDefinition is now async and falls back to the
    // cached Amazon schemas when the id isn't in the static
    // hardcoded list — so any field exposed by /api/pim/fields with
    // a marketplace context is also acceptable here.
    if (isAttr) {
      // #542(1) — an `attr_*` write with NO marketplace context is refused for
      // WHAT IT IS, not as an unknown field.
      //
      // The attribute registry is per marketplace: with `marketplace: null`
      // the lookup falls back to the static hardcoded list, so measured on
      // master DE/de **60 of 60 `attr_*` columns refused** with "Unknown or
      // read-only category attribute" — which is false twice over (they are
      // neither unknown nor read-only) and sent the reader looking at the
      // registry instead of at the missing context. This is the Owner's
      // "unable to write color".
      //
      // Deliberately NOT defaulted from the product's own market: that can
      // differ from the market whose schema the columns were built against,
      // and silently writing against a different schema is worse than
      // refusing. The caller sends the scope it is showing.
      if (!registryMarketplace) {
        errors.push({
          id: c.id,
          field: c.field,
          error: 'No marketplace context — the attribute registry is per marketplace, so this write needs the scope it was made in (marketplaceContexts).',
        })
        continue
      }
      const contractKey = c.field.replace(/^attr_/, '')
      if (c.target === 'channel' && effectiveContexts.length !== 1) {
        errors.push({ id: c.id, field: c.field, error: 'Edit category attributes in one channel, marketplace and listing at a time; each has its own requirements.' })
        continue
      }
      const rowColumn = (c.target === 'channel' ? rowContract : masterRowContract).get(c.id)?.get(contractKey)
      const def = rowColumn ? { editable: rowColumn.editable, type: 'text' as const, options: rowColumn.options } : c.target === 'channel' ? undefined : contractEditableByKey.has(contractKey)
        ? { editable: contractEditableByKey.get(contractKey) === true, type: 'text' as const, options: undefined as string[] | undefined }
        : await getFieldDefinition(c.field, { marketplace: registryMarketplace })
      if (!def || !def.editable) {
        errors.push({
          id: c.id,
          field: c.field,
          error: 'Unknown or read-only category attribute',
        })
        continue
      }
      // Validate select options — only when the CONTRACT does not know the column; where it does,
      // `coerceForShape` below applies the contract's own `mode` (an OPEN list accepts an off-list
      // value; the registry's `select` read every enum as closed, which is not what the sheet says).
      if (!columnFactsByKey.has(c.field.replace(/^attr_/, '')) && def.type === 'select' && def.options && c.value !== null) {
        if (!def.options.includes(String(c.value))) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Must be one of: ${def.options.join(', ')}`,
          })
          continue
        }
      }
    }
    // Channel fields require at least one marketplace context whose
    // channel matches the field's prefix (amazon_* → AMAZON, ebay_*
    // → EBAY). With R.1 multi-targets, a request that selects e.g.
    // AMAZON:IT + EBAY:UK can carry both `amazon_title` and
    // `ebay_title` changes — each routes to its matching contexts.
    if (isCh) {
      if (effectiveContexts.length === 0) {
        errors.push({
          id: c.id,
          field: c.field,
          error: 'marketplaceContexts required for channel fields',
        })
        continue
      }
      const expectedChannel = channelOf(c.field)
      const matching = expectedChannel
        ? effectiveContexts.filter((ctx) => ctx.channel === expectedChannel)
        : effectiveContexts
      if (matching.length === 0) {
        errors.push({
          id: c.id,
          field: c.field,
          error: `Field belongs to ${expectedChannel} but no ${expectedChannel} target was selected`,
        })
        continue
      }
    }

    if (!slotOf && changes.some(other => other?.id === c.id && parseSlotField(other.field)?.base === c.field)) {
      errors.push({ id: c.id, field: raw.field, error: 'Edit the whole list separately from its individual positions.' })
      continue
    }
    if (c.intent === 'reset') {
      if (c.cascade || slotOf) {
        errors.push({ id: c.id, field: raw.field, error: slotOf
          ? 'Inheritance belongs to the whole list. Reset the full list, or edit this individual value.'
          : 'Return to inheritance requires one field without a family cascade.' })
        continue
      }
      validated.push({ id: c.id, field: c.field, value: null, cascade: false, target: c.target, reset: true })
      continue
    }

    if (slotOf) {
      if (isChannelChange(c) && effectiveContexts.length !== 1) {
        errors.push({ id: c.id, field: raw.field, error: 'Edit list positions in one channel, marketplace and listing at a time to preserve its other values.' })
        continue
      }
      if (changes.some(other => other?.id === c.id && other.field === c.field)) {
        errors.push({ id: c.id, field: raw.field, error: 'Edit the whole list separately from its individual positions.' })
        continue
      }
      const baseKey = c.field.replace(/^attr_/, '').replace(/^(amazon|ebay)_/, '')
      const exact = c.target === 'channel' ? rowContract.get(c.id)?.get(baseKey) : undefined
      const maxSlots = exact?.cardinality?.max ?? 1000
      if (slotOf.index > maxSlots) {
        errors.push({ id: c.id, field: raw.field, error: `This field supports at most ${maxSlots} values for the selected category` })
        continue
      }
      let slotValue: unknown = c.value
      if (slotValue !== null && slotValue !== undefined && typeof slotValue !== 'string' && typeof slotValue !== 'number' && typeof slotValue !== 'boolean') {
        errors.push({ id: c.id, field: raw.field, error: 'A slot takes one value, not a list' })
        continue
      }
      if (typeof slotValue === 'string') {
        const t = slotValue.trim()
        slotValue = t === '' ? null : t
      }
      // #489 — the cap of the SLOT column the sheet shows (`bulletPoints_3` → 700), not of the list.
      const slotColumnKey = `${c.field.replace(/^attr_/, '').replace(/^(amazon|ebay)_/, '')}_${slotOf.index}`
      const slotCapErr = capViolation(slotColumnKey, slotValue, c.target === 'channel' ? c.id : undefined)
      if (slotCapErr) {
        errors.push({ id: c.id, field: raw.field, error: slotCapErr })
        continue
      }
      validated.push({ id: c.id, field: c.field, value: slotValue, cascade: !!c.cascade, target: c.target, slot: slotOf.index })
      continue
    }

    let value: any = c.value

    // Category attributes (attr_*) — text + select fields. Trim text,
    // pass select values through (validation already gated above).
    if (isAttr) {
      // AM.1 — INTO the column's shape, or refused. A scalar column still trims; a list column takes
      // an array (per-item cap below); a measure takes { value, unit } with a known unit.
      const rowColumn = (c.target === 'channel' ? rowContract : masterRowContract).get(c.id)?.get(c.field.replace(/^attr_/, ''))
      if (primaryContext?.channel === 'ETSY' && isReferenceField(c.field.slice(5)) && typeof value === 'number' && Number.isSafeInteger(value)) value = String(value)
      if (isReferenceField(c.field.slice(5)) && value != null && typeof value !== 'string') {
        errors.push({ id: c.id, field: c.field, error: 'Enter a reference name or ID as text.' })
        continue
      }
      if (rowColumn?.shopifyField) {
        const field = rowColumn.shopifyField
        if (c.cascade) { errors.push({ id: c.id, field: c.field, error: 'Shopify fields belong to exact product or variant rows. Select the intended rows explicitly instead of cascading a parent value.' }); continue }
        const raw = value == null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value)
        const store = storeFor(c.id, c.field.replace(/^attr_/, ''))
        const translation = store?.kind === 'platformAttributes' && store.path[0] === '_shopifyInformationLocales'
        const error = field.reason ?? (field.definition && raw !== null ? shopifyDefinitionApplicability(field.definition, rowCategoryById.get(c.id)) : null) ?? (translation && raw === null ? null : field.definition ? validateShopifyField(field.definition, raw) : nativeFieldValueError(field.id as NativeEdit['field'], raw))
        if (error) { errors.push({ id: c.id, field: c.field, error }); continue }
        if (field.definition && field.currency && raw !== null && JSON.parse(raw).currency_code !== field.currency) { errors.push({ id: c.id, field: c.field, error: `Use this Shopify store’s ${field.currency} currency.` }); continue }
        // Metafield strings are Shopify's wire format, including JSON and explicit empty text.
        // Never run text trimming, Number coercion or slot flattening on them.
        const stored = field.definition ? raw : raw === null ? null : field.id === 'tags' || field.id === 'weight' || field.id === 'unitPriceMeasurement' ? JSON.parse(raw)
          : field.type === 'boolean' ? raw === 'true' : raw
        validated.push({ id: c.id, field: c.field, value: stored, cascade: !!c.cascade, target: c.target })
        continue
      }
      const facts = rowColumn ? factsOf(rowColumn) : columnFactsByKey.get(c.field.replace(/^attr_/, ''))
      // A display name can exceed the ID's cap. Resolve it before validating the stored form.
      const reference = isReferenceField(c.field.slice(5))
      const shaped = coerceForShape(reference ? { key: c.field, shape: 'scalar', kind: 'text' } : facts, value)
      if (shaped.ok === false) {
        // (`strictNullChecks` is off here, so the discriminated union does not narrow by itself.)
        errors.push({ id: c.id, field: c.field, error: (shaped as { error: string }).error })
        continue
      }
      value = (shaped as { value: unknown }).value
      // #489 — refuse an over-cap value with the SAME sentence the sheet shows; per item for a list.
      const capErr = reference ? null : Array.isArray(value)
        ? value.map((item, i) => { const e = capViolation(c.field, item, c.target === 'channel' ? c.id : undefined); return e ? `value ${i + 1}: ${e}` : null }).find((e) => e) ?? null
        : capViolation(c.field, value, c.target === 'channel' ? c.id : undefined)
      if (capErr) {
        errors.push({ id: c.id, field: c.field, error: capErr })
        continue
      }
      validated.push({
        id: c.id,
        field: c.field,
        value,
        cascade: !!c.cascade,
        target: c.target,
      })
      continue
    }

    // Channel fields are all text in D.3d (title, description). Trim,
    // null on empty.
    if (isCh) {
      if (['price', 'quantity'].includes(CHANNEL_FIELD_MAP[c.field])) {
        const n = value === null || value === '' ? null : Number(value)
        if (n === null || !Number.isFinite(n) || n < 0 || CHANNEL_FIELD_MAP[c.field] === 'quantity' && !Number.isSafeInteger(n)) {
          errors.push({ id: c.id, field: c.field, error: 'Enter a non-negative number; quantity must be a whole number' })
          continue
        }
        const numericError = numericStorageError(CHANNEL_FIELD_MAP[c.field], n)
        if (numericError) {
          errors.push({ id: c.id, field: c.field, error: numericError })
          continue
        }
        validated.push({ id: c.id, field: c.field, value: n, cascade: !!c.cascade, target: c.target })
        continue
      }
      // AM.1 — the bullet override column is an ARRAY; a whole-list write arrives as one.
      if (CHANNEL_FIELD_MAP[c.field] === 'bulletPointsOverride') {
        const list = coerceForShape({ key: c.field, shape: 'list' }, value)
        if (list.ok === false) {
          errors.push({ id: c.id, field: c.field, error: list.error })
          continue
        }
        validated.push({ id: c.id, field: c.field, value: list.value ?? [], cascade: !!c.cascade, target: c.target })
        continue
      }
      if (typeof value !== 'string' && value !== null && value !== undefined) {
        value = String(value)
      }
      if (typeof value === 'string') {
        const trimmed = value.trim()
        value = trimmed === '' ? null : trimmed
      }
      // Length validation (lightweight — frontend already enforces)
      if (
        typeof value === 'string' &&
        c.field === 'amazon_title' &&
        value.length > 200
      ) {
        errors.push({
          id: c.id,
          field: c.field,
          error: 'Amazon title max 200 characters',
        })
        continue
      }
      if (
        typeof value === 'string' &&
        c.field === 'ebay_title' &&
        value.length > 80
      ) {
        errors.push({
          id: c.id,
          field: c.field,
          error: 'eBay title max 80 characters',
        })
        continue
      }
      // #489 — refuse an over-cap value with the SAME sentence the sheet shows.
      const capErr = capViolation(c.field, value, c.target === 'channel' ? c.id : undefined)
      if (capErr) {
        errors.push({ id: c.id, field: c.field, error: capErr })
        continue
      }
      validated.push({ id: c.id, field: c.field, value, cascade: !!c.cascade, target: c.target })
      continue
    }

    if (NUMERIC_FIELDS.has(c.field)) {
      if (value === '' || value === null || value === undefined) {
        value = null
      } else {
        const n = numericFromLocale(value)
        const numericError = numericStorageError(c.field, n)
        if (numericError) {
          errors.push({ id: c.id, field: c.field, error: numericError })
          continue
        }
        value = n
      }
    } else if (c.field === 'weightUnit') {
      const v = String(value ?? '').toLowerCase()
      if (!WEIGHT_UNIT_VALUES.has(v)) {
        errors.push({
          id: c.id,
          field: c.field,
          error: `Weight unit must be one of ${Array.from(WEIGHT_UNIT_VALUES).join(', ')}`,
        })
        continue
      }
      value = v
    } else if (c.field === 'dimUnit') {
      const v = String(value ?? '').toLowerCase()
      if (!DIM_UNIT_VALUES.has(v)) {
        errors.push({
          id: c.id,
          field: c.field,
          error: `Dimension unit must be one of ${Array.from(DIM_UNIT_VALUES).join(', ')}`,
        })
        continue
      }
      value = v
    } else if (c.field === 'gtin') {
      // Empty / null clears it.
      if (value === '' || value === null || value === undefined) {
        value = null
      } else {
        const digits = String(value).replace(/\D/g, '')
        if (digits.length < 8 || digits.length > 14) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'GTIN must be 8–14 digits',
          })
          continue
        }
        value = digits
      }
    } else if (INTEGER_FIELDS.has(c.field)) {
      if (value === '' || value === null || value === undefined) {
        value = 0
      } else {
        const n = numericFromLocale(value)
        const numericError = numericStorageError(c.field, n)
        if (numericError) {
          errors.push({ id: c.id, field: c.field, error: numericError })
          continue
        }
        value = n
      }
    } else if (c.field === 'status') {
      const v = String(value ?? '').toUpperCase()
      if (!STATUS_VALUES.has(v)) {
        errors.push({
          id: c.id,
          field: c.field,
          error: `Status must be one of ${Array.from(STATUS_VALUES).join(', ')}`,
        })
        continue
      }
      value = v
    } else if (c.field === 'fulfillmentChannel') {
      if (value === '' || value === null || value === undefined) {
        value = null
      } else {
        const v = String(value).toUpperCase()
        if (!CHANNEL_VALUES.has(v)) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Channel must be one of ${Array.from(CHANNEL_VALUES).join(', ')}`,
          })
          continue
        }
        value = v
      }
    } else if (c.field === 'bulletPoints' || c.field === 'keywords') {
      // W1.4 — string[] master fields. Accept array literally or a
      // JSON-string payload (the bulk-ops grid pastes JSON; the
      // edit-page form sends a real array). Empty / null clears
      // the column. Caps at 20 entries; trims each; drops blanks.
      let arr: unknown[] | null = null
      if (value === null || value === undefined || value === '') {
        arr = []
      } else if (Array.isArray(value)) {
        arr = value as unknown[]
      } else if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value)
          arr = Array.isArray(parsed) ? parsed : null
        } catch {
          arr = null
        }
      }
      if (arr === null) {
        errors.push({
          id: c.id,
          field: c.field,
          error: `${c.field} must be a string array or JSON array`,
        })
        continue
      }
      if (arr.some(x => typeof x !== 'string')) {
        errors.push({ id: c.id, field: c.field, error: `${c.field} must contain text values only` })
        continue
      }
      const cleaned = (arr as string[]).map(x => x.trim()).filter(x => x.length > 0)
      value = cleaned
    } else if (c.field === 'hsCode') {
      // W1.4 — HS tariff code, digit string (6, 8 or 10 digits in
      // most jurisdictions; we accept dots/spaces and strip them).
      // Empty / null clears.
      if (value === null || value === undefined || value === '') {
        value = null
      } else {
        const raw = String(value).replace(/[\s.]/g, '')
        if (!/^\d{4,12}$/.test(raw)) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'hsCode must be 4–12 digits (dots and spaces ignored)',
          })
          continue
        }
        value = raw
      }
    } else if (c.field === 'countryOfOrigin') {
      // W1.4 — ISO 3166-1 alpha-2, upper-case. Empty / null clears.
      if (value === null || value === undefined || value === '') {
        value = null
      } else {
        const raw = String(value).trim().toUpperCase()
        if (!/^[A-Z]{2}$/.test(raw)) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'countryOfOrigin must be a 2-letter ISO country code',
          })
          continue
        }
        value = raw
      }
    } else if (c.field === 'ppeCategory') {
      // W7.1 — PPE Directive 2016/425 category. Empty / null clears.
      const VALID_PPE = new Set(MASTER_FIELD_OPTIONS.ppeCategory)
      if (value === null || value === undefined || value === '') {
        value = null
      } else if (!VALID_PPE.has(String(value))) {
        errors.push({
          id: c.id,
          field: c.field,
          error: 'ppeCategory must be CAT_I, CAT_II, or CAT_III',
        })
        continue
      }
    } else if (c.field === 'garmentClass') {
      // C4 — EN 17092 garment class. Empty / null clears.
      const VALID_CLASS = new Set(MASTER_FIELD_OPTIONS.garmentClass)
      if (value === null || value === undefined || value === '') {
        value = null
      } else if (!VALID_CLASS.has(String(value).toUpperCase())) {
        errors.push({ id: c.id, field: c.field, error: 'garmentClass must be AAA, AA, A, B, or C (EN 17092)' })
        continue
      } else {
        value = String(value).toUpperCase()
      }
    } else if (c.field === 'impactProtectors') {
      // C4 — JSON array of { zone, standard, level }. Empty / null clears.
      if (value === null || value === undefined || value === '') {
        value = null
      } else if (!Array.isArray(value)) {
        errors.push({ id: c.id, field: c.field, error: 'impactProtectors must be an array of { zone, standard, level }' })
        continue
      } else {
        value = (value as any[])
          .map((p) => ({
            zone: p?.zone != null ? String(p.zone) : null,
            standard: p?.standard != null ? String(p.standard) : null,
            level: p?.level != null ? String(p.level) : null,
          }))
          .filter((p) => p.zone || p.standard || p.level)
      }
    } else if (c.field === 'isParent') {
      // GTIN.3 / Step 4 — boolean coercion. Accept true/false +
      // their string forms ("true"/"false", "1"/"0") since the
      // bulk-ops grid sometimes pastes JSON-stringified payloads.
      if (typeof value === 'boolean') {
        // already correct
      } else if (
        value === 'true' ||
        value === '1' ||
        value === 1
      ) {
        value = true
      } else if (
        value === 'false' ||
        value === '0' ||
        value === 0 ||
        value === '' ||
        value === null ||
        value === undefined
      ) {
        value = false
      } else {
        errors.push({
          id: c.id,
          field: c.field,
          error: 'isParent must be a boolean',
        })
        continue
      }
    } else if (c.field === 'parentId') {
      // GTIN.3 / Step 4 — FK to another Product.id. Empty / null
      // unsets the parent link. A non-existent FK would be caught
      // by Prisma; we don't pre-validate here to keep the bulk
      // path narrow.
      if (value === null || value === undefined || value === '') {
        value = null
      } else if (typeof value !== 'string') {
        value = String(value).trim() || null
      } else {
        value = value.trim() || null
      }
    } else {
      // text fields — trim, coerce empty string to null only for
      // optional fields. name + sku are required, leave as-is.
      if (typeof value !== 'string' && value !== null && value !== undefined) {
        value = String(value)
      }
      if (c.field === 'sku') {
        const trimmed = typeof value === 'string' ? value.trim() : ''
        if (!trimmed) {
          errors.push({ id: c.id, field: c.field, error: 'SKU cannot be empty' })
          continue
        }
        value = trimmed
      } else if (c.field === 'name') {
        if (!value || (typeof value === 'string' && value.trim().length === 0)) {
          errors.push({ id: c.id, field: c.field, error: 'Name cannot be empty' })
          continue
        }
        value = (value as string).trim()
      } else if (typeof value === 'string') {
        const trimmed = value.trim()
        value = trimmed === '' ? null : trimmed
      }
    }

    // #489 — refuse an over-cap value with the SAME sentence the sheet shows.
    const capErr = capViolation(c.field, value, c.target === 'channel' ? c.id : undefined)
    if (capErr) {
      errors.push({ id: c.id, field: c.field, error: capErr })
      continue
    }
    validated.push({ id: c.id, field: c.field, value, cascade: !!c.cascade, target: c.target })
  }

  // Pre-validate SKU uniqueness — catches conflicts before the transaction
  // so the user gets a clear "SKU already in use" error rather than a
  // generic P2002 database exception.
  const skuChanges = validated.filter((v) => v.field === 'sku' && typeof v.value === 'string')
  if (skuChanges.length > 0) {
    const conflicting = await prisma.product.findMany({
      where: {
        sku: { in: skuChanges.map((v) => String(v.value)) },
        id: { notIn: skuChanges.map((v) => v.id) },
        deletedAt: null,
      },
      select: { sku: true },
    })
    for (const conflict of conflicting) {
      const idx = validated.findIndex((v) => v.field === 'sku' && v.value === conflict.sku)
      if (idx !== -1) {
        errors.push({ id: validated[idx].id, field: 'sku', error: `SKU "${conflict.sku}" is already used by another product` })
        validated.splice(idx, 1)
      }
    }
  }

  // Phase 1 — SKU rename safety guard. Product.sku doubles as the
  // channel seller-SKU, which Amazon/eBay treat as permanent: renaming
  // a product that's live on a channel would silently desync the live
  // listing (the channel keeps the old seller-SKU forever). Block only
  // the sku change — other fields in the same PATCH still apply — until
  // the channel-safe rename path ships. Drafts/unpublished products
  // rename freely. "Live" matches the app's own definition:
  // listingStatus ACTIVE && isPublished (see coverage rollup above).
  const skuRenameIds = validated
    .filter((v) => v.field === 'sku' && typeof v.value === 'string')
    .map((v) => v.id)
  if (skuRenameIds.length > 0) {
    const liveListings = await prisma.channelListing.findMany({
      where: {
        listingStatus: 'ACTIVE',
        isPublished: true,
        OR: [
          { productId: { in: skuRenameIds } },
          { product: { parentId: { in: skuRenameIds } } },
        ],
      },
      select: {
        channel: true,
        productId: true,
        product: { select: { parentId: true } },
      },
    })
    const renameIdSet = new Set(skuRenameIds)
    const liveChannelsByOwner = new Map<string, Set<string>>()
    for (const l of liveListings) {
      // A listing blocks the rename of its own product (productId in the
      // set) or, for a child listing, of the parent being renamed.
      const owner = renameIdSet.has(l.productId)
        ? l.productId
        : l.product?.parentId
      if (!owner || !renameIdSet.has(owner)) continue
      const set = liveChannelsByOwner.get(owner) ?? new Set<string>()
      set.add(l.channel)
      liveChannelsByOwner.set(owner, set)
    }
    for (const [owner, channels] of liveChannelsByOwner) {
      const idx = validated.findIndex(
        (v) => v.field === 'sku' && v.id === owner,
      )
      if (idx !== -1) {
        errors.push({
          id: owner,
          field: 'sku',
          error: `Can't change the SKU while this product is live on ${Array.from(
            channels,
          ).join(
            ', ',
          )} — the channel seller-SKU can't be renamed in place. Unpublish it first, or use the channel-safe rename (coming soon).`,
        })
        validated.splice(idx, 1)
      }
    }
  }

  const aliasTargets = effectiveContexts.flatMap(ctx => {
    const aliasKey = (ctx as { aliasKey?: string }).aliasKey
    if (!aliasKey) return []
    const ids = [...new Set(validated.filter(v => isChannelChange(v) && (!channelOf(v.field) || channelOf(v.field) === ctx.channel)).map(v => v.id))]
    return ids.map(productId => ({ productId, channel: ctx.channel, marketplace: ctx.marketplace, connectionId: connFor.get(ctx.channel) ?? null, aliasKey }))
  })
  if (aliasTargets.length) {
    const { validateAliasWriteTargets } = await import('../pim/listing-alias.service.js')
    await validateAliasWriteTargets(aliasTargets)
  }

  // ── #675 — a no-op write must not spend a version ──────────────────
  //
  // A cell whose incoming value EQUALS the stored one is dropped here: it
  // spends no version, writes no audit row, and is not counted in `updated`.
  // A version spent on a no-op makes every CAS holder stale for nothing, and
  // the next legitimate write then reports a conflict that never happened.
  //
  // BOUNDED to requests carrying `expectedVersion`, deliberately. Those
  // callers — the sheet editors and the drawer — are exactly the ones whose
  // version economy matters; the tokenless bulk-ops paths gain nothing and
  // would pay this read on the widest requests. **The bound is a bound: a
  // tokenless PATCH behaves exactly as before.**
  //
  // ONE batched read per request, never one per cell — the autosave path is
  // already the slow half of the operator's edit.
  //
  // "Equal" is SEMANTIC, not textual: for the override bag compare the KEY's
  // value, never the serialised bag (a merge that reorders keys is still a
  // no-op, and comparing JSON strings would call it a change); scalars are
  // compared after the route's own normalisation, the one that makes 5 and
  // "5" the same edit.
  // Resolve seller/theme references before equality checks and persistence. Display labels from
  // the browser are never authoritative; the same resolver serves import preview and apply.
  const normalizedChanges: Array<{ id: string; field: string; value: unknown }> = []
  const references = validated.filter(v => isCategoryAttrField(v.field) && isReferenceField(v.field.slice(5)) && !v.reset)
  if (references.length) {
    const resolveReference = createReferenceResolver()
    const scope = effectiveContexts.length === 1 ? primaryContext : null
    const refused = new Set<Validated>()
    try {
      const listings = scope ? await prisma.channelListing.findMany({ where: {
        productId: { in: [...new Set(references.map(v => v.id))] }, channel: scope.channel, marketplace: scope.marketplace,
        channelConnectionId: connFor.get(scope.channel) ?? null, aliasKey: scope.aliasKey ?? '',
      } }) : []
      const listingsByProduct = new Map(listings.map(listing => [listing.productId, listing]))
      for (const change of references) {
        const field = change.field.slice(5)
        if (!isReferenceField(field)) continue
        try {
          if (!scope || change.target !== 'channel') throw new Error('Assign this reference in one channel, account and marketplace at a time.')
          const listing = listingsByProduct.get(change.id)
          const previous = listing ? readStoredChannelValue(storeFor(change.id, field), listing as unknown as Record<string, unknown>, [field]) : undefined
          // Keeping a stored ID is not a new assignment, including a retired or unavailable ID.
          if (previous !== undefined && previous === change.value) continue
          const value = await resolveReference({ field, value: change.value, channel: scope.channel, marketplace: scope.marketplace,
            accountId: connFor.get(scope.channel), productType: rowCategoryById.get(change.id) })
          const column = rowContract.get(change.id)?.get(field)
          const checked = coerceForShape(column ? { ...factsOf(column), options: undefined, mode: 'open' } : undefined, value)
          if (checked.ok === false) throw new Error(checked.error)
          if (checked.value !== change.value) normalizedChanges.push({ id: change.id, field: change.field, value: checked.value })
          change.value = checked.value
        } catch (error) {
          errors.push({ id: change.id, field: change.field, error: error instanceof Error ? error.message : 'This reference could not be verified. Try again.' })
          refused.add(change)
        }
      }
    } catch {
      for (const change of references) {
        errors.push({ id: change.id, field: change.field, error: 'The existing reference could not be read. Reload and try again.' })
        refused.add(change)
      }
    }
    for (let index = validated.length - 1; index >= 0; index--) if (refused.has(validated[index])) validated.splice(index, 1)
  }
  const noOpKeys = new Set<string>()
  // #689(1) — a request that changes nothing still answers with the row's
  // CURRENT version, so a caller holding a stale token learns it is behind
  // WITHOUT a 409 for a write that would have changed nothing. Read from the
  // row the equality pass already fetched: no extra query.
  let noOpCurrentVersion: number | null = null
  let noOpVersionOf: 'product' | 'channelListing' | null = null
  let noOpMasterCount = 0
  let noOpChannelCount = 0
  if (expectedVersion !== undefined && validated.length > 0) {
    try {
      const ids = [...new Set(validated.map((v) => v.id))]
      const [prodRows, listingRows] = await Promise.all([
        prisma.product.findMany({ where: { id: { in: ids } } }),
        effectiveContexts.length > 0
          ? prisma.channelListing.findMany({
              where: {
                productId: { in: ids },
                channel: { in: effectiveContexts.map((c) => c.channel) as never },
                marketplace: { in: effectiveContexts.map((c) => c.marketplace) },
                OR: effectiveContexts.map(ctx => ({ channel: ctx.channel, marketplace: ctx.marketplace,
                  aliasKey: (ctx as { aliasKey?: string }).aliasKey ?? '', channelConnectionId: connFor.get(ctx.channel) ?? null })),
              },
              // #700(iii) — NO `select`. A mapped channel field lives in a real
              // COLUMN on ChannelListing (`title`, `description`), not in
              // `overrideData`; selecting the bag alone made every mapped
              // same-value write look like a change. The row carries the bag
              // too, so the attr_* path is unaffected.
            })
          : Promise.resolve([]),
      ])
      const prodById = new Map(prodRows.map((p) => [p.id, p as unknown as Record<string, unknown>]))
      const listingFor = (pid: string) =>
        (listingRows.find((r) => r.productId === pid) ?? null) as Record<string, unknown> | null
      const bagFor = (pid: string) => {
        return (listingFor(pid)?.overrideData ?? {}) as Record<string, unknown>
      }
      const same = (a: unknown, b: unknown) => {
        if (a === b || (a === null && b === undefined) || (a === undefined && b === null)) return true
        // AM.1 — arrays and measures compare by VALUE, never by `String()` (which makes every
        // object `[object Object]` and every array its joined items).
        if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object')) {
          return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
        }
        return String(a ?? '') === String(b ?? '')
      }
      for (const v of validated) {
        if (currentFormulaWrite(context.formulaWriteToken)?.operations) continue
        // Pin/reset changes provenance even when the displayed value stays the same. Comparing
        // one listing also cannot establish a no-op across several requested coordinates.
        if (v.reset || changes.some(c => c.id === v.id && c.intent === 'pin' &&
          (parseSlotField(c.field)?.base ?? c.field) === v.field)) continue
        if (isChannelChange(v) && effectiveContexts.length !== 1) continue
        const row = prodById.get(v.id)
        if (!row) continue
        let current: unknown
        if (isChannelChange(v)) {
          // #689 — the bag key is the WRITER's key, not the field name.
          // A prefixed channel field is stored stripped through
          // CHANNEL_FIELD_MAP (`amazon_title` → `title`, :2175); reading
          // `v.field` compared against a key the bag NEVER has, so `current`
          // was always undefined and no same-value `amazon_title`/`ebay_title`
          // write was ever skipped. Safe direction (it wrote where it could
          // have skipped), but #675 simply did not reach these fields.
          //
          // Keyed on the FIELD, not on `v.target`: the write routes on
          // `isChannelField(v.field)` alone (:2409), independent of `target`,
          // so the read must use the same test or the two disagree for a
          // caller that omits `target`. One map, never a mirror.
          // TWO stores behind one channel layer, measured 2026-09-02:
          //   attr_* + target:'channel' → the `overrideData` JSONB bag
          //   mapped/prefixed fields    → a real COLUMN (`title`,
          //                               `description`), written by
          //                               `upsertChannelListings` as a column
          // Reading the bag for a mapped field returns undefined forever,
          // which is what #692 did — right key, wrong store.
          if (isCategoryAttrField(v.field)) {
            const stripped = v.field.replace(/^attr_/, '')
            const store = storeFor(v.id, stripped)
            if (store?.kind === 'listingColumn') {
              current = readStoredChannelValue(store, listingFor(v.id) ?? {}, [stripped, v.field])
            } else if (store?.kind === 'platformAttributes') {
              // AM.1 — the store this write LANDS on (rehearsal 2026-09-05: a `null` restore of an
              // eBay subtitle was swallowed as "unchanged" because the bag never held the key).
              const bag = listingFor(v.id)?.platformAttributes
              const val = readPath(bag, store.path)
              current = store.unitPath && v.value && typeof v.value === 'object' && !Array.isArray(v.value)
                ? { value: val ?? null, unit: readPath(bag, store.unitPath) ?? null }
                : val
            } else {
              current = bagFor(v.id)[stripped]
            }
          } else {
            current = listingFor(v.id)?.[CHANNEL_FIELD_MAP[v.field]]
          }
        }
        else if (isCategoryAttrField(v.field)) {
          current = ((row.categoryAttributes ?? {}) as Record<string, unknown>)[v.field.replace(/^attr_/, '')]
        } else current = row[v.field]
        // A SLOT change compares against its own position in the current list.
        if (v.slot !== undefined) current = (readListValue(current) ?? [])[v.slot - 1] ?? null
        if (isChannelChange(v) && current === undefined) continue
        if (same(current, v.value)) {
          noOpKeys.add(`${v.id}:${v.field}`)
          // Same predicate as the READ above and as the write at :2409 —
          // `isChannelField` OR an explicit channel target. Keying this on
          // `v.target` alone (as it first did) attributed a mapped
          // `amazon_title` no-op to the PRODUCT and handed back the product's
          // version for a cell that lives on the listing: the two tests
          // disagreed, which is how it was caught.
          if (isChannelChange(v)) noOpChannelCount++
          else noOpMasterCount++
        }
      }
      // Which row does the caller's token belong to? The same question the
      // 409 path answers at the bottom of this handler, and for the same
      // reason: a channel write CASes the LISTING, so handing back
      // `Product.version` gives a number from a different row (seen: 1 while
      // the listing was at 19) that no client can recover with. Mirror the
      // success path's choice rather than assuming 'product'.
      if (noOpKeys.size > 0) {
        if (noOpMasterCount === 0 && noOpChannelCount > 0) {
          // Only claim a listing version when exactly one listing is in
          // play; with several coordinates there is no single right answer,
          // and a wrong number is worse than none.
          if (listingRows.length === 1) {
            noOpCurrentVersion = (listingRows[0] as { version?: number }).version ?? null
            noOpVersionOf = 'channelListing'
          }
        } else {
          noOpCurrentVersion = (prodRows[0] as { version?: number } | undefined)?.version ?? null
          noOpVersionOf = 'product'
        }
      }
    } catch {
      // A comparison we cannot make is not a reason to refuse the write: fall
      // through and behave exactly as before. Skipping a real change would be
      // far worse than spending a version on a no-op.
    }
  }
  if (noOpKeys.size > 0) {
    for (let i = validated.length - 1; i >= 0; i--) {
      if (noOpKeys.has(`${validated[i].id}:${validated[i].field}`)) validated.splice(i, 1)
    }
  }

  if (primaryContext && ['AMAZON', 'EBAY', 'ETSY'].includes(primaryContext.channel)) {
    const candidates = validated.filter(isChannelChange)
    if (candidates.length) {
      try {
        const { informationChangeErrors } = await import('../pim/information-validation.js')
        const listings = await prisma.channelListing.findMany({ where: { productId: { in: [...new Set(candidates.map(c => c.id))] },
          channel: primaryContext.channel, marketplace: primaryContext.marketplace, channelConnectionId: connFor.get(primaryContext.channel) ?? null, aliasKey: primaryContext.aliasKey ?? '' } })
        const issues = await informationChangeErrors({ ...primaryContext, accountId: connFor.get(primaryContext.channel), changes: candidates, listings, columns: rowContract })
        errors.push(...issues)
        const refused = new Set(issues.map(issue => issue.id))
        for (let i = validated.length - 1; i >= 0; i--) if (isChannelChange(validated[i]) && refused.has(validated[i].id)) validated.splice(i, 1)
      } catch (error) {
        for (const candidate of candidates) errors.push({ id: candidate.id, field: candidate.field, error: `Information validation is unavailable: ${error instanceof Error ? error.message : String(error)}` })
        for (let i = validated.length - 1; i >= 0; i--) if (candidates.includes(validated[i])) validated.splice(i, 1)
      }
    }
  }

  // ── DRY RUN — validation is done; nothing below this point may run ──
  // Placed ABOVE the empty-validation branch deliberately: that branch writes
  // a `BulkOperation` row, and a preview must not leave a job record behind.
  if (input?.dryRun === true) {
    return {
      dryRun: true,
      wouldUpdate: validated.length,
      errors,
      ...(normalizedChanges.length ? { normalizedChanges } : {}),
    }
  }

  // #675 — everything was a no-op. This is a SUCCESS with nothing to do, not
  // a validation failure: the branch below returns 400 and writes a FAILED
  // BulkOperation row, which would tell an operator their save failed because
  // the value was already right. `updated: 0` with no `errors[]` is what the
  // client already paints as saved.
  if (validated.length === 0 && errors.length === 0 && noOpKeys.size > 0) {
    return {
      success: true,
      updated: 0,
      unchanged: noOpKeys.size,
      ...(normalizedChanges.length ? { normalizedChanges } : {}),
      cascadeCount: 0,
      affectedChildren: 0,
      elapsedMs: 0,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      // Never the echoed token — that would tell a stale client it is current.
      ...(noOpCurrentVersion !== null && noOpVersionOf !== null
        ? { currentVersion: noOpCurrentVersion, versionOf: noOpVersionOf }
        : {}),
    }
  }

  // Nothing survived validation — do not open a transaction
  if (validated.length === 0) {
    await prisma.bulkOperation.create({
      data: {
        changeCount: changes.length,
        productCount: new Set(changes.map((c) => c.id)).size,
        changes: changes as any,
        status: 'FAILED',
        // P10 — the token the REQUEST carried, or null when it carried none.
        // Without it an audit row cannot say whether the write it records was
        // version-guarded: the token is a top-level request field, so
        // `changes` never held it, and a token this route could not parse used
        // to vanish without trace (AIREON, 2026-09-02).
        expectedVersion: expectedVersion ?? null,
        errors: errors as any,
      },
    })
    throw new ProductBulkError(400, { errors })
  }

  // Apply survivors atomically. Per-row updates in a single
  // transaction (array form). With serverless max:1 connection and
  // sequential transactions, this is ~13ms per row.
  //
  // D.3c additions:
  //   - cascade=true: pre-fetches children for each cascading parent,
  //     adds extra updates for each child. cascadedFields gets the
  //     field name appended (deduped on read; allowing dups is fine
  //     and avoids an extra round-trip per child).
  //   - cascade=false on a child: removes the field from the child's
  //     cascadedFields array via raw SQL array_remove, so a direct
  //     edit cleanly overrides any prior cascade.
  try {
    const startTs = Date.now()
    const productIds = new Set(validated.map((v) => v.id))

    // Pre-fetch which validated targets are children (parentId set).
    // Used to decide whether to call array_remove on cascadedFields
    // when applying a non-cascade change.
    const targetIds = Array.from(productIds)
    // PES.5 — this findMany already runs; it now also carries the values the
    // audit trail needs for `before`, so capturing the previous value costs no
    // extra round-trip. The two JSONB bags are pulled ONLY on the
    // single-product path (`expectedVersion`/If-Match — how the Product Edit
    // Studio autosaves): a catalogue-wide bulk-op can span hundreds of
    // products, and reading two bags per row there would be real weight for a
    // log line. Multi-product bulk-ops keep exactly today's behaviour and log
    // no previous value, which the history API reports honestly rather than
    // rendering as "unchanged".
    const capturePrevious = expectedVersion !== undefined
    const targetProducts = await prisma.product.findMany({
      where: { id: { in: targetIds } },
      select: capturePrevious
        ? { id: true, parentId: true, isParent: true, categoryAttributes: true, localizedContent: true, name: true, description: true, brand: true, manufacturer: true, basePrice: true, bulletPoints: true, keywords: true }
        : { id: true, parentId: true, isParent: true },
    })
    const priorById = new Map(targetProducts.map((p) => [p.id, p as Record<string, unknown>]))
    const childIdSet = new Set(
      targetProducts.filter((p) => p.parentId).map((p) => p.id)
    )

    // ── AM.1 — slot writes → whole-array writes ─────────────────────
    // Read-modify-write on the layer the change lands on, SEEDED from what the cell showed: the
    // layer's own array when it has one, else the master's (own row, then parent) — so pinning
    // bullet 3 on a channel that inherited five bullets keeps the other four. Several slots of one
    // list in one request compose in order. Concurrency is the caller's CAS token, as for any write.
    const slotSnapshots = new Map<string, { id: string; version: number; updatedAt?: Date }>()
    const slotWrites = validated.filter((v) => v.slot !== undefined)
    if (slotWrites.length > 0) {
      const blank = (x: unknown) => x === null || x === undefined || String(x).trim() === ''
      const hasContent = (x: unknown) => (readListValue(x) ?? []).some((i) => !blank(i))
      const ids = [...new Set(slotWrites.map((v) => v.id))]
      const rows = await prisma.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, parentId: true, categoryAttributes: true, bulletPoints: true, keywords: true },
      })
      const parentIds = [...new Set(rows.map((r) => r.parentId).filter((x): x is string => !!x))]
      const parents = parentIds.length
        ? await prisma.product.findMany({ where: { id: { in: parentIds } }, select: { id: true, categoryAttributes: true, bulletPoints: true, keywords: true } })
        : []
      const rowById = new Map(rows.map((r) => [r.id, r as Record<string, unknown>]))
      const parentById = new Map(parents.map((p) => [p.id, p as Record<string, unknown>]))
      const needsListing = slotWrites.some((v) => v.target === 'channel' || isChannelField(v.field))
      const slotListings = needsListing && effectiveContexts.length > 0
        ? await prisma.channelListing.findMany({
            where: {
              productId: { in: ids },
              OR: effectiveContexts.map((ctx) => ({ channel: ctx.channel, marketplace: ctx.marketplace, aliasKey: (ctx as { aliasKey?: string }).aliasKey ?? '', channelConnectionId: connFor.get(ctx.channel) ?? null })),
            },
            select: { id: true, version: true, updatedAt: true, productId: true, channel: true, marketplace: true, aliasKey: true, overrideData: true, platformAttributes: true, bulletPointsOverride: true, followMasterBulletPoints: true },
          })
        : []
      for (const listing of slotListings) slotSnapshots.set(listing.id, listing)
      const listingFor = (pid: string, channel: string | null) =>
        channel ? slotListings.find((l) => l.productId === pid && l.channel === channel) : undefined
      const pickMaster = (r: Record<string, unknown> | undefined, field: string): unknown => {
        if (!r) return undefined
        if (isCategoryAttrField(field)) return ((r.categoryAttributes ?? {}) as Record<string, unknown>)[field.replace(/^attr_/, '')]
        return r[field]
      }
      const masterSeed = (pid: string, field: string): unknown => {
        const row = rowById.get(pid)
        const own = pickMaster(row, field)
        if (hasContent(own)) return own
        const parent = row?.parentId ? parentById.get(String(row.parentId)) : undefined
        return pickMaster(parent, field)
      }
      // Inherited slots must be seeded from the same market mapping as the displayed grid,
      // including localization and transforms, rather than a raw Product array.
      const nativeListKey = (id: string, field: string) => {
        const base = field.replace(/^attr_/, '').replace(/^(amazon|ebay)_/, '')
        const facts = Object.values(rowContract.get(id)?.get(base)?.channels ?? {})[0]
        return facts?.key ?? facts?.attribute ?? null
      }
      let resolvedLists: Awaited<ReturnType<typeof import('../pim/mapping/resolve-batch.service.js').resolveBatch>> | undefined
      const inheritedChannelSeed = async (id: string, field: string): Promise<unknown> => {
        const key = nativeListKey(id, field)
        if (!key) throw new Error('List requirements are unavailable. Reload the channel schema before editing list positions.')
        if (!resolvedLists) {
          const { resolveBatch } = await import('../pim/mapping/resolve-batch.service.js')
          const ctx = effectiveContexts[0]
          resolvedLists = await resolveBatch({ channel: ctx.channel, marketplace: ctx.marketplace,
            aliasKey: (ctx as { aliasKey?: string }).aliasKey ?? '',
            channelConnectionId: connFor.get(ctx.channel) ?? null,
            productIds: ids, fieldKeys: [...new Set(slotWrites.map(v => nativeListKey(v.id, v.field)).filter((key): key is string => !!key))],
            includeCatalogue: false,
          })
        }
        const cell = resolvedLists.products.find(p => p.productId === id)?.cells[key]
        if (!cell) throw new Error('Could not resolve the current channel list. Reload the scope before editing its positions.')
        return cell.value
      }
      const seeds = new Map<string, unknown>()
      for (const v of slotWrites) {
        const prefixed = isChannelField(v.field)
        const ch = prefixed ? channelOf(v.field) : v.target === 'channel' ? (effectiveContexts[0]?.channel ?? null) : null
        const seedKey = `${v.id}|${v.field}|${v.target ?? ''}`
        let seed = seeds.get(seedKey)
        if (seed === undefined) {
          if (ch) {
            const column = prefixed ? CHANNEL_FIELD_MAP[v.field] : undefined
            const base = v.field.replace(/^attr_/, '')
            const store = column ? { kind: 'listingColumn' as const, column, followFlag: FOLLOW_FLAG_FOR_COLUMN[column] } : storeFor(v.id, base)
            const own = readStoredChannelValue(store, listingFor(v.id, ch), [base])
            try {
              seed = own !== undefined ? own : await inheritedChannelSeed(v.id, v.field)
            } catch (error) {
              context.logger.warn({ err: error }, 'Could not resolve list before slot edit')
              throw new ProductBulkError(503, { error: 'Could not load the current channel list. Reload the scope before editing its positions.' })
            }
          } else {
            seed = masterSeed(v.id, v.field)
          }
        }
        const next = withSlotValue(seed, v.slot as number, v.value)
        seeds.set(seedKey, next)
        v.value = next
        delete v.slot
      }
    }

    // Pre-fetch children for cascading parents.
    const cascadingParents = validated.filter((v) => v.cascade)
    const childrenByParent = new Map<string, string[]>()
    let totalAffectedChildren = 0
    const allAffectedChildIds = new Set<string>()
    if (cascadingParents.length > 0) {
      const parentIds = Array.from(
        new Set(cascadingParents.map((v) => v.id))
      )
      const kids = await prisma.product.findMany({
        where: { parentId: { in: parentIds } },
        select: { id: true, parentId: true },
      })
      for (const k of kids) {
        if (!k.parentId) continue
        let arr = childrenByParent.get(k.parentId)
        if (!arr) {
          arr = []
          childrenByParent.set(k.parentId, arr)
        }
        arr.push(k.id)
        allAffectedChildIds.add(k.id)
      }
      totalAffectedChildren = allAffectedChildIds.size
    }

    // Build the transaction's update list. One Prisma promise per
    // statement; runs serially in array-form $transaction.
    const updates: any[] = []
    const listingGuards = new Map<string, any>()

    // Helper for ChannelListing upsert by (productId, channel,
    // marketplace). R.1 — fans out to every effectiveContext whose
    // channel matches the field's prefix, so one change targets all
    // selected markets in a single transaction. Returns an array of
    // Prisma promises (possibly empty) rather than a single one.
    // The listings a CHANNEL-targeted request writes to. Used to report the
    // version from the row that actually changed rather than from the product.
    const channelListingIdsTouched: string[] = []

    // #700(i)/(ii) — the listings a MAPPED channel write touches.
    //
    // The attr_* coordinate loop already CASes the LISTING and records what
    // it touched (see `siblings` below); the mapped path did neither, so a
    // mapped save was unguarded AND answered with no `currentVersion` at all.
    // PES.3 measured the consequence: without the recorded id the sheet
    // cannot advance `row.listing.version`, so the SECOND consecutive title
    // edit on a row sends a stale token and 409s. Fetched ONCE here, not per
    // context, and only when a token makes it meaningful.
    //
    // #703 — alias-aware. Every context carries its own `aliasKey` ('' = the
    // product's PRIMARY listing), and the CAS must land on the row the write
    // lands on, so the rows are matched per context below rather than
    // filtered to the primary here.
    const casProductId = expectedVersion !== undefined ? validated[0]?.id : undefined
    const mappedListings =
      casProductId !== undefined &&
      effectiveContexts.length > 0 &&
      validated.some((v) => isChannelField(v.field) || v.target === 'channel' && storeFor(v.id, v.field.replace(/^attr_/, ''))?.kind === 'listingColumn')
        ? await prisma.channelListing.findMany({
            where: {
              productId: casProductId,
              channel: { in: effectiveContexts.map((c) => c.channel) as never },
              marketplace: { in: effectiveContexts.map((c) => c.marketplace) },
              OR: effectiveContexts.map(ctx => ({ channel: ctx.channel, channelConnectionId: connFor.get(ctx.channel) ?? null })),
              aliasKey: {
                in: [...new Set(effectiveContexts.map((c) => (c as { aliasKey?: string }).aliasKey ?? ''))],
              },
            },
            select: { id: true, productId: true, channel: true, marketplace: true, aliasKey: true, version: true },
          })
        : []

    const upsertChannelListings = (
      productId: string,
      field: string,
      value: any,
      reset = false,
      declaredStore?: Extract<ChannelStoreFact, { kind: 'listingColumn' }>,
    ) => {
      if (effectiveContexts.length === 0) return []
      const stripped = declaredStore?.column ?? CHANNEL_FIELD_MAP[field]
      if (!stripped) return []
      const expected = channelOf(field)
      const targets = expected
        ? effectiveContexts.filter((ctx) => ctx.channel === expected)
        : effectiveContexts
      return targets.flatMap((ctx) => {
        const channelMarket = `${ctx.channel}_${ctx.marketplace}`
        // #703 — the CONTEXT's aliasKey, not a hardcoded primary. The client
        // sends it (PES.3's writer emits `aliasKey: 'alias-2'` for a row under
        // a non-primary alias and `''` for the primary); this path used to
        // overwrite that with `''`, so a mapped write from an alias row landed
        // on the PRIMARY listing — a silent wrong-row write, and with the
        // listing CAS it would also have guarded the wrong row's version.
        // The attr_* path already reads it this way (:2417).
        const ctxAliasKey = (ctx as { aliasKey?: string }).aliasKey ?? ''
        const stmts: unknown[] = []
        const keys = declaredStore ? [...new Set([stripped, field, field.replace(/^attr_/, ''),
          ...(stripped === 'title' ? ['name', 'item_name'] : [])])] : channelOverrideKeys(field)
        const mutation = channelValueMutation(declaredStore ?? { kind: 'listingColumn', column: stripped,
          followFlag: FOLLOW_FLAG_FOR_COLUMN[stripped] }, keys, reset ? 'INHERIT' : 'SET', value)
        const patch = mutation.columns
        // Only the row the caller's token addresses. A cascade to CHILDREN
        // calls this function too, and CASing a child against the parent's
        // token would refuse a write the token says nothing about.
        const hit =
          productId === casProductId
            ? mappedListings.find(
                (l) =>
                  l.channel === ctx.channel &&
                  l.marketplace === ctx.marketplace &&
                  l.aliasKey === ((ctx as { aliasKey?: string }).aliasKey ?? ''),
              )
            : undefined
        if (hit) {
          if (expectedVersion !== undefined) {
            listingGuards.set(hit.id,
              prisma.channelListing.update({
                where: { id: hit.id, version: expectedVersion },
                // ⚠ VERIFY ONLY — do NOT bump. The upsert below already does
                // `version: { increment: 1 }`; bumping here too would advance
                // the row by TWO while the response reported ONE, and the next
                // write would 409 every time. Prisma still throws P2025 when
                // the version does not match, which is this statement's whole
                // job. Same shape as the attr_* CAS.
                data: { updatedAt: new Date() },
              }),
            )
          }
          // Recorded whether or not a token was sent: this is what makes the
          // response able to report the LISTING's version for a mapped write.
          channelListingIdsTouched.push(hit.id)
        }
        // Prisma cannot target an unattributed listing's null account in a compound unique.
        // A previewed cell already identifies that exact listing, so use its ID in this case.
        stmts.push(hit && !connFor.get(ctx.channel) ? prisma.channelListing.update({
          where: { id: hit.id },
          data: { ...patch, version: { increment: 1 } } as any,
        }) : prisma.channelListing.upsert({
          where: {
            productId_channel_marketplace: workspaceKey({
              productId,
              channel: ctx.channel,
              marketplace: ctx.marketplace,
              channelConnectionId: connFor.get(ctx.channel) ?? null,
              // PES.5 — aliasKey joins the key; '' = the product's PRIMARY listing. NOT NULL because Prisma cannot target a null inside a compound unique.
              aliasKey: ctxAliasKey,
            }),
          },
          create: {
            productId,
            channel: ctx.channel,
            channelMarket,
            region: ctx.marketplace,
            marketplace: ctx.marketplace,
            listingStatus: 'DRAFT',
            // Without this the CREATE branch defaults `aliasKey` to '' — so a
            // first write under a non-primary alias would silently create the
            // PRIMARY row instead of the alias's.
            aliasKey: ctxAliasKey,
            aliasId: ctxAliasKey || null,
            channelConnectionId: connFor.get(ctx.channel) ?? null,
            isPublished: false,
            ...patch,
          } as any,
          // #542(3) — EVERY ChannelListing write bumps the version.
          //
          // Measured: this path left version at 64 while the override-bag path
          // took it 64 → 65 on the same row. A CAS token that only half the
          // writers advance is not a concurrency guard, it is a guard that
          // fails exactly when two writers use different paths — which is the
          // case it exists for. A client holding v64 would have passed CAS
          // after this write and silently overwritten it.
          update: {
            ...patch,
            version: { increment: 1 },
          } as any,
        }))
        if (mutation.overrideRemove.length) {
          const keys = mutation.overrideRemove
          stmts.push(prisma.$executeRaw`
            UPDATE "ChannelListing" SET "overrideData" = COALESCE("overrideData", '{}'::jsonb) - ${keys}::text[]
            WHERE "productId" = ${productId} AND "channel" = ${ctx.channel} AND "marketplace" = ${ctx.marketplace}
              AND "aliasKey" = ${ctxAliasKey} AND "channelConnectionId" IS NOT DISTINCT FROM ${connFor.get(ctx.channel) ?? null}
          `)
        }
        return stmts
      })
    }

    // ── D.3e: pre-group attr_* changes per product ────────────────
    // We MERGE everything for one product into a single jsonb in
    // one UPDATE rather than emitting one statement per attr.
    // Map<productId, Record<strippedKey, value>> — separate maps
    // for direct vs cascade so cascade fan-out can read its own group.
    const attrDirectByProduct = new Map<string, Record<string, any>>()
    const attrResetByProduct = new Map<string, string[]>()
    const attrCascadeByProduct = new Map<string, Record<string, any>>()
    const attrCascadeFieldNames = new Map<string, string[]>() // for cascadedFields tracking

    // Phase 13d — basePrice and totalStock changes route through
    // dedicated services (MasterPriceService / applyStockMovement)
    // AFTER the bulk transaction commits, so the cascade to
    // ChannelListing fires atomically per product. We collect them
    // here, skip the direct prisma.product.update inside the bulk
    // transaction, and process them post-commit. Cascade fan-out to
    // children + cascadedFields markers stay inside the bulk
    // transaction (same place as other field cascades).
    type MasterDataDelta = { productId: string; newValue: number }
    const priceDeltas: MasterDataDelta[] = []
    const stockDeltas: MasterDataDelta[] = []
    const isMasterDataField = (f: string) =>
      f === 'basePrice' || f === 'totalStock'

    // ── PES.5 / #169 — channel-targeted attribute writes ────────────
    // `ChannelListing.overrideData` is the layer the resolver ALREADY reads
    // (attribute-resolver applies it as `channelOverride`, above master and
    // below the explicit *Override columns). Measured 2026-09-01: it is `{}`
    // on all 977 rows with exactly one writer in the API — the cascade was
    // built and never fed. This is the write side, nothing more.
    //
    // Keyed by coordinate so one operator edit fans out across the contexts
    // exactly as R.1 intends, and so each listing gets ONE merged jsonb write
    // rather than one per attribute.
    // The listings a CHANNEL-targeted request writes to. Used to report the
    // version from the row that actually changed rather than from the product.

    const channelAttrByCoord = new Map<
      string,
      { productId: string; channel: string; marketplace: string; aliasKey: string; patch: Record<string, unknown>; remove: string[] }
    >()
    // AM.1 — channel fields whose store is a `platformAttributes` PATH (eBay item specifics and
    // listing settings). Written as a JSON path set on the EXISTING listing — never created here.
    const platformPatchByCoord = new Map<
      string,
      { productId: string; channel: string; marketplace: string; aliasKey: string; remove: string[]; sets: ChannelValueMutation['platform'] }
    >()

    for (const v of validated) {
      if (!isCategoryAttrField(v.field)) continue
      if (v.target === 'channel') {
        const stripped = v.field.replace(/^attr_/, '')
        const store = storeFor(v.id, stripped)
        if (store?.kind === 'listingColumn') {
          updates.push(...upsertChannelListings(v.id, v.field, v.value, v.reset, store))
          continue
        }
        if (store?.kind === 'platformAttributes') {
          for (const ctx of effectiveContexts) {
            const aliasKey = (ctx as { aliasKey?: string }).aliasKey ?? ''
            const key = `${v.id}|${ctx.channel}|${ctx.marketplace}|${aliasKey}`
            let entry = platformPatchByCoord.get(key)
            if (!entry) {
              entry = { productId: v.id, channel: ctx.channel, marketplace: ctx.marketplace, aliasKey, sets: [], remove: [] }
              platformPatchByCoord.set(key, entry)
            }
            const mutation = channelValueMutation(store, [stripped, v.field], v.reset ? 'INHERIT' : 'SET', v.value)
            entry.remove.push(...mutation.overrideRemove)
            entry.sets.push(...mutation.platform)
          }
          continue
        }
        for (const ctx of effectiveContexts) {
          const aliasKey = (ctx as { aliasKey?: string }).aliasKey ?? ''
          const key = `${v.id}|${ctx.channel}|${ctx.marketplace}|${aliasKey}`
          let entry = channelAttrByCoord.get(key)
          if (!entry) {
            entry = { productId: v.id, channel: ctx.channel, marketplace: ctx.marketplace, aliasKey, patch: {}, remove: [] }
            channelAttrByCoord.set(key, entry)
          }
          const mutation = channelValueMutation(undefined, [stripped], v.reset ? 'INHERIT' : 'SET', v.value)
          for (const key of mutation.overrideRemove) { delete entry.patch[key]; if (!entry.remove.includes(key)) entry.remove.push(key) }
          for (const [key, value] of Object.entries(mutation.overrideSet)) {
            entry.remove = entry.remove.filter(removed => removed !== key)
            entry.patch[key] = value
          }
        }
        continue
      }
      const stripped = v.field.replace(/^attr_/, '')
      const target = v.cascade ? attrCascadeByProduct : attrDirectByProduct
      let bag = target.get(v.id)
      if (!bag) {
        bag = {}
        target.set(v.id, bag)
      }
      if (v.reset) {
        attrResetByProduct.set(v.id, [...(attrResetByProduct.get(v.id) ?? []), stripped])
        delete bag[stripped]
      } else bag[stripped] = v.value
      if (v.cascade) {
        let names = attrCascadeFieldNames.get(v.id)
        if (!names) {
          names = []
          attrCascadeFieldNames.set(v.id, names)
        }
        names.push(v.field)
      }
    }

    // attr_* writers — use jsonb merge: COALESCE ensures null becomes
    // empty object first; the || operator does shallow merge so
    // existing keys not in the patch are preserved.
    const writeAttrMerge = (productId: string, patch: Record<string, any>, remove: string[] = []) => {
      const owner = variationOwners.get(productId)
      const axes = owner ? variationAttributePatch(owner, owner.variationAxes, patch, remove) : null
      // One atomic merge within the existing bulk transaction and Product CAS. Unedited axes and
      // unrelated attributes are read from the locked row, never replaced by a stale client bag.
      if (axes?.changed) return prisma.$executeRaw`
        UPDATE "Product"
        SET "categoryAttributes" = ((COALESCE("categoryAttributes", '{}'::jsonb) - ${remove}::text[]) || ${JSON.stringify(patch)}::jsonb)
              || jsonb_build_object('variations',
                ((CASE WHEN jsonb_typeof("categoryAttributes"->'variations') = 'object' THEN "categoryAttributes"->'variations' ELSE '{}'::jsonb END) - ${axes.unset}::text[]) || ${JSON.stringify(axes.set)}::jsonb),
            "variantAttributes" = ((CASE WHEN jsonb_typeof("variantAttributes") = 'object' THEN "variantAttributes" ELSE '{}'::jsonb END) - ${axes.unset}::text[]) || ${JSON.stringify(axes.set)}::jsonb
        WHERE id = ${productId}
      `
      return prisma.$executeRaw`
        UPDATE "Product"
        SET "categoryAttributes" = (COALESCE("categoryAttributes", '{}'::jsonb) - ${remove}::text[]) || ${JSON.stringify(patch)}::jsonb
        WHERE id = ${productId}
      `
    }

    /**
     * PES.5 — merge an attribute patch into ONE listing's `overrideData`.
     *
     * UPSERT rather than UPDATE: every family member currently has a listing
     * on the coordinates that exist (measured: 21/21, 41/41, 50/50), but the
     * sheet legitimately shows a coordinate the family is not listed on yet,
     * and an edit there must stick rather than vanish.
     *
     * ⚠ A listing born this way is `isPublished: false` and `DRAFT`. Typing in
     * a cell must never produce something publishable — the existing 6-field
     * upsert path leaves `isPublished` at its schema default of TRUE, which is
     * a sharper edge than this one needs.
     *
     * `ON CONFLICT` names the five-column key including `aliasKey`, so the
     * merge lands on THE listing the cell belongs to and not on the primary.
     */

    for (const v of validated) {
      // Same function every reader calls. Behaviour-identical here: `attr_*`
      // hits `continue` two lines down before `isCh` is ever read, so this
      // reduces to `isChannelField(v.field)` exactly as before.
      const isCh = isChannelChange(v)
      const isAttr = isCategoryAttrField(v.field)

      // Skip individual attr_* loop iterations — handled in batched
      // writes below the main loop.
      if (isAttr) continue

      // Phase 13d — master-data fields (basePrice, totalStock) get
      // collected for post-commit service dispatch instead of being
      // pushed straight into the bulk transaction. The cascadedFields
      // bookkeeping for children stays in the bulk transaction; only
      // the actual master-data write is hoisted out so the service
      // can run its cascade as a single atomic transaction per
      // product.
      if (isMasterDataField(v.field)) {
        const collector = v.field === 'basePrice' ? priceDeltas : stockDeltas
        const numericValue =
          v.field === 'basePrice'
            ? Number(v.value)
            : Math.max(0, Math.floor(Number(v.value) || 0))
        if (v.field === 'basePrice' && (!Number.isFinite(numericValue) || numericValue < 0)) {
          errors.push({
            id: v.id,
            field: v.field,
            error: 'basePrice must be a non-negative number',
          })
          continue
        }
        if (v.cascade) {
          collector.push({ productId: v.id, newValue: numericValue })
          const kids = childrenByParent.get(v.id) ?? []
          for (const childId of kids) {
            collector.push({ productId: childId, newValue: numericValue })
            // cascadedFields marker for the child stays in the bulk
            // transaction so the visual "inheriting" state lands
            // atomically with the rest of the patch.
            updates.push(
              prisma.product.update({
                where: { id: childId },
                data: { cascadedFields: { push: v.field } } as any,
              }),
            )
          }
        } else if (childIdSet.has(v.id)) {
          // Direct edit on a child — service handles the value
          // write; cascadedFields removal stays here so the
          // "inherited" badge clears atomically.
          collector.push({ productId: v.id, newValue: numericValue })
          updates.push(
            prisma.$executeRaw`
              UPDATE "Product"
              SET "cascadedFields" = array_remove("cascadedFields", ${v.field})
              WHERE id = ${v.id}
            `,
          )
        } else {
          // Direct edit on a parent or standalone.
          collector.push({ productId: v.id, newValue: numericValue })
        }
        continue
      }

      if (v.cascade) {
        // Cascade applies to the parent itself + all its children.
        // For channel fields, each "update" is a ChannelListing
        // upsert in the active marketplace context. cascadedFields
        // tracking still goes on the Product row so children can be
        // visually distinguished as inheriting.
        if (isCh) {
          updates.push(...upsertChannelListings(v.id, v.field, v.value, v.reset))
          const kids = childrenByParent.get(v.id) ?? []
          for (const childId of kids) {
            updates.push(
              ...upsertChannelListings(childId, v.field, v.value),
            )
            // Track on Product.cascadedFields with the prefixed name
            updates.push(
              prisma.product.update({
                where: { id: childId },
                data: { cascadedFields: { push: v.field } } as any,
              })
            )
          }
        } else {
          updates.push(
            prisma.product.update({
              where: { id: v.id },
              data: { [v.field]: v.value } as any,
            })
          )
          // D11 — ONE statement for the whole fan-out, not one per child.
          // Every child receives the identical value and the identical
          // `cascadedFields` push, so `updateMany` expresses it exactly;
          // `ProductUpdateManyMutationInput.cascadedFields` takes the same
          // `{ push }` input as a single update (checked in the generated
          // client, not assumed). `$transaction([...])` runs its statements
          // SERIALLY, so this is the difference between 1 round trip and one
          // per child — on a 50-row family, 50 round trips become 2.
          const kids = childrenByParent.get(v.id) ?? []
          if (kids.length > 0) {
            updates.push(
              prisma.product.updateMany({
                where: { id: { in: kids } },
                data: {
                  [v.field]: v.value,
                  cascadedFields: { push: v.field },
                } as any,
              })
            )
          }
        }
      } else if (isCh) {
        // Direct channel-field edit. With R.1 multi-targets this
        // upserts one ChannelListing row per matching context. For
        // children, also remove the prefixed field from
        // cascadedFields so future renders don't show "inherited."
        updates.push(...upsertChannelListings(v.id, v.field, v.value, v.reset))
        if (childIdSet.has(v.id)) {
          updates.push(
            prisma.$executeRaw`
              UPDATE "Product"
              SET "cascadedFields" = array_remove("cascadedFields", ${v.field})
              WHERE id = ${v.id}
            `
          )
        }
      } else if (childIdSet.has(v.id)) {
        // Direct edit on a child Product field — also remove the
        // field from cascadedFields if it's there (override).
        updates.push(
          prisma.$executeRaw`
            UPDATE "Product"
            SET ${Prisma.raw(`"${v.field}"`)} = ${v.value as any},
                "cascadedFields" = array_remove("cascadedFields", ${v.field})
            WHERE id = ${v.id}
          `
        )
      } else {
        // Direct edit on a parent or standalone Product field
        updates.push(
          prisma.product.update({
            where: { id: v.id },
            data: { [v.field]: v.value } as any,
          })
        )
      }
    }

    // ── D.3e: emit batched attr_* writes ───────────────────────────
    // Direct attr edits — one merged UPDATE per product. For children
    // we also array_remove the attr_* field names from cascadedFields
    // so a direct override clears the "inherited" marker (matching
    // the non-attr child override semantics above).
    // ── PES.5 / #169 — channel-targeted attribute writes ────────────
    // Connections resolved once per channel from the family's existing
    // listings, so a row born here lands on the SAME account as its siblings.
    // channelConnectionId is part of the unique key, so an unattributed row
    // would collide differently too.
    if (channelAttrByCoord.size > 0) {
      const coordProductIds = [...new Set([...channelAttrByCoord.values()].map((e) => e.productId))]
      const siblings = await prisma.channelListing.findMany({
        where: { productId: { in: coordProductIds }, OR: [...channelAttrByCoord.values()].map(e => ({
          channel: e.channel, marketplace: e.marketplace, aliasKey: e.aliasKey, channelConnectionId: connFor.get(e.channel) ?? null,
        })) },
        select: { id: true, productId: true, channel: true, marketplace: true, aliasKey: true, channelConnectionId: true, version: true },
      })

      for (const e of channelAttrByCoord.values()) {
        // CAS on the LISTING's own version, not the Product's (#171.3): a
        // channel write does not change the product, and CASing on
        // Product.version would make two operators on DIFFERENT channels
        // conflict for no reason. Prisma throws P2025 when no row matches,
        // which the existing catch already turns into a 409.
        if (expectedVersion !== undefined) {
          const hit = siblings.find(
            (l) => l.productId === e.productId && l.channel === e.channel &&
                   l.marketplace === e.marketplace && l.aliasKey === e.aliasKey,
          )
          // Only guard a listing that EXISTS. A first write to a coordinate
          // has no version to conflict with, and inventing one would reject
          // the very edit that creates the row.
          if (hit) {
            listingGuards.set(hit.id,
              prisma.channelListing.update({
                where: { id: hit.id, version: expectedVersion },
                // ⚠ VERIFY ONLY — do NOT bump here. `writeChannelOverrideMerge`
                // below already does `"version" = "version" + 1`, and bumping in
                // both made an accepted write advance the version by TWO while
                // the response reported ONE. Feeding the returned version into
                // the next write then 409'd every time — i.e. the sheet stops
                // saving after the first cell and blames the operator.
                // Prisma still throws P2025 when the version does not match,
                // which is the whole job of this statement.
                data: { updatedAt: new Date() },
              }),
            )
          }
        }
        updates.push(writeChannelOverrideMerge(prisma, e, connFor.get(e.channel) ?? null))
        const touched = siblings.find(
          (l) => l.productId === e.productId && l.channel === e.channel &&
                 l.marketplace === e.marketplace && l.aliasKey === e.aliasKey,
        )
        if (touched) channelListingIdsTouched.push(touched.id)
      }
    }

    // ── AM.1 — platformAttributes path writes (eBay item specifics, listing settings) ──
    if (platformPatchByCoord.size > 0) {
      const entries = [...platformPatchByCoord.values()]
      const rows = await prisma.channelListing.findMany({
        where: {
          productId: { in: [...new Set(entries.map((e) => e.productId))] },
          OR: entries.map((e) => ({ channel: e.channel as never, marketplace: e.marketplace, aliasKey: e.aliasKey, channelConnectionId: connFor.get(e.channel) ?? null })),
        },
        select: { id: true, productId: true, channel: true, marketplace: true, aliasKey: true, version: true, updatedAt: true, platformAttributes: true },
      })
      for (const e of entries) {
        const row = rows.find((l) => l.productId === e.productId && l.channel === e.channel && l.marketplace === e.marketplace && l.aliasKey === e.aliasKey)
        if (!row) {
          errors.push({ id: e.productId, field: e.sets.map((x) => x.path.join('.')).join(','), error: `No ${e.channel} listing on ${e.marketplace} yet — a listing field needs the listing to exist` })
          continue
        }
        // Replacing a JSON bag must guard the snapshot even for callers without a token.
        listingGuards.set(row.id, prisma.channelListing.update({
          where: { id: row.id, version: expectedVersion ?? row.version, ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}) },
          data: { updatedAt: new Date() },
        }))
        const bag = applyPlatformMutations(row.platformAttributes, e.sets)
        updates.push(
          prisma.$executeRaw`
            UPDATE "ChannelListing"
            SET "platformAttributes" = ${JSON.stringify(bag)}::jsonb,
                "overrideData" = COALESCE("overrideData", '{}'::jsonb) - ${e.remove}::text[],
                "version" = "version" + 1,
                "updatedAt" = now()
            WHERE id = ${row.id}
          `,
        )
        channelListingIdsTouched.push(row.id)
      }
    }

    for (const [productId, patch] of attrDirectByProduct) {
      updates.push(writeAttrMerge(productId, patch, attrResetByProduct.get(productId)))
      if (childIdSet.has(productId)) {
        for (const stripped of Object.keys(patch)) {
          const fieldName = `attr_${stripped}`
          updates.push(
            prisma.$executeRaw`
              UPDATE "Product"
              SET "cascadedFields" = array_remove("cascadedFields", ${fieldName})
              WHERE id = ${productId}
            `
          )
        }
      }
    }

    // Cascade attr edits — merge into parent + every child, then
    // push the prefixed field names onto each child's cascadedFields.
    for (const [parentId, patch] of attrCascadeByProduct) {
      updates.push(writeAttrMerge(parentId, patch))
      const kids = childrenByParent.get(parentId) ?? []
      const fieldNames = attrCascadeFieldNames.get(parentId) ?? []
      for (const childId of kids) {
        updates.push(writeAttrMerge(childId, patch))
        for (const fieldName of fieldNames) {
          updates.push(
            prisma.product.update({
              where: { id: childId },
              data: { cascadedFields: { push: fieldName } } as any,
            })
          )
        }
      }
    }

    // W1.2 — optimistic concurrency CAS. When the caller passed an
    // expectedVersion, prepend a Product.update keyed by (id,
    // version) so the database itself rejects the write when the
    // row has moved on. Prisma throws P2025 on the not-found CAS;
    // we catch it below and return 409 with the current version
    // so the client can refresh and retry.
    const targetId =
      expectedVersion !== undefined
        ? Array.from(productIds)[0]
        : undefined

    // PES.5 — a CHANNEL-targeted change does not touch the Product, so its
    // `expectedVersion` is the LISTING's token (guarded above), not the
    // product's. Running the product CAS as well would compare the listing's
    // number against `Product.version` and 409 on a conflict that never
    // happened: measured, 868 of 977 listings (89%) carry a version differing
    // from their product's, gaps up to 88. A spurious conflict is worse than
    // no CAS — it teaches an operator to dismiss the one message that must
    // always mean something.
    // #700 — the write's own predicate, restored now that it is SAFE to use.
    //
    // History, because the sequence is the whole lesson: keying this on
    // `isChannelChange` removed the product CAS from mapped channel writes,
    // and since the mapped path had NO listing CAS either, that left the
    // studio's title/description saves guarded by nothing — reverted 14:55:14.
    // The listing CAS added above is what makes the change safe: a mapped
    // write is now guarded on the row it actually touches. Restoring it here
    // also closes a second hole in the other direction — a MASTER column sent
    // with `target: 'channel'` (`'channel' !== 'channel'` is false) previously
    // took no CAS at all despite carrying a token.
    const hasMasterTargetedChange = validated.some((v) => !isChannelChange(v))
    if (expectedVersion !== undefined && targetId && hasMasterTargetedChange) {
      updates.unshift(
        prisma.product.update({
          where: { id: targetId, version: expectedVersion },
          data: { version: { increment: 1 } },
        }),
      )
    }

    // A slot rewrites its sibling array. Guard the snapshot it used, including tokenless callers.
    // Apply this after collecting other guards so a later column write cannot weaken it.
    for (const snapshot of slotSnapshots.values()) {
      listingGuards.set(snapshot.id, prisma.channelListing.update({
        where: { id: snapshot.id, version: expectedVersion ?? snapshot.version,
          ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}) },
        data: { updatedAt: new Date() },
      }))
      if (!channelListingIdsTouched.includes(snapshot.id)) channelListingIdsTouched.push(snapshot.id)
    }
    try {
      const formulaWrite = currentFormulaWrite(context.formulaWriteToken)
      if (formulaWrite && (validated.length !== 1 || validated[0].id !== formulaWrite.productId || validated[0].field !== formulaWrite.writeField)) throw new Error('Formula transaction does not match its value write.')
      const atomic = formulaWrite?.operations?.() ?? []
      const results = await prisma.$transaction([...listingGuards.values(), ...updates, ...atomic], {
        isolationLevel: 'ReadCommitted',
      })
      if (formulaWrite) formulaWrite.results = atomic.length ? results.slice(-atomic.length) : []
    } catch (txErr: any) {
      if (
        ((expectedVersion !== undefined && targetId) || listingGuards.size > 0) &&
        txErr?.code === 'P2025'
      ) {
        // PES.5 — report the version of the row the caller was actually
        // CASing on. A channel write CASes the LISTING, so returning
        // `Product.version` handed back a number from a different row (seen:
        // 1 while the listing was at 19) that no client can recover with.
        const channelOnly = channelListingIdsTouched.length > 0 && !hasMasterTargetedChange
        const fresh = channelOnly
          ? await prisma.channelListing
              .findUnique({ where: { id: channelListingIdsTouched[0] }, select: { version: true } })
              .catch(() => null)
          : await prisma.product
              .findUnique({ where: { id: targetId }, select: { version: true } })
              .catch(() => null)
        throw new ProductBulkError(409, {
          code: 'VERSION_CONFLICT',
          error: channelOnly
            ? 'Another change landed first on this listing — refresh the scope to pick up the latest version.'
            : 'Another change landed first — refresh the product to pick up the latest version.',
          expectedVersion,
          currentVersion: fresh?.version ?? null,
          /** Which row `currentVersion` belongs to, so a client cannot apply it to the wrong one. */
          versionOf: channelOnly ? 'channelListing' : 'product',
        })
      }
      throw txErr
    }

    // Phase 13d — process master-data cascades after the bulk
    // transaction commits. Each call is its own transaction
    // (price service / stock movement) and runs the
    // ChannelListing fan-out + outbound queue + audit log
    // atomically per product. Failures here don't roll back the
    // bulk transaction (which already committed); they're
    // surfaced via the errors array so the client can highlight
    // the affected cells. ChannelListing and listings cascade
    // are still atomic per-product — the partial-failure window
    // is per-row, not per-listing.
    if (priceDeltas.length > 0) {
      // Pre-deduplicate: a product appearing twice in the same PATCH
      // (say cascade=true and a separate direct edit on the same
      // child) collapses to the last value, since the master-data
      // write is idempotent and we want the no-op short-circuit in
      // the service to do its job rather than enqueueing the same
      // sync twice.
      const dedup = new Map<string, number>()
      for (const d of priceDeltas) dedup.set(d.productId, d.newValue)
      for (const [productId, newValue] of dedup) {
        try {
          await masterPriceService.update(productId, newValue, {
            actor: null,
            reason: 'bulk-grid-patch',
            tx: activeDatabaseTransaction(),
            idempotencyKey: `bulk:${startTs}:${productId}:basePrice`,
          })
        } catch (err) {
          errors.push({
            id: productId,
            field: 'basePrice',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    if (stockDeltas.length > 0) {
      const dedup = new Map<string, number>()
      for (const d of stockDeltas) dedup.set(d.productId, d.newValue)
      // Read all current totals in one query so we can compute deltas
      // without N round-trips. The values may have shifted between
      // the bulk commit and now (concurrent stock movement), but
      // applyStockMovement reads its own current value transactionally
      // before applying the delta, so this is just a starting point.
      const productIds = Array.from(dedup.keys())
      const currentRows = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, totalStock: true },
      })
      const currentTotalById = new Map<string, number>(
        currentRows.map((r) => [r.id, r.totalStock ?? 0]),
      )
      for (const [productId, newValue] of dedup) {
        const current = currentTotalById.get(productId) ?? 0
        const delta = newValue - current
        if (delta === 0) continue
        try {
          await applyStockMovement({
            productId,
            change: delta,
            reason: 'MANUAL_ADJUSTMENT',
            notes: 'bulk grid edit',
            actor: undefined,
            tx: activeDatabaseTransaction(),
          })
        } catch (err) {
          errors.push({
            id: productId,
            field: 'totalStock',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    // A4 — master CONTENT fan-out. The bulk transaction already wrote
    // Product.name/description/bulletPoints; now cascade them to each product's
    // ChannelListings (snapshot + queue a CONTENT_UPDATE for following listings)
    // so master content edits actually reach the marketplaces — the headline
    // "edit master → propagate" feature that was wired through dead code.
    // masterAlreadyWritten skips the redundant master write; cascade=true also
    // fans to children (whose Product content the bulk tx already updated).
    const contentByProduct = new Map<string, { title?: string; description?: string; bulletPoints?: string[] }>()
    const addContent = (pid: string, field: string, value: unknown) => {
      const bag = contentByProduct.get(pid) ?? {}
      if (field === 'name') bag.title = value == null ? '' : String(value)
      else if (field === 'description') bag.description = value == null ? '' : String(value)
      else if (field === 'bulletPoints') bag.bulletPoints = Array.isArray(value) ? value.map((x) => String(x)) : []
      contentByProduct.set(pid, bag)
    }
    for (const v of validated) {
      if (v.field !== 'name' && v.field !== 'description' && v.field !== 'bulletPoints') continue
      addContent(v.id, v.field, v.value)
      if (v.cascade) {
        for (const childId of childrenByParent.get(v.id) ?? []) addContent(childId, v.field, v.value)
      }
    }
    for (const [productId, contentChanges] of contentByProduct) {
      try {
        await masterContentService.update(productId, contentChanges, {
          masterAlreadyWritten: true,
          tx: activeDatabaseTransaction(),
          actor: null,
          reason: 'bulk-grid-patch',
          idempotencyKey: `bulk:${startTs}:${productId}:content`,
        })
      } catch (err) {
        errors.push({ id: productId, field: 'content', error: err instanceof Error ? err.message : String(err) })
      }
    }

    // PES.5 — the version the caller should hold NEXT, read from the row that
    // actually changed. Only for a channel-only write; a master write keeps
    // the existing `expectedVersion + 1`, which its single CAS bump makes true.
    const freshChannelVersion =
      expectedVersion !== undefined && channelListingIdsTouched.length > 0 && !hasMasterTargetedChange
        ? (await prisma.channelListing
            .findUnique({ where: { id: channelListingIdsTouched[0] }, select: { version: true } })
            .catch(() => null))?.version
        : undefined

    // #600(6) — the MASTER token, read back from the row rather than computed.
    //
    // It was `expectedVersion + 1`, under a comment of my own explaining why
    // computing is wrong: I fixed the channel half and left this one. The
    // arithmetic holds only while the CAS bump is the only bump — which is
    // precisely the case a concurrency token exists to detect the absence of.
    // When a second writer lands between the CAS and the response, the
    // computed number is the one value guaranteed to be wrong, and the client
    // stores it as truth.
    const freshMasterVersion =
      expectedVersion !== undefined && targetId && hasMasterTargetedChange
        ? (await prisma.product
            .findUnique({ where: { id: targetId }, select: { version: true } })
            .catch(() => null))?.version
        : undefined

    const elapsedMs = Date.now() - startTs

    const overallStatus =
      errors.length === 0 ? 'SUCCESS' : 'PARTIAL'

    const bulkOp = await prisma.bulkOperation.create({
      data: {
        changeCount: changes.length,
        productCount: productIds.size,
        changes: validated as any,
        status: overallStatus,
        expectedVersion: expectedVersion ?? null,
        errors: errors.length ? (errors as any) : undefined,
        cascadeCount: cascadingParents.length,
        affectedChildren: Array.from(allAffectedChildIds),
      },
    })

    // NN.4 — append-only audit log. One row per (productId, field)
    // touched in this PATCH so future audits can answer "who
    // changed price on SKU X last Tuesday." metadata pins the
    // bulkOperation id so the two tables join cleanly.
    // PES.5 — the trail gains the three things the Product Edit Studio's
    // per-cell history needs and this write never recorded: WHO (userId was
    // hardcoded null), the PREVIOUS value (`before` was JSON-null, so a diff
    // was impossible), and WHICH LAYER the edit landed on (no channel /
    // marketplace / alias / locale, so a channel edit was indistinguishable
    // from a master one). Approved 2026-09-01 as PES.5 §8 decision 2; the
    // endpoint's request/response contract is unchanged.
    const auditActor = context.userId ?? currentFormulaWrite(context.formulaWriteToken)?.userId ?? null
    const auditRows = validated.map((c: any) => {
      const prior = priorById.get(c.id)
      // `attr_x` writes into categoryAttributes; a bare key is a column. This
      // mirrors how the change itself is applied, so the recorded `before` is
      // the value the write actually replaced.
      const previous = c.target === 'channel' || !capturePrevious || !prior
        ? undefined
        : typeof c.field === 'string' && c.field.startsWith('attr_')
          ? (prior.categoryAttributes as Record<string, unknown> | null)?.[c.field.slice(5)]
          : prior[c.field]
      return {
        userId: auditActor,
        ip: context.ip ?? null,
        entityType: 'Product',
        entityId: c.id,
        action: 'update',
        // Written ONLY when actually captured. A `before` of `{ value: null }`
        // means "it was empty"; omitting the key means "we did not record it".
        // Collapsing those two into one shape is what makes a history panel lie.
        ...(previous !== undefined ? { before: { field: c.field, value: previous ?? null } } : {}),
        after: { field: c.field, value: c.value },
        metadata: {
          bulkOperationId: bulkOp.id,
          cascade: !!c.cascade,
          source: 'bulk-patch',
          // `effectiveContexts`, NOT the raw body field: that one is optional,
          // and this tsconfig is not strict, so `.length` on an absent array
          // would compile clean and then crash the autosave at runtime
          // (reference_api_tsconfig_not_strict).
          //
          // PES.5 / #169 — the layer is now the change's OWN target, not
          // merely "a context was supplied". A master-targeted change sent
          // alongside channel contexts still lands on the product, and the
          // history pane must say which it was.
          layer: c.target === 'channel' ? 'channel' : 'master',
          channel: c.target === 'channel' ? effectiveContexts[0]?.channel ?? null : null,
          marketplace: c.target === 'channel' ? effectiveContexts[0]?.marketplace ?? null : null,
          aliasKey: c.target === 'channel' ? (effectiveContexts[0] as { aliasKey?: string })?.aliasKey ?? '' : null,
          accountId: c.target === 'channel' && effectiveContexts.length === 1 ? connFor.get(effectiveContexts[0].channel) ?? null : null,
        },
      }
    })
    await auditLogService.writeMany(auditRows)

    // Activity consumes the same scoped receipts as field history. Mixed shared/channel
    // requests must never put another destination's fields in a scoped event.
    const eventGroups = new Map<string, typeof auditRows>()
    for (const row of auditRows) {
      const key = JSON.stringify([row.entityId, row.metadata.layer, row.metadata.channel, row.metadata.marketplace, row.metadata.accountId, row.metadata.aliasKey])
      eventGroups.set(key, [...(eventGroups.get(key) ?? []), row])
    }
    const activityEvents = [...eventGroups.values()].map(rows => ({
      aggregateId: rows[0].entityId,
      aggregateType: 'Product' as const,
      eventType: 'BULK_OP_APPLIED' as const,
      data: { fields: rows.map(row => row.after), bulkOperationId: bulkOp.id },
      metadata: { ...rows[0].metadata, source: 'OPERATOR' as const, userId: auditActor },
    }))
    const activeTx = activeDatabaseTransaction()
    if (activeTx) await productEventService.emitManyTx(activeTx, activityEvents)
    else await productEventService.emitMany(activityEvents)

    // Phase 1 — refresh ProductReadCache synchronously for every product
    // this PATCH touched, so the /products grid (which reads the cache)
    // reflects the edit immediately. productEventService.emitMany above
    // also enqueues a debounced cache:refresh, but that worker only runs
    // when queue workers are enabled (ENABLE_QUEUE_WORKERS=1 + Redis) —
    // awaiting the rebuild here makes the edit consistent regardless of
    // worker health, matching how products-catalog.routes.ts already
    // refreshes after its direct PATCH. Runs after all post-commit
    // cascades (price/stock/content) so the cache captures their writes.
    const cacheRefreshIds = Array.from(
      new Set<string>([...productIds, ...allAffectedChildIds]),
    )
    await afterDatabaseCommit(`product-cache:${cacheRefreshIds.slice().sort().join(',')}`, () => productReadCacheService.refreshMany(cacheRefreshIds)).catch(err => {
      context.logger.warn({ err, productIds: cacheRefreshIds }, '[products/bulk] cache refresh failed')
    })

    // ── Owner design §1 — recalculation, in the writing request ────
    // Every formula whose `dependsOn` names a field this PATCH just wrote is
    // re-evaluated HERE, before the response is built, so "the value you see
    // is the value that was stored" survives a cascade.
    //
    // SKIPPED when this write is itself a cascade. The formula service's
    // `writeValue` reaches this very route through `fastify.inject` (that is
    // the point of #775 — one writer, not two), so re-entering would restart
    // the walk with a fresh visited-set and recurse. The guard is the
    // explicit header that one caller sets.
    const isFormulaCascade = context.formulaCascade
    const recalculated: Array<{
      productId: string
      fieldKey: string
      scope: string
      value: unknown
      error: string | null
      sourceField: string
    }> = []
    let recalcError: string | null = null
    if (!isFormulaCascade) {
      // The whole pass is fail-open, for the same reason `auditLogService` is:
      // by the time we get here the operator's write is COMMITTED. Letting a
      // cascade fault escape would answer 500 to a request that succeeded,
      // and the client would report a failed edit that is actually stored —
      // the worst of the available outcomes. Caught by
      // `products-bulk-noop.vitest.test.ts`, which mocks a prisma without
      // `cellFormula` and got eight 500s.
      try {
        const fieldsByProduct = new Map<string, typeof validated>()
        for (const c of validated) {
          const list = fieldsByProduct.get(c.id) ?? []
          list.push(c)
          fieldsByProduct.set(c.id, list)
        }
        // ONE query decides whether any of these products carries a formula
        // at all. Without it a bulk PATCH over 400 products paid 400 round
        // trips to be told "no formulas here" — the overwhelmingly common case.
        const withFormulas = new Set(
          (
            await prisma.cellFormula.findMany({
              where: { OR: [{ productId: { in: Array.from(fieldsByProduct.keys()) } }, { product: { parentId: { in: Array.from(fieldsByProduct.keys()) } } }] },
              select: { productId: true, product: { select: { parentId: true } } },
              distinct: ['productId'],
            })
          ).flatMap((r) => [r.productId, ...(r.product?.parentId ? [r.product.parentId] : [])]),
        )
        for (const [productId, changedFields] of fieldsByProduct) {
          if (!withFormulas.has(productId)) continue
          try {
            const destinations = new Map<string, { fields: string[]; coordinate?: { channel: string; marketplace: string; channelConnectionId?: string | null; aliasKey?: string | null; locale?: string | null } }>()
            for (const c of changedFields) {
              if (!isChannelChange(c)) {
                const destination = destinations.get('master') ?? { fields: [] }
                destination.fields.push(c.field); destinations.set('master', destination); continue
              }
              const contexts = effectiveContexts.filter(ctx => !channelOf(c.field) || channelOf(c.field) === ctx.channel)
              for (const ctx of contexts) {
                const coordinate = { channel: ctx.channel, marketplace: ctx.marketplace, channelConnectionId: connFor.get(ctx.channel) ?? null, aliasKey: ctx.aliasKey ?? '', locale: ctx.locale }
                const key = JSON.stringify(coordinate)
                const destination = destinations.get(key) ?? { fields: [], coordinate }
                destination.fields.push(c.field); destinations.set(key, destination)
              }
            }
            for (const destination of destinations.values()) {
              const rows = await reevaluateDependents({ productId, changedFields: [...new Set(destination.fields)],
                coordinate: destination.coordinate, updatedBy: auditActor, ip: context.ip ?? null })
              for (const r of rows) recalculated.push({ productId, ...r })
            }
          } catch (err) {
            // One product's cascade failing must not stop the others.
            context.logger.error(
              { err, productId },
              '[products/bulk] formula recalculation failed for one product',
            )
            recalculated.push({
              productId,
              fieldKey: '',
              scope: 'master',
              value: null,
              error: err instanceof Error ? err.message : String(err),
              sourceField: changedFields[0]?.field ?? '',
            })
          }
        }
      } catch (err) {
        // Reported, never swallowed: a silent skip would leave a dependent
        // cell stale behind a response that said "saved".
        recalcError = err instanceof Error ? err.message : String(err)
        context.logger.error({ err }, '[products/bulk] formula recalculation pass failed')
      }
    }

    return {
      success: true,
      // NN.7 — surface the BulkOperation row id so the client can
      // show "operation id: bulk_xxx" in the failure toast and a
      // future "view audit log" panel can drill in. errors already
      // carry per-(id, field) attribution; the client maps them
      // into cell-level error highlights.
      operationId: bulkOp.id,
      updated: validated.length,
      ...(normalizedChanges.length ? { normalizedChanges } : {}),
      cascadeCount: cascadingParents.length,
      affectedChildren: totalAffectedChildren,
      errors: errors.length ? errors : undefined,
      elapsedMs,
      // W1.2 — when the caller participated in optimistic
      // concurrency, surface the freshly-incremented version so
      // the client can keep its local copy in sync without a
      // round-trip back to GET /api/products/:id.
      // PES.5 — for a CHANNEL write, read the version BACK rather than
      // computing `expectedVersion + 1`. The computed form was right only
      // while exactly one statement bumped; when two did, the response said
      // 16 and the row held 17, and the next write 409'd. Reading the stored
      // value cannot drift from it whatever the statements do.
      // #600(6) — the MASTER token is READ BACK too, never computed.
      //
      // `expectedVersion + 1` is right only while the CAS bump is the only bump —
      // which is exactly the case this token exists to detect the absence of. The
      // channel half was fixed and the master half left computing, under a comment
      // explaining why computing is wrong.
      // Owner design §1 — what the cascade re-evaluated in this request.
      // Omitted entirely when nothing cascaded, so an unchanged response
      // stays byte-identical for every caller that never uses formulas.
      ...(recalculated.length ? { recalculated } : {}),
      ...(recalcError ? { recalcError } : {}),
      currentVersion: freshChannelVersion ?? freshMasterVersion ?? undefined,
      versionOf: freshChannelVersion !== undefined ? 'channelListing' : expectedVersion !== undefined ? 'product' : undefined,
    }
  } catch (error: any) {
    if (error instanceof ProductBulkError) throw error
    context.logger.error({ err: error }, '[products/bulk] transaction failed')
    await prisma.bulkOperation
      .create({
        data: {
          changeCount: changes.length,
          productCount: new Set(changes.map((c) => c.id)).size,
          changes: changes as any,
          status: 'FAILED',
          errors: [{ error: error?.message ?? String(error) }] as any,
          expectedVersion: expectedVersion ?? null,
        },
      })
      .catch(() => {
        /* don't mask the real error with an audit-log failure */
      })
    throw new ProductBulkError(500, {
      error: 'Bulk update failed',
      message: error?.message ?? String(error),
    })
  }

}
