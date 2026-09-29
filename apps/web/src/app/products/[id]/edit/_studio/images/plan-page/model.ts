import { applyMediaOps, knownSetRefs, resolveAxis, resolveSet, resolveSwatch, type MediaLayer, type MediaOp, type MediaPlan, type MediaPlanStack, type MediaSetRef } from '@nexus/shared/media-plan'
import { parseMediaFileName } from '@nexus/shared/media-plan-files'
import { aliasMarkGlyph } from '@/design-system/primitives'
import { AMAZON_SAFETY_SLOTS, AMAZON_SLOTS, MEDIA_LIMITS, duplicateListingChecks, pickVersion, projectMediaDestination, type ChannelMediaLayout, type MediaAsset, type MediaCheck, type MediaFamily } from '@nexus/shared/media-plan-channels'

/**
 * Images rebuild P3b — the Media page's view of one family's photo plan (docs/images-studio-rebuild/PLAN.md §5).
 *
 * The page reads `GET /products/:id/media` once, edits one layer at a time through `POST /media/ops`, and computes every
 * destination's layout and checks with the SAME shared functions the publishers use (`projectMediaDestination`), so an
 * edit shows its effect at once and what the page shows is what a publish sends. Pure: tested without a browser.
 */

export type MediaChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY'

export interface LibraryAsset {
  id: string; productId: string; url: string; alt: string | null; mediaType: string
  width: number | null; height: number | null; mimeType: string | null; fileSize: number | null
  languageTag: string; versionGroupId: string | null; label: string
  /** The same picture stored again (another SKU's copy, or the same bytes at another address): one card, these ids
   *  resolve to it (2026-09-28: the library showed one picture once per SKU). */
  copies?: string[]
  /** Other cards that look alike (closest first): the same picture at another address (W4a), or the same template with
   *  other text — likely language versions of one photo (W4b). */
  lookalikes?: Array<{ id: string; distance: number; kind?: 'same' | 'versions' }>
  /** Photos the Owner marked the same as this one (W4a); each can be separated again. */
  merged?: Array<{ id: string; label: string }>
}
export interface PlanLayer {
  key: string; layer: MediaLayer; channel: string; marketplace: string; accountId: string; aliasKey: string
  plan: MediaPlan; revision: number
}
export interface MediaDestinationRow {
  key: string; channel: MediaChannel; marketplace: string; markets: string[]; accountId: string; accountLabel: string | null
  accountActive: boolean; alias: { id: string; label: string; position: number } | null; languages: string[]; listed: number
  productIds: string[]; targetable: boolean; refusal: string | null; api?: 'TRADING' | 'INVENTORY'
  /** ★ ①②③ position (DS AliasMark) when the account and market hold more than one listing of the family; else null. */
  listingMark?: number | null
}
export interface MediaAxis { code: string; label: string; dictionary: boolean; values: Array<{ key: string; label: string }> }
export interface MediaRead {
  productId: string; rootId: string; sku: string; name: string | null; mainLanguage: string
  family: MediaFamily & { axes: MediaAxis[]; unmapped: string[] }
  library: LibraryAsset[]; layers: PlanLayer[]; destinations: MediaDestinationRow[]
  meta?: { tookMs: number }
}

/** Which layer the page edits: Shared, one channel's layer, or one destination's own layer. */
export type LayerView = { layer: 'SHARED' } | { layer: 'CHANNEL'; channel: MediaChannel } | { layer: 'LISTING'; destination: string }

export const CHANNEL_LABEL: Record<MediaChannel, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }

export function isSwitched(read: MediaRead) { return read.layers.some(l => l.layer === 'SHARED') }

const layerByKey = (read: MediaRead, key: string) => read.layers.find(l => l.key === key)?.plan ?? null

/** The layers one destination reads, top to bottom. */
export function destinationStack(read: MediaRead, d: Pick<MediaDestinationRow, 'channel' | 'key'>): MediaPlanStack {
  return { shared: layerByKey(read, 'SHARED'), channel: layerByKey(read, `CHANNEL:${d.channel}`), listing: layerByKey(read, d.key) }
}

/** The stack a layer view edits: its own layer and the layers above it. */
export function viewStack(read: MediaRead, view: LayerView): MediaPlanStack {
  if (view.layer === 'SHARED') return { shared: layerByKey(read, 'SHARED') }
  if (view.layer === 'CHANNEL') return { shared: layerByKey(read, 'SHARED'), channel: layerByKey(read, `CHANNEL:${view.channel}`) }
  const d = read.destinations.find(x => x.key === view.destination)
  return d ? destinationStack(read, d) : { shared: layerByKey(read, 'SHARED') }
}

export function viewKey(view: LayerView): string {
  if (view.layer === 'SHARED') return 'SHARED'
  if (view.layer === 'CHANNEL') return `CHANNEL:${view.channel}`
  return view.destination
}

/** The address `POST /media/ops` expects for a view. */
export function viewAddress(read: MediaRead, view: LayerView) {
  if (view.layer === 'SHARED') return { layer: 'SHARED' as const }
  if (view.layer === 'CHANNEL') return { layer: 'CHANNEL' as const, channel: view.channel }
  const d = read.destinations.find(x => x.key === view.destination)
  if (!d) throw new Error('This destination is not on the page any more. Reload the page.')
  return { layer: 'LISTING' as const, channel: d.channel, marketplace: d.marketplace, accountId: d.accountId, aliasKey: d.alias?.id ?? '' }
}

/** "eBay IT · Test eBay" and the listing's name ("① Winter", "Main listing"; none for Amazon and Shopify). */
export function destinationNameParts(d: MediaDestinationRow): { head: string; name: string | null } {
  const where = d.marketplace === 'GLOBAL' ? '' : ` ${d.marketplace}`
  return { head: `${CHANNEL_LABEL[d.channel]}${where} · ${d.accountLabel ?? 'Unknown account'}`,
    name: d.alias ? d.alias.label : d.channel === 'EBAY' || d.channel === 'ETSY' ? 'Main listing' : null }
}

/** The listing alone ("★ Main listing", "① Winter"), for text about listings on one account and market. */
export function listingName(d: MediaDestinationRow) {
  const { head, name } = destinationNameParts(d)
  return `${d.listingMark != null ? `${aliasMarkGlyph(d.listingMark)} ` : ''}${name ?? head}`
}

/** The destination as one line of text, with the listing's mark (★ ①②③) when its account and market hold several. */
export function destinationLabel(d: MediaDestinationRow) {
  const { head, name } = destinationNameParts(d)
  const mark = d.listingMark != null ? `${aliasMarkGlyph(d.listingMark)} ` : ''
  return name === null ? head : `${head} · ${mark}${name}`
}

// ── Sets ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SetRow {
  ref: MediaSetRef
  label: string
  kind: 'common' | 'value' | 'sku' | 'safety'
  items: string[]
  /** The layer whose copy the view shows; `null` = nobody set it yet. */
  source: MediaLayer | null
  /** Variants that use the set (value and SKU sets). */
  skus: string[]
}

/** The resolved picture axis of a view and its values in family order (values only a layer knows come last). */
export function viewAxis(read: MediaRead, stack: MediaPlanStack) {
  const { axis, source } = resolveAxis(stack, read.family.defaultAxis)
  const info = read.family.axes.find(a => a.code === axis) ?? null
  const known = new Set(knownSetRefs(stack).filter(r => r.startsWith(`value:${axis}:`)).map(r => r.slice(6)))
  const order = axis ? read.family.valueOrder[axis] ?? [] : []
  const values = [...order, ...[...known].filter(k => !order.includes(k))]
  return { axis, source, info, values }
}

export function valueLabel(read: MediaRead, key: string) { return read.family.valueLabels[key] ?? key.split(':').slice(1).join(':').replace(/^text:/, '') }

/** The rows of the photo plan as one view sees them: Common, one per value of the axis, safety, then per-SKU sets. */
export function setRows(read: MediaRead, view: LayerView, options: { skus?: boolean } = {}): SetRow[] {
  const stack = viewStack(read, view)
  const { axis, values } = viewAxis(read, stack)
  const variants = read.family.variants
  const row = (ref: MediaSetRef, label: string, kind: SetRow['kind'], skus: string[] = []): SetRow => ({ ref, label, kind, skus, ...resolveSet(stack, ref) })
  const rows: SetRow[] = [row('common', 'Common', 'common', variants.map(v => v.sku))]
  if (axis) for (const key of values) rows.push(row(`value:${key}`, valueLabel(read, key), 'value', variants.filter(v => v.values[axis] === key).map(v => v.sku)))
  rows.push(row('safety', 'Safety (Amazon PS01–PS06)', 'safety'))
  if (options.skus) for (const v of variants) rows.push(row(`sku:${v.productId}`, `SKU ${v.sku}`, 'sku', [v.sku]))
  return rows
}

/** Per-SKU sets any layer of the view owns — the fold says how many there are. */
export function ownedSkuSets(read: MediaRead, view: LayerView) {
  const stack = viewStack(read, view)
  return read.family.variants.filter(v => resolveSet(stack, `sku:${v.productId}`).source !== null).length
}

export function swatchRows(read: MediaRead, view: LayerView) {
  const stack = viewStack(read, view)
  const { axis, values } = viewAxis(read, stack)
  if (!axis) return []
  return values.map(key => ({ value: key, label: valueLabel(read, key), ...resolveSwatch(stack, key) }))
}

// ── The library ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Where each library photo is used on Shared: "Common · 2", "Nero · main". A version of a placed photo counts as used. */
/** Library card id of any stored copy of a picture (a plan may point at a copy). */
export function cardOf(read: MediaRead): (id: string) => string {
  const card = new Map(read.library.flatMap(a => [[a.id, a.id] as const, ...(a.copies ?? []).map(c => [c, a.id] as const)]))
  return id => card.get(id) ?? id
}

export function libraryUsage(read: MediaRead): Map<string, string[]> {
  const usage = new Map<string, string[]>()
  const card = cardOf(read)
  const groupOf = new Map(read.library.map(a => [a.id, a.versionGroupId]))
  const members = (id: string) => {
    const group = groupOf.get(id)
    return group ? read.library.filter(a => a.versionGroupId === group).map(a => a.id) : [id]
  }
  for (const row of setRows(read, { layer: 'SHARED' }, { skus: true })) {
    row.items.forEach((id, i) => {
      for (const member of members(card(id))) usage.set(member, [...(usage.get(member) ?? []), i === 0 ? `${row.label} · main` : `${row.label} · ${i + 1}`])
    })
  }
  const stack = viewStack(read, { layer: 'SHARED' })
  for (const s of swatchRows(read, { layer: 'SHARED' })) if (s.assetId && stack.shared) usage.set(card(s.assetId), [...(usage.get(card(s.assetId)) ?? []), `${s.label} · swatch`])
  return usage
}

export type LibraryFilter = 'all' | 'unused' | 'used' | 'problems' | 'text' | 'lookalikes'
/** The library filtered by what a person looks for; order stays the library's own. */
export function filterLibrary(read: MediaRead, usage: Map<string, string[]>, filter: LibraryFilter, search: string) {
  const text = search.trim().toLowerCase()
  return read.library.filter(a => {
    if (text && !`${a.label} ${a.alt ?? ''} ${a.languageTag}`.toLowerCase().includes(text)) return false
    if (filter === 'unused') return !usage.has(a.id)
    if (filter === 'used') return usage.has(a.id)
    if (filter === 'problems') return assetProblems(a).length > 0
    if (filter === 'text') return a.languageTag !== 'zxx'
    if (filter === 'lookalikes') return !!a.lookalikes?.length
    return true
  })
}

/**
 * Where a photo (any of its ids) sits in the family's layers — "Shared: Common", "eBay IT · Test eBay · ① Winter: Nero"
 * — which is what marking it the same as another photo changes (W4a).
 */
export function photoPlacements(read: MediaRead, ids: readonly string[]): string[] {
  const wanted = new Set(ids)
  const hit = (items?: Array<{ assetId: string }>) => !!items?.some(i => wanted.has(i.assetId))
  const value = (key: string) => read.family.valueLabels[key] ?? key
  const out: string[] = []
  for (const layer of read.layers) {
    const destination = read.destinations.find(d => d.key === layer.key)
    const where = layer.layer === 'SHARED' ? 'Shared' : layer.layer === 'CHANNEL' ? `All ${CHANNEL_LABEL[layer.channel as MediaChannel] ?? layer.channel} listings`
      : destination ? destinationLabel(destination) : 'One listing'
    const sets = layer.plan.sets
    if (hit(sets.common)) out.push(`${where}: Common`)
    for (const [key, items] of Object.entries(sets.values ?? {})) if (hit(items)) out.push(`${where}: ${value(key)}`)
    for (const [productId, items] of Object.entries(sets.skus ?? {})) if (hit(items)) out.push(`${where}: ${read.family.variants.find(v => v.productId === productId)?.sku ?? 'one SKU'}`)
    if (hit(sets.safety)) out.push(`${where}: Safety`)
    for (const [key, item] of Object.entries(sets.swatches ?? {})) if (item && wanted.has(item.assetId)) out.push(`${where}: ${value(key)} swatch`)
  }
  return out
}

/** The address a photo comes from, in words: an Amazon image or a Nexus upload (W4a: the two sides of a look-alike). */
export function photoSource(url: string): string {
  const host = (() => { try { return new URL(url).hostname } catch { return '' } })()
  return /(^|\.)media-amazon\.com$/.test(host) ? 'Amazon image' : /(^|\.)cloudinary\.com$/.test(host) ? 'Nexus upload' : host || 'Unknown address'
}

/** Which of two look-alikes to keep by default: a Nexus upload over an Amazon image, then the one in more sets, then the larger. */
export function defaultKeep(read: MediaRead, a: LibraryAsset, b: LibraryAsset): LibraryAsset {
  const amazon = (x: LibraryAsset) => photoSource(x.url) === 'Amazon image'
  if (amazon(a) !== amazon(b)) return amazon(a) ? b : a
  const uses = (x: LibraryAsset) => photoPlacements(read, [x.id, ...(x.copies ?? [])]).length
  if (uses(a) !== uses(b)) return uses(a) > uses(b) ? a : b
  const area = (x: LibraryAsset) => (x.width ?? 0) * (x.height ?? 0)
  return area(b) > area(a) ? b : a
}

/** The languages a photo version can have here: the destinations' languages, the main one, and any a photo already has. */
export function versionLanguages(read: MediaRead): string[] {
  const text = (tag: string) => tag !== 'zxx' && tag !== 'mul'
  return [...new Set([read.mainLanguage, ...read.destinations.flatMap(d => d.languages), ...read.library.map(a => a.languageTag)].filter(text))].sort()
}

/** A photo's language for the versions choice: its own, else one its name says ("size-chart-es"), else none yet. */
export function guessLanguage(a: LibraryAsset): string {
  if (a.languageTag !== 'zxx' && a.languageTag !== 'mul') return a.languageTag
  const named = parseMediaFileName(a.label, { values: [], skus: [] }).language
  return named === 'zxx' ? '' : named
}

/** The photo sets that show both photos — where joining them as versions keeps one (W4b). */
export function sharedPlacements(read: MediaRead, a: LibraryAsset, b: LibraryAsset): string[] {
  const inB = new Set(photoPlacements(read, [b.id, ...(b.copies ?? [])]))
  return photoPlacements(read, [a.id, ...(a.copies ?? [])]).filter(place => inB.has(place))
}

/** What is wrong with one photo on its own (size, address) — the page's `Tag`s. Channel rules live in the checks. */
export function assetProblems(a: LibraryAsset): string[] {
  const problems: string[] = []
  if (a.mediaType !== 'IMAGE') return problems
  if (a.width == null || a.height == null) problems.push('Size unknown')
  else if (Math.max(a.width, a.height) < 500) problems.push(`${Math.max(a.width, a.height)} px`)
  if (!/^https:\/\//i.test(a.url)) problems.push('Not HTTPS')
  return problems
}

export function languageName(tag: string) {
  if (tag === 'zxx') return 'No text'
  if (tag === 'mul') return 'Several languages'
  return tag.toUpperCase()
}

/** The language versions of one photo, placed version first. */
export function versionsOf(read: MediaRead, id: string) {
  const a = read.library.find(x => x.id === id)
  if (!a?.versionGroupId) return a ? [a] : []
  return read.library.filter(x => x.versionGroupId === a.versionGroupId)
}

// ── Destinations ────────────────────────────────────────────────────────────────────────────────────────────────

export function assetMap(read: MediaRead): Map<string, MediaAsset> {
  // A copy's id resolves to its card's picture, so a plan that points at a copy shows and sends the same photo.
  return new Map(read.library.flatMap(a => [a.id, ...(a.copies ?? [])].map(id => [id, { id, url: a.url, mediaType: a.mediaType, width: a.width, height: a.height, mimeType: a.mimeType,
    fileSize: a.fileSize, languageTag: a.languageTag, versionGroupId: a.versionGroupId, label: a.label }] as const)))
}

/**
 * Every targetable destination's layout, computed by the shared projection (what a publish would send), plus the
 * warning for eBay listings on one account and market that would show the same photos (PLAN.md §4.5).
 */
export function computeLayouts(read: MediaRead): Record<string, ChannelMediaLayout> {
  const assets = assetMap(read)
  const targets = read.destinations.filter(d => d.targetable)
  const layouts: Record<string, ChannelMediaLayout> = Object.fromEntries(targets.map(d => [d.key,
    projectMediaDestination({ stack: destinationStack(read, d), family: read.family, axes: read.family.axes, assets, target: d, mainLanguage: read.mainLanguage })]))
  const duplicates = duplicateListingChecks(targets.map(d => ({ ...d, name: listingName(d) })), layouts, id => assets.get(id)?.url ?? id)
  for (const [key, checks] of duplicates) layouts[key] = { ...layouts[key], checks: [...layouts[key].checks, ...checks] }
  return layouts
}

export interface SetCell { ref: MediaSetRef; label: string; count: number; source: 'shared' | 'channel' | 'own' | 'none' }
/** Per set of the destination's own axis: where its photos come from and how many there are. */
export function destinationCells(read: MediaRead, d: MediaDestinationRow): SetCell[] {
  const stack = destinationStack(read, d)
  return setRows(read, { layer: 'LISTING', destination: d.key }).filter(r => r.kind !== 'safety' || d.channel === 'AMAZON').map(r => {
    const resolved = resolveSet(stack, r.ref)
    const source = resolved.source === 'LISTING' ? 'own' : resolved.source === 'CHANNEL' ? 'channel' : resolved.source === 'SHARED' ? 'shared' : 'none'
    return { ref: r.ref, label: r.kind === 'safety' ? 'Safety' : r.label, count: resolved.items.length, source }
  })
}

// ── Compare (P4) ────────────────────────────────────────────────────────────────────────────────────────────────

/** One destination's copy of one set, against the first chosen destination (the reference). */
export interface CompareCell {
  key: string
  /** The channel uses this set (Safety is Amazon's; per-SKU photos are Amazon's and Shopify's). */
  applies: boolean
  source: SetCell['source']
  items: string[]
  /** Photos this destination has and the reference does not (its own ids), and the reference's photos it lacks (the
   *  reference's ids) — by photo, not by language version (a photo's versions count as one photo, D6). */
  added: string[]
  missing: string[]
  /** Same photos as the reference, in a different order. */
  reordered: boolean
  same: boolean
}
export interface CompareRow { ref: MediaSetRef; label: string; kind: SetRow['kind']; same: boolean; cells: CompareCell[] }

const SKU_CHANNELS: ReadonlySet<MediaChannel> = new Set(['AMAZON', 'SHOPIFY'])

/**
 * Images rebuild P4 — Compare (PLAN.md §4.3): the chosen destinations' sets side by side. Each set is one row; each
 * destination's cell says where its photos come from and how it differs from the first chosen destination. Per-SKU
 * sets appear only when a chosen destination has one. Pure: the page and the tests call it the same way.
 */
export function compareDestinations(read: MediaRead, keys: readonly string[]): CompareRow[] {
  const chosen = keys.map(k => read.destinations.find(d => d.key === k)).filter((d): d is MediaDestinationRow => !!d?.targetable)
  if (!chosen.length) return []
  // One photo: any stored copy of a picture (its library card), and its language versions.
  const card = cardOf(read)
  const group = new Map(read.library.map(a => [a.id, a.versionGroupId ?? a.id]))
  const photo = (id: string) => group.get(card(id)) ?? card(id)
  const perDestination = chosen.map(d => new Map(setRows(read, { layer: 'LISTING', destination: d.key }, { skus: true }).map(r => [r.ref, r])))
  const order: SetRow[] = []
  for (const rows of perDestination) for (const row of rows.values()) if (!order.some(r => r.ref === row.ref)) order.push(row)
  const applies = (d: MediaDestinationRow, row: SetRow) => row.kind === 'safety' ? d.channel === 'AMAZON' : row.kind === 'sku' ? SKU_CHANNELS.has(d.channel) : true
  const result: CompareRow[] = []
  for (const head of order) {
    const cells = chosen.map((d, i): CompareCell => {
      const row = perDestination[i].get(head.ref)
      const source: SetCell['source'] = !row?.source ? 'none' : row.source === 'LISTING' ? 'own' : row.source === 'CHANNEL' ? 'channel' : 'shared'
      return { key: d.key, applies: !!row && applies(d, row), source, items: row?.items ?? [], added: [], missing: [], reordered: false, same: true }
    })
    const used = cells.filter(c => c.applies)
    // A per-SKU row shows only when some chosen destination that uses SKU photos has that SKU's own set.
    if (head.kind === 'sku' && !used.some(c => c.source !== 'none')) continue
    if (!used.length) continue
    const reference = used[0].items.map(photo)
    for (const cell of used) {
      const mine = cell.items.map(photo)
      cell.added = cell.items.filter(id => !reference.includes(photo(id)))
      cell.missing = used[0].items.filter(id => !mine.includes(photo(id)))
      cell.reordered = !cell.added.length && !cell.missing.length && mine.join('|') !== reference.join('|')
      cell.same = !cell.added.length && !cell.missing.length && !cell.reordered
    }
    result.push({ ref: head.ref, label: head.kind === 'safety' ? 'Safety' : head.label, kind: head.kind, same: used.every(c => c.same), cells })
  }
  return result
}

export function checkCounts(checks: readonly MediaCheck[]) {
  const unique = [...new Map(checks.map(c => [`${c.severity}|${c.message}`, c])).values()]
  return { errors: unique.filter(c => c.severity === 'error'), warnings: unique.filter(c => c.severity === 'warning') }
}

/** One line on what a destination would receive. */
export function layoutSummary(channel: MediaChannel, layout: ChannelMediaLayout): string {
  if (channel === 'EBAY' && 'gallery' in layout) return `Gallery ${layout.gallery.length}${layout.sets.length ? ` · ${layout.sets.length} ${layout.axisName ?? 'value'} set${layout.sets.length > 1 ? 's' : ''}` : ''}`
  if (channel === 'AMAZON' && 'items' in layout) return `${layout.items.length} SKU${layout.items.length === 1 ? '' : 's'} · up to ${Math.max(0, ...layout.items.map(i => Object.keys(i.slots).length))} slots${layout.safety.length ? ` · ${layout.safety.length} safety` : ''}`
  if (channel === 'SHOPIFY' && 'media' in layout) return `${layout.media.length} media · ${Object.values(layout.variantImages).filter(Boolean).length} variant images`
  if ('images' in layout) return `${layout.images.length} photos · ${layout.variationImages.length} option photos`
  return ''
}

// ── Local edits ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The same "one photo" rule the server applies: language versions of one photo count once. */
export function sameGroupOf(read: MediaRead) {
  const card = cardOf(read)
  const group = new Map(read.library.map(a => [a.id, a.versionGroupId]))
  return (a: string, b: string) => card(a) === card(b) || (!!group.get(card(a)) && group.get(card(a)) === group.get(card(b)))
}

/** Apply ops to one layer locally (the page moves at once; the server's answer then replaces it). Throws the same
 *  refusal the server would. */
export function applyLocal(read: MediaRead, view: LayerView, ops: readonly MediaOp[]): MediaRead {
  const layer: MediaLayer = view.layer
  const next = applyMediaOps(viewStack(read, view), layer, ops, sameGroupOf(read))
  return withLayer(read, view, next, null)
}

/** Replace (or remove, `plan: null`) one layer's plan. `revision: null` keeps the known revision. */
export function withLayer(read: MediaRead, view: LayerView, plan: MediaPlan | null, revision: number | null): MediaRead {
  const key = viewKey(view)
  const old = read.layers.find(l => l.key === key)
  const rest = read.layers.filter(l => l.key !== key)
  const empty = plan && view.layer !== 'SHARED' && !Object.keys(plan.sets).length && plan.axis === undefined
  if (!plan || empty) return { ...read, layers: rest }
  const address = viewAddress(read, view)
  const row: PlanLayer = old ? { ...old, plan, revision: revision ?? old.revision }
    : { key, layer: view.layer, channel: 'channel' in address ? address.channel ?? '' : '', marketplace: 'marketplace' in address ? address.marketplace ?? '' : '',
      accountId: 'accountId' in address ? address.accountId ?? '' : '', aliasKey: 'aliasKey' in address ? address.aliasKey ?? '' : '', plan, revision: revision ?? 0 }
  return { ...read, layers: [...rest, row] }
}

/** "Copy photos from" another destination: this destination's layer gets exactly the other one's resolved sets. */
export function copyFromOps(read: MediaRead, from: MediaDestinationRow, to: MediaDestinationRow): MediaOp[] {
  const source = destinationStack(read, from)
  const target = destinationStack(read, to)
  const refs = new Set<MediaSetRef>([...knownSetRefs(source), ...knownSetRefs(target)])
  const ops: MediaOp[] = []
  for (const ref of refs) {
    const s = resolveSet(source, ref), t = resolveSet(target, ref)
    if (JSON.stringify(s.items) === JSON.stringify(t.items)) continue
    // Same channel and the source only follows: following again gives the target the very same photos, and keeps following.
    if (from.channel === to.channel && s.source !== 'LISTING' && t.source === 'LISTING') ops.push({ op: 'follow', set: ref })
    else ops.push({ op: 'replace', set: ref, assetIds: s.items })
  }
  const axis = resolveAxis(source, read.family.defaultAxis).axis
  if (axis !== resolveAxis(target, read.family.defaultAxis).axis) ops.push({ op: 'axis', axis })
  return ops
}

/** "Follow … for all sets": drop every set, the axis and the swatches this layer owns. */
export function followAllOps(read: MediaRead, view: LayerView): MediaOp[] {
  if (view.layer === 'SHARED') return []
  const own = read.layers.find(l => l.key === viewKey(view))?.plan
  if (!own) return []
  const refs = knownSetRefs({ shared: own }).filter(ref => resolveSet({ shared: own }, ref).source !== null)
  return [
    ...refs.map(ref => ({ op: 'follow' as const, set: ref })),
    ...(own.axis !== undefined ? [{ op: 'axis' as const, axis: undefined }] : []),
    ...Object.keys(own.sets.swatches ?? {}).map(value => ({ op: 'swatch' as const, value, assetId: undefined })),
  ]
}

/** The version of each placed photo a market's languages see (D6), or the placed one (`languages: null`). */
export function shownVersion(read: MediaRead, assets: Map<string, MediaAsset>, id: string, languages: readonly string[] | null) {
  if (!languages) return { id, exact: true, language: read.library.find(a => a.id === id)?.languageTag ?? 'zxx' }
  const picked = pickVersion(id, assets, languages, read.mainLanguage)
  return picked ? { id: picked.assetId, exact: picked.exact, language: picked.language } : { id, exact: true, language: 'zxx' }
}

// ── The photo grid (2026-09-29 redesign) ───────────────────────────────────────────────────────────────────────

/** Amazon's slot names; the grid's columns everywhere but eBay, whose listing has no named slots. */
export const GRID_SLOTS = [...AMAZON_SLOTS]
// eBay's photos have no slot names: MAIN, then numbers. Nine show at first, as on Amazon; more appear as photos are added.
const EBAY_SLOTS = ['MAIN', ...Array.from({ length: 8 }, (_, i) => String(i + 2))]

/** The slot a position of a set gets its name from: MAIN, PT01…PT08, then 10, 11…; safety PS01–PS06. */
export function slotLabel(kind: SetRow['kind'], index: number): string {
  if (kind === 'safety') return AMAZON_SAFETY_SLOTS[index] ?? String(index + 1)
  return GRID_SLOTS[index] ?? String(index + 1)
}

/** The grid's columns and each row's size for one channel (null = Shared): how many photos the channel takes. */
export function gridShape(channel: MediaChannel | null) {
  const columns = channel === 'EBAY' ? EBAY_SLOTS : GRID_SLOTS
  const capacity = (kind: SetRow['kind']) => kind === 'safety' ? MEDIA_LIMITS.AMAZON.safety
    : channel === 'AMAZON' ? AMAZON_SLOTS.length
    : channel === 'EBAY' ? (kind === 'common' ? MEDIA_LIMITS.EBAY.gallery : MEDIA_LIMITS.EBAY.perValue)
    : channel === 'ETSY' ? MEDIA_LIMITS.ETSY.images
    : MEDIA_LIMITS.EBAY.gallery
  const slots = (kind: SetRow['kind']) => kind === 'safety' ? [...AMAZON_SAFETY_SLOTS] : undefined
  return { columns, capacity, slots }
}

/**
 * The destination the studio's scope selector points at (channel, market, account, listing), or null on the Shared
 * product. Amazon, Shopify and Etsy keep one photo set per account for every market; eBay one per market and listing.
 */
export function scopeDestinationKey(scope: { channel: string; marketplace: string; accountId: string; aliasKey: string | null } | null): string | null {
  if (!scope) return null
  const global = scope.channel === 'AMAZON' || scope.channel === 'SHOPIFY' || scope.channel === 'ETSY'
  return `LISTING:${scope.channel}:${global ? 'GLOBAL' : scope.marketplace}:${scope.accountId}:${scope.channel === 'AMAZON' ? '' : scope.aliasKey ?? ''}`
}

/** The listings one destination shares its account and market with (its aliases), main listing first. */
export function siblingListings(read: MediaRead, d: MediaDestinationRow): MediaDestinationRow[] {
  return read.destinations.filter(x => x.channel === d.channel && x.marketplace === d.marketplace && x.accountId === d.accountId)
    .sort((a, b) => (a.alias?.position ?? 0) - (b.alias?.position ?? 0))
}

/** Who owns a row's photos when it is not Shared, in words for the row's mark ("Own for eBay IT", "Own for ① Winter"). */
export function ownerLabel(read: MediaRead, row: Pick<SetRow, 'source'>, d: MediaDestinationRow): string | null {
  if (row.source === 'CHANNEL') return `Own for all ${CHANNEL_LABEL[d.channel]} listings`
  if (row.source !== 'LISTING') return null
  if (d.alias || siblingListings(read, d).length > 1) return `Own for ${listingName(d)}`
  return `Own for ${CHANNEL_LABEL[d.channel]}${d.marketplace === 'GLOBAL' ? '' : ` ${d.marketplace}`}`
}

/** Storage codes and bare slot codes say nothing to a person ("vija9w5xgwhyw…", "PT02"). */
export function isCodeName(label: string): boolean {
  // "vija9w5xgwhywk2ld7hq.jpg" (a storage id), "81Kp1xYzA7L._AC_SL1500_.jpg" (an Amazon image id), "PT02" (a slot).
  const base = label.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\._[A-Z0-9_,]+_$/, '').trim()
  return /^(MAIN|PT\d{2}|PS\d{2}|SWCH)$/i.test(base)
    || (/^[a-z0-9]{16,}$/.test(base) && /\d/.test(base) && /[a-z]/.test(base))
    || (/^[0-9A-Za-z+%-]{9,13}L$/.test(base) && /\d/.test(base) && /[A-Z]/.test(base.slice(0, -1)))
}

/**
 * Readable names for photos named by a storage code (Owner, 2026-09-29: "random file names instead of readable ones"):
 * where the photo sits — Shared first, then any other layer — as "Nero MAIN", "Common PT01", "Safety PS01",
 * "Giallo swatch"; a language version adds its language ("Size chart PT02 · DE"); a photo in no set is "Unused photo 1".
 * A real name stays. Nothing is renamed on the server.
 */
export function readableNames(read: MediaRead): Map<string, string> {
  const card = cardOf(read)
  const place = new Map<string, string>()
  const note = (id: string, where: string) => { const c = card(id); if (!place.has(c)) place.set(c, where) }
  for (const row of setRows(read, { layer: 'SHARED' }, { skus: true })) row.items.forEach((id, i) => note(id, `${row.kind === 'safety' ? 'Safety' : row.label} ${slotLabel(row.kind, i)}`))
  for (const s of swatchRows(read, { layer: 'SHARED' })) if (s.assetId) note(s.assetId, `${s.label} swatch`)
  for (const layer of read.layers) {
    if (layer.layer === 'SHARED') continue
    const sets = layer.plan.sets
    sets.common?.forEach((item, i) => note(item.assetId, `Common ${slotLabel('common', i)}`))
    for (const [key, items] of Object.entries(sets.values ?? {})) items.forEach((item, i) => note(item.assetId, `${valueLabel(read, key)} ${slotLabel('value', i)}`))
    sets.safety?.forEach((item, i) => note(item.assetId, `Safety ${slotLabel('safety', i)}`))
  }
  const names = new Map<string, string>()
  const taken = new Map<string, number>()
  let unused = 0
  for (const a of read.library) {
    if (!isCodeName(a.label)) { names.set(a.id, a.label); continue }
    const group = a.versionGroupId ? read.library.filter(x => x.versionGroupId === a.versionGroupId) : [a]
    const where = place.get(a.id) ?? group.map(m => place.get(m.id)).find(Boolean)
    const language = group.length > 1 && a.languageTag !== 'zxx' && a.languageTag !== 'mul' ? ` · ${a.languageTag.toUpperCase()}` : ''
    const name = where ? `${where}${language}` : `Unused photo ${++unused}`
    const n = (taken.get(name) ?? 0) + 1
    taken.set(name, n)
    names.set(a.id, n > 1 ? `${name} (${n})` : name)
  }
  return names
}

/** The read with readable photo names: every part of the page (tiles, library, windows, messages) shows them. */
export function withReadableNames(read: MediaRead): MediaRead {
  const names = readableNames(read)
  return { ...read, library: read.library.map(a => ({ ...a, label: names.get(a.id) ?? a.label })) }
}
