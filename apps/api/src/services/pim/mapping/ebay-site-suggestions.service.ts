/**
 * "Fill other eBay sites" (Categories workspace, the Owner's D1 = A, 2026-09-27) — the READ half: for one Nexus
 * category that has an eBay category on one site, which category each OTHER active eBay site should probably use.
 *
 * Why it needs a person: eBay leaf ids are per-site trees. 177104 is motorcycle jackets in IT, FR and ES; DE and UK
 * have no 177104 and use 177117, while FR 177117 is motocross jackets. So nothing here is assigned: it proposes up to
 * three candidates per site, says why, and the operator confirms (`ebay-site-assignments.service.ts` saves).
 *
 * Candidates come from three sources, each a reason the UI shows in plain words:
 *   - `same_id`         the source leaf id also exists (as a leaf) in the target site's downloaded tree;
 *   - `same_name`       the cross-site name finder (`findCategoryByNameOnSite`): eBay's best suggestion on the target
 *                       site for the source leaf's localised name;
 *   - `ebay_suggestion` eBay's suggestions on the target site for the Nexus category's name and for the title of the
 *                       category's first product.
 * Every candidate must be an assignable node of the target site's downloaded tree, and its path is that tree's path.
 * Ranking: most reasons first, then `same_name`, then `ebay_suggestion`, then the order found.
 *
 * eBay calls go through `EbayCategoryService.searchCategories` (the channel gateway). When eBay cannot be reached the
 * answer still comes back, with the eBay-based reasons missing and `ebay.available = false` — never a failed request.
 */
import prisma from '../../../db.js'
import { EbayCategoryService } from '../../ebay-category.service.js'
import { findCategoryByNameOnSite } from '../../ebay-category-cross-site.js'
import { taxonomyWhere } from '../../taxonomy/repository.js'
import { TaxonomyError } from '../../taxonomy/model.js'
import { categoryName, listCategoryMappings } from './category-mapping.service.js'

export type SuggestionReason = 'same_id' | 'same_name' | 'ebay_suggestion'
export interface SiteCandidate { categoryId: string; path: string; reasons: SuggestionReason[] }
export interface SiteSuggestion { market: string; treeReady: boolean; candidates: SiteCandidate[]; defaultCategoryId: string | null }
export interface TreeNode { path: string; name: string; assignable: boolean }

const REASON_ORDER: readonly SuggestionReason[] = ['same_id', 'same_name', 'ebay_suggestion']
const PREFERRED_SOURCE = 'IT'
const MAX_CANDIDATES = 3

let sharedEbay: Pick<EbayCategoryService, 'searchCategories'> | null = null
/** One instance, so eBay's 24-hour suggestion cache is shared across requests. */
const defaultEbay = () => (sharedEbay ??= new EbayCategoryService())

/**
 * PURE. Merge what the sources found (one entry per find, in the order found) into at most `limit` candidates:
 * one per category id with every reason that named it, only nodes that are assignable in the target tree, ranked by
 * number of reasons, then `same_name`, then `ebay_suggestion`, then first found.
 */
export function rankCandidates(found: ReadonlyArray<{ categoryId: string; reason: SuggestionReason }>, tree: ReadonlyMap<string, TreeNode>, limit = MAX_CANDIDATES): SiteCandidate[] {
  const merged = new Map<string, { reasons: Set<SuggestionReason>; order: number }>()
  for (const { categoryId, reason } of found) {
    const id = categoryId.trim()
    if (!id) continue
    const entry = merged.get(id) ?? { reasons: new Set<SuggestionReason>(), order: merged.size }
    entry.reasons.add(reason)
    merged.set(id, entry)
  }
  const rank = (reasons: Set<SuggestionReason>) => [reasons.size, Number(reasons.has('same_name')), Number(reasons.has('ebay_suggestion'))]
  return [...merged]
    .filter(([id]) => tree.get(id)?.assignable === true)
    .sort(([, a], [, b]) => {
      const [ra, rb] = [rank(a.reasons), rank(b.reasons)]
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i]
      return a.order - b.order
    })
    .slice(0, limit)
    .map(([id, entry]) => ({ categoryId: id, path: tree.get(id)!.path, reasons: REASON_ORDER.filter(r => entry.reasons.has(r)) }))
}

/**
 * PURE. The site whose assignment the others are filled from: IT when it has one, then the site with the most eBay
 * listings of the category's products, then alphabetical.
 */
export function pickSourceSite(direct: readonly string[], listingCounts: Readonly<Record<string, number>> = {}): string | null {
  if (!direct.length) return null
  if (direct.includes(PREFERRED_SOURCE)) return PREFERRED_SOURCE
  return [...direct].sort((a, b) => (listingCounts[b] ?? 0) - (listingCounts[a] ?? 0) || a.localeCompare(b))[0]
}

export interface DirectAssignment { channelCategoryId: string; path: string | null; mappingId: string; reviewedAt: string | null }
export interface EbaySiteState {
  /** Active eBay sites (`Marketplace.code`), sorted. */
  sites: string[]
  /** categoryId → the sites where it has its OWN exact-site assignment. */
  direct: Map<string, Map<string, DirectAssignment>>
  /** categoryId → the sites where it has no assignment at all: none of its own, no '*' default, none inherited. */
  missing: Map<string, string[]>
}

/**
 * Every active eBay site's assignment state for every category, read the way the workspace reads it
 * (`listCategoryMappings`: an exact-site row beats '*', and `inheritedFrom` is the nearest mapped ancestor).
 */
export async function ebaySiteState(): Promise<EbaySiteState> {
  const markets = await prisma.marketplace.findMany({ where: { channel: 'EBAY', isActive: true }, select: { code: true } })
  const sites = [...new Set(markets.map(m => m.code.trim().toUpperCase()).filter(code => code && code !== '*'))].sort()
  const direct = new Map<string, Map<string, DirectAssignment>>()
  const missing = new Map<string, string[]>()
  for (const site of sites) {
    const { rows } = await listCategoryMappings({ channel: 'EBAY', marketplace: site })
    for (const row of rows) {
      if (row.mapping && row.mapping.marketplace === site) {
        const bySite = direct.get(row.categoryId) ?? new Map<string, DirectAssignment>()
        bySite.set(site, { channelCategoryId: row.mapping.channelCategoryId, path: row.mapping.channelCategoryPath, mappingId: row.mapping.id, reviewedAt: row.mapping.reviewedAt })
        direct.set(row.categoryId, bySite)
      } else if (!row.mapping && !row.inheritedFrom) {
        missing.set(row.categoryId, [...(missing.get(row.categoryId) ?? []), site])
      }
    }
  }
  return { sites, direct, missing }
}

/**
 * GET /pim/category-workspace/EBAY/site-coverage — the rows the workspace offers "Fill other eBay sites" on: a category
 * with its own assignment on at least one active site and none (direct or inherited) on at least one other.
 */
export async function ebaySiteCoverage() {
  const state = await ebaySiteState()
  const fillable: Record<string, { assigned: string[]; missing: string[] }> = {}
  for (const [categoryId, bySite] of state.direct) {
    const missing = state.missing.get(categoryId) ?? []
    if (bySite.size && missing.length) fillable[categoryId] = { assigned: [...bySite.keys()].sort(), missing }
  }
  return { sites: state.sites, fillable }
}

/** The active downloaded tree of one eBay site, or null when it was never downloaded. */
async function siteSnapshot(market: string): Promise<string | null> {
  const source = await prisma.marketplaceTaxonomy.findFirst({ where: taxonomyWhere('EBAY', market), select: { activeSnapshotId: true } })
  return source?.activeSnapshotId ?? null
}

async function treeNodes(snapshotId: string, ids: string[]): Promise<Map<string, TreeNode>> {
  if (!ids.length) return new Map()
  const nodes = await prisma.marketplaceTaxonomyNode.findMany({ where: { snapshotId, externalId: { in: ids } }, select: { externalId: true, name: true, path: true, assignable: true } })
  return new Map(nodes.map(n => [n.externalId, { path: n.path, name: n.name, assignable: n.assignable }]))
}

/** The title of the category's first live product: parent or standalone products first, primary membership first. */
async function firstProductTitle(categoryId: string): Promise<string | null> {
  for (const parentOnly of [true, false]) {
    const row = await prisma.productCategory.findFirst({
      where: { categoryId, product: { deletedAt: null, ...(parentOnly ? { parentId: null } : {}) } },
      orderBy: [{ isPrimary: 'desc' }, { assignedAt: 'asc' }, { productId: 'asc' }],
      select: { product: { select: { name: true, ebayTitle: true } } },
    })
    const title = (row?.product.ebayTitle || row?.product.name || '').trim()
    if (title) return title
  }
  return null
}

async function listingCountsBySite(categoryId: string, sites: string[]): Promise<Record<string, number>> {
  if (sites.length < 2) return {}
  const rows = await prisma.channelListing.groupBy({
    by: ['marketplace'],
    where: { channel: 'EBAY', marketplace: { in: sites }, product: { deletedAt: null, categories: { some: { categoryId } } } },
    _count: { _all: true },
  })
  return Object.fromEntries(rows.map(r => [r.marketplace, r._count._all]))
}

export interface EbaySiteSuggestions {
  categoryId: string
  categoryName: string
  productTitle: string | null
  source: { market: string; channelCategoryId: string; path: string | null } | null
  /** Sites that already have a category for this Nexus category (their own, a '*' default or inherited): left alone. */
  assignedSites: string[]
  sites: SiteSuggestion[]
  ebay: { available: boolean; message: string | null }
}

/** GET /pim/category-workspace/EBAY/site-suggestions?categoryId= — candidates for every active site with no category. */
export async function ebaySiteSuggestions(categoryId: string, deps: { ebay?: Pick<EbayCategoryService, 'searchCategories'> } = {}): Promise<EbaySiteSuggestions> {
  if (typeof categoryId !== 'string' || !categoryId.trim() || categoryId.length > 300) throw new TaxonomyError('Choose a category.')
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true, name: true, slug: true } })
  if (!category) throw new TaxonomyError('Category no longer exists.', 404)
  const name = categoryName(category.name) ?? category.slug
  const ebay = deps.ebay ?? defaultEbay()

  const state = await ebaySiteState()
  const direct = state.direct.get(categoryId) ?? new Map<string, DirectAssignment>()
  const targets = state.missing.get(categoryId) ?? []
  const sourceMarket = pickSourceSite([...direct.keys()], await listingCountsBySite(categoryId, [...direct.keys()]))
  const sourceAssignment = sourceMarket ? direct.get(sourceMarket)! : null

  // The source leaf's own name and path, from its site's tree (the mapping's stored path when the tree lacks it).
  let source: EbaySiteSuggestions['source'] = null
  let sourceLeafName: string | null = null
  if (sourceMarket && sourceAssignment) {
    const snapshot = await siteSnapshot(sourceMarket)
    const node = snapshot ? (await treeNodes(snapshot, [sourceAssignment.channelCategoryId])).get(sourceAssignment.channelCategoryId) : undefined
    const path = node?.path ?? sourceAssignment.path
    source = { market: sourceMarket, channelCategoryId: sourceAssignment.channelCategoryId, path }
    sourceLeafName = node?.name ?? path?.split(' › ').pop()?.trim() ?? null
  }
  const productTitle = targets.length ? await firstProductTitle(categoryId) : null

  let ebayFailed = false
  const ask = async (run: () => Promise<Array<{ categoryId: string; reason: SuggestionReason }>>) => {
    try { return await run() } catch { ebayFailed = true; return [] }
  }
  const sites = await Promise.all(targets.map(async (market): Promise<SiteSuggestion> => {
    const snapshot = await siteSnapshot(market)
    if (!snapshot) return { market, treeReady: false, candidates: [], defaultCategoryId: null }
    const suggestions = (query: string | null) => query && query.trim().length >= 2
      ? ask(async () => (await ebay.searchCategories(market, query, { throwOnError: true, limit: MAX_CANDIDATES })).map(item => ({ categoryId: item.productType, reason: 'ebay_suggestion' as const })))
      : Promise.resolve([])
    const [byName, byCategory, byTitle] = await Promise.all([
      sourceLeafName ? ask(async () => { const match = await findCategoryByNameOnSite(ebay, market, sourceLeafName!, { throwOnError: true }); return match ? [{ categoryId: match.id, reason: 'same_name' as const }] : [] }) : Promise.resolve([]),
      suggestions(name),
      suggestions(productTitle),
    ])
    const found = [
      ...(source ? [{ categoryId: source.channelCategoryId, reason: 'same_id' as const }] : []),
      ...byName, ...byCategory, ...byTitle,
    ]
    const tree = await treeNodes(snapshot, [...new Set(found.map(f => f.categoryId))])
    const candidates = rankCandidates(found, tree)
    return { market, treeReady: true, candidates, defaultCategoryId: candidates[0]?.categoryId ?? null }
  }))

  return {
    categoryId, categoryName: name, productTitle, source,
    assignedSites: state.sites.filter(site => !targets.includes(site)),
    sites,
    ebay: { available: !ebayFailed, message: ebayFailed ? 'eBay could not be reached, so its suggestions are missing. Same-number matches still show, and Search finds any category.' : null },
  }
}
