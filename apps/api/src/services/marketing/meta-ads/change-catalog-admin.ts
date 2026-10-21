/**
 * Meta ads step 34 (2026-10-21) — the drafts of the catalog changes (pure: built from the request and the live state the
 * tool read, without any call): create-meta-catalog (CT-006, CT-009 at create, CT-011), set-meta-catalog (CT-007, CT-008,
 * CT-009, CR-460, CT-121, CT-122), set-meta-catalog-access (CT-014, CT-015, CT-017, CT-134), set-meta-product-set (CT-064,
 * CT-065, CT-066) and remove-meta-catalog-items (CT-012, CT-045, CT-046, CT-068, CT-079). Each is one request (Meta has no
 * all-or-nothing request), checked by no Meta check (Meta documents validate_only on none of these edges: "Meta has no
 * check for this change"). Four can widen delivery, each SPENDS MONEY (the person's decision) when a campaign, ad set or ad
 * delivers on the catalog or set now — or when Nexus could not see everything that may (review B1: unknown counts as
 * spending, said in words): a set's filter that grows the set (or that Nexus cannot count; an empty set that fills starts
 * its ads again), a pixel connected (retargeting can reach more people), a default or fallback image (items without a
 * usable image can show), a category's first landing page (it starts showing). That premise — what delivers and whether
 * Nexus saw everything — is in each draft's `stands` (review A1), so a change approved while nothing delivered never runs
 * after something started. An empty set or a deleted catalog STOPS ads — said as a warning, never as "nothing changes".
 *
 * D7 (Shopify keeps writing items): no request here writes an item field. An items delete goes only where step 12's
 * writableCatalog(…, 'items') says Nexus may write items (the tool asks it before this draft, at the preview and again at
 * the run); everything else is 'settings'. The gateway checks every object and id again (gateway/meta-catalog-owner.ts).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { CatalogPersonNow, CatalogSettingsNow, CatalogUse, CategoryNow, EventSourceNow, SetNow, SetRowNow } from './live-catalog-admin.js'
import { setFilterOut } from './live-commerce.js'
import type { MetaCatalogKind } from '../../gateway/meta-catalog-rules.js'
import type { MetaCatalogEdge } from '../../gateway/meta.js'

/** What every catalog change says about Meta's check. */
export const NO_META_CHECK = 'Meta has no check for this change (validate_only is documented on none of the catalog edges): the preview is built from the live state, read again before it is sent.'

type Line = [string, unknown, unknown]

function request(step: number, label: string, objectId: string, objectKind: MetaCatalogKind, params: Record<string, string>, extra: Partial<MetaChangeRequest> & { operation: string; edge?: MetaCatalogEdge; undoable: boolean }): MetaChangeRequest {
  return { step, label, kind: 'ad', objectId, objectKind, params, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, ...extra }
}

const quoted = (name: string | null | undefined) => (name ? `"${name}" ` : '')
const draftOf = (d: Partial<MetaChangeDraft> & Pick<MetaChangeDraft, 'summary' | 'requests' | 'stands' | 'before' | 'after'>): MetaChangeDraft => ({
  changes: {}, totals: {}, warnings: [], spendsMoney: [], skipped: [], ...d,
})
const linesOf = (lines: Line[]) => {
  const { changes, more } = changeLines(lines)
  return { changes, ...(more ? { totals: { linesNotShown: more } } : {}) }
}

/** A filter as a person reads it; a filter that names a price says so without its amounts (money is shown only to some). */
export function filterInWords(filter: string | null | undefined): string {
  if (filter === null || filter === undefined || filter.trim() === '' || filter.trim() === '{}') return 'every item of the catalog'
  const out = setFilterOut(filter)
  if (out.filterHasPrices) return 'a filter that names a price (its amounts are shown only to people who may see revenue: meta-product-sets view set)'
  return typeof out.filterWords === 'string' ? out.filterWords : `Meta's filter ${filter.length > 300 ? `${filter.slice(0, 299)}…` : filter}`
}

/** Meta's filter text in Nexus's one spelling (JSON.stringify of what it parses to); '' (every item) stays ''. */
export function canonicalFilter(filter: string): string {
  if (filter.trim() === '' || filter.trim() === '{}') return ''
  try { return JSON.stringify(JSON.parse(filter)) } catch { return filter }
}

const USE_KIND: Readonly<Record<string, string>> = { campaign: 'campaign', adset: 'ad set', ad: 'ad' }
/** What uses a catalog or set and delivers now (effective status ACTIVE). */
export const deliveringOf = (use: CatalogUse) => use.users.filter((u) => u.effectiveStatus === 'ACTIVE')

/** The campaigns, ad sets and ads that use a catalog or set, in words, and what Nexus could not see (the chosen ad account's only). */
function useWarnings(use: CatalogUse, what: string): string[] {
  const unseen = use.unseen.length ? ` Nexus could not see everything: ${use.unseen.join('; ')}.` : ''
  if (!use.users.length) return [`No campaign, ad set or ad of the chosen ad account shows ${what} as far as Nexus can see.${unseen} Ads of other ad accounts that use it are not seen by Nexus.`]
  const live = deliveringOf(use)
  const shown = use.users.slice(0, 20).map((u) => `${USE_KIND[u.kind]} ${quoted(u.name)}(${u.id}, ${u.effectiveStatus ?? 'status not read'}, via ${u.uses})`).join('; ')
  return [`${plural(use.users.length, 'campaign, ad set or ad', 'campaigns, ad sets and ads')} of the chosen ad account show${use.users.length === 1 ? 's' : ''} ${what}${live.length ? ` (${live.length} delivering now)` : ''}: ${shown}${use.users.length > 20 ? `; and ${use.users.length - 20} more` : ''}.${unseen} Ads of other ad accounts are not seen by Nexus.`]
}

/**
 * Review A1 — the spend premise a preview stands on (in `stands`): the sorted ids of what delivers now from it, and whether
 * Nexus could not see everything. A preview approved while nothing delivered never runs after something started.
 */
export const spendPremise = (use: CatalogUse) => ({ delivering: deliveringOf(use).map((u) => `${u.kind}:${u.id}`).sort(), unseen: use.unseen.length > 0 })

/**
 * Review B1 / A5 — SPENDS MONEY when a change can widen delivery and something delivers now from it, or when Nexus could not
 * see everything that may (unknown counts as spending): the sentence says which, and what Nexus did not see.
 */
function spendLine(use: CatalogUse, what: string, how: string): string[] {
  const live = deliveringOf(use)
  if (!live.length && !use.unseen.length) return []
  const who = live.length ? `${plural(live.length, 'campaign, ad set or ad', 'campaigns, ad sets and ads')} delivering now (${live.map((u) => `${USE_KIND[u.kind]} ${u.id}`).join(', ')}) ${live.length === 1 ? 'uses' : 'use'} ${what}` : `Nexus could not see everything that may deliver on ${what}`
  return [`${who}: ${how}.${use.unseen.length ? ` Not seen by Nexus, so counted as spending: ${use.unseen.join('; ')}.` : ''}`]
}

// ── create-meta-catalog ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ImageSettings { carouselAd: string; singleAd: string }
export const displaySettingsParam = (s: ImageSettings) => JSON.stringify({ carousel_ad: { transformation_type: s.carouselAd }, single_ad: { transformation_type: s.singleAd } })

/** The record of a catalog Nexus made (undo deletes exactly it) or deleted. */
export interface CatalogMadeRecord {
  op: 'create' | 'remove'
  made: { id: string | null; name: string | null; segment: boolean; parentId: string | null } | null
  madeAt: string
  noUndo?: string[]
}

export interface CatalogCreateInput {
  name: string
  imageSettings?: ImageSettings | null
  segment?: { parentId: string; parentName: string | null; filter: string; matching: number | null; parentItems: number | null } | null
}

export function catalogCreateDraft(input: CatalogCreateInput, live: { portfolioId: string }): MetaChangeDraft {
  const segment = input.segment ?? null
  const params: Record<string, string> = segment
    ? { name: input.name, parent_catalog_id: segment.parentId, catalog_segment_filter: segment.filter || '{}' }
    : { name: input.name, vertical: 'commerce', ...(input.imageSettings ? { da_display_settings: displaySettingsParam(input.imageSettings) } : {}) }
  const warnings = segment
    ? [
      'A catalog segment is for collaborative ads: Meta makes it only when the business is onboarded to Collaborative Ads and the parent catalog is compliant (else Meta answers 2310019). Share it with a partner with set-meta-catalog-access (action share).',
      segment.matching === null ? 'Nexus could not count the items the segment would hold now.'
        : segment.matching === 0 ? 'No item of the parent catalog matches: the segment would be empty, and ads on it would not deliver (Meta).'
          : `The segment holds ${segment.matching} item${segment.matching === 1 ? '' : 's'} of the parent catalog now${segment.parentItems !== null && segment.matching >= segment.parentItems ? ' — it matches every item' : segment.parentItems !== null ? ` (of ${segment.parentItems})` : ''}; Meta re-applies the filter as items change.`,
    ]
    : [
      'Meta asks a person to accept its catalog terms in Business Manager before the business\'s first catalog: until then it refuses the create.',
      `The catalog belongs to business portfolio ${live.portfolioId} for good (Meta cannot move a catalog to another portfolio).`,
      'It starts empty: items come from a data source a person connects (Shopify\'s channel, a feed); Nexus writes no items (D7).',
    ]
  const lines: Line[] = [
    ['Catalog', null, input.name],
    ...(segment ? [['Segment of catalog', null, `${quoted(segment.parentName)}(${segment.parentId})`] as Line, ['Segment filter', null, filterInWords(segment.filter)] as Line] : []),
    ...(input.imageSettings && !segment ? [['Image crop / padding (carousel, single)', null, `${input.imageSettings.carouselAd}, ${input.imageSettings.singleAd}`] as Line] : []),
  ]
  return draftOf({
    summary: segment ? `Make catalog segment "${input.name}" of catalog ${segment.parentId}` : `Make catalog "${input.name}" in business portfolio ${live.portfolioId}`,
    ...linesOf(lines),
    warnings: [...warnings, NO_META_CHECK],
    requests: [request(1, segment ? `Make catalog segment "${input.name}" of catalog ${segment.parentId}` : `Make catalog "${input.name}" in business portfolio ${live.portfolioId}`, live.portfolioId, 'catalogbusiness', params, {
      operation: segment ? 'catalog.segment.create' : 'catalog.create', edge: 'owned_product_catalogs', undoable: false,
      expect: { name: input.name }, readBackFields: 'id,name,vertical,is_catalog_segment', recordEvenIfNotAsAsked: true,
    })],
    stands: { portfolioId: live.portfolioId, parentId: segment?.parentId ?? null },
    before: { op: 'create', made: null, madeAt: '' } satisfies CatalogMadeRecord,
    after: { op: 'create', made: { id: null, name: input.name, segment: !!segment, parentId: segment?.parentId ?? null }, madeAt: '' } satisfies CatalogMadeRecord,
  })
}

// ── remove-meta-catalog-items (and the undo of what a create made) ─────────────────────────────────────────────────

export type RemoveKind = 'catalog' | 'product-set' | 'items' | 'item' | 'feed'
export const CATALOG_REMOVE_KINDS: readonly RemoveKind[] = ['catalog', 'product-set', 'items', 'item', 'feed']
export const FINAL = 'DELETING IS FINAL: Meta keeps nothing to restore.'

export interface CatalogRemoveRecord { op: 'remove'; kind: RemoveKind; catalogId: string; ids: string[]; skus?: string[] }

/** A catalog (CT-012) — with every product set, item and feed in it. */
export function catalogDeleteDraft(live: { catalogId: string; name: string | null; isSegment: boolean | null; productCount: number | null; sets: SetRowNow[]; setsMore: boolean; use: CatalogUse }, alsoLive: boolean, why: 'asked' | 'undo'): MetaChangeDraft {
  const name = `catalog ${quoted(live.name)}(${live.catalogId})`
  const delivering = deliveringOf(live.use)
  const warnings = [
    FINAL,
    live.isSegment === true
      ? `A segment holds no items of its own: deleting it removes the segment and its ${plural(live.sets.length, 'product set')}; the parent catalog and its items stay.`
      : `It takes with it its ${live.productCount ?? 'unknown number of'} item(s), ${plural(live.sets.length, 'product set')}${live.setsMore ? ' (more than 500)' : ''} and every feed; every catalog ad using it stops.`,
    ...useWarnings(live.use, name),
    alsoLive
      ? `alsoLive: Nexus sends allow_delete_catalog_with_live_product_set=true, so Meta deletes it even while ads use its product sets — ${delivering.length ? `${plural(delivering.length, 'delivering campaign, ad set or ad', 'delivering campaigns, ad sets and ads')} STOP: ${delivering.map((u) => u.id).join(', ')}` : 'any ad that uses them STOPS'}.`
      : 'Meta refuses this delete while ads use its product sets (unless the person asks for that too: alsoLive).',
    'Meta lets only a catalog admin delete it (else 3970).',
    NO_META_CHECK,
  ]
  return draftOf({
    summary: `Delete ${name}${why === 'undo' ? ' (the undo of the change that made it)' : ''}`,
    ...linesOf([[`Catalog ${live.catalogId}`, live.name ?? 'exists', 'DELETED'], ...live.sets.slice(0, 15).map((s): Line => [`Product set ${s.id}`, `${quoted(s.name)}(${s.productCount ?? '?'} items)`, 'DELETED'])]),
    totals: { productSets: live.sets.length, adsObjectsUsingIt: live.use.users.length },
    warnings,
    requests: [request(1, `Delete ${name}`, live.catalogId, 'catalog', alsoLive ? { allow_delete_catalog_with_live_product_set: 'true' } : {}, { operation: alsoLive ? 'catalog.delete.live' : 'catalog.delete', method: 'DELETE', undoable: false })],
    stands: { catalogId: live.catalogId, sets: live.sets.map((s) => s.id).sort(), users: live.use.users.map((u) => `${u.kind}:${u.id}:${u.effectiveStatus}`).sort(), uses: spendPremise(live.use), alsoLive },
    before: { op: 'remove', kind: 'catalog', catalogId: live.catalogId, ids: [live.catalogId] } satisfies CatalogRemoveRecord,
    after: { op: 'remove', kind: 'catalog', catalogId: live.catalogId, ids: [live.catalogId] } satisfies CatalogRemoveRecord,
    alsoDeleted: { productSets: live.sets.map((s) => ({ id: s.id, name: s.name, items: s.productCount })), adsThatStop: live.use.users.map((u) => ({ kind: u.kind, id: u.id, name: u.name, status: u.effectiveStatus, via: u.uses })), notSeen: live.use.unseen },
  })
}

/** A product set (CT-068) — the undo of a set Nexus made too. */
export function setDeleteDraft(live: { set: SetNow; use: CatalogUse }, alsoLive: boolean, why: 'asked' | 'undo'): MetaChangeDraft {
  const { set } = live
  const name = `product set ${quoted(set.name)}(${set.productSetId})`
  const delivering = deliveringOf(live.use)
  return draftOf({
    summary: `Delete ${name}${why === 'undo' ? ' (the undo of the change that made it)' : ''}`,
    ...linesOf([[`Product set ${set.productSetId}`, `${quoted(set.name)}(${set.productCount ?? '?'} items; ${filterInWords(set.filter)})`, 'DELETED']]),
    warnings: [
      FINAL,
      'Ads on it stop: a set made again gets a new id, and ads keep the old one.',
      ...useWarnings(live.use, name),
      alsoLive
        ? `alsoLive: Nexus sends allow_live_product_set_deletion=true, so Meta deletes it even while an active ad or a shop collection uses it — ${delivering.length ? `${plural(delivering.length, 'delivering campaign, ad set or ad', 'delivering campaigns, ad sets and ads')} STOP: ${delivering.map((u) => u.id).join(', ')}` : 'any ad or collection that uses it STOPS'}.`
        : 'Meta refuses this delete while an active ad or a shop collection uses the set (unless the person asks for that too: alsoLive).',
      NO_META_CHECK,
    ],
    requests: [request(1, `Delete ${name}`, set.productSetId, 'productset', alsoLive ? { allow_live_product_set_deletion: 'true' } : {}, { operation: alsoLive ? 'productset.delete.live' : 'productset.delete', method: 'DELETE', undoable: false })],
    stands: { productSetId: set.productSetId, catalogId: set.catalogId, users: live.use.users.map((u) => `${u.kind}:${u.id}:${u.effectiveStatus}`).sort(), uses: spendPremise(live.use), alsoLive },
    before: { op: 'remove', kind: 'product-set', catalogId: set.catalogId, ids: [set.productSetId] } satisfies CatalogRemoveRecord,
    after: { op: 'remove', kind: 'product-set', catalogId: set.catalogId, ids: [set.productSetId] } satisfies CatalogRemoveRecord,
    alsoDeleted: { productSet: { id: set.productSetId, name: set.name, items: set.productCount }, adsThatStop: live.use.users.map((u) => ({ kind: u.kind, id: u.id, name: u.name, status: u.effectiveStatus, via: u.uses })), notSeen: live.use.unseen },
  })
}

/** Items by retailer id (CT-045): one items_batch of DELETEs, only of the retailer ids the catalog holds now. */
export function itemsDeleteDraft(live: { catalogId: string; catalogName: string | null; asked: string[]; found: Map<string, { itemId: string | null; name: string | null }>; use: CatalogUse }): MetaChangeDraft {
  const found = live.asked.filter((sku) => live.found.has(sku))
  const missing = live.asked.filter((sku) => !live.found.has(sku))
  const requests = found.length
    ? [request(1, `Delete ${plural(found.length, 'item')} from catalog ${quoted(live.catalogName)}(${live.catalogId})`, live.catalogId, 'catalog', {
      item_type: 'PRODUCT_ITEM',
      requests: JSON.stringify(found.map((sku) => ({ method: 'DELETE', data: { id: sku } }))),
      allow_upsert: 'false',
    }, { operation: 'catalog.items.delete', edge: 'items_batch', undoable: false })]
    : []
  return draftOf({
    summary: `Delete ${plural(found.length, 'item')} from catalog ${live.catalogId}`,
    ...linesOf(found.map((sku): Line => [`Item ${sku}`, `${quoted(live.found.get(sku)?.name)}(${live.found.get(sku)?.itemId ?? 'id not read'})`, 'DELETED'])),
    totals: { items: found.length },
    skipped: missing.map((sku) => `${sku}: not an item of this catalog now (Nexus read the catalog first): nothing to delete.`),
    warnings: [
      FINAL,
      'Their ads stop, and product sets that held them get smaller (an empty set does not deliver). Meta takes the deletes in one batch of its own: the run reads what Meta did with each (check_batch_request_status).',
      ...useWarnings(live.use, `catalog ${live.catalogId}`),
      'Meta answers a catalog\'s batches at about 200 a hour (80014: wait and ask again).',
      NO_META_CHECK,
    ],
    requests,
    stands: { catalogId: live.catalogId, found: found.map((sku) => `${sku}:${live.found.get(sku)?.itemId ?? ''}`).sort() },
    before: { op: 'remove', kind: 'items', catalogId: live.catalogId, ids: found.map((sku) => live.found.get(sku)?.itemId ?? '').filter(Boolean), skus: found } satisfies CatalogRemoveRecord,
    after: { op: 'remove', kind: 'items', catalogId: live.catalogId, ids: [], skus: found } satisfies CatalogRemoveRecord,
    alsoDeleted: { items: found.map((sku) => ({ sku, itemId: live.found.get(sku)?.itemId ?? null, name: live.found.get(sku)?.name ?? null })) },
  })
}

/** One item by its Meta id (CT-046; Meta's MCP ads_catalog_delete_product). */
export function itemDeleteDraft(live: { itemId: string; catalogId: string; sku: string | null; name: string | null; use: CatalogUse }): MetaChangeDraft {
  const name = `item ${quoted(live.name)}(${live.itemId}${live.sku ? `, SKU ${live.sku}` : ''})`
  return draftOf({
    summary: `Delete ${name} from catalog ${live.catalogId}`,
    ...linesOf([[`Item ${live.itemId}`, live.name ?? 'exists', 'DELETED']]),
    warnings: [FINAL, 'Its ads stop; sets that held it get smaller (an empty set does not deliver).', ...useWarnings(live.use, `catalog ${live.catalogId}`), NO_META_CHECK],
    requests: [request(1, `Delete ${name}`, live.itemId, 'productitem', {}, { operation: 'productitem.delete', method: 'DELETE', undoable: false })],
    stands: { itemId: live.itemId, catalogId: live.catalogId, sku: live.sku },
    before: { op: 'remove', kind: 'item', catalogId: live.catalogId, ids: [live.itemId], skus: live.sku ? [live.sku] : [] } satisfies CatalogRemoveRecord,
    after: { op: 'remove', kind: 'item', catalogId: live.catalogId, ids: [live.itemId], skus: live.sku ? [live.sku] : [] } satisfies CatalogRemoveRecord,
  })
}

/** A supplementary feed (CT-079): it brings no items (a supplementary feed only adds fields). */
export function feedDeleteDraft(live: { catalogId: string; feedId: string; name: string | null }): MetaChangeDraft {
  const name = `supplementary feed ${quoted(live.name)}(${live.feedId})`
  return draftOf({
    summary: `Delete ${name} of catalog ${live.catalogId}`,
    ...linesOf([[`Feed ${live.feedId}`, live.name ?? 'exists', 'DELETED']]),
    warnings: [FINAL, 'A supplementary feed only adds fields to items another source brings: the fields it added go with it (the items stay). Meta lets only a feed admin delete it (else 3964).', NO_META_CHECK],
    requests: [request(1, `Delete ${name}`, live.feedId, 'productfeed', {}, { operation: 'productfeed.delete', method: 'DELETE', undoable: false, parent: { kind: 'catalog', id: live.catalogId } })],
    stands: { feedId: live.feedId, catalogId: live.catalogId },
    before: { op: 'remove', kind: 'feed', catalogId: live.catalogId, ids: [live.feedId] } satisfies CatalogRemoveRecord,
    after: { op: 'remove', kind: 'feed', catalogId: live.catalogId, ids: [live.feedId] } satisfies CatalogRemoveRecord,
  })
}

// ── set-meta-catalog ────────────────────────────────────────────────────────────────────────────────────────────────

export interface CatalogSettingsFields { name?: string | null; defaultImageUrl?: string | null; fallbackImageUrl?: string | null; displaySettings?: { carouselAd: string | null; singleAd: string | null } | null }
export interface CatalogSettingsRecord {
  op: 'settings' | 'categories' | 'connect' | 'disconnect'
  catalogId: string
  fields?: CatalogSettingsFields
  categories?: CategoryNow[]
  sources?: Array<{ id: string; connected: boolean; pixel: boolean }>
  noUndo?: string[]
}

/** The fields of a catalog's settings as recorded and compared (the first fallback image only: Meta reads a list). */
export function settingsProjection(now: CatalogSettingsNow, keys: readonly (keyof CatalogSettingsFields)[]): CatalogSettingsFields {
  const out: CatalogSettingsFields = {}
  for (const key of keys) {
    if (key === 'name') out.name = now.name
    if (key === 'defaultImageUrl') out.defaultImageUrl = now.defaultImageUrl
    if (key === 'fallbackImageUrl') out.fallbackImageUrl = now.fallbackImageUrls[0] ?? null
    if (key === 'displaySettings') out.displaySettings = now.displaySettings
  }
  return out
}

export function catalogSettingsDraft(asked: { name?: string; defaultImageUrl?: string; fallbackImageUrl?: string; imageSettings?: ImageSettings }, now: CatalogSettingsNow & { catalogName?: string | null }, use: CatalogUse): MetaChangeDraft {
  const params: Record<string, string> = {}
  const lines: Line[] = []
  const skipped: string[] = []
  const warnings: string[] = []
  const noUndo: string[] = []
  const keys: Array<keyof CatalogSettingsFields> = []
  if (asked.name !== undefined) {
    if (asked.name === now.name) skipped.push(`The catalog is named "${asked.name}" already.`)
    else { params.name = asked.name; lines.push(['Name', now.name, asked.name]); keys.push('name') }
  }
  if (asked.defaultImageUrl !== undefined) {
    if (asked.defaultImageUrl === now.defaultImageUrl) skipped.push('The default image is that address already.')
    else {
      params.default_image_url = asked.defaultImageUrl; lines.push(['Default image (items without a usable image)', now.defaultImageUrl, asked.defaultImageUrl]); keys.push('defaultImageUrl')
      warnings.push('Meta treats an item image equal to the default image as "not loaded".')
      if (!now.defaultImageUrl) noUndo.push('There was no default image before, and Meta documents no way to clear one: undo cannot take it off.')
    }
  }
  if (asked.fallbackImageUrl !== undefined) {
    if (now.fallbackImageUrls.length === 1 && now.fallbackImageUrls[0] === asked.fallbackImageUrl) skipped.push('The fallback image is that address already.')
    else {
      params.fallback_image_url = asked.fallbackImageUrl; lines.push(['Fallback image (auto-generated items)', now.fallbackImageUrls.join(', ') || null, asked.fallbackImageUrl]); keys.push('fallbackImageUrl')
      if (!now.fallbackImageUrls.length) noUndo.push('There was no fallback image before, and Meta documents no way to clear one: undo cannot take it off.')
      else if (now.fallbackImageUrls.length > 1) noUndo.push(`Meta read ${now.fallbackImageUrls.length} fallback images; Meta takes one address: undo sends back the first.`)
    }
  }
  if (asked.imageSettings) {
    const to = { carouselAd: asked.imageSettings.carouselAd, singleAd: asked.imageSettings.singleAd }
    if (now.displaySettings && now.displaySettings.carouselAd === to.carouselAd && now.displaySettings.singleAd === to.singleAd) skipped.push('The image crop / padding settings are these already.')
    else {
      params.da_display_settings = displaySettingsParam(asked.imageSettings)
      lines.push(['Image crop / padding (carousel, single)', now.displaySettings ? `${now.displaySettings.carouselAd}, ${now.displaySettings.singleAd}` : 'Meta\'s default', `${to.carouselAd}, ${to.singleAd}`]); keys.push('displaySettings')
      warnings.push('It changes how every Advantage+ catalog ad of this catalog shows its items, at once.')
      if (!now.displaySettings?.carouselAd || !now.displaySettings?.singleAd) noUndo.push('The catalog had Meta\'s default image settings: undo cannot ask for "default" again.')
    }
  }
  const catalog = `catalog ${quoted(now.catalogName ?? now.name)}(${now.catalogId})`
  const before = settingsProjection(now, keys)
  // Review A5 — a default or fallback image lets items that had no usable image show in this catalog's ads: with something
  // delivering from the catalog (or not seen), that is SPENDS MONEY.
  const spendsMoney = params.default_image_url || params.fallback_image_url
    ? spendLine(use, catalog, 'items without a usable image (and auto-generated items) can then show in its ads, so they can deliver more')
    : []
  const expect: Record<string, string> = {}
  if (params.name) expect.name = params.name
  if (params.default_image_url) expect.default_image_url = params.default_image_url
  return draftOf({
    summary: `Change the settings of ${catalog}`,
    ...linesOf(lines),
    skipped,
    warnings: [...warnings, ...(spendsMoney.length || params.default_image_url || params.fallback_image_url ? useWarnings(use, catalog) : []), NO_META_CHECK],
    spendsMoney,
    requests: Object.keys(params).length ? [request(1, `Change ${keys.join(', ')} of ${catalog}`, now.catalogId, 'catalog', params, { operation: 'catalog.update', undoable: true, raisesSpend: spendsMoney.length > 0, expect, readBackFields: 'id,name,default_image_url,fallback_image_url,da_display_settings,product_count' })] : [],
    stands: { catalogId: now.catalogId, before, uses: spendPremise(use) },
    before: { op: 'settings', catalogId: now.catalogId, fields: before, ...(noUndo.length ? { noUndo } : {}) } satisfies CatalogSettingsRecord,
    after: { op: 'settings', catalogId: now.catalogId, fields: { ...before, ...(params.name ? { name: params.name } : {}), ...(params.default_image_url ? { defaultImageUrl: params.default_image_url } : {}), ...(params.fallback_image_url ? { fallbackImageUrl: params.fallback_image_url } : {}), ...(asked.imageSettings && keys.includes('displaySettings') ? { displaySettings: { carouselAd: asked.imageSettings.carouselAd, singleAd: asked.imageSettings.singleAd } } : {}) } } satisfies CatalogSettingsRecord,
  })
}

export interface CategoryAsk { criteria: string; value: string; name?: string; description?: string; destinationUrl?: string; imageUrl?: string }

/** CR-460 — categories' display (name, description, landing page, image); Meta cannot delete one (an empty landing page skips it). */
export function catalogCategoriesDraft(asked: CategoryAsk[], live: { catalogId: string; catalogName: string | null; byCriteria: Map<string, { byValue: Map<string, CategoryNow>; more: boolean }>; use: CatalogUse }): MetaChangeDraft | { refusal: string } {
  const data: Array<Record<string, string>> = []
  const lines: Line[] = []
  const skipped: string[] = []
  const notListed: string[] = []
  const before: CategoryNow[] = []
  const after: CategoryNow[] = []
  const noUndo: string[] = []
  for (const c of asked) {
    const listed = live.byCriteria.get(c.criteria)
    const now = listed?.byValue.get(c.value) ?? null
    if (!now) notListed.push(`${c.criteria} "${c.value}"`)
    const old: CategoryNow = now ?? { criteria: c.criteria, value: c.value, name: null, description: null, destinationUri: null, imageUrl: null }
    if (!old.destinationUri && c.destinationUrl === undefined) {
      return { refusal: `Category ${c.criteria} "${c.value}" has no landing page yet: Meta needs destinationUrl the first time a category is set (or "" to skip the category).` }
    }
    const entry: Record<string, string> = { categorization_criteria: c.criteria, criteria_value: c.value }
    const moved: string[] = []
    const set = (key: string, field: keyof CategoryNow, value: string | undefined, label: string) => {
      if (value === undefined || value === old[field]) return
      if (key === 'destination_uri' && value === '' && old.destinationUri === null) return
      entry[key] = value
      moved.push(label)
      lines.push([`${c.criteria} "${c.value}": ${label}`, old[field], value === '' ? 'empty (Meta skips this category)' : value])
    }
    set('name', 'name', c.name, 'name')
    set('description', 'description', c.description, 'description')
    set('destination_uri', 'destinationUri', c.destinationUrl, 'landing page')
    set('image_url', 'imageUrl', c.imageUrl, 'image')
    if (!moved.length) { skipped.push(`Category ${c.criteria} "${c.value}" is like that already.`); continue }
    data.push(entry)
    before.push(old)
    after.push({ ...old, ...(entry.name !== undefined ? { name: entry.name } : {}), ...(entry.description !== undefined ? { description: entry.description } : {}), ...(entry.destination_uri !== undefined ? { destinationUri: entry.destination_uri || null } : {}), ...(entry.image_url !== undefined ? { imageUrl: entry.image_url } : {}) })
    for (const [field, word] of [['name', 'name'], ['description', 'description'], ['imageUrl', 'image']] as const) {
      if (entry[field === 'imageUrl' ? 'image_url' : field] !== undefined && old[field] === null) noUndo.push(`${c.criteria} "${c.value}" had no ${word} before: Meta cannot clear it, so undo leaves it.`)
    }
  }
  const catalog = `catalog ${quoted(live.catalogName)}(${live.catalogId})`
  // Review A5 — a category that gets its first landing page (or one again after a skip) starts showing in category ads.
  const opens = after.filter((c, i) => c.destinationUri && !before[i].destinationUri).map((c) => `${c.criteria} "${c.value}"`)
  const spendsMoney = opens.length ? spendLine(live.use, catalog, `${opens.join(', ')} start${opens.length === 1 ? 's' : ''} showing in its category ads, so they can deliver more`) : []
  return draftOf({
    summary: `Change ${plural(data.length, 'category', 'categories')} of ${catalog}`,
    ...linesOf(lines),
    skipped,
    warnings: [
      'Categories belong to the catalog: every category ad of it shows them at once.',
      'Meta cannot delete a category ("not supported at this time"); an empty landing page skips it.',
      ...(notListed.length ? [`Not among the catalog's top 1,000 categories Meta lists now: ${notListed.join(', ')} — Meta skips a value no item has (its answer counts the skipped ones).`] : []),
      ...[...live.byCriteria.values()].some((l) => l.more) ? ['Nexus read the first 500 categories of a criteria; a category beyond them counts as never set.'] : [],
      ...(opens.length ? useWarnings(live.use, catalog) : []),
      NO_META_CHECK,
    ],
    spendsMoney,
    requests: data.length ? [request(1, `Set ${plural(data.length, 'category', 'categories')} of ${catalog}`, live.catalogId, 'catalog', { data: JSON.stringify(data) }, { operation: 'catalog.categories', edge: 'categories', undoable: true, raisesSpend: spendsMoney.length > 0 })] : [],
    stands: { catalogId: live.catalogId, before, uses: spendPremise(live.use) },
    before: { op: 'categories', catalogId: live.catalogId, categories: before, ...(noUndo.length ? { noUndo } : {}) } satisfies CatalogSettingsRecord,
    after: { op: 'categories', catalogId: live.catalogId, categories: after } satisfies CatalogSettingsRecord,
  })
}

/** CT-121 / CT-122 — pixels connected to a catalog, or pixels and apps disconnected from it. */
export function eventSourcesDraft(action: 'connect' | 'disconnect', ids: string[], live: { catalogId: string; catalogName: string | null; sources: Map<string, EventSourceNow>; sourcesMore: boolean; pixels: Map<string, string | null>; use: CatalogUse }): MetaChangeDraft | { refusal: string } {
  const catalog = `catalog ${quoted(live.catalogName)}(${live.catalogId})`
  if (action === 'connect') {
    const foreign = ids.filter((id) => !live.pixels.has(id))
    if (foreign.length) return { refusal: `Nexus connects only pixels of the chosen ad account (meta-datasets lists them): ${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not one. An app is connected in Commerce Manager.` }
  }
  if (live.sourcesMore) return { refusal: `Catalog ${live.catalogId} has more pixels and apps connected than Nexus reads (200): change them in Commerce Manager.` }
  const want = action === 'connect' ? ids.filter((id) => !live.sources.has(id)) : ids.filter((id) => live.sources.has(id))
  const skipped = ids.filter((id) => !want.includes(id)).map((id) => (action === 'connect' ? `${id} is connected to this catalog already.` : `${id} is not connected to this catalog: nothing to disconnect.`))
  const label = (id: string) => `${action === 'connect' ? 'pixel' : live.sources.get(id)?.sourceType ?? 'source'} ${quoted(action === 'connect' ? live.pixels.get(id) : live.sources.get(id)?.name)}(${id})`
  // A pixel connected can let a delivering catalog ad that retargets on its events reach more people (wider targeting);
  // what Nexus could not see counts as delivering (review B1).
  const spendsMoney = action === 'connect' && want.length ? spendLine(live.use, catalog, 'with the pixel\'s events, retargeting and product audiences can reach more people and spend more of their budgets') : []
  const warnings = action === 'connect'
    ? ['A connected pixel lets catalog ads and product audiences match its events to these items (Meta needs rights on the catalog, the pixel and the business).', ...useWarnings(live.use, catalog), NO_META_CHECK]
    : [
      'Disconnecting breaks retargeting catalog ads and catalog product audiences that use these events.',
      ...useWarnings(live.use, catalog),
      'Meta\'s catalog page shows this DELETE while its edge page says it cannot be done: Meta\'s answer decides (LIVE-PROBES CA34-02).',
      NO_META_CHECK,
    ]
  return draftOf({
    summary: `${action === 'connect' ? 'Connect' : 'Disconnect'} ${plural(want.length, action === 'connect' ? 'pixel' : 'pixel or app', action === 'connect' ? 'pixels' : 'pixels and apps')} ${action === 'connect' ? 'to' : 'from'} ${catalog}`,
    ...linesOf(want.map((id): Line => [label(id), action === 'connect' ? 'not connected' : 'connected', action === 'connect' ? 'connected' : 'not connected'])),
    skipped,
    warnings,
    spendsMoney,
    requests: want.length ? [request(1, `${action === 'connect' ? 'Connect' : 'Disconnect'} ${want.join(', ')} ${action === 'connect' ? 'to' : 'from'} ${catalog}`, live.catalogId, 'catalog', { external_event_sources: JSON.stringify(want) }, {
      operation: action === 'connect' ? 'catalog.eventsources.connect' : 'catalog.eventsources.disconnect', edge: 'external_event_sources', undoable: true, raisesSpend: spendsMoney.length > 0, ...(action === 'disconnect' ? { method: 'DELETE' as const } : {}),
    })] : [],
    stands: { catalogId: live.catalogId, connected: want.map((id) => `${id}:${live.sources.has(id)}`).sort(), uses: spendPremise(live.use) },
    before: { op: action, catalogId: live.catalogId, sources: want.map((id) => ({ id, connected: live.sources.has(id), pixel: live.pixels.has(id) })) } satisfies CatalogSettingsRecord,
    after: { op: action, catalogId: live.catalogId, sources: want.map((id) => ({ id, connected: action === 'connect', pixel: live.pixels.has(id) })) } satisfies CatalogSettingsRecord,
  })
}

// ── set-meta-catalog-access ─────────────────────────────────────────────────────────────────────────────────────────

export interface CatalogAccessRecord {
  op: 'assign' | 'remove' | 'share' | 'unshare'
  catalogId: string
  userId?: string
  /** assign / remove: is the person on the catalog (after: as the change left it), and their tasks then (Meta's unpacked list). */
  assigned?: boolean
  tasks?: string[] | null
  businessId?: string
  shared?: boolean
  permittedTasks?: string[]
  noUndo?: string[]
}

export function personAccessDraft(action: 'assign' | 'remove', input: { userId: string; tasks?: string[] }, live: { catalogId: string; catalogName: string | null; people: Map<string, CatalogPersonNow>; who: { name: string | null; kind: string } | null; nexusSystemUserId: string | null }): MetaChangeDraft | { refusal: string } {
  const catalog = `catalog ${quoted(live.catalogName)}(${live.catalogId})`
  const now = live.people.get(input.userId) ?? null
  // Review A2 — Nexus's own system user is never changed here, given tasks or taken off (fewer tasks or none would stop
  // every Nexus catalog tool); when Nexus cannot tell which it is, nothing is sent.
  if (!live.nexusSystemUserId) return { refusal: 'Nexus could not read which system user it is, so it changes no one\'s access to a catalog.' }
  if (input.userId === live.nexusSystemUserId) return { refusal: `${input.userId} is Nexus's own system user: Nexus never changes its own access to a catalog (fewer tasks or none would stop every Nexus catalog tool). A person does that in Meta Business settings, if it is meant.` }
  if (action === 'remove') {
    if (!now) return { refusal: `${input.userId} is not assigned to ${catalog}: nothing to remove.` }
  } else if (!live.who) {
    return { refusal: `${input.userId} is not a person or system user of the chosen business portfolio: Nexus gives catalog access only to them (meta-account-access lists them).` }
  }
  const tasks = [...new Set(input.tasks ?? [])].sort()
  if (action === 'assign' && now && now.tasks.join(',') === tasks.join(',')) return draftOf({ summary: 'Nothing to change', skipped: [`${input.userId} has these tasks on the catalog already.`], requests: [], stands: null, before: null, after: null })
  const who = `${live.who?.kind ?? now?.userType ?? 'person'} ${quoted(live.who?.name ?? now?.name)}(${input.userId})`
  return draftOf({
    summary: action === 'assign' ? `Give ${who} ${tasks.join(', ')} on ${catalog}` : `Take ${who} off ${catalog}`,
    ...linesOf([[`Access of ${who}`, now ? now.tasks.join(', ') || 'assigned' : 'none', action === 'assign' ? tasks.join(', ') : 'none']]),
    warnings: [
      ...(action === 'assign' ? ['MANAGE lets the person change the catalog and its items; ADVERTISE lets them use it in ads; MANAGE_AR and AA_ANALYZE are Meta\'s augmented-reality and analytics tasks. Meta may ask for two-factor authentication on the business (415).'] : ['They lose the catalog in Meta at once.']),
      NO_META_CHECK,
    ],
    requests: [request(1, action === 'assign' ? `Give ${who} ${tasks.join(', ')} on ${catalog}` : `Take ${who} off ${catalog}`, live.catalogId, 'catalog', action === 'assign' ? { user: input.userId, tasks: JSON.stringify(tasks) } : { user: input.userId }, {
      operation: action === 'assign' ? 'catalog.users.assign' : 'catalog.users.remove', edge: 'assigned_users', undoable: true, ...(action === 'remove' ? { method: 'DELETE' as const } : {}),
    })],
    stands: { catalogId: live.catalogId, userId: input.userId, tasks: now?.tasks ?? null },
    before: { op: action, catalogId: live.catalogId, userId: input.userId, assigned: !!now, tasks: now?.tasks ?? null } satisfies CatalogAccessRecord,
    after: { op: action, catalogId: live.catalogId, userId: input.userId, assigned: action === 'assign', tasks: action === 'assign' ? tasks : null } satisfies CatalogAccessRecord,
  })
}

export function partnerAccessDraft(action: 'share' | 'unshare', input: { businessId: string; permittedTasks?: string[]; collabTerms?: string[]; utm?: Record<string, string> }, live: { catalogId: string; catalogName: string | null; isSegment: boolean | null; portfolioId: string; agencies: Map<string, { name: string | null; takenByAnotherBusiness: boolean }>; agenciesMore: boolean; partnerTaken: boolean }): MetaChangeDraft | { refusal: string } {
  const catalog = `${live.isSegment ? 'catalog segment' : 'catalog'} ${quoted(live.catalogName)}(${live.catalogId})`
  const shared = live.agencies.has(input.businessId)
  if (live.agenciesMore) return { refusal: `${catalog} is shared with more partners than Nexus reads (500): change its sharing in Meta Business settings.` }
  if (action === 'unshare' && !shared) return { refusal: `${catalog} is not shared with business portfolio ${input.businessId}: nothing to stop.` }
  if (action === 'share') {
    if (input.businessId === live.portfolioId) return { refusal: 'That is this business\'s own business portfolio: a catalog is shared with a partner, not with its owner.' }
    if (live.partnerTaken) return { refusal: `Business portfolio ${input.businessId} is used by another business in Nexus: Nexus never shares a catalog with it.` }
    if ((input.collabTerms?.length || (input.utm && Object.keys(input.utm).length)) && live.isSegment !== true) return { refusal: 'Collaborative-ads terms and UTM settings go only with the share of a catalog segment (create one with create-meta-catalog segmentOf).' }
  }
  const tasks = [...new Set(input.permittedTasks ?? [])].sort()
  const params: Record<string, string> = action === 'share'
    ? {
      business: input.businessId, permitted_tasks: JSON.stringify(tasks),
      ...(input.collabTerms?.length ? { enabled_collab_terms: JSON.stringify([...new Set(input.collabTerms)].sort()) } : {}),
      ...(input.utm && Object.keys(input.utm).length ? { utm_settings: JSON.stringify(input.utm) } : {}),
    }
    : { business: input.businessId }
  const partner = `business portfolio ${quoted(live.agencies.get(input.businessId)?.name)}(${input.businessId})`
  const noUndo = action === 'share' && shared ? ['It was shared with this partner before, and Nexus cannot read which tasks it had: undo cannot put them back.'] : []
  return draftOf({
    summary: action === 'share' ? `Share ${catalog} with ${partner} (${tasks.join(', ')})` : `Stop sharing ${catalog} with ${partner}`,
    ...linesOf([
      [`Sharing with ${partner}`, shared ? 'shared' : 'not shared', action === 'share' ? `shared: ${tasks.join(', ')}` : 'not shared'],
      ...(params.enabled_collab_terms ? [['Collaborative-ads terms', null, JSON.parse(params.enabled_collab_terms).join(', ')] as Line] : []),
      ...(params.utm_settings ? [['UTM settings', null, params.utm_settings] as Line] : []),
    ]),
    warnings: [
      ...(action === 'share'
        ? ['The partner can then advertise (ADVERTISE) or manage (MANAGE) this catalog in its own business. Meta documents this call for a catalog segment (collaborative ads); for a plain catalog it is in Meta\'s SDK only, so Meta\'s answer decides (LIVE-PROBES CA34-03).', ...(live.isSegment ? ['For collaborative ads the brand accepts the share in its Collaboration Center.'] : [])]
        : ['The partner loses the catalog at once; its ads on it stop. Meta documents this call in its SDK only: Meta\'s answer decides (LIVE-PROBES CA34-03).']),
      NO_META_CHECK,
    ],
    requests: [request(1, action === 'share' ? `Share ${catalog} with ${partner}` : `Stop sharing ${catalog} with ${partner}`, live.catalogId, 'catalog', params, {
      operation: action === 'share' ? 'catalog.agencies.share' : 'catalog.agencies.unshare', edge: 'agencies', undoable: true, ...(action === 'unshare' ? { method: 'DELETE' as const } : {}),
    })],
    stands: { catalogId: live.catalogId, businessId: input.businessId, shared },
    before: { op: action, catalogId: live.catalogId, businessId: input.businessId, shared, ...(noUndo.length ? { noUndo } : {}) } satisfies CatalogAccessRecord,
    after: { op: action, catalogId: live.catalogId, businessId: input.businessId, shared: action === 'share', ...(action === 'share' ? { permittedTasks: tasks } : {}) } satisfies CatalogAccessRecord,
  })
}

// ── set-meta-product-set ────────────────────────────────────────────────────────────────────────────────────────────

/** What a set change records and undo compares: its name, its filter (Nexus's spelling; '' = every item), its retailer id. */
export interface SetFields { name: string | null; filter: string; retailerId: string | null }
export interface ProductSetRecord {
  op: 'create' | 'change' | 'remove'
  catalogId: string
  productSetId: string | null
  set: SetFields | null
  /** before only: the collection text and images it had (undo sends them back when the change moved them). */
  metadata?: SetNow['metadata']
  madeAt?: string
  noUndo?: string[]
}

export const setFieldsOf = (set: SetNow): SetFields => ({ name: set.name, filter: canonicalFilter(set.filter), retailerId: set.retailerId })

export interface SetAsk {
  name?: string
  /** The rule as step 13's productSetFilter built it ('{}' = every item, said explicitly), when the filter changes. */
  filter?: string
  retailerId?: string
  metadata?: Record<string, string>
  shops?: Array<{ shop_id: string; ordering_index: number }>
}

interface CountNow { matching: number | null; catalogItems: number | null; itemsNow: number | null }

/** The item count before → after (step 13's preview), and the empty-set and every-item words. */
function countLines(filter: string | undefined, count: CountNow | null): { lines: Line[]; warnings: string[] } {
  if (filter === undefined) return { lines: [], warnings: [] }
  if (!count || count.matching === null) return { lines: [], warnings: ['Nexus could not count the items this filter matches (a filter longer than a read takes, or Meta did not say): if it matches none, ads on the set stop.'] }
  const every = filter === '{}' || (count.catalogItems !== null && count.matching >= count.catalogItems)
  return {
    lines: [['Items in the set', count.itemsNow, count.matching]],
    warnings: [
      ...(count.matching === 0 ? ['No item matches: the set would be EMPTY, and ads on it stop delivering (Meta). Nothing spends more, but its ads stop.'] : []),
      ...(every ? [`It matches every item of the catalog (${count.catalogItems ?? count.matching}).`] : []),
    ],
  }
}

export function setCreateDraft(ask: SetAsk & { name: string; filter: string }, live: { catalogId: string; catalogName: string | null; count: CountNow | null; usesInternalLabel: boolean }): MetaChangeDraft {
  const catalog = `catalog ${quoted(live.catalogName)}(${live.catalogId})`
  const params: Record<string, string> = {
    name: ask.name, filter: ask.filter,
    ...(ask.retailerId ? { retailer_id: ask.retailerId } : {}),
    ...(ask.metadata && Object.keys(ask.metadata).length ? { metadata: JSON.stringify(ask.metadata) } : {}),
    ...(ask.shops?.length ? { publish_to_shops: JSON.stringify(ask.shops) } : {}),
  }
  const counted = countLines(ask.filter, live.count ? { ...live.count, itemsNow: null } : null)
  return draftOf({
    summary: `Make product set "${ask.name}" in ${catalog}`,
    ...linesOf([
      ['Product set', null, ask.name], ['Filter', null, filterInWords(ask.filter)], ...counted.lines,
      ...(ask.retailerId ? [['Retailer id of the set', null, ask.retailerId] as Line] : []),
      ...(params.metadata ? [['Shop collection text and images', null, params.metadata] as Line] : []),
      ...(ask.shops?.length ? [['Published to shops (as a collection)', null, ask.shops.map((s) => `${s.shop_id} #${s.ordering_index}`).join(', ')] as Line] : []),
    ]),
    warnings: [
      'A new set is used by no ad yet: nothing changes in any ad until one promotes it.',
      ...counted.warnings,
      ...(live.usesInternalLabel ? ['internal_label as a set filter field is on no Meta page: Meta may refuse it, or the set may match nothing (LIVE-PROBES CT-063b).'] : []),
      ...(params.metadata ? ['Collection text and images go through Meta\'s integrity review before a shop shows them.'] : []),
      'Meta refuses a set whose filter equals another set\'s of this catalog (10803): Nexus says so if it does.',
      NO_META_CHECK,
    ],
    requests: [request(1, `Make product set "${ask.name}" in ${catalog}`, live.catalogId, 'catalog', params, {
      operation: 'productset.create', edge: 'product_sets', undoable: false, expect: { name: ask.name }, readBackFields: 'id,name,filter,retailer_id,product_count,latest_metadata,product_catalog{id}', recordEvenIfNotAsAsked: true,
    })],
    stands: { catalogId: live.catalogId },
    before: { op: 'create', catalogId: live.catalogId, productSetId: null, set: null } satisfies ProductSetRecord,
    after: { op: 'create', catalogId: live.catalogId, productSetId: null, set: { name: ask.name, filter: ask.filter === '{}' ? '' : ask.filter, retailerId: ask.retailerId ?? null } } satisfies ProductSetRecord,
  })
}

/** CT-065 / CT-066 — a set's name, filter, retailer id, collection text, shops (also the undo of a change: `restore`). */
export function setChangeDraft(ask: SetAsk, live: { set: SetNow; count: CountNow | null; use: CatalogUse; usesInternalLabel: boolean }, why: 'asked' | 'undo' = 'asked'): MetaChangeDraft {
  const { set } = live
  const now = setFieldsOf(set)
  const params: Record<string, string> = {}
  const lines: Line[] = []
  const skipped: string[] = []
  const noUndo: string[] = []
  if (ask.name !== undefined) {
    if (ask.name === now.name) skipped.push(`The set is named "${ask.name}" already.`)
    else { params.name = ask.name; lines.push(['Name', now.name, ask.name]) }
  }
  if (ask.filter !== undefined) {
    const to = ask.filter === '{}' ? '' : ask.filter
    if (to === now.filter) skipped.push('The set has this filter already.')
    else { params.filter = ask.filter; lines.push(['Filter', filterInWords(now.filter), filterInWords(ask.filter)]) }
  }
  if (ask.retailerId !== undefined) {
    if (ask.retailerId === now.retailerId) skipped.push('The set has this retailer id already.')
    else {
      params.retailer_id = ask.retailerId; lines.push(['Retailer id of the set', now.retailerId, ask.retailerId])
      if (!now.retailerId) noUndo.push('The set had no retailer id before: Meta documents no way to clear one, so undo leaves it.')
    }
  }
  if (ask.metadata && Object.keys(ask.metadata).length) {
    params.metadata = JSON.stringify(ask.metadata); lines.push(['Shop collection text and images', set.metadata ? JSON.stringify(set.metadata) : null, params.metadata])
    if (!set.metadata) noUndo.push('The set had no collection text or images before: Meta documents no way to clear them, so undo leaves them.')
  }
  if (ask.shops?.length) {
    // Review B2 — only a list of shops (documented); `publish_to_shops=[]` (every shop) is not documented: never sent.
    const shops = ask.shops
    params.publish_to_shops = JSON.stringify(shops)
    lines.push(['Published to shops (as a collection)', 'as Meta has it (Nexus cannot read the list)', shops.map((s) => `${s.shop_id} #${s.ordering_index}`).join(', ')])
    noUndo.push('Nexus cannot read which shops the set was published to before: undo leaves the shops as this change set them.')
  }
  const counted = countLines(params.filter, live.count)
  const name = `product set ${quoted(set.name)}(${set.productSetId})`
  // A filter that grows the set (or that Nexus could not count) under something delivering now — or under what Nexus could
  // not see (review B1) — can make it spend more: an empty set that fills starts its ads again (PLAN: wider targeting).
  const grows = params.filter !== undefined && (!live.count || live.count.matching === null || live.count.itemsNow === null || live.count.matching > live.count.itemsNow)
  const spendsMoney = grows
    ? spendLine(live.use, 'this set', `${live.count && live.count.matching !== null && live.count.itemsNow !== null ? `from ${live.count.itemsNow} to ${live.count.matching} items` : 'with a filter Nexus could not count'}, ${live.count?.itemsNow === 0 ? 'the empty set fills and its ads start delivering again' : 'more items can make them spend more of their budgets'}`)
    : []
  const before: SetFields = now
  const after: SetFields = {
    name: params.name ?? now.name,
    filter: params.filter !== undefined ? (params.filter === '{}' ? '' : params.filter) : now.filter,
    retailerId: params.retailer_id ?? now.retailerId,
  }
  return draftOf({
    summary: why === 'undo' ? `Put ${name} back as it was` : `Change ${name}`,
    ...linesOf([...lines, ...counted.lines]),
    skipped,
    warnings: [
      ...(params.filter !== undefined ? ['It changes what every live catalog ad on this set shows, at once.'] : []),
      ...counted.warnings,
      ...(params.filter !== undefined || params.name !== undefined ? useWarnings(live.use, name) : []),
      ...(live.usesInternalLabel ? ['internal_label as a set filter field is on no Meta page: Meta may refuse it, or the set may match nothing (LIVE-PROBES CT-063b).'] : []),
      ...(params.metadata ? ['Collection text and images go through Meta\'s integrity review before a shop shows them.'] : []),
      ...(params.filter !== undefined ? ['Meta refuses a filter equal to another set\'s of this catalog (10803): Nexus says so if it does.'] : []),
      NO_META_CHECK,
    ],
    spendsMoney,
    requests: Object.keys(params).length ? [request(1, why === 'undo' ? `Put ${name} back` : `Change ${name}`, set.productSetId, 'productset', params, {
      operation: 'productset.update', undoable: true, raisesSpend: spendsMoney.length > 0, expect: params.name ? { name: params.name } : {}, readBackFields: 'id,name,filter,retailer_id,product_count,latest_metadata,product_catalog{id}',
    })] : [],
    stands: { productSetId: set.productSetId, catalogId: set.catalogId, before, uses: spendPremise(live.use), grows },
    before: { op: 'change', catalogId: set.catalogId, productSetId: set.productSetId, set: before, ...(params.metadata && set.metadata ? { metadata: set.metadata } : {}), ...(noUndo.length ? { noUndo } : {}) } satisfies ProductSetRecord,
    after: { op: 'change', catalogId: set.catalogId, productSetId: set.productSetId, set: after } satisfies ProductSetRecord,
  })
}

