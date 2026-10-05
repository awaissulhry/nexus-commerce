/**
 * MCP phase 3 T3 — `ebay-categories`: find an eBay category and see what it needs, before `set-listing-fields` sets
 * `categoryId` on a listing. Until now no tool searched eBay categories or showed a category's item specifics: a person
 * chose one on the product's eBay sheet ("Load eBay fields").
 *
 *   query       eBay's suggested categories for some words on one market (`EbayCategoryService.searchCategories`, the
 *               same search the listing wizard's category picker and the eBay flat file use). Each one's leaf flag is
 *               checked against Nexus's copy of eBay's tree when the business has synced it (`MarketplaceTaxonomy`).
 *               When eBay cannot be reached, that copy is searched instead (`searchTaxonomy`, the Categories page's).
 *   categoryId  the category's item specifics and the conditions it allows:
 *                 · loaded — the business's cached definition (`CategorySchema`, the row "Load eBay fields" writes and
 *                   the listing review checks), selected as `loadEbaySpec` selects it. No eBay call.
 *                 · not loaded — read live through `EbayCategoryService.getCategoryAspectsRich` and
 *                   `getItemConditionPolicies` (the calls "Load eBay fields" makes), shaped by the SAME builder
 *                   (`ebayCategoryDefinition`), and NOT stored: the read writes nothing in Nexus. A person still loads
 *                   it for the review (the sheet does it by itself once the category is set on the listing).
 *
 * Every eBay call goes through the service, so through the channel gateway (account state, rate bucket, call ledger),
 * with its 24-hour in-memory caches. One service instance per business: the service holds the eBay token it last
 * resolved (the business's primary eBay account), which must never serve another business's call.
 *
 * Read only and low risk. Lists are bounded: 10 suggestions (20 from Nexus's copy), 60 item specifics, 25 values each
 * (200 when one item specific is asked for).
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { workspaceIdForQuery, workspaceKey } from '../../../lib/workspace-context.js'
import type { EbayCategoryService } from '../../ebay-category.service.js'
import { aspectNames, type EbayCachedAspect, type EbayCachedCondition } from '../../pim/channel-specs/ebay.js'
import { categorySchemaMarkets } from '../../categories/category-schema-coordinate.js'
import { EBAY_ASPECT_VALUE_MAX } from '../../ebay-aspect-values.js'
import { ebayConditionName, toTradingConditionId } from '../../ebay-condition.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { safeText } from './claude-safe.js'

const MAX_SUGGESTIONS = 10
const MAX_TREE_MATCHES = 20
const MAX_SPECIFICS = 60
const VALUES_EACH = 25
const VALUES_ONE = 200
const NOTHING = 'Nothing was read.'

const siteOf = (market: string) => (market === 'UK' ? 'EBAY_GB' : `EBAY_${market}`)
/** The business's code for an eBay market: eBay's site id (EBAY_IT) is read as IT, eBay's GB site as UK. */
const codeOf = (raw: string) => {
  const code = raw.trim().toUpperCase().replace(/^EBAY_/, '')
  return code === 'GB' ? 'UK' : code
}
const reason = (error: unknown) => safeText(error instanceof Error ? error.message : String(error), 200)

// ── the service, one per business ───────────────────────────────────────────────────────────────────

type CategoryReads = Pick<EbayCategoryService, 'searchCategories' | 'getCategoryAspectsRich' | 'getItemConditionPolicies'>
const services = new Map<string, CategoryReads>()

async function ebayCategories(): Promise<CategoryReads> {
  const business = workspaceIdForQuery()
  let service = services.get(business)
  if (!service) {
    const { EbayCategoryService } = await import('../../ebay-category.service.js')
    service = new EbayCategoryService()
    services.set(business, service)
  }
  return service
}

// ── Nexus's copy of eBay's tree (read only) ─────────────────────────────────────────────────────────

interface TreeNode { name: string; path: string; leaf: boolean }

/** The nodes of this market's synced eBay tree for these ids; `synced` false when the business has no copy yet. */
async function treeNodes(market: string, ids: string[]): Promise<{ synced: boolean; nodes: Map<string, TreeNode> }> {
  const { taxonomyWhere } = await import('../../taxonomy/repository.js')
  const source = await prisma.marketplaceTaxonomy.findUnique({
    where: { taxonomy_scope: workspaceKey(taxonomyWhere('EBAY', market)) }, select: { activeSnapshotId: true },
  })
  const nodes = new Map<string, TreeNode>()
  if (!source?.activeSnapshotId) return { synced: false, nodes }
  if (ids.length) {
    const rows = await prisma.marketplaceTaxonomyNode.findMany({
      where: { snapshotId: source.activeSnapshotId, externalId: { in: ids } }, select: { externalId: true, name: true, path: true, assignable: true },
    })
    for (const row of rows) nodes.set(row.externalId, { name: row.name, path: row.path, leaf: row.assignable })
  }
  return { synced: true, nodes }
}

// ── item specifics, in the stored definition's shape ────────────────────────────────────────────────

interface Definition { aspects: EbayCachedAspect[]; conditions: EbayCachedCondition[] | null }

const REQUIREMENT_ORDER = { required: 0, recommended: 1, optional: 2 } as const

/** A stored or live aspect as Claude reads it. `values` capped; `valuesTotal` says how many eBay lists. */
function specificOut(a: EbayCachedAspect, valuesCap: number, valueSearch: string | undefined) {
  const names = aspectNames(a)
  if (!names) return null
  const all = Array.isArray(a.options) ? a.options.map(String) : []
  const wanted = valueSearch ? all.filter((value) => value.toLowerCase().includes(valueSearch.toLowerCase())) : all
  const requiredFrom = !a.required && typeof a.expectedRequiredByDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a.expectedRequiredByDate)
    ? a.expectedRequiredByDate.slice(0, 10) : null
  const requirement: keyof typeof REQUIREMENT_ORDER = a.required ? 'required' : a.recommended || requiredFrom ? 'recommended' : 'optional'
  const type = a.dataType === 'NUMBER' || a.kind === 'number' ? 'number' : a.dataType === 'DATE' || a.kind === 'date' ? 'date' : 'text'
  return {
    name: names.localized,
    ...(names.english !== names.localized ? { englishName: names.english } : {}),
    requirement,
    ...(requiredFrom ? { requiredFrom } : {}),
    type,
    // Older cached rows do not say whether more than one value is allowed: null is "not known", never "no".
    multiValue: a.cardinality ? a.cardinality === 'MULTI' : null,
    variationAxis: a.variantEligible === true,
    // eBay's SELECTION_ONLY: a value off the list is refused by eBay.
    valuesOnly: all.length > 0 && a.enumMode === 'strict',
    maxLength: Math.min(typeof a.maxLength === 'number' && a.maxLength > 0 ? a.maxLength : EBAY_ASPECT_VALUE_MAX, EBAY_ASPECT_VALUE_MAX),
    values: wanted.slice(0, valuesCap),
    ...(wanted.length > valuesCap ? { moreValues: wanted.length - valuesCap } : {}),
    valuesTotal: all.length,
  }
}

/** The category's conditions: the code `set-listing-fields` takes as conditionId, eBay's number and English name. */
const conditionsOut = (conditions: EbayCachedCondition[]) => conditions
  .filter((c) => c && typeof c.value === 'string' && c.value)
  .map((c) => ({ value: c.value, conditionId: toTradingConditionId(c.value) || null, name: ebayConditionName(c.value, c.label), ...(c.label ? { siteName: c.label } : {}) }))

/** The business's loaded definition of the category, chosen as `loadEbaySpec` chooses it (newest active row, any spelling). */
async function loadedDefinition(market: string, categoryId: string) {
  const row = await prisma.categorySchema.findFirst({
    where: { channel: 'EBAY', marketplace: { in: categorySchemaMarkets('EBAY', market) }, productType: categoryId, isActive: true },
    orderBy: [{ fetchedAt: 'desc' }, { id: 'asc' }],
    select: { schemaDefinition: true, fetchedAt: true, expiresAt: true },
  })
  const definition = row?.schemaDefinition as { aspects?: unknown; conditions?: unknown } | null | undefined
  if (!row || !Array.isArray(definition?.aspects)) return null
  return {
    definition: { aspects: definition.aspects as EbayCachedAspect[], conditions: Array.isArray(definition.conditions) ? definition.conditions as EbayCachedCondition[] : [] },
    fetchedAt: row.fetchedAt, stale: row.expiresAt < new Date(),
  }
}

/** Read live through the service ("Load eBay fields"' own calls), shaped by the writer's builder, and NOT stored. */
async function liveDefinition(market: string, categoryId: string): Promise<{ definition: Definition; conditionsError: string | null } | { error: string }> {
  const ebay = await ebayCategories()
  const [aspects, conditions] = await Promise.allSettled([
    ebay.getCategoryAspectsRich(categoryId, market, { throwOnError: true }),
    ebay.getItemConditionPolicies(categoryId, market, { throwOnError: true }),
  ])
  if (aspects.status === 'rejected') return { error: reason(aspects.reason) }
  const { ebayCategoryDefinition } = await import('../../categories/ebay-category-definition.js')
  const built = ebayCategoryDefinition(aspects.value, conditions.status === 'fulfilled' ? conditions.value : [])
  return {
    definition: { aspects: built.aspects as EbayCachedAspect[], conditions: conditions.status === 'fulfilled' ? built.conditions : null },
    conditionsError: conditions.status === 'rejected' ? reason(conditions.reason) : null,
  }
}

// ── ebay-categories ─────────────────────────────────────────────────────────────────────────────────

const input = z.object({
  market: z.string().trim().min(2).max(20)
    .describe("the business's eBay market code, e.g. IT, DE, FR, ES or UK (UK is eBay's site EBAY_GB)"),
  query: z.string().trim().min(2).max(200).optional()
    .describe('words for what is sold, e.g. "giacca moto pelle": the categories eBay suggests for them on this market. Give query or categoryId, not both'),
  categoryId: z.string().trim().regex(/^\d{1,12}$/, 'an eBay category id is a number, e.g. 177104').optional()
    .describe("an eBay category id of this market, e.g. 177104: the category's item specifics and the conditions it allows"),
  specific: z.string().trim().min(1).max(120).optional()
    .describe(`with categoryId: only this item specific (eBay's name or its English name), with up to ${VALUES_ONE} of its allowed values`),
  valueSearch: z.string().trim().min(1).max(60).optional()
    .describe('with specific: only the allowed values that contain this text, e.g. a brand name'),
})
type Args = z.infer<typeof input>

/** The business's active eBay market for the code, or why not. */
async function businessMarket(raw: string): Promise<{ market: string } | { error: string }> {
  const market = codeOf(raw)
  const rows = await prisma.marketplace.findMany({ where: { channel: 'EBAY' }, select: { code: true, isActive: true }, orderBy: { code: 'asc' } })
  const own = rows.map((row) => ({ code: codeOf(row.code), active: row.isActive }))
  const active = [...new Set(own.filter((row) => row.active).map((row) => row.code))]
  if (active.includes(market)) return { market }
  if (own.some((row) => row.code === market)) return { error: `eBay ${market} is switched off in this business. Its eBay markets: ${active.join(', ') || 'none'}. ${NOTHING}` }
  if (!active.length) return { error: `This business has no eBay market. ${NOTHING}` }
  return { error: `There is no eBay market ${market} in this business. Its eBay markets: ${active.join(', ')} (business-overview lists them). ${NOTHING}` }
}

async function search(market: string, query: string): Promise<ToolResult> {
  const where = { market, site: siteOf(market), query }
  let suggestions: Array<{ productType: string; displayName: string; matchPercentage?: number }> = []
  let ebayError: string | null = null
  try {
    suggestions = (await (await ebayCategories()).searchCategories(market, query, { throwOnError: true, limit: MAX_SUGGESTIONS })).slice(0, MAX_SUGGESTIONS)
  } catch (error) {
    ebayError = reason(error)
  }
  if (!ebayError) {
    const tree = await treeNodes(market, suggestions.map((s) => s.productType))
    return {
      ok: true,
      data: {
        ...where,
        source: 'eBay suggestions',
        categories: suggestions.map((s) => {
          const node = tree.nodes.get(s.productType)
          const path = s.displayName
          return {
            id: s.productType,
            name: node?.name ?? path.split(' › ').pop() ?? path,
            path,
            // eBay suggests leaf categories; Nexus's copy of the tree confirms or corrects it when it has the id.
            leaf: node ? node.leaf : true,
            ...(typeof s.matchPercentage === 'number' ? { match: s.matchPercentage } : {}),
          }
        }),
        note: suggestions.length
          ? 'A listing needs a leaf category (leaf true). Next: ebay-categories with a categoryId shows its item specifics and conditions; set-listing-fields values.categoryId sets it on the listing\'s main row.'
          : 'eBay suggests no category for these words on this market. Try other words, in the market\'s language.',
      },
    }
  }
  // eBay could not answer: Nexus's own copy of eBay's tree, searched as the Categories page searches it.
  const { searchTaxonomy } = await import('../../taxonomy/repository.js')
  const found = await searchTaxonomy('EBAY', market, { query, page: 1 }).catch(() => null)
  if (!found?.snapshotId) return { ok: false, error: `eBay could not be reached (${ebayError}), and Nexus has no copy of eBay ${market}'s category tree to search instead. ${NOTHING}` }
  return {
    ok: true,
    data: {
      ...where,
      source: "Nexus's copy of eBay's category tree (eBay could not be reached)",
      ebayError,
      categories: found.items.slice(0, MAX_TREE_MATCHES).map((node) => ({ id: node.externalId, name: node.name, path: node.path, leaf: node.assignable })),
      ...(found.total > MAX_TREE_MATCHES ? { moreMatches: found.total - MAX_TREE_MATCHES } : {}),
      note: 'Matched on the words of each category\'s path, in the market\'s language (not eBay\'s ranking). A listing needs a leaf category (leaf true).',
    },
  }
}

async function details(market: string, categoryId: string, a: Args): Promise<ToolResult> {
  const tree = await treeNodes(market, [categoryId])
  const node = tree.nodes.get(categoryId) ?? null
  const category = { id: categoryId, name: node?.name ?? null, path: node?.path ?? null, leaf: node ? node.leaf : null }
  if (node && !node.leaf) {
    return { ok: false, error: `eBay ${market} category ${categoryId} (${node.path}) is not a leaf category: a listing needs one of the categories below it. Search with query to find one. ${NOTHING}` }
  }
  const loaded = await loadedDefinition(market, categoryId)
  let definition: Definition
  let conditionsError: string | null = null
  if (loaded) {
    definition = loaded.definition
  } else {
    const live = await liveDefinition(market, categoryId)
    if ('error' in live) return { ok: false, error: `eBay ${market} category ${categoryId}: Nexus has not loaded it, and eBay could not be read (${live.error}). ${NOTHING}` }
    definition = live.definition
    conditionsError = live.conditionsError
  }

  const wanted = a.specific?.toLowerCase()
  const aspects = definition.aspects.filter((aspect) => aspect && typeof aspect === 'object' && aspectNames(aspect))
  const chosen = wanted ? aspects.filter((aspect) => { const n = aspectNames(aspect)!; return n.localized.toLowerCase() === wanted || n.english.toLowerCase() === wanted }) : aspects
  if (wanted && !chosen.length) {
    const known = aspects.map((aspect) => aspectNames(aspect)!.localized)
    return { ok: false, error: `Category ${categoryId} has no item specific "${a.specific}". Its item specifics: ${known.slice(0, MAX_SPECIFICS).join(', ')}${known.length > MAX_SPECIFICS ? ' …' : ''}. ${NOTHING}` }
  }
  const out = chosen.map((aspect) => specificOut(aspect, wanted ? VALUES_ONE : VALUES_EACH, wanted ? a.valueSearch : undefined))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s, order) => ({ s, order }))
    .sort((x, y) => REQUIREMENT_ORDER[x.s.requirement] - REQUIREMENT_ORDER[y.s.requirement] || x.order - y.order)
    .map(({ s }) => s)
  const conditions = definition.conditions ? conditionsOut(definition.conditions) : null

  return {
    ok: true,
    data: {
      market,
      site: siteOf(market),
      category,
      ...(!node && tree.synced ? { categoryNote: `Nexus's copy of eBay ${market}'s tree does not hold ${categoryId}: check the id belongs to this market (each eBay site has its own ids).` } : {}),
      loadedInNexus: !!loaded,
      ...(loaded ? { loadedAt: loaded.fetchedAt.toISOString(), ...(loaded.stale ? { stale: true } : {}) } : {}),
      source: loaded ? 'Nexus: the details loaded for this category (what the listing review checks)' : 'eBay, read live: Nexus stored nothing',
      itemSpecificsTotal: aspects.length,
      requiredCount: out.filter((s) => s.requirement === 'required').length,
      itemSpecifics: out.slice(0, MAX_SPECIFICS),
      ...(out.length > MAX_SPECIFICS ? { moreItemSpecifics: out.length - MAX_SPECIFICS } : {}),
      conditions,
      ...(conditions && !conditions.length ? { conditionsNote: 'eBay names no condition for this category.' } : {}),
      ...(conditionsError ? { conditionsNote: `eBay's condition list for this category could not be read (${conditionsError}).` } : {}),
      note: [
        'Set the category with set-listing-fields values.categoryId on the listing\'s main row, and the condition with values.conditionId (a value above).',
        loaded
          ? 'Its item-specific keys show in product-content with the listing\'s coordinate.'
          : 'Nexus has not loaded this category: the listing review cannot check it yet. Once categoryId is set, a person opens the product\'s eBay sheet in the product studio, which loads it by itself or with Load eBay fields; the item-specific keys then show in product-content.',
        'A value off a valuesOnly list is refused by eBay; at most maxLength characters per value.',
      ].join(' '),
    },
  }
}

const ebayCategoriesTool: AgentTool = {
  name: 'ebay-categories',
  title: 'eBay categories and item specifics',
  input,
  requires: [F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  description:
    'Find an eBay category and see what it needs, before setting categoryId with set-listing-fields. With query: the '
    + "categories eBay suggests for those words on one of the business's eBay markets (id, name, path, leaf: a listing "
    + 'needs a leaf category). With categoryId: its item specifics (name and English name, required or recommended, '
    + 'allowed values, whether only listed values are accepted, multi-value, whether it can be a variation axis, max '
    + 'length) and the conditions it allows (the code conditionId takes, eBay\'s number and name). The details are the '
    + 'ones Nexus has loaded for the category (what the listing review checks); for a category Nexus has not loaded they '
    + 'are read live from eBay and nothing is stored: a person then loads it on the product\'s eBay sheet (Load eBay '
    + 'fields). Reads only; it changes no listing.',
  async handler(args): Promise<ToolResult> {
    const a = args as Args
    if (!!a.query === !!a.categoryId) return { ok: false, error: `Give query (words, to find a category) or categoryId (one category's details), not both. ${NOTHING}` }
    if ((a.specific || a.valueSearch) && !a.categoryId) return { ok: false, error: `specific and valueSearch go with categoryId. ${NOTHING}` }
    if (a.valueSearch && !a.specific) return { ok: false, error: `valueSearch goes with specific (the item specific whose values to search). ${NOTHING}` }
    const named = await businessMarket(a.market)
    if ('error' in named) return { ok: false, error: named.error }
    return a.query ? search(named.market, a.query) : details(named.market, a.categoryId!, a)
  },
}

export const EBAY_CATEGORY_TOOLS: AgentTool[] = [ebayCategoriesTool]
