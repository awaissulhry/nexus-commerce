/**
 * AE.4 — live product sync, the follower's side (shared stock plan step 6; contract
 * docs/2026-09-19-shared-stock-build.md §6.1).
 *
 * Everything here runs in the FOLLOWER's business, as the system (no person). The only read of the
 * owner's data goes through copy-source.service.ts, after the database named the products
 * (`nexus_assortment_sync_source`). Per link it re-reads BOTH products as they are now and applies the
 * difference — it never replays a remembered value, so an old or repeated change cannot write old data.
 *
 *   rows      the catalog transfer engine's own plan and apply, in one transaction with the sync flag
 *             set (capture ignores it: no loops), so the follower's field contracts, translation store,
 *             readiness and read cache run as for an import. No staged job and no review: the share's
 *             consent is the review for a product that already follows.
 *   managed   product type, price and status through their services, as in the first copy.
 *   media     the link maps each source image to the follower's copy of it.
 *   sku       R-AE-2: renamed where the follower is not live; held (and the owners told) where it is.
 *   structure a variation added under a followed parent is created and linked here.
 */
import type { TransferIssue, TransferRow } from '@nexus/shared/catalog-transfer'
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { WorkspaceError, requireWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { isCloudinaryConfigured } from '../cloudinary.service.js'
import { cleanUpUnreferencedMedia } from '../images/media-file-cleanup.service.js'
import { catalogRows, productInclude } from '../pim/catalog-transfer-export.js'
import { buildTransferPlan, transferContracts } from '../pim/catalog-transfer-plan.js'
import { applyTransferTarget, loadTransferContext } from '../pim/catalog-transfer.service.js'
import { PRIMARY_CONTENT_LOCALE } from '../pim/content-locale.js'
import { productEventService } from '../product-event.service.js'
import { notifyOwners } from '../stock-pool/pool-notify.js'
import { copyImages, type PlannedImage } from './copy-media.service.js'
import { missingDefinitions } from './copy-preview.service.js'
import { applyManaged, createDefinitions } from './copy-run.service.js'
import { linkSource, readLinkedCatalog, type LinkSource, type ManagedFields, type OfferedCatalog } from './copy-source.service.js'
import {
  ABSENT, FOLLOW_AGAIN, decide, fieldKey, fingerprint, followerMediaPrint, imageFilePrint, imageMetaPrint, planMedia, readState, rowPrints,
  type AppliedState, type Decision, type ImageFacts, type MediaEntry,
} from './sync-fields.js'

export const SKU_KEY = 'sku'
export const MEDIA_KEY = 'media'
const MANAGED_PREFIX = 'managed:'
const MANAGED_FIELDS: Array<keyof ManagedFields> = ['productType', 'basePrice', 'minPrice', 'maxPrice', 'b2bPrice', 'b2bMinQty', 'status']
const MARKET = /^(?:[A-Z]{2}|GLOBAL)$/

export interface LinkSyncResult {
  outcome: 'synced' | 'unchanged' | 'detached' | 'skipped'
  /** Why a link was skipped or detached (a code), or null. */
  reason: string | null
  applied: string[]
  recorded: string[]
  /** Fields found edited in this business since the last sync: kept, and recorded as overrides. */
  overrides: string[]
  refused: Array<{ key: string; message: string }>
  held: { sku: string; reason: string } | null
  /** Definitions and variations this run created. */
  created: string[]
}

const result = (outcome: LinkSyncResult['outcome'], reason: string | null = null): LinkSyncResult =>
  ({ outcome, reason, applied: [], recorded: [], overrides: [], refused: [], held: null, created: [] })

/** Bring one link's follower product up to its source. Call in the follower's context. */
export async function syncLink(linkId: string): Promise<LinkSyncResult> {
  const { workspaceId } = requireWorkspace()
  const link = await prisma.catalogLink.findFirst({ where: { id: linkId, targetWorkspaceId: workspaceId } })
  if (!link || link.status !== 'active') return result('skipped', 'link_not_active')

  let door: LinkSource
  try {
    door = await linkSource(linkId)
  } catch (error) {
    if (error instanceof WorkspaceError) return result('skipped', error.code)
    throw error
  }

  const target = await prisma.product.findFirst({ where: { id: link.targetProductId }, select: { id: true, sku: true, parentId: true, deletedAt: true } })
  if (!target || target.deletedAt) {
    await detach(link.id, 'deleted in this business')
    return result('detached', 'target_deleted')
  }
  if (!door.source || door.source.deleted) {
    await detach(link.id, door.source ? 'no longer shared, or deleted in the business that shares it' : 'deleted in the business that shares it')
    await notifyOwners({
      type: 'assortment-link-detached', severity: 'warn',
      title: `${target.sku} no longer follows a shared product`,
      body: 'The business that shared it deleted it or stopped sharing it. This product stays here as your own, unchanged.',
      entityType: 'Product', entityId: target.id, href: `/products/${encodeURIComponent(target.id)}/edit`,
    })
    return result('detached', 'source_gone')
  }

  const market = await marketFor(link)
  const offered = new Set<string>(door.fieldGroups)
  const catalog = await readLinkedCatalog({ link: door, productIds: [door.source.id], market })
  const source = catalog.products[0]
  const state = readState(link.appliedState)
  const overrides = new Set(link.overrides)
  const outcome = result('unchanged')
  const decisions = new Map<string, Decision>()
  const sourcePrint = new Map<string, string>()
  const note = (key: string, decision: Decision, print: string) => { decisions.set(key, decision); sourcePrint.set(key, print) }

  // ── Rows (every offered field the transfer engine writes) ──
  const sourceRows = pathRows(catalog.rows.filter((row) => row.entity === 'Products'), source)
  const sourcePrints = rowPrints(sourceRows, (path) => path)
  const tree = await categoryTree()
  // The source's languages, and those fingerprinted before (a translation removed at the source).
  const locales = offered.has('translations')
    ? [...new Set([PRIMARY_CONTENT_LOCALE, ...sourceRows.map((row) => row.locale).filter(Boolean), ...Object.keys(state.fields).filter(isRowKey).map((key) => key.split('@')[1]).filter(Boolean)])]
    : [PRIMARY_CONTENT_LOCALE]
  const followerBefore = rowPrints(await exportFollower(target.id, market, locales), (id) => tree.get(id) ?? null)
  const rowKeys = new Set([...sourcePrints.keys(), ...Object.keys(state.fields).filter(isRowKey)])
  for (const key of rowKeys) {
    const print = sourcePrints.get(key) ?? ABSENT
    note(key, decide({ source: print, target: followerBefore.get(key) ?? ABSENT, applied: state.fields[key], overridden: overrides.has(key) }), print)
  }

  // ── Owner-managed fields ──
  const followerManaged = await prisma.product.findUnique({ where: { id: target.id }, select: managedSelect })
  for (const field of MANAGED_FIELDS) {
    if (!(field in source.managed)) continue
    const key = MANAGED_PREFIX + field
    const print = fingerprint(managedValue(source.managed[field]))
    note(key, decide({ source: print, target: fingerprint(managedValue(followerManaged?.[field])), applied: state.fields[key], overridden: overrides.has(key) }), print)
  }

  // ── SKU (identity) ──
  if (offered.has('identity')) {
    const print = fingerprint(door.source.sku)
    note(SKU_KEY, decide({ source: print, target: fingerprint(target.sku), applied: state.fields[SKU_KEY], overridden: overrides.has(SKU_KEY) }), print)
  }

  for (const [key, decision] of decisions) if (decision === 'override' && !overrides.has(key)) outcome.overrides.push(key)
  const apply = [...decisions].filter(([, decision]) => decision === 'apply').map(([key]) => key)
  const refused = new Map<string, string>()

  // 1. Rows, through the engine.
  const rowApply = apply.filter(isRowKey)
  if (rowApply.length) {
    outcome.created.push(...await ensureDefinitions(catalog))
    const followerTree = await categoryTree(true)
    const rows = await rowsForFollower(catalog.rows, rowApply, { sku: target.sku, sourceParentId: door.source.parentId, shareId: link.shareId, paths: source, tree: followerTree })
    for (const [key, message] of rows.refused) refused.set(key, message)
    for (const [key, message] of await applyRows(rows.rows, target.sku, market, `assortment-sync:${link.id}`, 'update')) refused.set(key, message)
  }

  // 2. Owner-managed fields, through their services.
  const managedApply = apply.filter((key) => key.startsWith(MANAGED_PREFIX)).map((key) => key.slice(MANAGED_PREFIX.length) as keyof ManagedFields)
  if (managedApply.length) {
    const subset: ManagedFields = {}
    for (const field of managedApply) (subset as Record<string, unknown>)[field] = source.managed[field]
    const managed = await applyManaged(target.id, subset, `assortment-sync:${link.id}`)
    // Its failures name the service ("price", "status"), not the field: every field sent is tried again.
    if (managed.failed.length) for (const field of managedApply) refused.set(MANAGED_PREFIX + field, managed.failed.join('; '))
  }

  // 3. SKU.
  let held: LinkSyncResult['held'] = null
  if (apply.includes(SKU_KEY)) {
    const renamed = await renameSku(target, door.source.sku)
    if (renamed.held) {
      held = { sku: door.source.sku, reason: renamed.held }
      decisions.set(SKU_KEY, 'same') // not applied: its fingerprint stays, so the next run tries again
    }
  }

  // 4. Media.
  let media = state.media
  if (offered.has('media')) {
    const synced = await syncMedia(target.id, catalog, door.source.id, state, overrides, link.id)
    media = synced.media
    if (synced.decision === 'override' && !overrides.has(MEDIA_KEY)) outcome.overrides.push(MEDIA_KEY)
    if (synced.decision === 'apply') outcome.applied.push(MEDIA_KEY)
    for (const failure of synced.failed) refused.set(MEDIA_KEY, failure)
  }

  // 5. Fingerprint what now stands. A refused field keeps its old fingerprint, so it is tried again.
  const fields: AppliedState['fields'] = { ...state.fields }
  const touched = [...decisions].filter(([key, decision]) => (decision === 'apply' || decision === 'record') && !refused.has(key) && !(key === SKU_KEY && held))
  if (touched.length) {
    const followerAfter = rowPrints(await exportFollower(target.id, market, locales), (id) => tree.get(id) ?? null)
    const managedAfter = await prisma.product.findUnique({ where: { id: target.id }, select: { ...managedSelect, sku: true } })
    for (const [key, decision] of touched) {
      const after = key === SKU_KEY ? fingerprint(managedAfter?.sku ?? '')
        : key.startsWith(MANAGED_PREFIX) ? fingerprint(managedValue(managedAfter?.[key.slice(MANAGED_PREFIX.length) as keyof ManagedFields]))
        : followerAfter.get(key) ?? ABSENT
      fields[key] = [sourcePrint.get(key)!, after]
      if (decision === 'apply') outcome.applied.push(key)
      else outcome.recorded.push(key)
    }
  }
  outcome.refused = [...refused].map(([key, message]) => ({ key, message }))
  outcome.held = held

  // 6. Variations added at the source.
  if (offered.has('structure') && door.variations.length) {
    outcome.created.push(...await createNewVariations(link, door, target, market))
  }

  const nextOverrides = [...new Set([...overrides, ...outcome.overrides])].sort()
  await prisma.catalogLink.update({
    where: { id: link.id },
    data: {
      appliedState: { v: 1, fields, ...(media ? { media } : {}) } as unknown as Prisma.InputJsonValue,
      overrides: nextOverrides,
      sourceVersion: door.source.version,
      lastSyncedAt: new Date(),
      lastSyncError: refused.size ? [...refused].map(([key, message]) => `${key}: ${message}`).join('\n').slice(0, 2000) : null,
      ...(held ? { heldSku: held.sku, heldReason: held.reason, heldAt: link.heldSku === held.sku ? link.heldAt : new Date() } : { heldSku: null, heldReason: null, heldAt: null }),
      ...(link.syncMarket ? {} : { syncMarket: market }),
    },
  })

  if (held && link.heldSku !== held.sku) {
    await notifyOwners({
      type: 'assortment-sku-held', severity: 'warn',
      title: `SKU change waiting: ${target.sku} → ${held.sku}`,
      body: held.reason,
      entityType: 'Product', entityId: target.id, href: `/products/${encodeURIComponent(target.id)}/edit`,
    })
  }
  if (outcome.created.length) {
    await notifyOwners({
      type: 'assortment-sync-created', severity: 'info',
      title: `Created while following shared products: ${outcome.created.length}`,
      body: outcome.created.slice(0, 20).join(', '),
      entityType: 'CatalogLink', entityId: link.id, href: '/settings/sharing',
    })
  }
  if (outcome.applied.length) {
    await productEventService.emit({
      aggregateId: target.id, aggregateType: 'Product', eventType: 'PRODUCT_UPDATED',
      data: { source: 'assortment-sync', fields: outcome.applied },
      metadata: { source: 'SYSTEM', linkId: link.id },
    })
  }
  outcome.outcome = outcome.applied.length || outcome.created.length ? 'synced' : 'unchanged'
  return outcome
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────

const managedSelect = { productType: true, basePrice: true, minPrice: true, maxPrice: true, b2bPrice: true, b2bMinQty: true, status: true } as const

function managedValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && value !== null && 'toString' in value && !Array.isArray(value)) return Number(String(value))
  if (typeof value === 'number') return value
  const numeric = typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null
  return numeric ?? value
}

const isRowKey = (key: string) => key !== SKU_KEY && key !== MEDIA_KEY && !key.startsWith(MANAGED_PREFIX)

/** The source's category rows with slug paths in place of its ids (ids differ per business). */
function pathRows(rows: TransferRow[], product: OfferedCatalog['products'][number]): TransferRow[] {
  return rows.map((row) => {
    if (row.action !== 'SET') return row
    if (row.field === 'categoryIds') return { ...row, value: product.categoryPaths.map((path) => path.join('/')).sort() }
    if (row.field === 'primaryCategoryId') return { ...row, value: product.primaryCategoryPath?.join('/') ?? null }
    return row
  })
}

let treeCache: { workspaceId: string; at: number; tree: Map<string, string> } | null = null
/** This business's categories: id → slug path. */
async function categoryTree(fresh = false): Promise<Map<string, string>> {
  const { workspaceId } = requireWorkspace()
  if (!fresh && treeCache && treeCache.workspaceId === workspaceId && Date.now() - treeCache.at < 5_000) return treeCache.tree
  const categories = await prisma.category.findMany({ select: { id: true, parentId: true, slug: true } })
  const byId = new Map(categories.map((c) => [c.id, c]))
  const tree = new Map<string, string>()
  for (const category of categories) {
    const path: string[] = []
    for (let at: typeof category | undefined = category; at && path.length < 64; at = at.parentId ? byId.get(at.parentId) : undefined) path.unshift(at.slug)
    tree.set(category.id, path.join('/'))
  }
  treeCache = { workspaceId, at: Date.now(), tree }
  return tree
}

/** The follower product's rows, exported as the source's are (same market, same languages, no listings). */
async function exportFollower(productId: string, market: string, locales: string[]): Promise<TransferRow[]> {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: productInclude })
  if (!product) return []
  const families = await prisma.productFamily.findMany({ select: { id: true, code: true, label: true, description: true, parentFamilyId: true } })
  const boundary = {
    productId: product.id, rootId: product.parentId ?? product.id,
    products: [{ id: product.id, sku: product.sku, parentId: product.parentId }],
    includeShared: true, listings: [], locales,
  }
  const rows = await catalogRows([product], { market, boundary }, transferContracts(market, { allowIncompleteSchema: true, allowUnknownMarket: true }), families)
  return rows.filter((row) => row.entity === 'Products')
}

async function marketFor(link: { shareId: string; syncMarket: string | null }): Promise<string> {
  if (link.syncMarket && MARKET.test(link.syncMarket)) return link.syncMarket
  const run = await prisma.assortmentCopyRun.findFirst({ where: { shareId: link.shareId, state: { in: ['done', 'partial'] } }, orderBy: { createdAt: 'desc' }, select: { market: true } })
  return run?.market && MARKET.test(run.market) ? run.market : 'GLOBAL'
}

// ── Applying rows ───────────────────────────────────────────────────────────────────────────

/**
 * The source rows for `keys`, made valid in this business: the follower's SKU, its categories by
 * path, its own parent, and an inherited language row without the parent's text. A field that cannot
 * be placed here (a category path or a parent this business does not have) is refused with its reason.
 */
async function rowsForFollower(
  rows: TransferRow[], keys: string[],
  context: { sku: string; sourceParentId: string | null; shareId: string; paths: OfferedCatalog['products'][number]; tree: Map<string, string> },
): Promise<{ rows: TransferRow[]; refused: Map<string, string> }> {
  const wanted = new Set(keys)
  const idByPath = new Map([...context.tree].map(([id, path]) => [path, id]))
  const refused = new Map<string, string>()
  const out: TransferRow[] = []
  const present = new Set<string>()
  const base = rows.find((row) => row.entity === 'Products')
  for (const row of rows) {
    if (row.entity !== 'Products') continue
    const key = fieldKey(row)
    if (!wanted.has(key)) continue
    present.add(key)
    const mine: TransferRow = { ...row, sku: context.sku }
    if (row.locale && row.action === 'INHERIT') { out.push({ ...mine, value: undefined }); continue }
    if (row.field === 'categoryIds' && row.action === 'SET') {
      const paths = context.paths.categoryPaths.map((path) => path.join('/'))
      const ids = paths.map((path) => idByPath.get(path))
      if (ids.some((id) => !id)) { refused.set(key, 'a category of the shared product does not exist in this business'); continue }
      out.push({ ...mine, value: (ids as string[]).sort() })
      continue
    }
    if (row.field === 'primaryCategoryId' && row.action === 'SET') {
      const id = context.paths.primaryCategoryPath ? idByPath.get(context.paths.primaryCategoryPath.join('/')) : undefined
      out.push(id ? { ...mine, value: id } : { ...mine, action: 'INHERIT', value: undefined })
      continue
    }
    if (row.field === 'parentSku' && row.action === 'SET') {
      const parent = context.sourceParentId ? await followerOf(context.shareId, context.sourceParentId) : null
      if (!parent) { refused.set(key, 'its parent does not follow a shared product in this business'); continue }
      out.push({ ...mine, value: parent.sku })
      continue
    }
    out.push(mine)
  }
  // A field the source no longer carries: a translation removed there is removed here too. Any other
  // field (an emptied list, which the export leaves out) is refused with its reason, never marked done.
  for (const key of wanted) {
    if (present.has(key)) continue
    const [field, locale] = key.split('@')
    if (!locale || !base) { refused.set(key, 'the shared product has no value here now; emptying it is not followed, so empty it here by hand'); continue }
    out.push({ ...base, sku: context.sku, field, locale, action: 'INHERIT', value: undefined })
  }
  return { rows: out, refused }
}

/** The follower product that follows a source product through this share, if any. */
async function followerOf(shareId: string, sourceProductId: string): Promise<{ id: string; sku: string } | null> {
  const link = await prisma.catalogLink.findFirst({ where: { shareId, sourceProductId, status: 'active' }, select: { targetProductId: true } })
  if (!link) return null
  return prisma.product.findFirst({ where: { id: link.targetProductId, deletedAt: null }, select: { id: true, sku: true } })
}

class PlanRefused extends Error {
  constructor(readonly issues: TransferIssue[]) { super(issues.map((issue) => issue.message).join('; ')) }
}

/**
 * Plan and apply rows for one product with the transfer engine, in one transaction, with the sync flag
 * set. Refused fields are dropped and the rest applied; each refused field comes back with its reason.
 */
async function applyRows(rows: TransferRow[], sku: string, market: string, label: string, mode: 'update' | 'create'): Promise<Map<string, string>> {
  const refused = new Map<string, string>()
  const contracts = transferContracts(market, { allowIncompleteSchema: true, allowUnknownMarket: true })
  let attempt = rows
  for (let pass = 0; pass < 3 && attempt.length; pass++) {
    try {
      await inDatabaseTransaction(prisma, async () => {
        await prisma.$executeRaw`SELECT nexus_assortment_sync_write()`
        const context = await loadTransferContext(attempt, prisma)
        const plan = await buildTransferPlan(attempt, mode, context, contracts, undefined, { declaredProductSkus: new Set([sku]) })
        if (plan.issues.length) throw new PlanRefused(plan.issues)
        for (const target of plan.targets) {
          if (target.create || target.cells.some((cell) => cell.verdict === 'changed')) await applyTransferTarget(prisma, target, label, null)
        }
      })
      return refused
    } catch (error) {
      if (!(error instanceof PlanRefused)) throw error
      const fields = new Set(error.issues.map((issue) => issue.field).filter(Boolean))
      for (const row of attempt) if (fields.has(row.field)) refused.set(fieldKey(row), error.issues.find((issue) => issue.field === row.field)?.message ?? 'refused')
      const next = attempt.filter((row) => !fields.has(row.field))
      // An issue that names no field of these rows refuses the product as a whole.
      if (next.length === attempt.length) {
        for (const row of attempt) refused.set(fieldKey(row), error.message)
        return refused
      }
      attempt = next
    }
  }
  return refused
}

/** Families, attributes, options and category paths the followed values need and this business lacks. */
async function ensureDefinitions(catalog: OfferedCatalog): Promise<string[]> {
  const { workspaceId } = requireWorkspace()
  const missing = await missingDefinitions(catalog, workspaceId)
  const { create } = missing
  const count = create.families.length + create.attributeGroups.length + create.attributes.length + create.options.length + create.familyAttributes.length + create.categories.length
  if (!count) return []
  const created = await createDefinitions(catalog, missing)
  return [
    ...created.families.map((code) => `family ${code}`), ...created.attributes.map((code) => `attribute ${code}`),
    ...created.options.map((text) => `options ${text}`), ...created.categories.map((path) => `category ${path}`),
  ]
}

// ── SKU ─────────────────────────────────────────────────────────────────────────────────────

/**
 * R-AE-2. "Live" is the bulk editor's definition (bulk-edit.service.ts): a listing ACTIVE and
 * published, of the product or of one of its variations — the channel keeps the old seller SKU, so a
 * rename there would silently break the listing.
 */
async function renameSku(target: { id: string; sku: string }, sku: string): Promise<{ held: string | null }> {
  const live = await prisma.channelListing.findMany({
    where: { listingStatus: 'ACTIVE', isPublished: true, OR: [{ productId: target.id }, { product: { parentId: target.id } }] },
    select: { channel: true },
  })
  if (live.length) {
    const channels = [...new Set(live.map((listing) => listing.channel))].sort().join(', ')
    return { held: `This product is live on ${channels}. A channel keeps the old seller SKU, so the new SKU waits here. End or unpublish the listing, and the new SKU is applied by itself; then list it again under the new SKU.` }
  }
  const taken = await prisma.product.findFirst({ where: { sku, NOT: { id: target.id } }, select: { id: true } })
  if (taken) return { held: `This business already has a product with the SKU ${sku}. Rename or delete that product, and the new SKU is applied by itself.` }
  try {
    const renamed = await prisma.product.updateMany({ where: { id: target.id, sku: target.sku }, data: { sku, version: { increment: 1 } } })
    if (!renamed.count) return { held: 'The product changed while its SKU was being renamed. It is tried again.' }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { held: `This business already has a product with the SKU ${sku}. Rename or delete that product, and the new SKU is applied by itself.` }
    }
    throw error
  }
  return { held: null }
}

// ── Media ───────────────────────────────────────────────────────────────────────────────────

async function followerImages(productId: string): Promise<ImageFacts[]> {
  return prisma.productImage.findMany({ where: { productId }, select: { id: true, url: true, alt: true, type: true, isPrimary: true, sortOrder: true } })
}

function sourceImagesOf(catalog: OfferedCatalog, productId: string) {
  return catalog.images.filter((image) => image.productId === productId && image.mediaType === 'IMAGE')
}

async function syncMedia(targetId: string, catalog: OfferedCatalog, sourceId: string, state: AppliedState, overrides: Set<string>, linkId: string): Promise<{
  decision: Decision; media: AppliedState['media']; failed: string[]
}> {
  const images = sourceImagesOf(catalog, sourceId)
  const facts: ImageFacts[] = images.map((image) => ({ id: image.id, url: image.url, alt: image.alt, type: image.type, isPrimary: image.isPrimary, sortOrder: image.sortOrder }))
  const current = await followerImages(targetId)
  if (overrides.has(MEDIA_KEY)) return { decision: 'override', media: state.media, failed: [] }
  const map = state.media?.map ?? []
  if (!state.media) {
    // No baseline: only an empty image set is filled; anything else was chosen here.
    if (current.length && facts.length) return { decision: 'override', media: state.media, failed: [] }
    if (!facts.length) return { decision: 'record', media: { target: followerMediaPrint(current), map: [] }, failed: [] }
  } else if (state.media.target !== FOLLOW_AGAIN && followerMediaPrint(current) !== state.media.target) {
    return { decision: 'override', media: state.media, failed: [] }
  }
  const plan = planMedia(facts, map)
  if (!plan.add.length && !plan.remove.length && !plan.update.length) {
    return { decision: 'same', media: state.media ?? { target: followerMediaPrint(current), map }, failed: [] }
  }

  const failed: string[] = []
  const kept = new Map(map.map((entry) => [entry.source, entry]))
  for (const entry of plan.remove) {
    kept.delete(entry.source)
    const image = await prisma.productImage.findFirst({ where: { id: entry.target, productId: targetId } })
    if (!image) continue
    await prisma.productImage.delete({ where: { id: image.id } })
    if (image.publicId && isCloudinaryConfigured()) {
      cleanUpUnreferencedMedia({ publicId: image.publicId, url: image.url, mediaType: image.mediaType }).catch(() => { /* bytes stay when their references cannot be checked */ })
    }
  }
  for (const { source, entry } of plan.update) {
    const others = current.filter((image) => image.id !== entry.target)
    await prisma.productImage.updateMany({
      where: { id: entry.target, productId: targetId },
      data: {
        alt: source.alt,
        type: source.type === 'MAIN' && others.some((image) => image.type === 'MAIN') ? 'ALT' : source.type,
        isPrimary: source.isPrimary && !others.some((image) => image.isPrimary),
      },
    })
    kept.set(source.id, { ...entry, meta: imageMetaPrint(source) })
  }
  if (plan.add.length) {
    const planned: PlannedImage[] = images.filter((image) => plan.add.some((add) => add.id === image.id)).map((image) => ({
      id: image.id, url: image.url, alt: image.alt, type: image.type, isPrimary: image.isPrimary, sortOrder: image.sortOrder,
      width: image.width, height: image.height, mimeType: image.mimeType, fileSize: image.fileSize,
    }))
    const copied = await copyImages(targetId, planned)
    failed.push(...copied.failed)
    for (const pair of copied.pairs) {
      const image = plan.add.find((add) => add.id === pair.source)!
      kept.set(pair.source, { source: pair.source, target: pair.target, file: imageFilePrint(image), meta: imageMetaPrint(image) })
    }
  }
  logger.info('assortment-sync: images followed', { linkId, added: plan.add.length - failed.length, removed: plan.remove.length, updated: plan.update.length })
  const nextMap: MediaEntry[] = [...kept.values()].sort((a, b) => a.source.localeCompare(b.source))
  return { decision: 'apply', media: { target: followerMediaPrint(await followerImages(targetId)), map: nextMap }, failed }
}

// ── Structure ───────────────────────────────────────────────────────────────────────────────

/**
 * A variation added at the source under this followed parent: created here under the follower's parent
 * and linked, with its owner-managed fields and images, and its baseline recorded. A variation whose SKU
 * already exists in this business is left for a person: the next copy review offers link or skip.
 */
async function createNewVariations(link: { id: string; shareId: string }, door: LinkSource, parent: { id: string; sku: string }, market: string): Promise<string[]> {
  const { workspaceId } = requireWorkspace()
  const created: string[] = []
  const linked = new Set((await prisma.catalogLink.findMany({
    where: { shareId: link.shareId, targetWorkspaceId: workspaceId, status: 'active', sourceProductId: { in: door.variations.map((v) => v.id) } },
    select: { sourceProductId: true },
  })).map((row) => row.sourceProductId))
  for (const variation of door.variations) {
    if (linked.has(variation.id)) continue
    const existing = await prisma.product.findFirst({ where: { sku: variation.sku }, select: { id: true } })
    if (existing) {
      await notifyOwners({
        type: 'assortment-variation-exists', severity: 'info',
        title: `New shared variation ${variation.sku} was not linked`,
        body: `The shared ${door.source?.sku ?? 'product'} has a new variation ${variation.sku}, and this business already has a product with that SKU. Open Shared products and copy products to link or skip it.`,
        entityType: 'Product', entityId: existing.id, href: '/settings/sharing',
      })
      continue
    }
    const catalog = await readLinkedCatalog({ link: door, productIds: [variation.id], market })
    created.push(...await ensureDefinitions(catalog))
    const product = catalog.products[0]
    const tree = await categoryTree(true)
    const rows = await rowsForFollower(catalog.rows, [...new Set(catalog.rows.filter((row) => row.entity === 'Products').map(fieldKey))],
      { sku: variation.sku, sourceParentId: door.source?.id ?? null, shareId: link.shareId, paths: product, tree })
    const refusedCreate = await applyRows(rows.rows, variation.sku, market, `assortment-sync:${link.id}`, 'create')
    const made = await prisma.product.findFirst({ where: { sku: variation.sku, deletedAt: null }, select: { id: true, parentId: true } })
    if (!made) {
      logger.warn('assortment-sync: a new variation could not be created', { linkId: link.id, sku: variation.sku, refused: [...refusedCreate.values()].slice(0, 3) })
      continue
    }
    const newLink = await prisma.catalogLink.create({
      data: {
        shareId: link.shareId, sourceWorkspaceId: door.ownerWorkspaceId, sourceProductId: variation.id,
        targetWorkspaceId: workspaceId, targetProductId: made.id, linkedBy: 'created', sourceVersion: variation.version, syncMarket: market,
      },
      select: { id: true },
    })
    await applyManaged(made.id, product.managed, `assortment-sync:${link.id}`)
    const images = sourceImagesOf(catalog, variation.id).map((image) => ({
      id: image.id, url: image.url, alt: image.alt, type: image.type, isPrimary: image.isPrimary, sortOrder: image.sortOrder,
      width: image.width, height: image.height, mimeType: image.mimeType, fileSize: image.fileSize,
    }))
    const copied = await copyImages(made.id, images)
    await recordBaseline(newLink.id, { rows: catalog.rows, product, managed: product.managed, sku: variation.sku, market, images, pairs: copied.pairs })
    created.push(`variation ${variation.sku}`)
  }
  return created
}

// ── Baseline ────────────────────────────────────────────────────────────────────────────────

/**
 * The fingerprints a new link starts from: the source values as they were copied, and the follower's
 * values right after. Called when a copy finishes and when a variation is created here. `rows` are the
 * copied rows (category ids of either business: they compare by path).
 */
export async function recordBaseline(linkId: string, input: {
  rows: TransferRow[]
  product: { categoryPaths: string[][]; primaryCategoryPath: string[] | null } | null
  managed: ManagedFields
  sku: string
  market: string
  images: Array<Pick<PlannedImage, 'id' | 'url' | 'alt' | 'type' | 'isPrimary'>>
  pairs: Array<{ source: string; target: string }>
}): Promise<void> {
  const link = await prisma.catalogLink.findFirst({ where: { id: linkId, status: 'active' }, select: { targetProductId: true } })
  if (!link) return
  const tree = await categoryTree(true)
  const productRows = input.rows.filter((row) => row.entity === 'Products')
  const sourceRows = input.product ? pathRows(productRows, { ...input.product } as OfferedCatalog['products'][number]) : productRows
  const sourcePrints = input.product ? rowPrints(sourceRows, (path) => path) : rowPrints(sourceRows, (id) => tree.get(id) ?? null)
  const locales = [...new Set([PRIMARY_CONTENT_LOCALE, ...productRows.map((row) => row.locale).filter(Boolean)])]
  const followerPrints = rowPrints(await exportFollower(link.targetProductId, input.market, locales), (id) => tree.get(id) ?? null)
  const fields: AppliedState['fields'] = {}
  for (const [key, print] of sourcePrints) fields[key] = [print, followerPrints.get(key) ?? ABSENT]
  const current = await prisma.product.findUnique({ where: { id: link.targetProductId }, select: { ...managedSelect, sku: true } })
  for (const field of MANAGED_FIELDS) {
    if (!(field in input.managed)) continue
    fields[MANAGED_PREFIX + field] = [fingerprint(managedValue(input.managed[field])), fingerprint(managedValue(current?.[field]))]
  }
  fields[SKU_KEY] = [fingerprint(input.sku), fingerprint(current?.sku ?? '')]
  const byId = new Map(input.images.map((image) => [image.id, image]))
  const map: MediaEntry[] = input.pairs.flatMap((pair) => {
    const image = byId.get(pair.source)
    return image ? [{ source: pair.source, target: pair.target, file: imageFilePrint(image), meta: imageMetaPrint(image) }] : []
  }).sort((a, b) => a.source.localeCompare(b.source))
  const state: AppliedState = { v: 1, fields, media: { target: followerMediaPrint(await followerImages(link.targetProductId)), map } }
  await prisma.catalogLink.update({
    where: { id: linkId },
    data: { appliedState: state as unknown as Prisma.InputJsonValue, syncMarket: input.market, lastSyncedAt: new Date() },
  })
}

// ── Reading a link's state ──────────────────────────────────────────────────────────────────

export interface LinkStateView {
  link: {
    id: string
    shareId: string
    sourceBusiness: string | null
    linkedBy: string
    status: string
    detachedReason: string | null
    heldSku: string | null
    heldReason: string | null
    heldAt: Date | null
    lastSyncedAt: Date | null
    lastSyncError: string | null
  } | null
  /**
   * Every followed field, measured now: "override" when this business keeps its own value (recorded, or
   * edited since the last sync — the next sync records it), "follow" otherwise.
   */
  fields: Array<{ key: string; state: 'follow' | 'override' }>
}

/** The link of one product of this business, newest first (a detached link is history). */
export async function catalogLinkState(productId: string): Promise<LinkStateView> {
  requireWorkspace()
  const link = await prisma.catalogLink.findFirst({ where: { targetProductId: productId }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] })
  if (!link) return { link: null, fields: [] }
  const share = await prisma.assortmentShare.findFirst({ where: { id: link.shareId }, select: { ownerWorkspace: { select: { name: true } } } })
  const view: LinkStateView['link'] = {
    id: link.id, shareId: link.shareId, sourceBusiness: share?.ownerWorkspace.name ?? null, linkedBy: link.linkedBy, status: link.status,
    detachedReason: link.detachedReason, heldSku: link.heldSku, heldReason: link.heldReason, heldAt: link.heldAt,
    lastSyncedAt: link.lastSyncedAt, lastSyncError: link.lastSyncError,
  }
  if (link.status !== 'active') return { link: view, fields: [] }
  const state = readState(link.appliedState)
  const overrides = new Set(link.overrides)
  const rowKeys = Object.keys(state.fields).filter(isRowKey)
  const locales = [...new Set([PRIMARY_CONTENT_LOCALE, ...rowKeys.map((key) => key.split('@')[1]).filter(Boolean)])]
  const tree = await categoryTree()
  const now = rowKeys.length ? rowPrints(await exportFollower(productId, await marketFor(link), locales), (id) => tree.get(id) ?? null) : new Map<string, string>()
  const current = await prisma.product.findUnique({ where: { id: productId }, select: { ...managedSelect, sku: true } })
  const printOf = (key: string) => key === SKU_KEY ? fingerprint(current?.sku ?? '')
    : key.startsWith(MANAGED_PREFIX) ? fingerprint(managedValue(current?.[key.slice(MANAGED_PREFIX.length) as keyof ManagedFields]))
    : now.get(key) ?? ABSENT
  const fields: LinkStateView['fields'] = Object.entries(state.fields).map(([key, pair]) => ({
    key, state: overrides.has(key) || (pair[1] !== FOLLOW_AGAIN && printOf(key) !== pair[1]) ? 'override' as const : 'follow' as const,
  }))
  if (state.media) {
    const edited = state.media.target !== FOLLOW_AGAIN && followerMediaPrint(await followerImages(productId)) !== state.media.target
    fields.push({ key: MEDIA_KEY, state: overrides.has(MEDIA_KEY) || edited ? 'override' : 'follow' })
  }
  for (const key of overrides) if (!fields.some((field) => field.key === key)) fields.push({ key, state: 'override' })
  return { link: view, fields: fields.sort((a, b) => a.key.localeCompare(b.key)) }
}

/** A partial copy finished again: the images copied now join the link's image map. Writes nothing if none is new. */
export async function mergeMediaPairs(linkId: string, images: Array<Pick<PlannedImage, 'id' | 'url' | 'alt' | 'type' | 'isPrimary'>>, pairs: Array<{ source: string; target: string }>): Promise<void> {
  const link = await prisma.catalogLink.findFirst({ where: { id: linkId, status: 'active' }, select: { targetProductId: true, appliedState: true } })
  if (!link) return
  const state = readState(link.appliedState)
  const map = new Map((state.media?.map ?? []).map((entry) => [entry.source, entry]))
  const byId = new Map(images.map((image) => [image.id, image]))
  let added = 0
  for (const pair of pairs) {
    const image = byId.get(pair.source)
    if (!image || map.get(pair.source)?.target === pair.target) continue
    map.set(pair.source, { source: pair.source, target: pair.target, file: imageFilePrint(image), meta: imageMetaPrint(image) })
    added++
  }
  if (!added) return
  state.media = { target: followerMediaPrint(await followerImages(link.targetProductId)), map: [...map.values()].sort((a, b) => a.source.localeCompare(b.source)) }
  await prisma.catalogLink.update({ where: { id: linkId }, data: { appliedState: state as unknown as Prisma.InputJsonValue } })
}

// ── Detach ──────────────────────────────────────────────────────────────────────────────────

async function detach(linkId: string, reason: string): Promise<void> {
  await prisma.catalogLink.updateMany({
    where: { id: linkId, status: 'active' },
    data: { status: 'detached', detachedAt: new Date(), detachedReason: reason },
  })
}
