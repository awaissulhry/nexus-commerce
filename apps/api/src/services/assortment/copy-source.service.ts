/**
 * AE.3 — reading what a share offers, from the business that owns it.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §16.3. This is the ONE module that enters another
 * business's context on behalf of a request. It may read only what the database authorises:
 *
 *   1. `nexus_assortment_copy_source(shareId)` runs in the FOLLOWER's context. The database checks the
 *      share is active, the person is an OWNER of the follower, and returns the product IDs the
 *      assortment covers. This module never chooses those IDs.
 *   2. The owner's data is then read in the OWNER's context (no person: a system read) for exactly
 *      those IDs — the products, the families and attributes they use, their category paths and
 *      their images.
 *   3. Rows are kept only for the field groups the owner offered (field-groups.ts). Everything else
 *      is reported with its reason, never silently dropped.
 *
 * A follower gets NO read policy on the owner's product tables: row security is the filter many
 * queries rely on, so such a policy would leak the owner's products into the follower's own lists.
 */
import type { TransferRow } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { WorkspaceError, requireWorkspace, withWorkspace } from '../../lib/workspace-context.js'
import { catalogRows, productInclude } from '../pim/catalog-transfer-export.js'
import { transferContracts, type TransferProduct } from '../pim/catalog-transfer-plan.js'
import { PRIMARY_CONTENT_LOCALE } from '../pim/content-locale.js'
import { contentLanguages } from '../pim/content-read.js'
import { classifyRow, type ColumnStorage } from './field-groups.js'
import type { FieldGroup } from './share-rules.js'

export interface AuthorisedSource {
  shareId: string
  shareVersion: number
  ownerWorkspaceId: string
  fieldGroups: FieldGroup[]
  followSettings: boolean
  products: Array<{ id: string; sku: string; parentId: string | null; version: number }>
}

export interface FamilyDefinition {
  code: string
  label: string
  description: string | null
  parentCode: string | null
  attributes: Array<{ code: string; required: boolean; channels: string[]; sortOrder: number }>
}
export interface AttributeDefinition {
  code: string
  label: string
  description: string | null
  type: string
  validation: unknown
  defaultValue: unknown
  localizable: boolean
  scope: string
  sortOrder: number
  groupCode: string
  options: Array<{ code: string; label: string; metadata: unknown; sortOrder: number }>
}
export interface AttributeGroupDefinition { code: string; label: string; description: string | null; sortOrder: number }
/** One category, addressed by its slug path from the root (ids differ per business). */
export interface CategoryDefinition { path: string[]; code: string | null; name: unknown; description: unknown; attributes: unknown; sortOrder: number; isActive: boolean }

export interface SourceImage {
  id: string
  productId: string
  url: string
  publicId: string | null
  /** The owner's own library asset (a Shopify file): never carried over, but it marks a stored file. */
  sourceAssetId: string | null
  alt: string | null
  type: string
  /** 'IMAGE' | 'VIDEO' | 'MODEL3D' | 'DOC'. Only images are copied (AE.3c). */
  mediaType: string
  isPrimary: boolean
  sortOrder: number
  width: number | null
  height: number | null
  mimeType: string | null
  fileSize: number | null
  contentHash: string | null
}

/**
 * Fields the transfer engine leaves to their owning services (its MANAGED_FIELDS): set after apply,
 * and only those whose group was offered. An absent key means "not offered".
 */
export interface ManagedFields {
  productType?: string | null
  basePrice?: string
  minPrice?: string | null
  maxPrice?: string | null
  b2bPrice?: string | null
  b2bMinQty?: number | null
  status?: string
}

export interface OfferedCatalog {
  source: AuthorisedSource
  market: string
  /** Transfer rows for the offered groups only, without source versions. */
  rows: TransferRow[]
  /**
   * Per field: why it is not copied. `group` is the field group that was not offered; `reason` is why a
   * field is never shared. Exactly one is set. `label` is the field's name as people read it.
   */
  excluded: Array<{ field: string; label: string; group: string | null; reason: string | null; rows: number }>
  products: Array<{ id: string; sku: string; parentSku: string | null; version: number; familyCode: string | null; categoryPaths: string[][]; primaryCategoryPath: string[] | null; managed: ManagedFields }>
  families: FamilyDefinition[]
  attributeGroups: AttributeGroupDefinition[]
  attributes: AttributeDefinition[]
  categories: CategoryDefinition[]
  images: SourceImage[]
}

const MARKET = /^(?:[A-Z]{2}|GLOBAL)$/
/** The transfer engine's metadata fields have no master-sheet column, so no column label. */
const METADATA_LABELS: Record<string, string> = { family: 'Family', parentSku: 'Parent SKU', categoryIds: 'Categories', primaryCategoryId: 'Primary category' }

/** Step 1: the database decides what this follower may read. */
export async function authorisedSource(shareId: string): Promise<AuthorisedSource> {
  requireWorkspace()
  const [{ result }] = await prisma.$queryRaw<Array<{ result: Record<string, unknown> }>>`SELECT nexus_assortment_copy_source(${shareId}) AS result`
  if (typeof result.error === 'string') {
    throw new WorkspaceError(String(result.code ?? 'source_refused'), result.error, Number(result.status ?? 403))
  }
  return result as unknown as AuthorisedSource
}

/** Steps 2 and 3. Call in the FOLLOWER's context. */
export async function readOfferedCatalog(input: { shareId: string; market: string }): Promise<OfferedCatalog> {
  const market = String(input.market ?? '').trim().toUpperCase()
  if (!MARKET.test(market)) throw new WorkspaceError('invalid_market', 'Choose the marketplace whose attribute dictionary the copy uses.', 400)
  const source = await authorisedSource(input.shareId)
  return readFromOwner(source, source.products.map((product) => product.id), market)
}

/**
 * AE.4 — what the follower's sync worker may read for one link (shared stock plan step 6, contract
 * docs/2026-09-19-shared-stock-build.md §6.1). The database answers only for an active link of an active
 * share between two active businesses, in the follower's context, and names the product ids: the source
 * product and, for a parent, its variations the assortment still covers. No person is needed — the
 * follower's owner consented when the share was accepted and the link was made.
 */
export interface LinkSource {
  linkId: string
  shareId: string
  ownerWorkspaceId: string
  fieldGroups: FieldGroup[]
  /** null: the source product no longer exists. `deleted`: deleted, or no longer in the assortment. */
  source: { id: string; sku: string; version: number; parentId: string | null; deleted: boolean } | null
  variations: Array<{ id: string; sku: string; version: number }>
}

export async function linkSource(linkId: string): Promise<LinkSource> {
  requireWorkspace()
  const [{ result }] = await prisma.$queryRaw<Array<{ result: Record<string, unknown> }>>`SELECT nexus_assortment_sync_source(${linkId}) AS result`
  if (typeof result.error === 'string') throw new WorkspaceError(String(result.code ?? 'source_refused'), result.error, 409)
  return result as unknown as LinkSource
}

/** Read `productIds` (all named by `link`) from the owner, filtered to the link's offered groups. Call in the FOLLOWER's context. */
export async function readLinkedCatalog(input: { link: LinkSource; productIds: string[]; market: string }): Promise<OfferedCatalog> {
  const market = String(input.market ?? '').trim().toUpperCase()
  if (!MARKET.test(market)) throw new WorkspaceError('invalid_market', 'The link has no reference marketplace.', 400)
  const named = new Map<string, { id: string; sku: string; parentId: string | null; version: number }>()
  const { source } = input.link
  if (source && !source.deleted) named.set(source.id, { id: source.id, sku: source.sku, parentId: source.parentId, version: source.version })
  for (const variation of input.link.variations) named.set(variation.id, { ...variation, parentId: source?.id ?? null })
  const products = input.productIds.map((id) => {
    const product = named.get(id)
    if (!product) throw new WorkspaceError('source_not_named', 'The database did not name this product for the link.', 409)
    return product
  })
  const authorised: AuthorisedSource = {
    shareId: input.link.shareId, shareVersion: 0, ownerWorkspaceId: input.link.ownerWorkspaceId,
    fieldGroups: input.link.fieldGroups, followSettings: false, products,
  }
  return readFromOwner(authorised, products.map((product) => product.id), market)
}

async function readFromOwner(source: AuthorisedSource, ids: string[], market: string): Promise<OfferedCatalog> {
  const follower = requireWorkspace()
  const offered = new Set<string>(source.fieldGroups)

  const read = await withWorkspace(
    { workspaceId: source.ownerWorkspaceId, actorUserId: null, membershipId: null, roleKeys: [] },
    () => readInOwner(source, ids, market, offered.has('translations')),
  ).catch((error: unknown) => {
    // Marketplaces belong to each business: the owner may not have the one this business chose. Say so,
    // with the owner's own list, instead of a server error. (By name: the class is mocked in tests.)
    if ((error as { name?: string })?.name === 'UnknownMarketError') {
      const known = (error as { known?: string[] }).known ?? []
      throw new WorkspaceError('unknown_market', `The business that shares these products has no marketplace ${market}.${known.length ? ` It has ${known.join(', ')}.` : ''} Choose another reference marketplace.`, 400)
    }
    throw error
  })
  // Back in the follower's context: nothing below may touch the owner's tables.
  if (requireWorkspace().workspaceId !== follower.workspaceId) throw new WorkspaceError('context_leak', 'The business context did not return to the follower.', 500)

  const excludedCounts = new Map<string, OfferedCatalog['excluded'][number]>()
  const rows: TransferRow[] = []
  for (const row of read.rows) {
    const disposition = classifyRow(row, read.storage.get(row.field), PRIMARY_CONTENT_LOCALE)
    // An empty list (no bullet points, no keywords) has nothing to copy, and the field contract refuses
    // an empty list outright: sending it would refuse the whole product. Nothing is set or cleared.
    const emptyList = row.action === 'SET' && Array.isArray(row.value) && row.value.every((item) => item === null || String(item).trim() === '')
    const reason = 'never' in disposition ? disposition.never : emptyList ? 'empty in the shared product, so nothing is copied' : null
    const group = 'never' in disposition || emptyList || offered.has(disposition.group) ? null : disposition.group
    if (reason || group) {
      const key = `${row.field}\u0000${reason ?? group}`
      const entry = excludedCounts.get(key) ?? { field: row.field, label: read.labels.get(row.field) ?? METADATA_LABELS[row.field] ?? row.field, group, reason, rows: 0 }
      entry.rows++
      excludedCounts.set(key, entry)
      continue
    }
    // The source version names the OWNER's record; in the follower it would read as a stale export.
    const { version: _sourceVersion, ...rest } = row
    rows.push(rest)
  }

  return {
    source,
    market,
    rows,
    excluded: [...excludedCounts.values()].sort((a, b) => a.field.localeCompare(b.field)),
    products: read.products.map(({ raw, ...product }) => ({
      ...product,
      managed: {
        ...(offered.has('attributes') ? { productType: raw.productType } : {}),
        ...(offered.has('price') ? {
          basePrice: raw.basePrice.toString(), minPrice: raw.minPrice?.toString() ?? null, maxPrice: raw.maxPrice?.toString() ?? null,
          b2bPrice: raw.b2bPrice?.toString() ?? null, b2bMinQty: raw.b2bMinQty,
        } : {}),
        ...(offered.has('status') ? { status: raw.status } : {}),
      },
    })),
    families: offered.has('structure') || offered.has('attributes') ? read.families : [],
    attributeGroups: offered.has('attributes') ? read.attributeGroups : [],
    attributes: offered.has('attributes') ? read.attributes : [],
    categories: offered.has('attributes') ? read.categories : [],
    images: offered.has('media') ? read.images : [],
  }
}

async function readInOwner(source: AuthorisedSource, ids: string[], market: string, includeTranslations: boolean) {
  const products = ids.length === 0 ? [] : await prisma.product.findMany({
    where: { id: { in: ids }, workspaceId: source.ownerWorkspaceId, deletedAt: null },
    include: productInclude,
    orderBy: { sku: 'asc' },
  })
  if (products.length !== ids.length) {
    throw new WorkspaceError('source_changed', 'The shared products changed while they were being read. Try again.', 409)
  }
  const families = await prisma.productFamily.findMany({
    where: { workspaceId: source.ownerWorkspaceId },
    select: { id: true, code: true, label: true, description: true, parentFamilyId: true },
  })
  const familyById = new Map(families.map((family) => [family.id, family]))
  const contracts = transferContracts(market, { allowIncompleteSchema: true })
  const rows: TransferRow[] = []
  const storage = new Map<string, ColumnStorage>()
  const labels = new Map<string, string>()
  for (const product of products) {
    const locales = includeTranslations ? contentLanguages(product, product.parent) : [PRIMARY_CONTENT_LOCALE]
    const boundary = {
      productId: product.id, rootId: product.parentId ?? product.id,
      products: [{ id: product.id, sku: product.sku, parentId: product.parentId }],
      includeShared: true, listings: [], locales,
    }
    rows.push(...await catalogRows([product], { market, boundary }, contracts, families))
    const familyId = product.familyId ?? product.parent?.familyId ?? null
    for (const column of await contracts.master(familyId, product as unknown as TransferProduct)) {
      if (!storage.has(column.key)) storage.set(column.key, column.storage as ColumnStorage)
      if (!labels.has(column.key) && typeof column.label === 'string') labels.set(column.key, column.label)
    }
  }

  // Families in use, with their ancestors, and the attributes they declare.
  const usedFamilyIds = new Set<string>()
  for (const product of products) {
    let id = product.familyId ?? product.parent?.familyId ?? null
    while (id && !usedFamilyIds.has(id)) {
      usedFamilyIds.add(id)
      id = familyById.get(id)?.parentFamilyId ?? null
    }
  }
  const familyAttributes = usedFamilyIds.size === 0 ? [] : await prisma.familyAttribute.findMany({
    where: { familyId: { in: [...usedFamilyIds] } },
    select: { familyId: true, required: true, channels: true, sortOrder: true, attribute: { include: { group: true, options: { orderBy: { sortOrder: 'asc' } } } } },
    orderBy: { sortOrder: 'asc' },
  })
  const attributeByCode = new Map<string, AttributeDefinition>()
  const groupByCode = new Map<string, AttributeGroupDefinition>()
  for (const link of familyAttributes) {
    const a = link.attribute
    groupByCode.set(a.group.code, { code: a.group.code, label: a.group.label, description: a.group.description, sortOrder: a.group.sortOrder })
    attributeByCode.set(a.code, {
      code: a.code, label: a.label, description: a.description, type: a.type, validation: a.validation, defaultValue: a.defaultValue,
      localizable: a.localizable, scope: a.scope, sortOrder: a.sortOrder, groupCode: a.group.code,
      options: a.options.map((o) => ({ code: o.code, label: o.label, metadata: o.metadata, sortOrder: o.sortOrder })),
    })
  }
  const familyDefinitions: FamilyDefinition[] = [...usedFamilyIds].map((id) => {
    const family = familyById.get(id)!
    return {
      code: family.code, label: family.label, description: family.description,
      parentCode: family.parentFamilyId ? familyById.get(family.parentFamilyId)?.code ?? null : null,
      attributes: familyAttributes.filter((l) => l.familyId === id).map((l) => ({ code: l.attribute.code, required: l.required, channels: l.channels, sortOrder: l.sortOrder })),
    }
  })

  // Categories in use, addressed by slug path, ancestors first.
  const categoryIds = new Set(products.flatMap((product) => product.categories.map((c) => c.categoryId)))
  const categories = new Map<string, { id: string; parentId: string | null; slug: string; code: string | null; name: unknown; description: unknown; attributes: unknown; sortOrder: number; isActive: boolean }>()
  let frontier = [...categoryIds]
  while (frontier.length) {
    const found = await prisma.category.findMany({
      where: { id: { in: frontier.filter((id) => !categories.has(id)) }, workspaceId: source.ownerWorkspaceId },
      select: { id: true, parentId: true, slug: true, code: true, name: true, description: true, attributes: true, sortOrder: true, isActive: true },
    })
    for (const category of found) categories.set(category.id, category)
    frontier = found.map((category) => category.parentId).filter((id): id is string => !!id && !categories.has(id))
  }
  const pathOf = (id: string): string[] => {
    const path: string[] = []
    for (let at = categories.get(id); at; at = at.parentId ? categories.get(at.parentId) : undefined) path.unshift(at.slug)
    return path
  }
  const categoryDefinitions: CategoryDefinition[] = [...categories.values()]
    .map((c) => ({ path: pathOf(c.id), code: c.code, name: c.name, description: c.description, attributes: c.attributes, sortOrder: c.sortOrder, isActive: c.isActive }))
    .sort((a, b) => a.path.length - b.path.length || a.path.join('/').localeCompare(b.path.join('/')))

  const images = ids.length === 0 ? [] : await prisma.productImage.findMany({
    where: { productId: { in: ids } },
    select: { id: true, productId: true, url: true, publicId: true, sourceAssetId: true, alt: true, type: true, mediaType: true, isPrimary: true, sortOrder: true, width: true, height: true, mimeType: true, fileSize: true, contentHash: true },
    orderBy: [{ productId: 'asc' }, { sortOrder: 'asc' }],
  })

  const skuById = new Map(products.map((product) => [product.id, product.sku]))
  return {
    rows,
    storage,
    labels,
    products: products.map((product) => ({
      id: product.id, sku: product.sku, parentSku: product.parentId ? skuById.get(product.parentId) ?? product.parent?.sku ?? null : null,
      version: product.version, familyCode: familyById.get(product.familyId ?? '')?.code ?? null,
      categoryPaths: product.categories.map((c) => pathOf(c.categoryId)),
      primaryCategoryPath: (() => { const primary = product.categories.find((c) => c.isPrimary); return primary ? pathOf(primary.categoryId) : null })(),
      raw: { productType: product.productType, basePrice: product.basePrice, minPrice: product.minPrice, maxPrice: product.maxPrice, b2bPrice: product.b2bPrice, b2bMinQty: product.b2bMinQty, status: product.status },
    })),
    families: familyDefinitions,
    attributeGroups: [...groupByCode.values()],
    attributes: [...attributeByCode.values()],
    categories: categoryDefinitions,
    images,
  }
}
