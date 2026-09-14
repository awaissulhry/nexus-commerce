import { inDatabaseTransaction, activeDatabaseTransaction } from '../../lib/database-context.js'
import { writeContent } from './content-write.js'
import { produceReadiness } from './readiness-index.service.js'
import { lockCategoryTree } from '../category-lock.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import { productReadCacheService } from '../product-read-cache.service.js'
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { transferTargetKey, type TransferMode, type TransferPreview, type TransferRow, type TransferIssue } from '@nexus/shared/catalog-transfer'
import { buildTransferPlan, fingerprint, transferContracts, type TransferContext, type TransferProduct, type TransferTarget, type TransferPlan } from './catalog-transfer-plan.js'
import { clearSheetColumnCache } from './sheet-columns.service.js'
import { clearFieldCatalogueCache } from './mapping/field-catalogue.service.js'
import { productRoleOf } from '@nexus/shared/master-sheet'
import { relationshipAliasConflicts } from './relationship-alias-guard.js'

type Payload = { kind: 'catalog-transfer-v1'; market: string; mode: TransferMode; rows?: TransferRow[]; plan: TransferPlan; previewExpiresAt: string }
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export const safeSnapshot = (value: Record<string, unknown> | null) => value ? json({ ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_count')),
  ...('categories' in value ? { categories: (value.categories as { categoryId: string }[]).slice().sort((a, b) => a.categoryId.localeCompare(b.categoryId)) } : {}),
}) : null

/**
 * LX.F2 R-LX-21 (F-LX-4) — the columns a SHARED-content write cascades onto a channel
 * listing it did not otherwise change: `master-content.service.ts:137` bumps `version` and
 * sets `lastSyncStatus: 'PENDING'` / `lastSyncedAt: null` for every listing that FOLLOWS the
 * shared text, and Prisma stamps `updatedAt`. That is a real change to the row, so the
 * cascade is right to make it — but it is not a change to anything the PREVIEW read.
 *
 * Measured, the exact difference that refused a whole job (LXF2_DIFF probe on
 * `catalog-transfer-http.vitest.test.ts`, 2026-09-13 09:57): a workbook that sets the shared
 * `name` AND a channel `title` on the same product applied target 1 (the product), whose
 * cascade moved the listing `version` **8 → 9**, `updatedAt`
 * `2026-01-01T00:00:00.000Z → 2026-09-13T07:57:53.190Z`, `lastSyncStatus` `undefined →
 * 'PENDING'`, `lastSyncedAt` `undefined → null` — and **no other field differed at all** —
 * then refused target 2 with "Listing changed since preview", leaving the job `PARTIAL`.
 * A job cannot be allowed to invalidate its own preview.
 *
 * So the conflict detector compares what the preview DEPENDED ON. The write itself keeps its
 * compare-and-set on the FRESHLY READ `version` + `updatedAt`
 * (`channelListing.updateMany({ where: { id, version, updatedAt } })`), so a commit that
 * races this transaction is still refused, and any real difference in a stored value — the
 * case that actually means "someone edited this listing" — still fails the fingerprint.
 */
const CASCADE_STAMPED_LISTING_FIELDS = ['version', 'updatedAt', 'lastSyncStatus', 'lastSyncedAt'] as const
/** The stored content of a `ChannelListingTranslation`; everything else on that row is bookkeeping. */
const PIN_CONTENT_FIELDS = ['name', 'description', 'bulletPoints', 'keywords', 'attributes'] as const
const pinCarriesContent = (pin: Record<string, unknown>) => PIN_CONTENT_FIELDS.some(field => {
  const value = pin[field]
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return value !== ''
})
export const listingConflictSnapshot = (value: Record<string, unknown> | null) => {
  const snapshot = safeSnapshot(value) as Record<string, unknown> | null
  if (!snapshot) return null
  for (const field of CASCADE_STAMPED_LISTING_FIELDS) delete snapshot[field]
  // The second half of the same cascade: for every language that FOLLOWS the shared text it
  // writes a `ChannelListingTranslation` carrying only `follows` (+ its own version) — no
  // stored content at all (`master-content.service.ts:135-136`). Measured with the harness's
  // `translations` include repaired: the cascade created `{language:'it', follows:['title'],
  // version:1}` on a listing whose preview snapshot had `translations: []`, and the whole job
  // read PARTIAL again. A content-free pin row is not a change to any value the preview read,
  // so the comparison keeps only pins that actually carry content, and compares their CONTENT
  // (plus `language` and the `follows` set), never their ids or versions.
  if (Array.isArray(snapshot.translations)) {
    snapshot.translations = (snapshot.translations as Record<string, unknown>[])
      .filter(pinCarriesContent)
      .map(pin => ({ language: pin.language, follows: [...(pin.follows as string[] ?? [])].sort(), ...Object.fromEntries(PIN_CONTENT_FIELDS.map(field => [field, pin[field] ?? null])) }))
      .sort((a, b) => String(a.language).localeCompare(String(b.language)))
  }
  return snapshot
}

export async function loadTransferContext(rows: TransferRow[], db = prisma, reference?: Pick<TransferContext, 'families' | 'categories' | 'accounts' | 'markets'>): Promise<TransferContext> {
  const skus = [...new Set(rows.flatMap(r => [r.sku, ...(r.entity === 'Products' && r.field === 'parentSku' && r.action === 'SET' ? [String(r.value)] : [])]))]
  if (skus.length > 5000) throw new Error('Import at most 5,000 products per file; split larger catalogs into separate files')
  const [products, accounts, markets, aliases] = await Promise.all([
    db.product.findMany({ where: { OR: [{ sku: { in: skus } }, { children: { some: { sku: { in: skus } } } }] }, include: { translations: true, parent: { include: { translations: true } }, categories: { select: { categoryId: true, isPrimary: true } }, _count: { select: { children: true } } } }),
    reference ? Promise.resolve(reference.accounts) : db.channelConnection.findMany({ where: { id: { in: [...new Set(rows.map(r => r.accountId).filter(Boolean))] } }, select: { id: true, channelType: true, marketplace: true, isActive: true } }),
    reference ? Promise.resolve(reference.markets) : db.marketplace.findMany({ where: { isActive: true, OR: rows.filter(r => r.channel && r.marketplace).map(r => ({ channel: r.channel, code: r.marketplace })) }, select: { channel: true, code: true, language: true, languages: true } }),
    db.productListingAlias.findMany({ where: { id: { in: [...new Set(rows.map(r => r.aliasKey).filter(Boolean))] } }, select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, status: true } }),
  ])
  const familyIds = [...new Set(products.map(p => p.familyId).filter((id): id is string => !!id))]
  const familyCodes = rows.filter(r => r.entity === 'Products' && r.field === 'family' && r.action === 'SET').map(r => String(r.value))
  const categoryIds = [...new Set([...products.flatMap(p => p.categories.map(c => c.categoryId)), ...rows.filter(r => r.entity === 'Products' && ['categoryIds', 'primaryCategoryId'].includes(r.field) && r.action === 'SET').flatMap(r => Array.isArray(r.value) ? r.value.filter((id): id is string => typeof id === 'string') : typeof r.value === 'string' ? [r.value] : [])])]
  const [families, categories] = await Promise.all([
    reference ? Promise.resolve(reference.families) : db.productFamily.findMany({ where: { OR: [{ id: { in: familyIds } }, { code: { in: familyCodes } }] }, select: { id: true, code: true, label: true }, orderBy: { code: 'asc' } }),
    reference ? Promise.resolve(reference.categories) : db.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, isActive: true } }),
  ])
  const productMap = new Map(products.map(p => [p.sku, safeSnapshot(p) as TransferProduct]))
  const skuByProductId = new Map(products.map(p => [p.id, p.sku]))
  const relationshipChanges = [...new Set(rows.filter(row => row.entity === 'Products' && row.field === 'parentSku').flatMap(row => {
    const product = productMap.get(row.sku)
    if (!product) return []
    const current = product.parentId ? skuByProductId.get(product.parentId) ?? null : null
    return current !== (row.action === 'SET' ? row.value : null) ? [product.id] : []
  }))]
  const relationshipBlockedProducts = await relationshipAliasConflicts(db, relationshipChanges)
  const channelRows = rows.filter(r => r.entity !== 'Products')
  const coordinates = [...new Map(channelRows.filter(r => productMap.has(r.sku)).map(r => [transferTargetKey(r), { productId: productMap.get(r.sku)!.id, channel: r.channel, marketplace: r.marketplace, channelConnectionId: r.accountId, aliasKey: r.aliasKey }])).values()]
  const listings = coordinates.length ? await db.channelListing.findMany({ where: { OR: coordinates }, include: { translations: true }, take: 10_001 }) : []
  if (listings.length > 10_000) throw new Error('This transfer batch exceeds 10,000 matching listing records')
  const byId = new Map(products.map(p => [p.id, p.sku]))
  const categoryDefaults: Record<string, string | null> = {}
  const { resolveCategoriesForProducts } = await import('./mapping/category-mapping.service.js')
  for (const coordinate of new Set(channelRows.map(r => JSON.stringify([r.channel, r.marketplace])))) {
    const [channel, marketplace] = JSON.parse(coordinate) as string[]
    const defaults = await resolveCategoriesForProducts({ productIds: products.map(p => p.id), channel, marketplace })
    for (const product of products) categoryDefaults[JSON.stringify([product.sku, channel, marketplace])] = defaults[product.id]?.channelCategoryId ?? null
  }
  const listingMap = new Map<string, Record<string, unknown>[]>()
  for (const listing of listings) {
    const key = transferTargetKey({ entity: 'Listings', sku: byId.get(listing.productId)!, channel: listing.channel, accountId: listing.channelConnectionId!, marketplace: listing.marketplace, aliasKey: listing.aliasKey })
    listingMap.set(key, [...(listingMap.get(key) ?? []), safeSnapshot(listing)!])
  }
  const productIds = products.map(p => p.id)
  const formulas = await db.cellFormula.findMany({ where: { OR: [{ productId: { in: productIds } }, { product: { parentId: { in: productIds } } }] }, select: { productId: true, scope: true, channel: true, marketplace: true, locale: true, fieldKey: true, dependsOn: true, product: { select: { parentId: true } } } })
  return { products: productMap, listings: listingMap, families, categories, accounts, markets, aliases, categoryDefaults, formulas, relationshipBlockedProducts, parentsWithChildren: new Set(products.filter(p => p._count?.children > 0).map(p => p.id)) }
}

function payloadOf(value: unknown): Payload | null {
  const payload = value as Payload | null
  return payload?.kind === 'catalog-transfer-v1' ? payload : null
}
export async function readCatalogTransfer(jobId: string, userId: string | null) {
  const job = await prisma.bulkOperation.findFirst({ where: { id: jobId, userId } })
  const payload = payloadOf(job?.changes)
  return job && payload ? { job, payload } : null
}

function counts(plan: TransferPlan) {
  const cells = plan.targets.flatMap(t => t.cells)
  return { productsCreated: plan.targets.filter(t => t.create && t.identity.entity === 'Products').length,
    listingsCreated: plan.targets.filter(t => t.create && t.identity.entity !== 'Products').length,
    changed: cells.filter(c => c.verdict === 'changed').length, unchanged: cells.filter(c => c.verdict === 'unchanged').length, refused: plan.issues.length }
}

export async function previewCatalogTransfer(input: { rows: TransferRow[]; issues: TransferIssue[]; mode: TransferMode; market: string; filename: string; userId: string | null }): Promise<TransferPreview> {
  if (!input.rows.length && !input.issues.length) throw new Error('The file contains no attribute actions. Populate a template and choose SET, CLEAR or INHERIT.')
  const context = await loadTransferContext(input.rows)
  const plan = await buildTransferPlan(input.rows, input.mode, context, transferContracts(input.market))
  plan.issues.unshift(...input.issues)
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000)
  // Parent declarations before their children; listings after every product declaration.
  plan.targets.sort((a, b) => Number(a.identity.entity !== 'Products') - Number(b.identity.entity !== 'Products') || Number(!!a.parentSku) - Number(!!b.parentSku))
  // Each target already carries its import rows. Do not store another full copy at job level.
  const payload: Payload = { kind: 'catalog-transfer-v1', market: input.market, mode: input.mode, plan, previewExpiresAt: expiresAt.toISOString() }
  const job = await prisma.bulkOperation.create({ data: {
    userId: input.userId, productCount: new Set(input.rows.map(r => r.sku)).size, changeCount: counts(plan).changed,
    status: plan.issues.length ? 'INVALID' : 'QUEUED', changes: json(payload) as unknown as Prisma.InputJsonValue,
    errors: [], expiresAt, uploadFilename: input.filename, total: plan.targets.length, processed: 0,
  }, select: { id: true, status: true } })
  return { jobId: job.id, mode: input.mode, state: job.status, expiresAt: expiresAt.toISOString(), cells: plan.targets.flatMap(t => t.cells), issues: plan.issues, counts: counts(plan), warnings: plan.warnings }
}

export function catalogTransferStatus(loaded: NonNullable<Awaited<ReturnType<typeof readCatalogTransfer>>>) {
  const { job, payload } = loaded
  const errors = Array.isArray(job.errors) ? job.errors as unknown as TransferIssue[] : []
  return { jobId: job.id, state: job.status, processed: job.processed ?? 0, total: job.total ?? 0,
    counts: counts(payload.plan), issues: [...payload.plan.issues, ...errors], filename: job.uploadFilename,
    mode: payload.mode, warnings: payload.plan.warnings,
    ...(['QUEUED', 'INVALID'].includes(job.status) ? { cells: payload.plan.targets.flatMap(t => t.cells) } : {}),
    expiresAt: payload.previewExpiresAt, completedAt: job.completedAt?.toISOString() ?? null }
}

export class TransferConflict extends Error { statusCode = 409 }

const running = new Set<string>()
const LEASE_MS = 60_000

export async function startCatalogTransfer(jobId: string, userId: string | null) {
  const loaded = await readCatalogTransfer(jobId, userId)
  if (!loaded) return null
  if (['RUNNING', 'COMPLETED', 'PARTIAL'].includes(loaded.job.status)) return catalogTransferStatus(loaded)
  if (loaded.job.status !== 'QUEUED') throw new TransferConflict('This preview cannot be applied. Correct the file and preview it again.')
  if (Date.parse(loaded.payload.previewExpiresAt) <= Date.now()) throw new TransferConflict('The preview expired. Upload the file again to check the current catalog.')
  const claimed = await prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'QUEUED', expiresAt: { gt: new Date() } }, data: { status: 'RUNNING', expiresAt: new Date(Date.now() + LEASE_MS) } })
  if (claimed.count) void runCatalogTransfer(jobId).catch(() => { /* durable lease is recovered below */ })
  return { ...catalogTransferStatus(loaded), state: 'RUNNING' }
}

/** Each target and its checkpoint commit together. A restart cannot replay a committed target. */
export async function applyTransferTarget(tx: Prisma.TransactionClient, target: TransferTarget, jobId: string, userId: string | null) {
  if (target.contentWrites?.length && !activeDatabaseTransaction()) throw new Error('Content imports require the shared transactional write boundary')
  if (target.categories) await lockCategoryTree(tx)
  const id = target.identity
  const product = await tx.product.findUnique({ where: { workspace_sku: workspaceKey({ sku: id.sku }) }, include: { translations: true, parent: { include: { translations: true } }, categories: { select: { categoryId: true, isPrimary: true } } } })
  let entityId: string
  if (id.entity === 'Products') {
    if (fingerprint(safeSnapshot(product)) !== fingerprint(target.before)) throw new TransferConflict('Product changed since preview; preview this SKU again')
    const data = { ...target.patch }
    if (target.parentSku !== undefined) {
      const parent = target.parentSku ? await tx.product.findUnique({ where: { workspace_sku: workspaceKey({ sku: target.parentSku }) }, select: { id: true, parentId: true, isParent: true, deletedAt: true, _count: { select: { children: true } } } }) : null
      if (target.parentSku && (!parent || parent.deletedAt || productRoleOf({ ...parent, childCount: parent._count?.children }) !== 'parent')) throw new TransferConflict('The selected parent is no longer available')
      if (parent && product && product.parentId !== parent.id && (parent.id === product.id || product.isParent || await tx.product.count({ where: { parentId: product.id } }))) throw new TransferConflict('This product is now a parent. Reload the family and preview the import again.')
      if (product && product.parentId !== (parent?.id ?? null) && (await relationshipAliasConflicts(tx, [product.id])).has(product.id)) throw new TransferConflict('This SKU has listing aliases. Resolve its listing relationships before changing Parent SKU.')
      data.parentId = parent?.id ?? null
    }
    if (data.impactProtectors === null) data.impactProtectors = Prisma.DbNull
    if (product && !Object.keys(data).length && !target.categories) entityId = product.id
    else if (product) {
      const updated = await tx.product.updateMany({ where: { id: product.id, version: product.version, updatedAt: product.updatedAt, deletedAt: null }, data: { ...data, version: { increment: 1 } } as Prisma.ProductUpdateManyMutationInput })
      if (!updated.count) throw new TransferConflict('Product changed during apply; preview this SKU again')
      entityId = product.id
    } else {
      const created = await tx.product.create({ data: { sku: id.sku, name: String(data.name), basePrice: 0, status: 'DRAFT', ...data } as Prisma.ProductUncheckedCreateInput })
      entityId = created.id
    }
    if (target.categories) {
      const available = await tx.category.count({ where: { id: { in: target.categories.map(c => c.categoryId) }, isActive: true } })
      if (available !== target.categories.length) throw new TransferConflict('An internal category is no longer available')
      await tx.productCategory.deleteMany({ where: { productId: entityId } })
      if (target.categories.length) await tx.productCategory.createMany({ data: target.categories.map(c => ({ ...c, productId: entityId })) })
    }
  } else {
    if (!product || product.deletedAt) throw new TransferConflict('Shared product is unavailable; its import may have failed')
    const account = await tx.channelConnection.findUnique({ where: { id: id.accountId }, select: { channelType: true, marketplace: true, isActive: true } })
    if (!account || account.isActive === false || account.channelType !== id.channel || account.marketplace && !['GLOBAL', id.marketplace].includes(account.marketplace)) throw new TransferConflict('The channel account changed since preview')
    if (id.aliasKey) {
      const alias = await tx.productListingAlias.findFirst({ where: { id: id.aliasKey, productId: product.parentId ?? product.id, channel: id.channel, marketplace: id.marketplace, channelConnectionId: id.accountId, status: 'ACTIVE' }, select: { id: true } })
      if (!alias) throw new TransferConflict('The listing alias changed since preview')
    }
    const matches = await tx.channelListing.findMany({ where: { productId: product.id, channel: id.channel, marketplace: id.marketplace, channelConnectionId: id.accountId, aliasKey: id.aliasKey }, include: { translations: true } })
    // LX.F2 R-LX-21 — `listingConflictSnapshot` on BOTH sides (the reason is on its definition).
    if (matches.length > 1 || fingerprint(listingConflictSnapshot(matches[0] ?? null)) !== fingerprint(listingConflictSnapshot(target.before as Record<string, unknown> | null))) throw new TransferConflict('Listing changed since preview; preview this listing again')
    if (matches[0]) {
      const listing = matches[0]
      const result = Object.keys(target.patch).length ? await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version, updatedAt: listing.updatedAt }, data: { ...target.patch, version: { increment: 1 } } as Prisma.ChannelListingUpdateManyMutationInput }) : { count: 1 }
      if (!result.count) throw new TransferConflict('Listing changed during apply; preview this listing again')
      entityId = listing.id
    } else {
      const listing = await tx.channelListing.create({ data: {
        productId: product.id, channel: id.channel, marketplace: id.marketplace, region: id.marketplace,
        channelMarket: `${id.channel}_${id.marketplace}`, channelConnectionId: id.accountId, aliasKey: id.aliasKey, aliasId: id.aliasKey || null,
        listingStatus: 'DRAFT', isPublished: false, ...target.patch,
      } as Prisma.ChannelListingUncheckedCreateInput })
      entityId = listing.id
    }
  }
  for (const write of target.contentWrites ?? []) await writeContent({ ...write, productId: id.entity === 'Products' ? entityId : product!.id, label: `Import ${id.sku} · ${write.address.tier === 'source' ? 'source' : write.address.language}`, userId, state: 'reviewed' })
  await produceReadiness(id.entity === 'Products' ? entityId : product!.id, id.entity === 'Products' ? undefined : { channel: id.channel, market: id.marketplace, accountId: id.accountId })
  await productReadCacheService.refreshInTransaction(tx, [id.entity === 'Products' ? entityId : product!.id, ...(product?.parentId ? [product.parentId] : [])])
  await tx.auditLog.create({ data: { userId, entityType: id.entity === 'Products' ? 'Product' : 'ChannelListing', entityId, action: target.create ? 'create' : 'update',
    before: json(target.cells.map(c => ({ field: c.field, locale: c.locale, value: c.before, state: c.beforeState }))) as Prisma.InputJsonValue,
    after: json(target.cells.map(c => ({ field: c.field, locale: c.locale, value: c.after, state: c.afterState }))) as Prisma.InputJsonValue,
    metadata: { source: 'catalog-transfer', jobId, channel: id.channel, accountId: id.accountId, marketplace: id.marketplace, aliasKey: id.aliasKey },
  } })
}

async function runCatalogTransfer(jobId: string) {
  if (running.has(jobId)) return
  running.add(jobId)
  try {
    const job = await prisma.bulkOperation.findUnique({ where: { id: jobId } }), payload = payloadOf(job?.changes)
    if (!job || !payload || job.status !== 'RUNNING') return
    // Reload schema contracts after a deployment/schema edit. Target snapshots still guard data.
    clearSheetColumnCache(); clearFieldCatalogueCache()
    const contracts = transferContracts(payload.market)
    for (let index = job.processed ?? 0; index < payload.plan.targets.length; index++) {
      const target = payload.plan.targets[index]
      let issue: TransferIssue | null = null
      try {
        const context = await loadTransferContext(target.rows)
        // Use upsert for validation: this target's creation/update decision was fixed at preview.
        // LX.F2 R-LX-21 — see `buildTransferPlan`'s `revalidateDeclaredVersion`.
        const checked = await buildTransferPlan(target.rows, 'upsert', context, contracts, undefined, { revalidateDeclaredVersion: false })
        const current = checked.targets[0]
        // A newly imported parent can make a formerly missing parent available; the stored patch
        // still names its SKU. All field requirements and write shapes must remain identical.
        if (!current || current.contractHash !== target.contractHash || fingerprint([current.patch, current.contentWrites]) !== fingerprint([target.patch, target.contentWrites])) throw new TransferConflict(checked.issues[0]?.message ?? 'Attribute requirements or reference choices changed since preview; upload the file again')
        await inDatabaseTransaction(prisma, async () => {
          const tx = prisma
          const checkpoint = await tx.bulkOperation.updateMany({ where: { id: jobId, status: 'RUNNING', processed: index }, data: { processed: index + 1, expiresAt: new Date(Date.now() + LEASE_MS) } })
          if (!checkpoint.count) throw new TransferConflict('Job checkpoint already advanced')
          if (target.create || target.cells.some(c => c.verdict === 'changed')) await applyTransferTarget(tx, target, jobId, job.userId)
        })
      } catch (e) {
        issue = { row: target.identity.row, sku: target.identity.sku, field: target.identity.field, message: e instanceof Error ? e.message : String(e) }
      }
      if (issue) {
        // Refusals are checkpointed too. Retry is a new preview of failed rows, never a replay.
        const result = await prisma.$transaction(async tx => {
          const current = await tx.bulkOperation.findUnique({ where: { id: jobId }, select: { errors: true } })
          const errors = [...(Array.isArray(current?.errors) ? current.errors : []), issue]
          return tx.bulkOperation.updateMany({ where: { id: jobId, status: 'RUNNING', processed: index }, data: { processed: index + 1, errors: json(errors) as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + LEASE_MS) } })
        })
        if (!result.count) return
      }
    }
    const current = await prisma.bulkOperation.findUnique({ where: { id: jobId }, select: { errors: true } })
    await prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'RUNNING', processed: payload.plan.targets.length }, data: {
      status: Array.isArray(current?.errors) && current.errors.length ? 'PARTIAL' : 'COMPLETED', completedAt: new Date(), expiresAt: null,
    } })
  } finally { running.delete(jobId) }
}

export async function recoverCatalogTransfers() {
  const jobs = await prisma.bulkOperation.findMany({ where: { status: 'RUNNING', expiresAt: { lt: new Date() }, changes: { path: ['kind'], equals: 'catalog-transfer-v1' } }, select: { id: true }, take: 2 })
  for (const job of jobs) {
    const claimed = await prisma.bulkOperation.updateMany({ where: { id: job.id, status: 'RUNNING', expiresAt: { lt: new Date() } }, data: { expiresAt: new Date(Date.now() + LEASE_MS) } })
    if (claimed.count) void runCatalogTransfer(job.id).catch(() => { /* retry after lease expiry */ })
  }
}
