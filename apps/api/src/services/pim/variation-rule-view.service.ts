import { hasVariationMappingOverride } from '@nexus/shared/variation-mapping'
import { loadStoredVariationProjection } from './stored-variation-projection.js'
import { categoryForListing, resolveCategoriesForProducts } from './mapping/category-mapping.service.js'
import { resolveVariationProjection } from './variation-rules.service.js'
import { variationCollisionGroups } from './variation-collisions.js'
/**
 * VT.1b — the read model and the blast-radius simulation behind
 * `GET|PUT /pim/channel-mapping/:channel/:code/variations[/:categoryId]` (VX §11.1, design §3.7).
 *
 * Every number here is computed from the database and the resolver, and handed to the page whole: VT.3's group
 * computes NONE of them, because a number the page adds up is a number the wire and the screen can disagree about.
 *
 * The shape is the mirror of `apps/web/src/app/channels/mapping/_shared/contracts.ts` (`VariationRuleView`,
 * `VariationRuleWrite`, `VariationRuleSimulation`) — the file VT.3 codes against.
 */

import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { limitsFor, vocabularyFor } from './family-projection-limits.js'
import {
  getMappingForMarketplaceWithWarnings,
  getVariationRule,
  setVariationRuleInMapping,
  type MarketplaceSchemaMapping,
} from './schema-mapping.service.js'
import { mappingToken } from './mapping/revision-token.js'
import { validateStoredVariationRule, type StoredVariationRule } from './variation-rule-store.js'
import { loadAmazonThemeFacts } from './variation-theme-facts.js'
import {
  addsForTheme,
  classifyThemes,
  deriveAmazonTheme,
  dropsForTheme,
  themeSegments,
  attributeTitle,
  bindSegmentToAttribute,
  type ThemeSchemaFacts,
} from './variation-theme-segments.js'
import { channelDisplayName, foldAvailability, VT_COPY } from './variation-rules.service.js'

export interface VariationRuleViewInput {
  channel: string
  market: string
  /** null = the channel-wide rule. */
  categoryId: string | null
}

export interface VariationRuleView {
  channel: string
  market: string
  categoryId: string | null
  categoryLabel: string
  source: 'rule' | 'derived' | 'none'
  ruleLabel: string | null
  derivation: { axisSummary: string; themeCode: string | null; themeLabel: string | null; families: number; familiesTotal: number } | null
  counts: { follow: number; override: number; collide: number; wouldCollide: number; total: number }
  theme: { code: string | null; label: string | null; options: Array<{ code: string; label: string; coversAll: boolean; drops: string[]; deprecated: boolean }> } | null
  axes: Array<{ axisKey: string; label: string; channelName: string; target: string | null; included: boolean }>
  dropped: string[]
  collisions: {
    resolver: 'split' | 'fold' | 'exclude'
    foldInto: string | null
    foldSeparator: string
    resolvers: Array<{ kind: 'split' | 'fold' | 'exclude'; available: boolean; reason: string | null }>
  }
  split: { mode: 'one' | 'per-axis'; axisKey: string | null; available: boolean; reason: string | null }
  valueMaps: Array<{ axisKey: string; label: string; mapped: number; unreviewed: number }>
  axisNamesSentence: string
  previewSkus: Array<{ productId: string; sku: string; name: string | null; productType: string | null; listedHere: boolean; label: string }>
  writeBlockedReason: string | null
  expectedToken: string
  /** R-VT-2 (a) — stored keys the read did not recognise, named. Empty = everything was recognised. */
  mappingWarnings: string[]
  vocabulary: { sectionTitle: string }
}

/** VX §7 — who names an axis on each channel. One sentence, server-stated. */
const AXIS_NAMES_SENTENCE: Record<string, string> = {
  AMAZON: 'Amazon prints its own localised axis names from the theme — Nexus sends the values verbatim.',
  EBAY: 'eBay uses the site’s own aspect name per market (Colore, Farbe, Couleur); values are sent verbatim.',
  SHOPIFY: 'Shopify option names are yours to choose and are translatable per locale; values are sent verbatim.',
  ETSY: 'Etsy names come from its property list; values are sent verbatim.',
}

/**
 * The families a category's rule reaches: every PARENT product of that channel category, with the axes it declares and
 * whether its coordinate listing carries its own theme (an override, which a rule does not reach).
 */
async function familiesFor(channel: string, market: string, categoryId: string | null) {
  const parents = await prisma.product.findMany({
    where: {
      parentId: null,
      deletedAt: null,
      channelListings: { some: { channel, marketplace: market } },
      children: { some: { deletedAt: null } },
    },
    select: {
      id: true, sku: true, name: true, productType: true, variationAxes: true, variationTheme: true,
      channelListings: {
        where: { channel, marketplace: market },
        select: { id: true, version: true, variationTheme: true, variationMapping: true, platformAttributes: true, aliasId: true, aliasKey: true, externalListingId: true, listingStatus: true, channelConnectionId: true },
      },
      _count: { select: { children: { where: { deletedAt: null } } } },
    },
    orderBy: { sku: 'asc' },
  })
  const defaults = categoryId ? await resolveCategoriesForProducts({ productIds: parents.map(p => p.id), channel, marketplace: market }) : {}
  return parents.map(parent => ({ ...parent, channelListings: parent.channelListings.filter(listing => !categoryId || categoryForListing(defaults[parent.id], channel, listing.platformAttributes).channelCategoryId === categoryId) })).filter(parent => parent.channelListings.length > 0)
}

/** Amazon: a theme override is the coordinate's own non-empty `variationTheme`; eBay: its own `_variationAxes`. */
function hasOwnOverride(channel: string, listing: { variationTheme: string | null; variationMapping: unknown; platformAttributes: unknown } | undefined): boolean {
  if (!listing) return false
  if (channel === 'EBAY') {
    const bag = (listing.platformAttributes ?? {}) as Record<string, unknown>
    return bag._variationAxesMode === 'override' || bag._variationAxesMode !== 'inherit' && Array.isArray(bag._variationAxes) && (bag._variationAxes as unknown[]).some((v) => typeof v === 'string' && v.trim())
  }
  return hasVariationMappingOverride(listing.variationMapping) || typeof listing.variationTheme === 'string' && listing.variationTheme.trim().length > 0
}

export async function getVariationRuleView(input: VariationRuleViewInput): Promise<VariationRuleView> {
  return inDatabaseTransaction(prisma, () => readVariationRuleView(input))
}

async function readVariationRuleView(input: VariationRuleViewInput): Promise<VariationRuleView> {
  const channel = input.channel.toUpperCase()
  const market = input.market.toUpperCase()
  const categoryId = input.categoryId?.trim() || null

  const { mapping, warnings } = await getMappingForMarketplaceWithWarnings(channel, market)
  const stored = getVariationRule(mapping, categoryId)
  const families = await familiesFor(channel, market, categoryId)

  // The category's MOST COMMON axis set — design §3.7's derivation sentence is about that set, not about one family.
  const bySet = new Map<string, { axes: string[]; families: number }>()
  for (const family of families) {
    const axes = (family.variationAxes ?? []).filter((a) => typeof a === 'string' && a.trim())
    if (axes.length === 0) continue
    const key = axes.map(canonicalVariantAxis).join('/')
    const hit = bySet.get(key) ?? { axes, families: 0 }
    hit.families += 1
    bySet.set(key, hit)
  }
  const commonest = [...bySet.values()].sort((a, b) => b.families - a.families)[0] ?? null
  const familiesWithAxes = [...bySet.values()].reduce((n, s) => n + s.families, 0)

  const amazon = channel === 'AMAZON' && categoryId ? await loadAmazonThemeFacts(market, categoryId) : null
  const facts: ThemeSchemaFacts = amazon?.facts ?? { properties: {}, themes: [], deprecated: [] }
  const wantedKeys = (commonest?.axes ?? []).map(canonicalVariantAxis)
  const derived = channel === 'AMAZON' && wantedKeys.length > 0 ? deriveAmazonTheme(wantedKeys, facts) : null

  const labelFor = (segment: string) => {
    const bound = bindSegmentToAttribute(segment, facts.properties as Record<string, unknown>)
    return attributeTitle(bound?.attribute ?? null, facts.properties as Record<string, unknown>)
      ?? segment.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
  const themeOptions = classifyThemes(facts).map((t) => ({
    code: t.code,
    label: themeSegments(t.code).map(labelFor).join(' / '),
    coversAll: dropsForTheme(t.keys, wantedKeys).length === 0 && addsForTheme(t.keys, wantedKeys).length === 0 && wantedKeys.length > 0,
    drops: dropsForTheme(t.keys, wantedKeys),
    deprecated: t.deprecated,
  }))

  const limits = limitsFor(channel, facts.themes)
  const effectiveTheme = stored?.rule.theme ?? derived?.match.code ?? null
  const effectiveAxes: VariationRuleView['axes'] = stored
    ? stored.rule.axes.slice().sort((a, b) => a.order - b.order).map((axis) => ({
        axisKey: axis.axisKey,
        label: axis.axisKey.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        channelName: axis.target ?? axis.axisKey,
        target: axis.target,
        included: axis.included,
      }))
    : (commonest?.axes ?? []).map((familyKey, index) => {
        const axisKey = canonicalVariantAxis(familyKey)
        const segment = themeSegments(effectiveTheme ?? '')[index] ?? null
        const bound = segment ? bindSegmentToAttribute(segment, facts.properties as Record<string, unknown>) : null
        return {
          axisKey,
          label: familyKey,
          channelName: segment ? labelFor(segment) : familyKey,
          target: bound?.attribute ?? null,
          included: limits.axes === null || index < limits.axes,
        }
      })
  const dropped = effectiveAxes.filter((a) => !a.included).map((a) => a.axisKey)

  // ── the counts, from the families themselves ───────────────────────────────────────────────────
  const measured = await measureVariationFamilies(input, families)
  const { override, follow, total, collide } = measured

  // ── value maps: the real store, per axis of the commonest set ──────────────────────────────────
  const valueMaps: VariationRuleView['valueMaps'] = []
  for (const familyKey of commonest?.axes ?? []) {
    const attribute = canonicalVariantAxis(familyKey)
    // Two counts, one query each, both from the real store — `reviewedAt IS NULL` is the "needs a human" marker.
    const [mapped, unreviewed] = await Promise.all([
      prisma.fieldValueMap.count({ where: { channel, marketplace: { in: [market, '*'] }, attribute } }),
      prisma.fieldValueMap.count({ where: { channel, marketplace: { in: [market, '*'] }, attribute, reviewedAt: null } }),
    ])
    valueMaps.push({ axisKey: attribute, label: familyKey, mapped, unreviewed })
  }

  const previewSkus = families.slice(0, 5).map((family) => ({
    productId: family.id,
    sku: family.sku,
    name: family.name,
    productType: family.productType,
    listedHere: family.channelListings.some((l) => !!l.externalListingId),
    label: `${family.sku} · ${family._count.children} variants`,
  }))

  const splitCreatable = false // PES.5-ii: listing aliases are not creatable yet, so `per-axis` cannot run.
  const source: VariationRuleView['source'] = stored ? 'rule' : derived || (channel !== 'AMAZON' && wantedKeys.length > 0) ? 'derived' : 'none'

  return {
    channel,
    market,
    categoryId,
    categoryLabel: categoryId ?? `Every ${channelDisplayName(channel)} category`,
    source,
    ruleLabel: stored?.rule.label ?? (stored ? `${channelDisplayName(channel)} ${categoryId ?? 'default'}` : null),
    derivation: stored || !commonest ? null : {
      axisSummary: commonest.axes.join(' × '),
      themeCode: derived?.match.code ?? null,
      themeLabel: derived ? themeSegments(derived.match.code).map(labelFor).join(' / ') : null,
      families: commonest.families,
      familiesTotal: familiesWithAxes,
    },
    counts: { follow, override, collide, wouldCollide: measured.wouldCollide, total },
    theme: channel === 'AMAZON'
      ? { code: effectiveTheme, label: effectiveTheme ? themeSegments(effectiveTheme).map(labelFor).join(' / ') : null, options: themeOptions }
      : null,
    axes: effectiveAxes,
    dropped,
    collisions: {
      resolver: stored?.rule.collisions.resolver ?? 'exclude',
      foldInto: stored?.rule.collisions.foldInto ?? null,
      foldSeparator: stored?.rule.collisions.foldSeparator ?? ' / ',
      resolvers: [
        { kind: 'split', available: splitCreatable, reason: splitCreatable ? null : 'Listing split is unavailable until listing aliases are enabled.' },
        // VT.1b item 2 (VT.4) — the SAME availability function the coordinate uses. A category-wide read has no cell
        // facts, so it answers `false` with the reason rather than guessing `true`: whether a variant's axis cell can
        // be written is a per-coordinate fact, and VT.4 measured every one of them as `write: null`.
        { kind: 'fold', ...foldAvailability(null, effectiveAxes.filter((a) => a.included).map((a) => a.axisKey)) },
        { kind: 'exclude', available: true, reason: null },
      ],
    },
    split: {
      mode: stored?.rule.split.mode ?? 'one',
      axisKey: stored?.rule.split.axisKey ?? null,
      available: splitCreatable,
      reason: splitCreatable ? null : 'Listing split is unavailable until listing aliases are enabled.',
    },
    valueMaps,
    axisNamesSentence: AXIS_NAMES_SENTENCE[channel] ?? 'Axis names come from the channel; values are sent verbatim.',
    previewSkus,
    writeBlockedReason: channel === 'AMAZON' && categoryId && !amazon
      ? VT_COPY.schemaUnavailable
      : null,
    expectedToken: mappingToken(mapping),
    mappingWarnings: warnings,
    vocabulary: { sectionTitle: vocabularyFor(channel).sectionTitle },
  }
}

/**
 * The blast radius, VX §11.1's sentence: `<n> products follow this rule · <m> would gain a collision`.
 *
 * It is NOT the field-rule impact scan, and it cannot be: that scan counts products whose FIELD values a rule changes,
 * and a variation rule changes none. It answers the two questions the sentence asks, from the families themselves, and
 * it is the ONLY simulation — the same function runs for the dry run and for the pre-commit check.
 */
async function measureVariationFamilies(input: VariationRuleViewInput, families: Awaited<ReturnType<typeof familiesFor>>, proposedRule?: StoredVariationRule | null) {
  const { getInformationSheet } = await import('./information-sheet.js')
  let follow = 0, override = 0, wouldCollide = 0, collide = 0
  for (const family of families) {
    const sheets = new Map<string, Awaited<ReturnType<typeof getInformationSheet>>>()
    let follows = false, currentCollision = false, gained = false
    for (const listing of family.channelListings) {
      const { input: facts } = await loadStoredVariationProjection({ productId: family.id, channel: input.channel.toUpperCase(), market: input.market.toUpperCase(), listingId: listing.id, aliasKey: listing.aliasKey })
      const account = listing.channelConnectionId ?? ''
      if (!sheets.has(account)) sheets.set(account, await getInformationSheet({ productId: family.id, scope: 'channel', channel: input.channel.toUpperCase(), market: input.market.toUpperCase(), ...(account ? { accountId: account } : {}), includeMapping: true }))
      const sheet = sheets.get(account)!
      facts.family.variants = facts.family.variants?.map(variant => ({ ...variant, axisValues: sheet.rows.find(r => r.id === variant.id && (r.aliasId ?? '') === listing.aliasKey)?.axisValues ?? {} }))
      const current = resolveVariationProjection(facts)
      currentCollision ||= (current.collisions?.unresolved ?? 0) > 0
      if (hasOwnOverride(input.channel.toUpperCase(), listing) || (!input.categoryId && facts.rule?.category)) continue
      follows = true
      if (proposedRule === undefined) continue
      facts.rule = proposedRule ? { label: proposedRule.label ?? 'Proposed rule', category: input.categoryId, theme: proposedRule.theme, mapping: proposedRule.axes } : null
      const proposed = resolveVariationProjection(facts)
      if (proposed.candidates?.state === 'unavailable' || proposed.axes.some(a => a.included && a.unbound)) throw new Error(`Cannot evaluate ${family.sku}: load its category schema and bind every included axis to the selected theme.`)
      const collidingIds = (cell: typeof current) => new Set(variationCollisionGroups(cell.axes.filter(a => a.included).map(a => a.familyKey), facts.family.variants ?? []).flatMap(g => g.members.map(m => m.id)))
      const before = collidingIds(current)
      gained ||= [...collidingIds(proposed)].some(id => !before.has(id))
    }
    if (follows) follow++; else override++
    if (currentCollision) collide++
    if (gained) wouldCollide++
  }
  return { follow, override, wouldCollide, collide, total: families.length }
}

export async function simulateVariationRule(input: VariationRuleViewInput & { rule: StoredVariationRule | null }): Promise<{ follow: number; wouldCollide: number; total: number; override: number }> {
  return inDatabaseTransaction(prisma, async () => {
    const families = await familiesFor(input.channel.toUpperCase(), input.market.toUpperCase(), input.categoryId?.trim() || null)
    const { follow, wouldCollide, total, override } = await measureVariationFamilies(input, families, input.rule)
    return { follow, wouldCollide, total, override }
  })
}

/** The mapping with this rule written, for the caller to hand to the review/activation path. Never writes. */
export function draftVariationRule(
  mapping: MarketplaceSchemaMapping,
  categoryId: string | null,
  rule: StoredVariationRule | null,
  actor: string | null,
): { mapping: MarketplaceSchemaMapping; errors: string[] } {
  const path = categoryId ? `mapping.variationsByProductType.${categoryId}` : 'mapping.variations'
  const errors = rule ? validateStoredVariationRule(rule, path) : []
  if (errors.length) return { mapping, errors }
  const stamped: StoredVariationRule | null = rule
    ? { ...rule, updatedAt: new Date().toISOString(), updatedBy: actor }
    : null
  return { mapping: setVariationRuleInMapping(mapping, categoryId, stamped), errors: [] }
}
