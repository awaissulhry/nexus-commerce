/**
 * AE.3 — Review 1: what a copy would bring into the follower business. Read-only for both businesses.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §16.2. The confirm step re-computes this review and
 * refuses to continue if its fingerprint changed, so nothing is created that the owner did not see.
 */
import { createHash } from 'node:crypto'
import { transferCanonical } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { requireWorkspace } from '../../lib/workspace-context.js'
import { imageOrigin } from './copy-media.service.js'
import { readOfferedCatalog, type OfferedCatalog } from './copy-source.service.js'

export type ProductOutcome =
  | { kind: 'new'; sku: string; sourceProductId: string; parentSku: string | null }
  | { kind: 'match'; sku: string; sourceProductId: string; parentSku: string | null; followerProductId: string; followerName: string }
  | { kind: 'linked'; sku: string; sourceProductId: string; parentSku: string | null; followerProductId: string }
  | { kind: 'blocked'; sku: string; sourceProductId: string; parentSku: string | null; reason: string }

export interface CopyPreview {
  shareId: string
  shareVersion: number
  market: string
  fieldGroups: string[]
  /** images: every image that arrives (a stored file is copied, an outside address is carried). mediaNotCopied:
   *  videos, 3D models and documents, which this phase does not copy. */
  counts: { new: number; match: number; linked: number; blocked: number; images: number; mediaNotCopied: number }
  /** Top-level first, then variations; each variation follows its parent's link-or-skip choice. */
  products: ProductOutcome[]
  create: {
    families: Array<{ code: string; label: string }>
    attributeGroups: Array<{ code: string; label: string }>
    attributes: Array<{ code: string; label: string; type: string }>
    options: Array<{ attributeCode: string; code: string; label: string }>
    familyAttributes: Array<{ familyCode: string; attributeCode: string }>
    /** `path` is the slug path the copy matches on; `names` is the same path as people read it. */
    categories: Array<{ path: string[]; names: string[] }>
  }
  /** Definitions that exist in the follower but differ in a way that stops values landing. */
  conflicts: Array<{ kind: 'attribute_type'; code: string; label: string; source: string; follower: string }>
  excluded: OfferedCatalog['excluded']
  /** Bytes of the image files to copy; null when a file's size is unknown. */
  imageBytes: number | null
  fingerprint: string
}

export async function previewCopy(input: { shareId: string; market: string }): Promise<{ preview: CopyPreview; catalog: OfferedCatalog }> {
  const catalog = await readOfferedCatalog(input)
  const { workspaceId } = requireWorkspace()
  const skus = catalog.products.map((p) => p.sku)

  const followerProducts = skus.length === 0 ? [] : await prisma.product.findMany({
    where: { workspaceId, sku: { in: skus } },
    select: { id: true, sku: true, name: true, deletedAt: true },
  })
  const links = await prisma.catalogLink.findMany({
    where: { targetWorkspaceId: workspaceId, status: 'active' },
    select: { shareId: true, sourceProductId: true, targetProductId: true },
  })
  const followerBySku = new Map(followerProducts.map((p) => [p.sku, p]))
  const linkBySource = new Map(links.filter((l) => l.shareId === catalog.source.shareId).map((l) => [l.sourceProductId, l]))
  const linkByTarget = new Map(links.map((l) => [l.targetProductId, l]))

  // Parents first, then SKU: a variation's link-or-skip follows its parent, so the parent must be decided first.
  const ordered = [...catalog.products].sort((x, y) => Number(x.parentSku !== null) - Number(y.parentSku !== null) || x.sku.localeCompare(y.sku))
  const products: ProductOutcome[] = ordered.map((p) => {
    const base = { sku: p.sku, sourceProductId: p.id, parentSku: p.parentSku }
    const linked = linkBySource.get(p.id)
    if (linked) return { kind: 'linked', ...base, followerProductId: linked.targetProductId }
    const existing = followerBySku.get(p.sku)
    if (!existing) return { kind: 'new', ...base }
    if (existing.deletedAt) return { kind: 'blocked', ...base, reason: 'A deleted product in this business still holds this SKU. Restore or purge it first.' }
    if (linkByTarget.has(existing.id)) return { kind: 'blocked', ...base, reason: 'The product with this SKU already follows another shared product.' }
    return { kind: 'match', ...base, followerProductId: existing.id, followerName: existing.name }
  })

  const create = await missingDefinitions(catalog, workspaceId)
  const images = catalog.images.filter((i) => i.mediaType === 'IMAGE')
  const files = images.filter((i) => imageOrigin(i.url) === 'file')
  const imageBytes = files.every((i) => i.fileSize !== null) ? files.reduce((n, i) => n + (i.fileSize ?? 0), 0) : null
  const counts = {
    new: products.filter((p) => p.kind === 'new').length,
    match: products.filter((p) => p.kind === 'match').length,
    linked: products.filter((p) => p.kind === 'linked').length,
    blocked: products.filter((p) => p.kind === 'blocked').length,
    images: images.length,
    mediaNotCopied: catalog.images.length - images.length,
  }
  const body = {
    shareId: catalog.source.shareId, shareVersion: catalog.source.shareVersion, market: catalog.market, fieldGroups: catalog.source.fieldGroups,
    counts, products, create: create.create, conflicts: create.conflicts, excluded: catalog.excluded, imageBytes,
  }
  // What the review DEPENDED ON: the source records and their versions, the rows, and the follower state.
  const fingerprint = createHash('sha256').update(transferCanonical({
    body, sourceVersions: catalog.products.map((p) => [p.id, p.version]), rows: catalog.rows,
  })).digest('hex')
  return { preview: { ...body, fingerprint }, catalog }
}

/** A category's display name: a plain string, or the English (else first) value of a localized one. */
function categoryName(categories: OfferedCatalog['categories'], path: string[]): string | null {
  const name = categories.find((c) => c.path.join('/') === path.join('/'))?.name
  if (typeof name === 'string' && name.trim()) return name
  if (name && typeof name === 'object') {
    const values = name as Record<string, unknown>
    const chosen = typeof values.en === 'string' && values.en.trim() ? values.en : Object.values(values).find((v) => typeof v === 'string' && v.trim())
    if (typeof chosen === 'string') return chosen
  }
  return null
}

async function missingDefinitions(catalog: OfferedCatalog, workspaceId: string) {
  const familyCodes = catalog.families.map((f) => f.code)
  const attributeCodes = catalog.attributes.map((a) => a.code)
  const groupCodes = catalog.attributeGroups.map((g) => g.code)
  const families = familyCodes.length ? await prisma.productFamily.findMany({ where: { workspaceId, code: { in: familyCodes } }, select: { id: true, code: true, familyAttributes: { select: { attribute: { select: { code: true } } } } } }) : []
  const groups = groupCodes.length ? await prisma.attributeGroup.findMany({ where: { workspaceId, code: { in: groupCodes } }, select: { code: true } }) : []
  const attributes = attributeCodes.length ? await prisma.customAttribute.findMany({ where: { workspaceId, code: { in: attributeCodes } }, select: { code: true, type: true, options: { select: { code: true } } } }) : []
  const followerCategories = catalog.categories.length ? await prisma.category.findMany({ where: { workspaceId }, select: { id: true, parentId: true, slug: true } }) : []
  const familyByCode = new Map(families.map((f) => [f.code, f]))
  const groupSet = new Set(groups.map((g) => g.code))
  const attributeByCode = new Map(attributes.map((a) => [a.code, a]))

  const create: CopyPreview['create'] = { families: [], attributeGroups: [], attributes: [], options: [], familyAttributes: [], categories: [] }
  const conflicts: CopyPreview['conflicts'] = []
  for (const group of catalog.attributeGroups) if (!groupSet.has(group.code)) create.attributeGroups.push({ code: group.code, label: group.label })
  for (const attribute of catalog.attributes) {
    const existing = attributeByCode.get(attribute.code)
    if (!existing) {
      create.attributes.push({ code: attribute.code, label: attribute.label, type: attribute.type })
      for (const option of attribute.options) create.options.push({ attributeCode: attribute.code, code: option.code, label: option.label })
      continue
    }
    if (existing.type !== attribute.type) {
      conflicts.push({ kind: 'attribute_type', code: attribute.code, label: attribute.label, source: attribute.type, follower: existing.type })
      continue
    }
    const has = new Set(existing.options.map((o) => o.code))
    for (const option of attribute.options) if (!has.has(option.code)) create.options.push({ attributeCode: attribute.code, code: option.code, label: option.label })
  }
  // After the attribute pass: a link to an attribute whose type conflicts is not created either.
  const conflicting = new Set(conflicts.map((c) => c.code))
  for (const family of catalog.families) {
    const existing = familyByCode.get(family.code)
    if (!existing) create.families.push({ code: family.code, label: family.label })
    const has = new Set(existing?.familyAttributes.map((fa) => fa.attribute.code) ?? [])
    for (const link of family.attributes) if (!has.has(link.code) && !conflicting.has(link.code)) create.familyAttributes.push({ familyCode: family.code, attributeCode: link.code })
  }
  // Categories: walk the follower tree by slug from the root. Every missing tail is created.
  const children = new Map<string, Array<{ id: string; slug: string }>>()
  for (const c of followerCategories) {
    const key = c.parentId ?? ''
    if (!children.has(key)) children.set(key, [])
    children.get(key)!.push({ id: c.id, slug: c.slug })
  }
  for (const category of catalog.categories) {
    let parent = ''
    let missing = false
    for (const slug of category.path) {
      const next = children.get(parent)?.find((c) => c.slug === slug)
      if (!next) { missing = true; break }
      parent = next.id
    }
    if (missing) create.categories.push({ path: category.path, names: category.path.map((slug, depth) => categoryName(catalog.categories, category.path.slice(0, depth + 1)) ?? slug) })
  }
  return { create, conflicts }
}
