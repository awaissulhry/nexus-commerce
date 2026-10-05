/**
 * MCP full control L6 — draft listings and their fields (plan section 02, step 6). Nexus only: nothing here reaches a
 * channel. Only a publish (publish-listing) sends a listing.
 *
 *   create-draft-listings  inert drafts of a product family on one channel, market and account, through the ONE draft
 *                          creator (`ensureDraftListings`, family: true): parent and every variant, syncPaused, unpublished.
 *   remove-draft-listings  its inverse: removes drafts that are still untouched (never published, nothing of their own).
 *   set-listing-fields     a listing's own field values on one coordinate (the product sheet's channel-scope save,
 *                          `applyProductBulkEdits` target channel), which variants the listing includes
 *                          (`writeProjectionInclusion`), or its Amazon variation theme (`writeProjectionMapping`).
 *
 * L7 — products and variations (plan section 02, step 7):
 *   create-product         a product, or a family with its variations, through the create wizard's own service
 *                          (`create-product.service.ts`). No stock and no identifiers: stock is a stock tool's, EAN/GTIN
 *                          the identifier tools'.
 *   create-variations      new variations of a family, every combination of the values named, through the family
 *                          generator (`generateCombinations`): its dry run gives a token, the run commits only that plan.
 *   discard-new-products   their inverse: moves products nobody used yet (no listing, order or stock movement) to the
 *                          recycle bin, or restores them from it.
 *
 * Each dry run writes nothing (a draft preview runs the creator in a transaction that is rolled back). Each change waits
 * for a person's approval and re-checks, when it runs, that what it found is still what the person approved.
 * All run in the caller's business (row-level security; no argument names a business).
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { channelLabel } from '@nexus/shared/channel-label'
import { isStillDraftListing, STILL_DRAFT_LISTING } from '@nexus/shared/push-lock'
import prisma from '../../../db.js'
import { connectionLabel } from '../../connection-label.js'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'
import { isListingContentKey } from './listing-content-keys.js'

const DRAFT_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry)
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

/** The draft creator loads lazily, as its routes load it: the registry (every tool file) stays light. */
const drafts = () => import('../../pim/draft-listing.service.js')

/** A sentence the draft creator or the account resolver gives a person (an HTTP 4xx), as opposed to a fault. */
function personError(error: unknown): string | null {
  // Most Nexus refusals carry `statusCode`; the family variation writer names it `status`.
  const status = (error as { statusCode?: unknown })?.statusCode ?? (error as { status?: unknown })?.status
  return typeof status === 'number' && status >= 400 && status < 500 ? (error instanceof Error ? error.message : String(error)) : null
}

/** Thrown to roll back a dry run's transaction, carrying what the run would have done. */
class DryRun<T> extends Error {
  constructor(readonly result: T) { super('dry run') }
}

const accountLabelOf = async (accountId: string | null) => {
  if (!accountId) return null
  const row = await prisma.channelConnection.findFirst({ where: { id: accountId },
    select: { id: true, channelType: true, accountLabel: true, ebayStoreName: true, displayName: true, ebaySignInName: true, externalAccountId: true } })
  return row ? connectionLabel(row).label : null
}

// ── create-draft-listings / remove-draft-listings ─────────────────────────────────────────────────────

interface DraftCoordinate { productId: string; channel: string; market: string; accountId?: string | null }
interface DraftOutcome { accountId: string | null; created: Array<{ id: string; productId: string; sku: string; version: number }>; existing: number }

/**
 * The drafts the one creator makes for a family on a coordinate. `commit` false: inside a transaction that is rolled
 * back, so nothing stays. `expect` (the approved product ids): the run is rolled back and refused when it would create
 * any other set.
 */
async function runDraftCreator(c: DraftCoordinate, commit: boolean, expect?: string[]): Promise<DraftOutcome> {
  const { ensureDraftListings } = await drafts()
  const work = async (tx: Parameters<typeof ensureDraftListings>[0]): Promise<DraftOutcome> => {
    const rows = await ensureDraftListings(tx, { channel: c.channel, market: c.market, accountId: c.accountId ?? null, productIds: [c.productId], family: true })
    const created = rows.filter((row) => row.created)
    const facts = created.length ? await tx.channelListing.findMany({ where: { id: { in: created.map((row) => row.id) } },
      select: { id: true, channelConnectionId: true, product: { select: { sku: true } } } }) : []
    const any = rows.length ? await tx.channelListing.findFirst({ where: { id: rows[0].id }, select: { channelConnectionId: true } }) : null
    const outcome: DraftOutcome = {
      accountId: any?.channelConnectionId ?? null,
      created: created.map((row) => ({ id: row.id, productId: row.productId, sku: facts.find((f) => f.id === row.id)?.product.sku ?? '', version: row.version }))
        .sort((a, b) => a.sku.localeCompare(b.sku)),
      existing: rows.length - created.length,
    }
    if (!commit) throw new DryRun(outcome)
    if (expect && canonical([...expect].sort()) !== canonical(outcome.created.map((row) => row.productId).sort())) throw new DryRun(outcome)
    return outcome
  }
  try {
    return await prisma.$transaction(work)
  } catch (error) {
    if (error instanceof DryRun) {
      if (!commit) return error.result as DraftOutcome
      throw Object.assign(new Error('The drafts it would start changed since it was approved. Nothing was created; ask Claude again.'), { statusCode: 409 })
    }
    throw error
  }
}

const draftCoordinateInput = {
  productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family (parent), one of its variations or a single product; the whole family is drafted'),
  channel: z.preprocess(upper, z.enum(DRAFT_CHANNELS)).describe('AMAZON, EBAY, SHOPIFY or ETSY'),
  market: z.string().trim().toUpperCase().min(2).max(20).describe('the marketplace code, e.g. IT or DE; GLOBAL for Shopify and Etsy'),
  accountId: z.string().trim().min(1).max(64).optional()
    .describe('the Nexus account id (listing-coordinates lists them); omitted: the channel\'s primary active account'),
}

/** C2 — a created draft set, as stored now: the drafts it created that are still untouched (same version, still drafts). */
async function untouchedDrafts(listings: Array<{ id: string; version: number }>) {
  const rows = await prisma.channelListing.findMany({ where: { id: { in: listings.map((l) => l.id) } },
    select: { id: true, version: true, listingStatus: true, isPublished: true, externalListingId: true } })
  return listings.filter((l) => rows.some((row) => row.id === l.id && row.version === l.version && isStillDraftListing(row)))
}

const CREATE_DRAFTS_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { coordinate?: unknown; listings?: Array<{ id: string; version: number }> }
    return { coordinate: after.coordinate ?? null, listings: await untouchedDrafts(after.listings ?? []) }
  },
  request(change) {
    const after = (change.after ?? {}) as { listings?: Array<{ id: string }> }
    if (!after.listings?.length) return { refusal: 'This change created no draft.' }
    return { tool: 'remove-draft-listings', args: { listingIds: after.listings.map((l) => l.id) } }
  },
}

const createDraftListings: AgentTool = {
  name: 'create-draft-listings',
  title: 'Create draft listings',
  input: z.object(draftCoordinateInput),
  requires: [F.productsEdit, F.listingsEdit],
  category: 'listings',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  // C1 — the drafts are inert and empty: removing them (remove-draft-listings) leaves nothing behind.
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: CREATE_DRAFTS_UNDO,
  description:
    'Start draft listings of a product family on one channel, market and account in Nexus: the parent and every variant, '
    + 'inert (paused, unpublished, no price or quantity) until a publish sends them. Nothing reaches the channel. Products '
    + 'that already have a listing there are left as they are. Waits for a person to approve it in Nexus.',
  async handler(args) {
    const product = await prisma.product.findFirst({ where: liveProduct(String(args.productId)), select: { id: true, sku: true } })
    if (!product) return { ok: false, error: PRODUCT_NOT_FOUND }
    const c = { productId: product.id, channel: String(args.channel), market: String(args.market), accountId: (args.accountId as string | undefined) ?? null }
    let outcome: DraftOutcome
    try {
      outcome = await runDraftCreator(c, false)
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${product.sku} on ${channelLabel(c.channel)} ${c.market}: ${sentence} Nothing was queued.` }
    }
    if (!outcome.created.length) {
      return { ok: false, error: `${product.sku} on ${channelLabel(c.channel)} ${c.market}: every product of the family already has a listing there. Nothing was queued.` }
    }
    return {
      ok: true,
      preview: {
        action: 'create-draft-listings',
        sku: product.sku,
        destination: { channel: c.channel, market: c.market, accountId: outcome.accountId, accountLabel: await accountLabelOf(outcome.accountId) },
        create: outcome.created.map((row) => ({ productId: row.productId, sku: row.sku })),
        alreadyListed: outcome.existing,
        note: 'Inert drafts in Nexus: paused and unpublished. Nothing is sent to the channel until a publish.',
      },
    }
  },
  async execute(args, ctx) {
    const product = await prisma.product.findFirst({ where: liveProduct(String(args.productId)), select: { id: true, sku: true } })
    if (!product) return { ok: false, error: PRODUCT_NOT_FOUND }
    const c = { productId: product.id, channel: String(args.channel), market: String(args.market), accountId: (args.accountId as string | undefined) ?? null }
    const approved = (ctx.approvedPreview as { create?: Array<{ productId?: unknown }> } | undefined)?.create
    let outcome: DraftOutcome
    try {
      outcome = await runDraftCreator(c, true, Array.isArray(approved) ? approved.map((row) => String(row.productId)) : undefined)
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${product.sku} on ${channelLabel(c.channel)} ${c.market}: ${sentence}` }
    }
    if (outcome.created.length) {
      // The product read cache (lists, counts) learns of the new rows, as the product sheet's own draft start does.
      const { productReadCacheService } = await import('../../product-read-cache.service.js')
      await productReadCacheService.refreshMany([...new Set(outcome.created.map((row) => row.productId))]).catch(() => undefined)
    }
    const coordinate = { channel: c.channel, market: c.market, accountId: outcome.accountId }
    const listings = outcome.created.map((row) => ({ id: row.id, version: row.version }))
    return {
      ok: true,
      data: { created: outcome.created.map((row) => ({ listingId: row.id, sku: row.sku })), alreadyListed: outcome.existing, destination: coordinate },
      // C1 — the drafts it created (ids and versions): undo removes exactly those, while they are still untouched.
      change: { before: { productId: product.id, sku: product.sku, coordinate, listings: [] }, after: { coordinate, listings } },
    }
  },
}

/** Why each listing cannot be removed as an untouched draft (none: it can), read on `db` (the removal's transaction). */
async function removalRefusals(ids: string[], db: Pick<typeof prisma, 'channelListing'> = prisma) {
  const rows = await db.channelListing.findMany({
    where: { id: { in: ids } },
    select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, version: true, listingStatus: true,
      isPublished: true, externalListingId: true, overrideData: true, platformAttributes: true, product: { select: { sku: true, parentId: true } },
      _count: { select: { snapshots: true, outboundSyncQueue: true } } },
  })
  const problems: string[] = []
  for (const id of ids) {
    const row = rows.find((r) => r.id === id)
    if (!row) { problems.push(`Listing ${id} not found in this business.`); continue }
    const own = row.overrideData && typeof row.overrideData === 'object' && Object.keys(row.overrideData as object).length > 0
      || row.platformAttributes && typeof row.platformAttributes === 'object' && Object.keys(row.platformAttributes as object).length > 0
    if (!isStillDraftListing(row)) problems.push(`${row.product.sku} ${channelLabel(row.channel)} ${row.marketplace}: not a draft (it was published or carries the channel's id).`)
    else if (row._count.snapshots || row._count.outboundSyncQueue) problems.push(`${row.product.sku} ${channelLabel(row.channel)} ${row.marketplace}: a publish or a push already used it.`)
    else if (own) problems.push(`${row.product.sku} ${channelLabel(row.channel)} ${row.marketplace}: it has values of its own; removing it would lose them.`)
  }
  return { rows, problems }
}

const REMOVE_DRAFTS_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { coordinates?: Array<{ productIds: string[]; channel: string; market: string; accountId: string | null; aliasKey: string }> }
    const coordinates = after.coordinates ?? []
    const present: string[] = []
    for (const c of coordinates) {
      const rows = await prisma.channelListing.findMany({ where: { productId: { in: c.productIds }, channel: c.channel, marketplace: c.market, channelConnectionId: c.accountId, aliasKey: c.aliasKey }, select: { id: true } })
      present.push(...rows.map((row) => row.id))
    }
    return { coordinates, present: present.sort() }
  },
  request(change) {
    const after = (change.after ?? {}) as { coordinates?: Array<{ rootId: string; channel: string; market: string; accountId: string | null; aliasKey: string }> }
    const coordinates = after.coordinates ?? []
    if (coordinates.length !== 1) return { refusal: 'These drafts were on several listings: start each again with create-draft-listings.' }
    const [c] = coordinates
    if (c.aliasKey) return { refusal: 'A second listing (alias) is started from the product in Nexus, not by a draft tool.' }
    return { tool: 'create-draft-listings', args: { productId: c.rootId, channel: c.channel, market: c.market, ...(c.accountId ? { accountId: c.accountId } : {}) } }
  },
}

const removeDraftListings: AgentTool = {
  name: 'remove-draft-listings',
  title: 'Remove draft listings',
  input: z.object({
    listingIds: z.array(z.string().trim().min(1).max(64)).min(1).max(250)
      .describe('Nexus listing ids of drafts to remove (listing-coordinates lists them); each must be an untouched draft'),
  }),
  requires: [F.productsEdit, F.listingsEdit],
  category: 'listings',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  // C1 — only untouched drafts (never published, never sent, nothing of their own): starting them again restores them.
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: REMOVE_DRAFTS_UNDO,
  description:
    'Remove draft listings Nexus has not published: drafts that were never sent to a channel and hold no values of their '
    + 'own (create-draft-listings starts them again). A published listing, or a draft with its own values, is refused: '
    + 'closing a live listing is close-listing. Nothing reaches the channel. Waits for a person to approve it in Nexus.',
  async handler(args) {
    const ids = [...new Set(args.listingIds as string[])]
    const { rows, problems } = await removalRefusals(ids)
    if (problems.length) return { ok: false, error: `${problems.slice(0, 10).join(' ')} Nothing was queued.` }
    return {
      ok: true,
      preview: {
        action: 'remove-draft-listings',
        remove: rows.map((row) => ({ listingId: row.id, sku: row.product.sku, channel: row.channel, market: row.marketplace, version: row.version }))
          .sort((a, b) => a.sku.localeCompare(b.sku) || a.listingId.localeCompare(b.listingId)),
        note: 'Removes untouched drafts from Nexus. Nothing was ever sent for them, and nothing is sent now.',
      },
    }
  },
  async execute(args) {
    const ids = [...new Set(args.listingIds as string[])]
    try {
      const removed = await prisma.$transaction(async (tx) => {
        const { rows, problems } = await removalRefusals(ids, tx)
        if (problems.length) throw Object.assign(new Error(problems.slice(0, 10).join(' ')), { statusCode: 409 })
        // Each row only as it was read: still a draft, the same version.
        for (const row of rows) {
          const gone = await tx.channelListing.deleteMany({ where: { id: row.id, version: row.version, ...STILL_DRAFT_LISTING } })
          if (gone.count !== 1) throw Object.assign(new Error(`${row.product.sku}: the draft changed while it was being removed.`), { statusCode: 409 })
        }
        return rows
      })
      const coordinates = new Map<string, { rootId: string; productIds: string[]; channel: string; market: string; accountId: string | null; aliasKey: string }>()
      for (const row of removed) {
        const key = canonical([row.product.parentId ?? row.productId, row.channel, row.marketplace, row.channelConnectionId, row.aliasKey])
        const entry = coordinates.get(key) ?? { rootId: row.product.parentId ?? row.productId, productIds: [], channel: row.channel, market: row.marketplace, accountId: row.channelConnectionId, aliasKey: row.aliasKey }
        entry.productIds.push(row.productId)
        coordinates.set(key, entry)
      }
      const list = [...coordinates.values()].map((c) => ({ ...c, productIds: c.productIds.sort() }))
      return {
        ok: true,
        data: { removed: removed.map((row) => ({ listingId: row.id, sku: row.product.sku })) },
        change: {
          before: { listings: removed.map((row) => ({ id: row.id, sku: row.product.sku, channel: row.channel, market: row.marketplace })) },
          after: { coordinates: list, present: [] },
        },
      }
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${sentence} Nothing was removed.` }
    }
  },
}

// ── set-listing-fields ───────────────────────────────────────────────────────────────────────────────

const FIELD_CAP = 40
// A measure (Amazon `item_package_weight`, `item_package_dimensions__length`) is { value, unit }; the product writer
// refuses a bare number or a unit the field does not take.
const fieldValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(500)).max(30),
  z.object({ value: z.number().positive().max(100_000), unit: z.string().trim().min(1).max(40) }).strict()])
/** Stock, price and fulfilment have their own tools; titles, descriptions, bullets and keywords their content door. */
const NOT_HERE = /quantity|price|fulfil|stock/i
const isAttributeKey = (key: string) => /^attr_[A-Za-z0-9_.:\- ]{1,120}$/.test(key)

const setFieldsInput = z.object({
  productId: z.string().trim().min(1).max(64)
    .describe('Nexus product id: the product whose listing changes (values), or any product of the family (variants, variationTheme)'),
  channel: z.preprocess(upper, z.enum(DRAFT_CHANNELS)).describe('AMAZON, EBAY, SHOPIFY or ETSY'),
  market: z.string().trim().toUpperCase().min(2).max(20).describe('the marketplace code, e.g. IT or DE; GLOBAL for Shopify and Etsy'),
  accountId: z.string().trim().min(1).max(64).optional()
    .describe('the Nexus account id (listing-coordinates names it); optional when the listing\'s market has one account'),
  listingId: z.string().trim().min(1).max(64).optional()
    .describe('a Nexus listing id from listing-coordinates, to change a second listing (alias) of the family on this account and market'),
  values: z.record(z.string().min(1).max(130), fieldValue).optional()
    .describe('listing attributes to set on this listing only, by key as product-content lists them with a coordinate (color, or attr_color); at most 40'),
  reset: z.array(z.string().min(1).max(130)).max(FIELD_CAP).optional()
    .describe('listing attributes (by key, e.g. color) that stop having a value of their own here and follow the product again'),
  variants: z.object({
    include: z.array(z.string().trim().min(1).max(64)).max(250).optional().describe('variation product ids this listing should include'),
    exclude: z.array(z.string().trim().min(1).max(64)).max(250).optional().describe('variation product ids this listing should leave out'),
  }).optional().describe('which variations the listing includes (a family\'s listing on this coordinate)'),
  variationTheme: z.string().trim().min(1).max(120).optional().describe('Amazon only: the variation theme of the family\'s listing on this market'),
})

interface Coordinate { productId: string; rootId: string; sku: string; channel: string; market: string; accountId: string; aliasKey: string }

/** The coordinate a change names: the product's listing there must exist (create-draft-listings starts one). */
async function coordinateFor(args: Record<string, unknown>, of: 'product' | 'family'): Promise<Coordinate | { error: string }> {
  const product = await prisma.product.findFirst({ where: liveProduct(String(args.productId)), select: { id: true, sku: true, parentId: true } })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const channel = String(args.channel), market = String(args.market)
  const where = `${product.sku} on ${channelLabel(channel)} ${market}`
  const rootId = product.parentId ?? product.id
  let accountId = args.accountId as string | undefined
  let aliasKey = ''
  if (args.listingId) {
    const named = await prisma.channelListing.findFirst({ where: { id: String(args.listingId) },
      select: { channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, product: { select: { id: true, parentId: true } } } })
    if (!named || (named.product.parentId ?? named.product.id) !== rootId || named.channel !== channel || named.marketplace !== market) {
      return { error: `${where}: this listing is not one of this family's listings here (listing-coordinates lists them).` }
    }
    aliasKey = named.aliasKey
    accountId ??= named.channelConnectionId ?? undefined
  }
  const subject = of === 'family' ? rootId : product.id
  const rows = await prisma.channelListing.findMany({ where: { productId: subject, channel, marketplace: market, aliasKey, ...(accountId ? { channelConnectionId: accountId } : {}) },
    select: { channelConnectionId: true } })
  const accounts = [...new Set(rows.map((r) => r.channelConnectionId).filter((id): id is string => !!id))]
  if (!rows.length) return { error: `${where}: there is no listing here yet. Start its drafts first (create-draft-listings).` }
  if (accounts.length !== 1) return { error: `${where}: ${accounts.length ? `it is listed on ${accounts.length} accounts here: name one (accountId)` : 'its listing has no account recorded'}.` }
  return { productId: product.id, rootId, sku: product.sku, channel, market, accountId: accounts[0], aliasKey }
}

/** The kind of change asked for: exactly one per request, so each run is one write of one door. */
function kindOf(args: Record<string, unknown>): 'values' | 'variants' | 'theme' | { error: string } {
  const kinds = [(args.values && Object.keys(args.values as object).length) || (args.reset as string[] | undefined)?.length ? 'values' : null,
    args.variants ? 'variants' : null, args.variationTheme ? 'theme' : null].filter(Boolean) as Array<'values' | 'variants' | 'theme'>
  if (kinds.length !== 1) return { error: kinds.length ? 'Ask for one kind of change at a time: values (and reset), variants, or variationTheme.' : 'Name what to change: values, reset, variants or variationTheme.' }
  return kinds[0]
}

type Own = { value: unknown; own: boolean }

/** The listing's current value of each attribute and whether it is its own (an override) or follows the product. */
async function currentValues(c: Coordinate, keys: string[]): Promise<{ values: Record<string, Own>; labels: Record<string, string>; unknown: string[]; known: string[] }> {
  const { resolveBatch } = await import('../../pim/mapping/resolve-batch.service.js')
  const result = await resolveBatch({ channel: c.channel, marketplace: c.market, channelConnectionId: c.accountId, aliasKey: c.aliasKey, productIds: [c.productId], includeCatalogue: true })
  const cells = result.products.find((p) => p.productId === c.productId)?.cells ?? {}
  const values: Record<string, Own> = {}, labels: Record<string, string> = {}, unknown: string[] = []
  for (const key of keys) {
    const cell = cells[key.replace(/^attr_/, '')]
    if (!cell) { unknown.push(key); continue }
    values[key] = { value: cell.value ?? null, own: cell.provenance === 'override' }
    labels[key] = cell.label ?? key
  }
  const known = Object.keys(cells).filter((k) => !NOT_HERE.test(k) && !isListingContentKey(k)).sort().map((k) => `attr_${k}`)
  return { values, labels, unknown, known }
}

const clipValue = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

/** The bulk writer's input for these values and resets, on this coordinate. */
const bulkInput = (c: Coordinate, values: Record<string, unknown>, reset: string[], dryRun: boolean) => ({
  changes: [
    ...Object.entries(values).map(([field, value]) => ({ id: c.productId, field, value, target: 'channel' as const, intent: 'set' as const })),
    ...reset.map((field) => ({ id: c.productId, field, value: null, target: 'channel' as const, intent: 'reset' as const })),
  ],
  marketplaceContexts: [{ channel: c.channel as never, marketplace: c.market, accountId: c.accountId, aliasKey: c.aliasKey }],
  ...(dryRun ? { dryRun: true } : {}),
})
const bulkContext = (userId: string | null) => ({ formulaCascade: false, userId, logger: { warn: () => undefined, error: () => undefined } })

/** A values change, previewed: the attributes, what they hold now, what they would hold; or why not. */
async function planValues(c: Coordinate, args: Record<string, unknown>, userId: string | null) {
  // A key as the product sheet's save names it (attr_color) or as product-content lists it with a coordinate (color).
  const attrKey = (key: string) => (key.startsWith('attr_') ? key : `attr_${key}`)
  const values = Object.fromEntries(Object.entries((args.values ?? {}) as Record<string, unknown>).map(([key, value]) => [attrKey(key), value]))
  const reset = [...new Set(((args.reset ?? []) as string[]).map(attrKey))]
  if (Object.keys(values).length !== Object.keys((args.values ?? {}) as object).length) return { error: 'An attribute is named twice (with and without attr_).' }
  const keys = [...new Set([...Object.keys(values), ...reset])]
  if (keys.length > FIELD_CAP) return { error: `At most ${FIELD_CAP} attributes at a time.` }
  const wrong = keys.filter((key) => !isAttributeKey(key) || NOT_HERE.test(key) || isListingContentKey(key))
  if (wrong.length) {
    return { error: `${wrong.join(', ')}: only listing attributes (attr_<attribute>) are set here. Stock and fulfilment go through `
      + 'set-listing-stock (an Amazon listing\'s FBA or FBM: action set-fulfilment), price through set-listing-price, and a listing\'s '
      + 'title, description, bullets and keywords through the content tools.' }
  }
  if (reset.some((key) => key in values)) return { error: 'An attribute is either set or reset, not both.' }
  const now = await currentValues(c, keys)
  if (now.unknown.length) return { error: `${now.unknown.join(', ')}: not an attribute of this listing. Its attributes: ${now.known.slice(0, 60).join(', ')}${now.known.length > 60 ? ' …' : ''}.` }
  const { applyProductBulkEdits } = await import('../../products/bulk-edit.service.js')
  const check = await applyProductBulkEdits(bulkInput(c, values, reset, true) as never, bulkContext(userId) as never) as
    { errors?: Array<{ field: string; error: string }>; warnings?: Array<{ field: string; warning: string }> }
  if (check.errors?.length) return { error: check.errors.slice(0, 10).map((e) => `${e.field}: ${e.error}`).join(' ') }
  // N4 — what the writer stores but warns about (a value off a closed channel list, a value over a channel cap): it is
  // saved, and the channel refuses it at the next publish. The approver and Claude see it before, not at publish.
  const warnings = (check.warnings ?? []).slice(0, 10)
  return { values, reset, before: now.values, labels: now.labels, warnings }
}

const SET_FIELDS_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { coordinate?: Coordinate; kind?: string; values?: Record<string, Own>; included?: Record<string, boolean>; theme?: unknown }
    const c = after.coordinate
    if (!c) return null
    if (after.kind === 'values') return { coordinate: c, kind: 'values', values: (await currentValues(c, Object.keys(after.values ?? {}))).values }
    const { getProjectionRead } = await import('../../pim/family-projection.service.js')
    const read = await getProjectionRead({ productId: c.rootId, channel: c.channel, market: c.market, accountId: c.accountId, aliasKey: c.aliasKey })
    if (after.kind === 'variants') {
      return { coordinate: c, kind: 'variants', included: Object.fromEntries(Object.keys(after.included ?? {}).map((id) => [id, read.children.find((ch) => ch.id === id)?.included ?? false])) }
    }
    return { coordinate: c, kind: 'theme', theme: read.theme?.value ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { coordinate?: Coordinate; kind?: string; values?: Record<string, Own>; included?: Record<string, boolean>; theme?: string | null }
    const c = before.coordinate
    if (!c) return { refusal: 'This change does not name its listing.' }
    const base = { productId: before.kind === 'values' ? c.productId : c.rootId, channel: c.channel, market: c.market, accountId: c.accountId,
      ...(c.aliasKey ? { listingId: (before as { listingId?: string }).listingId } : {}) }
    if (c.aliasKey && !(before as { listingId?: string }).listingId) return { refusal: 'This change does not name its second listing.' }
    if (before.kind === 'values') {
      const entries = Object.entries(before.values ?? {})
      const values = Object.fromEntries(entries.filter(([, v]) => v.own).map(([key, v]) => [key, v.value]))
      const reset = entries.filter(([, v]) => !v.own).map(([key]) => key)
      return { tool: 'set-listing-fields', args: { ...base, ...(Object.keys(values).length ? { values } : {}), ...(reset.length ? { reset } : {}) } }
    }
    if (before.kind === 'variants') {
      const included = Object.entries(before.included ?? {})
      return { tool: 'set-listing-fields', args: { ...base, variants: { include: included.filter(([, on]) => on).map(([id]) => id), exclude: included.filter(([, on]) => !on).map(([id]) => id) } } }
    }
    if (!before.theme) return { refusal: 'The listing had no variation theme of its own before: choose one in Nexus.' }
    return { tool: 'set-listing-fields', args: { ...base, variationTheme: before.theme } }
  },
}

/** The whole plan of a set-listing-fields request, read-only: what changes, from what, and its fingerprint. */
async function planSetFields(args: Record<string, unknown>, userId: string | null): Promise<{ error: string } | {
  c: Coordinate; kind: 'values' | 'variants' | 'theme'; preview: Record<string, unknown>; before: Record<string, unknown>
  apply: (approvedVersion: number | null) => Promise<void>; version: number | null }> {
  const product = await prisma.product.findFirst({ where: liveProduct(String(args.productId)), select: { sku: true } })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const kind = kindOf(args)
  if (typeof kind !== 'string') return { error: `${product.sku}: ${kind.error}` }
  const c = await coordinateFor(args, kind === 'values' ? 'product' : 'family')
  if ('error' in c) return c
  const where = `${c.sku} on ${channelLabel(c.channel)} ${c.market}`
  const destination = { channel: c.channel, market: c.market, accountId: c.accountId, accountLabel: await accountLabelOf(c.accountId), ...(args.listingId ? { listingId: String(args.listingId) } : {}) }
  const listingId = args.listingId ? String(args.listingId) : undefined
  if (kind === 'values') {
    const plan = await planValues(c, args, userId)
    if ('error' in plan) return { error: `${where}: ${plan.error}` }
    const changes = [
      ...Object.entries(plan.values).map(([key, to]) => ({ key, label: plan.labels[key], from: clipValue(plan.before[key].value), fromOwn: plan.before[key].own, to: clipValue(to) })),
      ...plan.reset.map((key) => ({ key, label: plan.labels[key], from: clipValue(plan.before[key].value), fromOwn: plan.before[key].own, to: '(follows the product)' })),
    ]
    return {
      c, kind, version: null,
      before: { coordinate: c, kind, listingId, values: plan.before },
      preview: { action: 'set-listing-fields', sku: c.sku, destination, changes,
        // Owner 2026-10-05 — Product media is the one photo source of an eBay listing; the save moves the list into it.
        ...(c.channel === 'EBAY' && Array.isArray(plan.values.attr_imageUrls) ? { note: 'The Image URLs become this listing\'s Product media when the change runs: a photo of the media library is used from the library, any other address is added to it.' } : {}),
        ...(plan.warnings.length ? {
          warnings: plan.warnings.map((w) => `${w.field}: ${w.warning}`),
          warning: `Saved in Nexus, but ${new Set(plan.warnings.map((w) => w.field)).size === 1 ? 'this value is' : 'these values are'} likely `
            + `to be refused by ${channelLabel(c.channel)} at the next publish: `
            + `${plan.warnings.slice(0, 3).map((w) => w.warning.replace(/\.+$/, '')).join('; ')}. product-content lists the allowed values.`,
        } : {}),
        fingerprint: fingerprint({ c, before: plan.before, values: plan.values, reset: plan.reset }) },
      apply: async () => {
        const { applyProductBulkEdits } = await import('../../products/bulk-edit.service.js')
        const out = await applyProductBulkEdits(bulkInput(c, plan.values, plan.reset, false) as never, bulkContext(userId) as never) as { errors?: Array<{ field: string; error: string }> }
        if (out.errors?.length) throw Object.assign(new Error(out.errors.slice(0, 10).map((e) => `${e.field}: ${e.error}`).join(' ')), { statusCode: 422 })
      },
    }
  }
  const { getProjectionRead, writeProjectionInclusion, writeProjectionMapping } = await import('../../pim/family-projection.service.js')
  const input = { productId: c.rootId, channel: c.channel, market: c.market, accountId: c.accountId, aliasKey: c.aliasKey }
  const read = await getProjectionRead(input)
  if (kind === 'variants') {
    const asked = args.variants as { include?: string[]; exclude?: string[] }
    const changes = [...(asked.include ?? []).map((id) => ({ id, included: true })), ...(asked.exclude ?? []).map((id) => ({ id, included: false }))]
    const ids = changes.map((ch) => ch.id)
    if (!changes.length) return { error: `${where}: name variations to include or exclude.` }
    if (new Set(ids).size !== ids.length) return { error: `${where}: a variation is named twice.` }
    const unknown = ids.filter((id) => !read.children.some((ch) => ch.id === id))
    if (unknown.length) return { error: `${where}: ${unknown.length} variation${unknown.length === 1 ? ' is' : 's are'} not in this family: ${unknown.slice(0, 5).join(', ')}.` }
    const moving = changes.filter((ch) => read.children.find((x) => x.id === ch.id)!.included !== ch.included)
    if (!moving.length) return { error: `${where}: every variation named is already as asked.` }
    const before = Object.fromEntries(moving.map((ch) => [ch.id, !ch.included]))
    return {
      c, kind, version: read.version,
      before: { coordinate: c, kind, listingId, included: before },
      preview: { action: 'set-listing-fields', sku: c.sku, destination, listingVersion: read.version,
        variants: moving.map((ch) => ({ productId: ch.id, sku: read.children.find((x) => x.id === ch.id)!.sku, included: { from: !ch.included, to: ch.included } })),
        fingerprint: fingerprint({ c, version: read.version, moving }) },
      apply: async (approvedVersion) => { await writeProjectionInclusion({ ...input, expectedVersion: approvedVersion ?? read.version, changes: moving }) },
    }
  }
  if (c.channel !== 'AMAZON') return { error: `${where}: a variation theme is set here for Amazon only; other channels name their variation axes in Nexus.` }
  const theme = String(args.variationTheme)
  // Wave 2 A4 — the dock's own list: the themes Amazon accepts, plus the one in use, which may be deprecated and is
  // then never a target.
  const options = read.theme?.options ?? []
  const target = options.find((o) => o.code === theme)
  const accepted = options.filter((o) => !o.deprecated)
  const named = accepted.length ? ` (${accepted.slice(0, 20).map((o) => o.code).join(', ')})` : ''
  if (target?.deprecated) return { error: `${where}: Amazon has deprecated ${theme} here; choose a theme Amazon accepts${named}.` }
  if (!target) return { error: `${where}: ${theme} is not a variation theme Amazon accepts for this product type here${named}.` }
  const from = read.theme?.value ?? null
  if (from === theme) return { error: `${where}: the variation theme is already ${theme}.` }
  return {
    c, kind, version: read.version,
    before: { coordinate: c, kind, listingId, theme: from },
    preview: { action: 'set-listing-fields', sku: c.sku, destination, listingVersion: read.version, variationTheme: { from, to: theme },
      ...(read.affectsAllMarkets ? { note: 'The theme is one per ASIN: it shows in every Amazon market of this listing.' } : {}),
      fingerprint: fingerprint({ c, version: read.version, from, theme }) },
    apply: async (approvedVersion) => { await writeProjectionMapping({ ...input, expectedVersion: approvedVersion ?? read.version, theme }) },
  }
}

const setListingFields: AgentTool = {
  name: 'set-listing-fields',
  title: 'Set listing fields',
  input: setFieldsInput,
  requires: [F.productsEdit, F.listingsEdit],
  category: 'listings',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  // C1 — Nexus only: the values it replaced (own, or following the product), the variations a listing included and its
  // theme are recorded, and undo sets them back through this tool.
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_FIELDS_UNDO,
  description:
    'Change one listing in Nexus on one channel, market and account — one kind of change per request: values (its own '
    + 'attributes, by the product sheet key attr_<attribute>; reset makes one follow the product again), variants (which '
    + 'variations the family\'s listing includes or leaves out), or variationTheme (Amazon). Nothing reaches the channel '
    + 'until a publish; stock, price and the listing\'s title, description, bullets and keywords have their own tools. Its '
    + 'keys and allowed values are what product-content lists for the listing\'s coordinate. '
    + 'The listing must exist (create-draft-listings starts it). Waits for a person to approve it in Nexus.',
  async handler(args, ctx) {
    let plan
    try {
      plan = await planSetFields(args, ctx.userId ?? null)
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: sentence }
    }
    if ('error' in plan) return { ok: false, error: plan.error === PRODUCT_NOT_FOUND ? plan.error : `${plan.error} Nothing was queued.` }
    return { ok: true, preview: plan.preview }
  },
  async execute(args, ctx) {
    const approved = ctx.approvedPreview as { fingerprint?: unknown; listingVersion?: unknown } | undefined
    let plan
    try {
      plan = await planSetFields(args, ctx.userId ?? null)
      if ('error' in plan) return { ok: false, error: plan.error === PRODUCT_NOT_FOUND ? plan.error : `${plan.error} Nothing changed.` }
      if (typeof approved?.fingerprint !== 'string') return { ok: false, error: 'A listing change runs only after a person approved its preview. Nothing changed.' }
      if (approved.fingerprint !== plan.preview.fingerprint) {
        return { ok: false, error: `${plan.c.sku} on ${channelLabel(plan.c.channel)} ${plan.c.market}: the listing changed since it was approved. Nothing changed; ask Claude again.` }
      }
      await plan.apply(typeof approved.listingVersion === 'number' ? approved.listingVersion : null)
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${sentence} Nothing changed.` }
    }
    const change: ToolChange = { before: plan.before, after: await SET_FIELDS_UNDO.current({ before: plan.before, after: { ...plan.before } }) }
    return { ok: true, data: { applied: plan.kind, ...plan.preview, fingerprint: undefined }, change }
  },
}

// ── create-product / create-variations / discard-new-products (L7) ──────────────────────────────────────

const attributeValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(500)).max(30)])
const createProductInput = z.object({
  sku: z.string().trim().min(1).max(100).describe('the new product\'s SKU; unique in the catalogue'),
  name: z.string().trim().min(1).max(500).describe('the product name'),
  basePrice: z.coerce.number().min(0).max(1_000_000).describe('the master price, in the master currency'),
  brand: z.string().trim().min(1).max(200).optional().describe('brand'),
  productType: z.string().trim().min(1).max(100).optional().describe('product type (category), e.g. OUTERWEAR'),
  description: z.string().max(20_000).optional().describe('master description'),
  manufacturer: z.string().trim().min(1).max(200).optional().describe('manufacturer'),
  weightValue: z.coerce.number().positive().max(100_000).optional().describe('weight'),
  weightUnit: z.string().trim().min(1).max(10).optional().describe('weight unit, e.g. kg or g'),
  dimLength: z.coerce.number().positive().max(100_000).optional().describe('length'),
  dimWidth: z.coerce.number().positive().max(100_000).optional().describe('width'),
  dimHeight: z.coerce.number().positive().max(100_000).optional().describe('height'),
  dimUnit: z.string().trim().min(1).max(10).optional().describe('dimension unit, e.g. cm'),
  categoryAttributes: z.record(z.string().min(1).max(100), attributeValue).optional().describe('master attributes by name, e.g. { material: "Leather" }'),
  variations: z.array(z.object({
    sku: z.string().trim().min(1).max(100).describe('the variation\'s SKU'),
    name: z.string().trim().min(1).max(500).optional().describe('its name; default "<product name> — <SKU>"'),
    attributes: z.record(z.string().min(1).max(60), z.string().trim().min(1).max(200)).describe('its variation values, e.g. { Size: "M", Color: "Black" }'),
    price: z.coerce.number().min(0).max(1_000_000).optional().describe('its master price; default the product\'s'),
  })).max(100).optional().describe('variations: the product becomes their family (parent)'),
})

const products = () => import('../../products/create-product.service.js')

/** C2 — products, as stored now: whether each is in the recycle bin. */
async function binState(ids: string[]) {
  const rows = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, deletedAt: true } })
  return ids.map((id) => ({ id, deleted: !rows.some((row) => row.id === id && row.deletedAt === null) }))
}
/** The undo of a create: those products to the recycle bin (discard-new-products refuses any that is in use by then). */
const DISCARD_CREATED: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { products?: Array<{ id: string }> }
    return { restore: false, products: await binState((after.products ?? []).map((p) => p.id)) }
  },
  request(change) {
    const after = (change.after ?? {}) as { products?: Array<{ id: string }> }
    if (!after.products?.length) return { refusal: 'This change created no product.' }
    return { tool: 'discard-new-products', args: { productIds: after.products.map((p) => p.id) } }
  },
}

const createProductTool: AgentTool = {
  name: 'create-product',
  title: 'Create a product',
  input: createProductInput,
  requires: [F.productsCreate, F.productsEdit],
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  // C1 — a new product nobody used yet goes to the recycle bin again (discard-new-products).
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: DISCARD_CREATED,
  description:
    'Create a product in Nexus, or a family with its variations (each with its SKU and variation values), as the Nexus '
    + 'create wizard does. No stock and no identifiers (EAN/GTIN): those have their own tools. No listing is created: '
    + 'create-draft-listings starts them. Waits for a person to approve it in Nexus.',
  async handler(args) {
    const input = args as z.infer<typeof createProductInput>
    const { assertCreatable } = await products()
    try {
      await assertCreatable(wizardInput(input))
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${sentence}. Nothing was queued.` }
    }
    const axes = await familyAxesOf(input)
    if ('error' in axes) return { ok: false, error: `${input.sku}: ${axes.error} Nothing was queued.` }
    const { variations, ...product } = input
    return {
      ok: true,
      preview: {
        action: 'create-product',
        product,
        variations: (variations ?? []).map((v) => ({ sku: v.sku, name: v.name ?? `${input.name} — ${v.sku}`, attributes: v.attributes, price: v.price ?? input.basePrice })),
        ...(axes.codes.length ? { axes: axes.labels.map((label, i) => ({ name: label, attribute: axes.codes[i] })) } : {}),
        note: 'Creates the product in Nexus only: no stock, no identifiers, no listing.',
      },
    }
  },
  async execute(args, ctx) {
    const input = args as z.infer<typeof createProductInput>
    const { assertCreatable, createProduct } = await products()
    try {
      await assertCreatable(wizardInput(input))
      const axes = await familyAxesOf(input)
      if ('error' in axes) return { ok: false, error: `${input.sku}: ${axes.error} Nothing was created.` }
      // The product and, for a family, its axes (`setFamilyAxes`, the one writer of a family's axes) in ONE transaction:
      // a family is never left without the axes its variations vary by.
      const { inDatabaseTransaction } = await import('../../../lib/database-context.js')
      const { setFamilyAxes } = await import('../../pim/family-variations.service.js')
      const created = await inDatabaseTransaction(prisma, async () => {
        const made = await createProduct(wizardInput(input), { userId: ctx.userId ?? null, ip: null, source: 'claude' })
        if (axes.codes.length) await setFamilyAxes(made.product.id, { expectedVersion: made.version, codes: axes.codes, labels: axes.labels })
        return made
      }, { isolationLevel: 'Serializable' })
      const ids = [created.product.id, ...created.variations.map((v) => v.id)]
      return {
        ok: true,
        data: { product: created.product, variations: created.variations },
        change: { before: { sku: created.product.sku, products: [] }, after: { products: ids.map((id) => ({ id, deleted: false })) } },
      }
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${sentence}. Nothing was created.` }
    }
  },
}

/** A new family's axes: its variation value names, in the order they first appear, each a dictionary attribute. */
async function familyAxesOf(input: z.infer<typeof createProductInput>): Promise<{ codes: string[]; labels: string[] } | { error: string }> {
  const names = [...new Set((input.variations ?? []).flatMap((v) => Object.keys(v.attributes)))]
  if (!names.length) return { codes: [], labels: [] }
  const { axisCodesFor } = await import('../../pim/family-variations.service.js')
  return axisCodesFor(names)
}

/** The create wizard's input from the tool's: no stock, no identifiers, no cost; variation values as the wizard names them. */
function wizardInput(input: z.infer<typeof createProductInput>) {
  const { variations, ...product } = input
  return { ...product, ...(variations ? { variations: variations.map((v) => ({ sku: v.sku, name: v.name ?? null, variationAttributes: v.attributes, price: v.price ?? null })) } : {}) }
}

const createVariationsInput = z.object({
  productId: z.string().trim().min(1).max(64).describe('Nexus product id of the family (parent), or one of its variations'),
  axisValues: z.record(z.string().min(1).max(100), z.array(z.string().trim().min(1).max(200)).min(1).max(100))
    .describe('per variation axis of the family, the values to combine, e.g. { Size: ["S", "M"], Color: ["Black"] }; every combination not yet in the family is created'),
  skuPattern: z.string().trim().min(1).max(200).describe('how each new SKU is made, e.g. {parent}-{Size.code}-{Color.code}'),
  valueCodes: z.record(z.string().min(1).max(100), z.record(z.string().min(1).max(200), z.string().trim().min(1).max(64))).optional()
    .describe('optional SKU codes per axis and value, e.g. { Color: { Black: "BLK" } }'),
})

const generator = () => import('../../pim/family-generate.service.js')

const createVariations: AgentTool = {
  name: 'create-variations',
  title: 'Create variations',
  input: createVariationsInput,
  requires: [F.productsCreate, F.productsEdit],
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: DISCARD_CREATED,
  description:
    'Create new variations of a product family in Nexus: every combination of the values named that the family does not '
    + 'have yet, each with a SKU from the pattern, as DRAFT products. The preview lists every SKU; what runs is exactly that '
    + 'plan, and nothing if the family changed since. No listing is created. Waits for a person to approve it in Nexus.',
  async handler(args) {
    const product = await prisma.product.findFirst({ where: liveProduct(String(args.productId)), select: { id: true, sku: true, parentId: true } })
    if (!product) return { ok: false, error: PRODUCT_NOT_FOUND }
    const root = await prisma.product.findFirst({ where: liveProduct(product.parentId ?? product.id), select: { id: true, sku: true, version: true } })
    if (!root) return { ok: false, error: PRODUCT_NOT_FOUND }
    const { generateCombinations } = await generator()
    let plan
    try {
      plan = await generateCombinations({ productId: root.id, version: root.version, axisValues: args.axisValues as Record<string, string[]>,
        skuPattern: String(args.skuPattern), valueCodes: args.valueCodes as Record<string, Record<string, string>> | undefined, dryRun: true })
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${root.sku}: ${sentence} Nothing was queued.` }
    }
    if (!('previewToken' in plan)) throw new Error('The generator ran for real in a dry run.')
    if (!plan.plan.length) {
      return { ok: false, error: `${root.sku}: nothing to create — ${plan.skipped.length} combination${plan.skipped.length === 1 ? '' : 's'} already exist or collide with a SKU. Nothing was queued.` }
    }
    return {
      ok: true,
      preview: {
        action: 'create-variations',
        family: { productId: root.id, sku: root.sku },
        familyVersion: root.version,
        counts: plan.counts,
        create: plan.plan.slice(0, 100).map((row) => ({ sku: row.sku, values: row.axisValues })),
        ...(plan.plan.length > 100 ? { moreCreated: plan.plan.length - 100 } : {}),
        ...(plan.skipped.length ? { skipped: plan.skipped.slice(0, 30) } : {}),
        ...(Object.keys(plan.newValues).length ? { newValues: plan.newValues } : {}),
        ...(plan.skuConventionWarnings.length ? { skuWarnings: plan.skuConventionWarnings.slice(0, 20) } : {}),
        previewToken: plan.previewToken,
        note: 'New variations are DRAFT products in Nexus. No listing is created.',
      },
    }
  },
  async execute(args, ctx) {
    const product = await prisma.product.findFirst({ where: liveProduct(String(args.productId)), select: { id: true, parentId: true } })
    if (!product) return { ok: false, error: PRODUCT_NOT_FOUND }
    const approved = ctx.approvedPreview as { previewToken?: unknown; familyVersion?: unknown } | undefined
    if (typeof approved?.previewToken !== 'string' || typeof approved.familyVersion !== 'number') {
      return { ok: false, error: 'New variations are created only after a person approved their preview. Nothing was created.' }
    }
    const { generateCombinations } = await generator()
    try {
      const result = await generateCombinations({ productId: product.parentId ?? product.id, version: approved.familyVersion, axisValues: args.axisValues as Record<string, string[]>,
        skuPattern: String(args.skuPattern), valueCodes: args.valueCodes as Record<string, Record<string, string>> | undefined, dryRun: false, previewToken: approved.previewToken })
      if (!('created' in result)) throw new Error('The generator previewed instead of creating.')
      return {
        ok: true,
        data: { created: result.created, familyVersion: result.version },
        change: { before: { familyId: product.parentId ?? product.id, products: [] }, after: { products: result.created.map((row) => ({ id: row.id, deleted: false })) } },
      }
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${sentence} Nothing was created.` }
    }
  },
}

/** Why each product cannot be binned (or restored) as a new, unused product; the rows when every one can. */
async function discardRefusals(ids: string[], restore: boolean, db: Pick<typeof prisma, 'product' | 'channelListing' | 'orderItem' | 'stockMovement'> = prisma) {
  const rows = await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, parentId: true, deletedAt: true,
    children: { select: { id: true, deletedAt: true } } } })
  const problems: string[] = []
  const [listings, orders, movements] = await Promise.all([
    db.channelListing.findMany({ where: { productId: { in: ids } }, select: { productId: true } }),
    db.orderItem.findMany({ where: { productId: { in: ids } }, select: { productId: true }, take: 1000 }),
    db.stockMovement.findMany({ where: { productId: { in: ids } }, select: { productId: true }, take: 1000 }),
  ])
  for (const id of ids) {
    const row = rows.find((r) => r.id === id)
    if (!row) { problems.push(`Product ${id} not found in this business.`); continue }
    if (restore ? row.deletedAt === null : row.deletedAt !== null) { problems.push(`${row.sku} is ${restore ? 'not in' : 'already in'} the recycle bin.`); continue }
    if (listings.some((l) => l.productId === id)) problems.push(`${row.sku} has listings: remove its drafts first (remove-draft-listings); a live listing is closed, not discarded.`)
    else if (orders.some((o) => o.productId === id)) problems.push(`${row.sku} has orders: it is in use.`)
    else if (movements.some((m) => m.productId === id)) problems.push(`${row.sku} has stock movements: it is in use.`)
    // A family moves together: binning a parent leaves no live variation behind; restoring a variation needs its parent.
    if (!restore) {
      const left = row.children.filter((c) => c.deletedAt === null && !ids.includes(c.id))
      if (left.length) problems.push(`${row.sku} has ${left.length} live variation${left.length === 1 ? '' : 's'} not named here.`)
    } else if (row.parentId && !ids.includes(row.parentId)) {
      const parent = await db.product.findFirst({ where: { id: row.parentId }, select: { deletedAt: true } })
      if (parent?.deletedAt) problems.push(`${row.sku}: restore its family parent with it.`)
    }
  }
  return { rows, problems }
}

const discardNewProducts: AgentTool = {
  name: 'discard-new-products',
  title: 'Discard new products',
  input: z.object({
    productIds: z.array(z.string().trim().min(1).max(64)).min(1).max(250).describe('Nexus product ids of products nobody used yet (a family with its variations)'),
    restore: z.boolean().optional().describe('true: take them back out of the recycle bin instead'),
  }),
  requires: [F.productsDelete, F.productsEdit],
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  // C1 — the recycle bin keeps them: restore (or this tool with restore) puts them back as they were.
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { restore?: boolean; products?: Array<{ id: string }> }
      return { restore: after.restore ?? false, products: await binState((after.products ?? []).map((p) => p.id)) }
    },
    request(change) {
      const after = (change.after ?? {}) as { restore?: boolean; products?: Array<{ id: string }> }
      if (!after.products?.length) return { refusal: 'This change moved no product.' }
      return { tool: 'discard-new-products', args: { productIds: after.products.map((p) => p.id), ...(after.restore ? {} : { restore: true }) } }
    },
  },
  description:
    'Move products nobody used yet to the Nexus recycle bin (no listing, no order, no stock movement; a family with all its '
    + 'variations), or take them back out with restore. A product in use is refused: Nexus deletes those from the product '
    + 'list, with their listings. Nothing reaches a channel. Waits for a person to approve it in Nexus.',
  async handler(args) {
    const ids = [...new Set(args.productIds as string[])]
    const restore = args.restore === true
    const { rows, problems } = await discardRefusals(ids, restore)
    if (problems.length) return { ok: false, error: `${problems.slice(0, 10).join(' ')} Nothing was queued.` }
    return {
      ok: true,
      preview: {
        action: 'discard-new-products',
        restore,
        products: rows.map((row) => ({ productId: row.id, sku: row.sku })).sort((a, b) => a.sku.localeCompare(b.sku)),
        note: restore ? 'Takes the products back out of the recycle bin.' : 'Moves the products to the recycle bin; restore takes them back.',
      },
    }
  },
  async execute(args, ctx) {
    const ids = [...new Set(args.productIds as string[])]
    const restore = args.restore === true
    try {
      const rows = await prisma.$transaction(async (tx) => {
        const { rows, problems } = await discardRefusals(ids, restore, tx)
        if (problems.length) throw Object.assign(new Error(problems.slice(0, 10).join(' ')), { statusCode: 409 })
        const target = restore ? null : new Date()
        const moved = await tx.product.updateMany({ where: { id: { in: ids }, deletedAt: restore ? { not: null } : null }, data: { deletedAt: target } })
        if (moved.count !== ids.length) throw Object.assign(new Error('A product changed while it was being moved.'), { statusCode: 409 })
        // One audit row per product, as the recycle bin's own action writes them.
        await tx.auditLog.createMany({ data: rows.map((row) => ({ userId: ctx.userId ?? null, entityType: 'Product', entityId: row.id, action: restore ? 'restore' : 'soft-delete',
          before: { deletedAt: row.deletedAt?.toISOString() ?? null }, after: { deletedAt: target?.toISOString() ?? null }, metadata: { sku: row.sku, source: 'claude' } })) })
        const { productReadCacheService } = await import('../../product-read-cache.service.js')
        await productReadCacheService.refreshInTransaction(tx, ids)
        return rows
      })
      return {
        ok: true,
        data: { restore, products: rows.map((row) => ({ productId: row.id, sku: row.sku })) },
        change: { before: { restore: !restore, products: ids.map((id) => ({ id, deleted: restore })) }, after: { restore, products: ids.map((id) => ({ id, deleted: !restore })) } },
      }
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${sentence} Nothing was moved.` }
    }
  },
}

export const LISTING_CREATE_TOOLS: AgentTool[] = [createDraftListings, removeDraftListings, setListingFields, createProductTool, createVariations, discardNewProducts]

