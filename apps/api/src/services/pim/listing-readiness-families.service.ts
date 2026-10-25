/**
 * Listing readiness — the family view (rebuild 2026-10-23, docs/listings/READINESS-REBUILD-2026-10-23.md, layout A).
 *
 * Reads the materialized `ReadinessIndex` only (never a live resolve). One top-level row per family root
 * (`parentId ?? id`); a "listing" is one product on one destination, its languages folded into one verdict (worst wins).
 * Two passes keep a business of ~11,300 index rows fast: LIGHT columns of every filtered row (tiles, order, paging), then
 * the problems (`missing[]`) of the requested page only, aggregated in SQL so no page moves the JSON of every row.
 * Filters are `listingReadinessWhere()` (the same as Translate); the state filter applies after the language fold.
 */
import { Prisma } from '@prisma/client'
import type {
  ReadinessChip, ReadinessDestination, ReadinessDetail, ReadinessFamiliesPage, ReadinessFamilyRow, ReadinessMemberRow,
  ReadinessMembersPage, ReadinessNextStep, ReadinessProblem, ReadinessProblemKind, ReadinessScopeState, ReadinessStateCounts,
  ReadinessStateFilter,
} from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { inDatabaseReadTransaction } from '../../lib/database-context.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { listingReadinessWhere, readinessProblemKind, readinessQuery } from './listing-readiness.service.js'
import { SCOPE_STATES, scopeStateRank } from './readiness-model.js'

/* ── query ────────────────────────────────────────────────────────────────────────────────── */

const PAGE_SIZES = ['50', '100', '200']
const STATE_FILTERS: readonly string[] = [...SCOPE_STATES, 'notChecked']
const text = (value: unknown, name: string, max = 200) => {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${name}`)
  return value.trim() || undefined
}
const count = (value: unknown, fallback: number, min: number, max: number, message: string) => {
  if (value === undefined || value === '') return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(message)
  return Number(value)
}

/** Everything `readinessQuery` accepts (its `state` aside), plus the search, the state tile and the page size. */
export function familiesQuery(query: Record<string, unknown>) {
  const base = readinessQuery({ ...query, state: undefined })
  const q = text(query.q, 'search')
  const state = text(query.state, 'state')
  if (state && !STATE_FILTERS.includes(state)) throw new Error('Select a readiness state')
  if (query.pageSize !== undefined && query.pageSize !== '' && !PAGE_SIZES.includes(query.pageSize as string)) throw new Error('Show 50, 100 or 200 rows per page')
  return { ...base, q, state: state as ReadinessStateFilter | undefined, pageSize: Number(query.pageSize || 50) }
}
export function membersQuery(rootId: unknown, query: Record<string, unknown>) {
  const root = text(rootId, 'product')
  if (!root) throw new Error('Select a product family')
  return { ...familiesQuery(query), rootId: root,
    limit: count(query.limit, 10, 1, 200, 'Show 1–200 variations'), offset: count(query.offset, 0, 0, 100_000, 'Use a valid offset') }
}
export function detailQuery(query: Record<string, unknown>) {
  const productId = text(query.productId, 'product')
  if (!productId) throw new Error('Select a product')
  if (query.family !== undefined && query.family !== '' && query.family !== '0' && query.family !== '1') throw new Error('family must be 1 or 0')
  const raw = text(query.destination, 'destination', 1000)
  let parsed: unknown
  try { parsed = raw ? JSON.parse(raw) : undefined } catch { parsed = undefined }
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some(v => v !== null && (typeof v !== 'string' || !v || v.length > 200))) throw new Error('Select a destination')
  const [channel, market, accountId, aliasId] = parsed as Array<string | null>
  return { ...familiesQuery(query), productId, family: query.family === '1', destination: { key: JSON.stringify(parsed), channel, market, accountId, aliasId } }
}

/* ── the model: fold, families, fill ──────────────────────────────────────────────────────── */

export interface LightRow {
  id: string; productId: string; coordinateKey: string
  channel: string | null; market: string | null; accountId: string | null; aliasId: string | null
  language: string; label: string; state: string; computedAt: Date; pendingSince: Date | null
}
const LIGHT = { id: true, productId: true, coordinateKey: true, channel: true, market: true, accountId: true, aliasId: true,
  language: true, label: true, state: true, computedAt: true, pendingSince: true } satisfies Prisma.ReadinessIndexSelect

/** One product on one destination, its languages folded (worst wins). */
export interface FoldedListing {
  productId: string
  destinationKey: string
  state: ReadinessScopeState
  /** The language whose row decided `state`; null for a filled listing. */
  language: string | null
  /** The row that decided `state` (its note explains a problem-less verdict); null for a filled listing. */
  worstRowId: string | null
  rowIds: string[]
  computedAt: Date | null
  pending: boolean
  /** No index row: a sibling has this destination, this product was not checked there yet. */
  filled?: true
}
export interface DestinationInfo { key: string; channel: string | null; market: string | null; accountId: string | null; aliasId: string | null; label: string; languages: Set<string> }
/** productId → destinationKey → listing. */
export type FamilyListings = Map<string, Map<string, FoldedListing>>

/** A stored state outside the vocabulary is not a verdict: read it as not computed. */
const stateOf = (state: string): ReadinessScopeState => (SCOPE_STATES as readonly string[]).includes(state) ? state as ReadinessScopeState : 'notComputed'
const worse = (a: ReadinessScopeState, b: ReadinessScopeState) => scopeStateRank(a) <= scopeStateRank(b) ? a : b

/** Fold languages per (product, destination): the worst state, the oldest check, pending when any row is. */
export function foldListings(rows: readonly LightRow[]): Map<string, FoldedListing> {
  const out = new Map<string, FoldedListing>()
  for (const row of rows) {
    const key = `${row.productId}\u0000${row.coordinateKey}`, state = stateOf(row.state)
    const current = out.get(key)
    if (!current) {
      out.set(key, { productId: row.productId, destinationKey: row.coordinateKey, state, language: row.language, worstRowId: row.id, rowIds: [row.id],
        computedAt: row.computedAt, pending: !!row.pendingSince })
      continue
    }
    current.rowIds.push(row.id)
    const rank = scopeStateRank(state) - scopeStateRank(current.state)
    // Ties keep the smaller language code, so the verdict's language never depends on row order.
    if (rank < 0 || (rank === 0 && row.language < current.language!)) Object.assign(current, { state, language: row.language, worstRowId: row.id })
    if (row.computedAt < current.computedAt!) current.computedAt = row.computedAt
    if (row.pendingSince) current.pending = true
  }
  return out
}

/** Every destination in the rows, with its first index label and the languages seen there. */
export function destinationInfos(rows: readonly LightRow[]): Map<string, DestinationInfo> {
  const out = new Map<string, DestinationInfo>()
  for (const row of rows) {
    let info = out.get(row.coordinateKey)
    if (!info) out.set(row.coordinateKey, info = { key: row.coordinateKey, channel: row.channel, market: row.market, accountId: row.accountId, aliasId: row.aliasId, label: row.label, languages: new Set() })
    info.languages.add(row.language)
  }
  return out
}

/** Group listings by family root (`parentId ?? id`). */
export function familiesOf(listings: Iterable<FoldedListing>, parentOf: (productId: string) => string | null | undefined): Map<string, FamilyListings> {
  const out = new Map<string, FamilyListings>()
  for (const listing of listings) {
    const root = parentOf(listing.productId) ?? listing.productId
    let family = out.get(root)
    if (!family) out.set(root, family = new Map())
    let member = family.get(listing.productId)
    if (!member) family.set(listing.productId, member = new Map())
    member.set(listing.destinationKey, listing)
  }
  return out
}

/**
 * A member that lacks a destination another member of its family has was not checked there yet: an honest
 * `notComputed` listing, never silence (R-LX-9 — absent is not empty). Mutates and returns the family.
 */
export function fillNotComputed(family: FamilyListings): FamilyListings {
  const keys = new Set<string>()
  for (const member of family.values()) for (const key of member.keys()) keys.add(key)
  for (const [productId, member] of family) {
    for (const key of keys) {
      if (!member.has(key)) member.set(key, { productId, destinationKey: key, state: 'notComputed', language: null, worstRowId: null, rowIds: [], computedAt: null, pending: false, filled: true })
    }
  }
  return family
}

export const emptyCounts = (): ReadinessStateCounts => ({ blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 0 })
export function countStates(listings: Iterable<{ state: ReadinessScopeState }>): ReadinessStateCounts {
  const counts = emptyCounts()
  for (const listing of listings) counts[listing.state]++
  return counts
}
export const matchesState = (state: ReadinessScopeState, filter: ReadinessStateFilter | undefined) =>
  !filter || (filter === 'notChecked' ? state === 'absent' || state === 'notComputed' : state === filter)

/* ── destinations: order and words ────────────────────────────────────────────────────────── */

const CHANNEL_ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']
const CHANNEL_NAMES: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' }
export const channelName = (channel: string) => CHANNEL_NAMES[channel]
  ?? channel.toLowerCase().split(/[_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ')

/** An alias row's index label is `<destination label> · <alias label>` (readiness-index.service.ts). */
export function aliasNameOf(label: string, baseLabel: string | undefined, aliasId: string): string {
  if (baseLabel && label.startsWith(`${baseLabel} · `)) return label.slice(baseLabel.length + 3)
  const at = label.lastIndexOf(' · ')
  return at >= 0 ? label.slice(at + 3) : aliasId
}

interface NamedDestination extends ReadinessDestination { storeName: string | null; aliasName: string | null }
const channelRank = (channel: string) => { const at = CHANNEL_ORDER.indexOf(channel); return at < 0 ? CHANNEL_ORDER.length : at }
/** Shared first; then Amazon, eBay, Shopify, Etsy, the rest A–Z; then market A–Z; then store; then alias (main listing first). */
export function compareDestinations(a: NamedDestination, b: NamedDestination): number {
  const shared = Number(b.channel === 'SHARED') - Number(a.channel === 'SHARED')
  if (shared) return shared
  return channelRank(a.channel) - channelRank(b.channel) || cmp(a.channel, b.channel) || cmp(a.marketplace, b.marketplace)
    || cmp(a.storeName ?? a.accountId ?? '', b.storeName ?? b.accountId ?? '') || cmp(a.accountId ?? '', b.accountId ?? '')
    || Number(!!a.aliasKey) - Number(!!b.aliasKey) || cmp(a.aliasName ?? '', b.aliasName ?? '') || cmp(a.aliasKey, b.aliasKey) || cmp(a.key, b.key)
}
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

type StoreKey = { channel: string | null; market: string | null; accountId: string | null }
/** channel + market → the stores (accounts) seen there. */
function storesByMarket(entries: Iterable<StoreKey>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const entry of entries) if (entry.channel) {
    const key = `${entry.channel}\u0000${entry.market ?? ''}`
    if (!out.has(key)) out.set(key, new Set())
    out.get(key)!.add(entry.accountId ?? '')
  }
  return out
}

/**
 * The chips' destinations in order, with their words: "Shared"; else the channel name, the market (none for GLOBAL),
 * ` · <alias>` for an alias, and ` · <store>` only when two or more stores share that channel and market in the result
 * (`otherStores`: stores the result has on a market beyond the destinations described, as in the Fix window).
 */
export function describeDestinations(infos: Iterable<DestinationInfo>, storeNames: ReadonlyMap<string, string> = new Map(), otherStores: Iterable<StoreKey> = []): ReadinessDestination[] {
  const all = [...infos]
  const stores = storesByMarket([...all, ...otherStores])
  const baseLabels = new Map<string, string>()
  for (const info of all) if (info.channel && !info.aliasId) baseLabels.set(`${info.channel}\u0000${info.market ?? ''}\u0000${info.accountId ?? ''}`, info.label)
  const named = all.map((info): NamedDestination => {
    if (!info.channel) return { key: info.key, channel: 'SHARED', marketplace: '', accountId: null, aliasKey: '', label: 'Shared', storeName: null, aliasName: null }
    const market = `${info.channel}\u0000${info.market ?? ''}`
    const storeName = info.accountId ? storeNames.get(info.accountId) ?? `Store …${info.accountId.slice(-6)}` : null
    const aliasName = info.aliasId ? aliasNameOf(info.label, baseLabels.get(`${market}\u0000${info.accountId ?? ''}`), info.aliasId) : null
    const where = info.market && info.market !== 'GLOBAL' ? ` ${info.market}` : ''
    const label = `${channelName(info.channel)}${where}${aliasName ? ` · ${aliasName}` : ''}${storeName && stores.get(market)!.size > 1 ? ` · ${storeName}` : ''}`
    return { key: info.key, channel: info.channel, marketplace: info.market ?? '', accountId: info.accountId, aliasKey: info.aliasId ?? '', label, storeName, aliasName }
  })
  return named.sort(compareDestinations).map(({ storeName: _store, aliasName: _alias, ...destination }) => destination)
}

/** Stores named only where the words need them: two or more accounts on one channel and market. */
async function storeNamesFor(entries: Iterable<StoreKey>): Promise<Map<string, string>> {
  const ids = [...storesByMarket(entries).values()].filter(set => set.size > 1).flatMap(set => [...set]).filter(Boolean)
  if (!ids.length) return new Map()
  const connections = await prisma.channelConnection.findMany({ where: { id: { in: ids } }, select: { id: true, accountLabel: true, displayName: true } })
  return new Map(connections.filter(c => c.accountLabel || c.displayName).map(c => [c.id, (c.accountLabel || c.displayName)!]))
}

/* ── links (the studio's own record link; the web adds the business prefix) ───────────────── */

export interface Coordinate { channel: string | null; market: string | null; accountId: string | null; aliasId: string | null }
/**
 * The studio for one product at one destination and language. With a field it is the exact-field link the old page's
 * `issueFieldHref()` built on the web (`studioFieldHref` + `studioRowId`): `tab` dropped, `rec=<alias or primary>:<id>`
 * on a channel (the product id on Shared) and `cell=<field>`. Without one it opens the errors tab, as `editorHref` did.
 */
export function studioHref(productId: string, at: Coordinate, locale: string, field?: string | null): string {
  const params = new URLSearchParams({ scope: at.channel ?? 'master', locale })
  if (!field) params.set('tab', 'errors')
  if (at.market) params.set('market', at.market)
  if (at.accountId) params.set('account', at.accountId)
  if (at.aliasId) params.set('alias', at.aliasId)
  if (field) {
    params.set('rec', at.channel ? `${at.aliasId ?? 'primary'}:${productId}` : productId)
    params.set('cell', field)
  }
  return `/products/${encodeURIComponent(productId)}/edit/studio?${params}`
}
const productHref = (productId: string) => `/products/${encodeURIComponent(productId)}/edit/studio`

/* ── problems ─────────────────────────────────────────────────────────────────────────────── */

const KIND_ORDER: readonly ReadinessProblemKind[] = ['required', 'translation', 'setup', 'rule', 'check']
export const kindRank = (kind: ReadinessProblemKind) => KIND_ORDER.indexOf(kind)

/** One field's problem on one destination of one row (family or product), over its listings and languages. */
export interface ProblemSummary { destinationKey: string; field: string; label: string; kind: ReadinessProblemKind; message: string; affected: number; productId: string; locale: string }
/** A row of `problemAggregates`' SQL: a field × (kind, requiredEmpty) group, or (`level` 1) the field's own total. */
export interface ProblemAggregateRow {
  groupId: string; coordinateKey: string; field: string; pair: string | null; level: number
  affected: number; label: string | null; reason: string | null; productId: string; language: string
}
const pairOf = (pair: string | null) => {
  const at = (pair ?? '').lastIndexOf('|')
  return { kind: at > 0 ? pair!.slice(0, at) : undefined, requiredEmpty: pair?.slice(at + 1) === '1' }
}

/** group → destination → its problems, one per field: the field's most urgent kind, its sentence and sample. */
export function problemSummaries(rows: readonly ProblemAggregateRow[]): Map<string, Map<string, ProblemSummary[]>> {
  const fields = new Map<string, { total?: number; best?: { kind: ReadinessProblemKind; row: ProblemAggregateRow } }>()
  for (const row of rows) {
    const key = `${row.groupId}\u0000${row.coordinateKey}\u0000${row.field}`
    let entry = fields.get(key)
    if (!entry) fields.set(key, entry = {})
    if (Number(row.level) === 1) { entry.total = Number(row.affected); continue }
    // The field's kind is its most urgent entry's; its sentence and sample come from that entry's group.
    const kind = readinessProblemKind(pairOf(row.pair)), best = entry.best
    const order = best ? kindRank(kind) - kindRank(best.kind) || Number(best.row.affected) - Number(row.affected) || cmp(row.pair ?? '', best.row.pair ?? '') : -1
    if (order < 0) entry.best = { kind, row }
  }
  const out = new Map<string, Map<string, ProblemSummary[]>>()
  for (const { total, best } of fields.values()) {
    if (!best) continue
    const { row, kind } = best
    let group = out.get(row.groupId)
    if (!group) out.set(row.groupId, group = new Map())
    if (!group.has(row.coordinateKey)) group.set(row.coordinateKey, [])
    group.get(row.coordinateKey)!.push({ destinationKey: row.coordinateKey, field: row.field, label: row.label || row.field, kind, message: row.reason ?? '',
      affected: total ?? Number(row.affected), productId: row.productId, locale: row.language })
  }
  return out
}

/**
 * The problems of the given index rows, aggregated in SQL per group (the family root, or the product) × destination ×
 * field — so a page never moves every row's `missing[]` JSON. The `level` 1 rows carry each field's distinct listings.
 */
export async function problemAggregates(ids: readonly string[], by: 'root' | 'product'): Promise<Map<string, Map<string, ProblemSummary[]>>> {
  if (!ids.length) return new Map()
  const group = by === 'root' ? Prisma.sql`COALESCE(p."parentId", p.id)` : Prisma.sql`r."productId"`
  const join = by === 'root' ? Prisma.sql`JOIN "Product" p ON p.id = r."productId"` : Prisma.empty
  const rows = await prisma.$queryRaw<ProblemAggregateRow[]>(Prisma.sql`
    SELECT x.g AS "groupId", x.c AS "coordinateKey", x.field, x.pair, GROUPING(x.pair)::int AS level,
      count(DISTINCT x.pid)::int AS affected, min(x.label) AS label,
      (array_agg(x.reason ORDER BY x.pid, x.lang))[1] AS reason,
      (array_agg(x.pid ORDER BY x.pid, x.lang))[1] AS "productId",
      (array_agg(x.lang ORDER BY x.pid, x.lang))[1] AS language
    FROM (
      SELECT ${group} AS g, r."coordinateKey" AS c, r."productId" AS pid, r.language AS lang,
        COALESCE(e->>'field', '') AS field, e->>'label' AS label, e->>'reason' AS reason,
        COALESCE(e->>'kind', '') || '|' || CASE WHEN e->>'requiredEmpty' = 'true' THEN '1' ELSE '0' END AS pair
      FROM "ReadinessIndex" r ${join}
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.missing) = 'array' THEN r.missing ELSE '[]'::jsonb END) e
      WHERE r.id = ANY(${[...ids]}::text[])
    ) x
    GROUP BY GROUPING SETS ((x.g, x.c, x.field, x.pair), (x.g, x.c, x.field))`)
  return problemSummaries(rows)
}

/* ── chips, next step, order ──────────────────────────────────────────────────────────────── */

/** One chip per destination the row has, in destination order. */
export function chipsOf(listings: Iterable<FoldedListing>, order: ReadonlyMap<string, number>, issues?: ReadonlyMap<string, readonly ProblemSummary[]>): ReadinessChip[] {
  const byKey = new Map<string, ReadinessChip>()
  for (const listing of listings) {
    let chip = byKey.get(listing.destinationKey)
    if (!chip) byKey.set(listing.destinationKey, chip = { destinationKey: listing.destinationKey, state: listing.state, counts: emptyCounts(),
      issueCount: issues?.get(listing.destinationKey)?.length ?? 0, pending: false, computedAt: null })
    chip.counts[listing.state]++
    chip.state = worse(chip.state, listing.state)
    if (listing.pending) chip.pending = true
    const at = listing.computedAt?.toISOString()
    if (at && (!chip.computedAt || at < chip.computedAt)) chip.computedAt = at
  }
  return [...byKey.values()].sort((a, b) => (order.get(a.destinationKey) ?? Infinity) - (order.get(b.destinationKey) ?? Infinity) || cmp(a.destinationKey, b.destinationKey))
}
export const rowStateOf = (chips: readonly ReadinessChip[]): ReadinessScopeState => chips.reduce<ReadinessScopeState>((state, chip) => worse(state, chip.state), chips.length ? 'ready' : 'notComputed')

/**
 * The most urgent thing to do: the worst chip (blocked > warn > notComputed > absent; ready never); in it the problem
 * by kind (required > translation > setup > rule > check), then most listings touched, then destination order, then
 * field. A worst chip with no recorded problem is picked itself (its note says why). Null when every chip is ready.
 */
export function pickNextStep(chips: readonly ReadinessChip[], problems: ReadonlyMap<string, readonly ProblemSummary[]> | undefined, order: ReadonlyMap<string, number>):
  { chip: ReadinessChip; problem: ProblemSummary | null } | null {
  const open = chips.filter(chip => chip.state !== 'ready')
  if (!open.length) return null
  const worst = Math.min(...open.map(chip => scopeStateRank(chip.state)))
  const candidates = open.filter(chip => scopeStateRank(chip.state) === worst)
  const position = (key: string) => order.get(key) ?? Infinity
  const ranked = candidates.flatMap(chip => problems?.get(chip.destinationKey) ?? [])
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.affected - a.affected || position(a.destinationKey) - position(b.destinationKey) || cmp(a.field, b.field))
  if (ranked.length) return { chip: candidates.find(chip => chip.destinationKey === ranked[0].destinationKey)!, problem: ranked[0] }
  return { chip: [...candidates].sort((a, b) => position(a.destinationKey) - position(b.destinationKey))[0], problem: null }
}

export const NOT_CHECKED_MESSAGE = 'Not computed yet — Nexus checks it within a few minutes'
export const NOT_SET_UP_MESSAGE = 'Not set up for this market yet'
const NO_PROBLEM: Record<ReadinessScopeState, { label: string; message: string; kind: ReadinessProblemKind }> = {
  notComputed: { label: 'Not computed', message: NOT_CHECKED_MESSAGE, kind: 'check' },
  absent: { label: 'Not set up', message: NOT_SET_UP_MESSAGE, kind: 'setup' },
  blocked: { label: 'Problems not recorded', message: 'Nexus has not recorded the problems yet — open the product to see them', kind: 'check' },
  warn: { label: 'Problems not recorded', message: 'Nexus has not recorded the problems yet — open the product to see them', kind: 'check' },
  ready: { label: 'Ready', message: '', kind: 'check' },
}

/** The pick in words, with its link: the exact field, or the destination's errors tab when no field is named. */
export function nextStepOf(pick: ReturnType<typeof pickNextStep>, at: (key: string) => Coordinate | undefined,
  sample: { productId: string; locale: string; note?: string | null } | undefined): ReadinessNextStep | null {
  if (!pick) return null
  const coordinate = at(pick.chip.destinationKey) ?? { channel: null, market: null, accountId: null, aliasId: null }
  if (pick.problem) {
    const p = pick.problem
    return { destinationKey: p.destinationKey, field: p.field || null, label: p.label, message: p.message, kind: p.kind, affected: p.affected,
      productId: p.productId, locale: p.locale, href: studioHref(p.productId, coordinate, p.locale, p.field || null) }
  }
  if (!sample) return null
  const words = NO_PROBLEM[pick.chip.state]
  return { destinationKey: pick.chip.destinationKey, field: null, label: words.label, message: sample.note?.trim() || words.message, kind: words.kind,
    affected: pick.chip.counts[pick.chip.state], productId: sample.productId, locale: sample.locale, href: studioHref(sample.productId, coordinate, sample.locale) }
}

interface ProductInfo { id: string; sku: string; name: string | null; parentId: string | null; isParent: boolean }
const nameKey = (name: string | null) => (name ?? '').toLowerCase()
/** Worst first, then name (case-insensitive), SKU, id — stable. */
export function compareRows(a: { state: ReadinessScopeState; name: string | null; sku: string; id: string }, b: typeof a): number {
  return scopeStateRank(a.state) - scopeStateRank(b.state) || cmp(nameKey(a.name), nameKey(b.name)) || cmp(a.sku, b.sku) || cmp(a.id, b.id)
}

export interface MemberSummary { product: ProductInfo; listings: FoldedListing[]; state: ReadinessScopeState; isParentListing: boolean; matches: boolean }
/** The members of one family: the parent's own listing first, then variants worst-first, then name and SKU. */
export function summarizeMembers(family: FamilyListings, rootId: string, rootIsParent: boolean, product: (id: string) => ProductInfo | undefined, filter?: ReadinessStateFilter): MemberSummary[] {
  const members = [...family].map(([productId, byKey]): MemberSummary => {
    const listings = [...byKey.values()]
    const info = product(productId) ?? { id: productId, sku: '', name: null, parentId: null, isParent: false }
    return { product: info, listings, state: listings.reduce<ReadinessScopeState>((s, l) => worse(s, l.state), 'ready'),
      isParentListing: productId === rootId && rootIsParent, matches: listings.some(l => matchesState(l.state, filter)) }
  })
  return members.sort((a, b) => Number(b.isParentListing) - Number(a.isParentListing)
    || compareRows({ ...a.product, state: a.state }, { ...b.product, state: b.state }))
}

/** The first listing (members in order) on that destination in that state: the product and language a link opens. */
function sampleOf(members: readonly MemberSummary[], destinationKey: string, state: ReadinessScopeState, destinations: ReadonlyMap<string, DestinationInfo>) {
  for (const member of members) {
    const listing = member.listings.find(l => l.destinationKey === destinationKey && l.state === state)
    if (listing) return { listing, productId: member.product.id, locale: listing.language ?? [...destinations.get(destinationKey)?.languages ?? []].sort()[0] ?? PRIMARY_CONTENT_LOCALE }
  }
  return undefined
}

/* ── reads ────────────────────────────────────────────────────────────────────────────────── */

/** `listingReadinessWhere` (without `state`: it applies after the fold) AND the search AND any extra scope. */
async function scopedWhere(query: Record<string, unknown>, q: string | undefined, userId: string | null, ...extra: Prisma.ReadinessIndexWhereInput[]): Promise<Prisma.ReadinessIndexWhereInput> {
  const parts = [await listingReadinessWhere({ ...query, state: undefined }, userId), ...extra]
  if (q) {
    const contains = { contains: q, mode: 'insensitive' as const }
    const hits = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ sku: contains }, { name: contains }, { gtin: contains }, { ean: contains }, { upc: contains }] }, select: { id: true, parentId: true } })
    parts.push(searchScope(hits))
  }
  return parts.length === 1 ? parts[0] : { AND: parts }
}
/** A product matches itself; a family's own product (the root) matching brings the whole family. */
export function searchScope(hits: ReadonlyArray<{ id: string; parentId: string | null }>): Prisma.ReadinessIndexWhereInput {
  return { product: { OR: [{ id: { in: hits.map(h => h.id) } }, { parentId: { in: hits.filter(h => !h.parentId).map(h => h.id) } }] } }
}
const familyScope = (rootId: string): Prisma.ReadinessIndexWhereInput => ({ product: { OR: [{ id: rootId }, { parentId: rootId }] } })

async function productsOf(ids: Iterable<string>): Promise<Map<string, ProductInfo>> {
  const select = { id: true, sku: true, name: true, parentId: true, isParent: true } as const
  const wanted = [...new Set(ids)]
  const products = new Map((wanted.length ? await prisma.product.findMany({ where: { id: { in: wanted } }, select }) : []).map(p => [p.id, p as ProductInfo]))
  // A root without rows of its own in the result (a selection, a filter) still names its family.
  const roots = [...new Set([...products.values()].map(p => p.parentId).filter((id): id is string => !!id && !products.has(id)))]
  if (roots.length) for (const p of await prisma.product.findMany({ where: { id: { in: roots } }, select })) products.set(p.id, p as ProductInfo)
  return products
}
async function facesOf(ids: readonly string[]) {
  const rows = ids.length ? await prisma.productReadCache.findMany({ where: { id: { in: [...ids] } }, select: { id: true, imageUrl: true, photoCount: true } }) : []
  return new Map(rows.map(r => [r.id, r]))
}
async function variantCountsOf(rootIds: readonly string[]) {
  const rows = rootIds.length ? await prisma.product.groupBy({ by: ['parentId'], where: { parentId: { in: [...rootIds] }, deletedAt: null }, _count: { _all: true } }) : []
  return new Map(rows.map(r => [r.parentId as string, r._count._all]))
}
async function notesOf(rowIds: readonly string[]) {
  const rows = rowIds.length ? await prisma.readinessIndex.findMany({ where: { id: { in: [...rowIds] } }, select: { id: true, note: true } }) : []
  return new Map(rows.map(r => [r.id, r.note]))
}
const iso = (date: Date | null | undefined) => date ? date.toISOString() : null
const oldest = (dates: Iterable<string | null>) => { let at: string | null = null; for (const d of dates) if (d && (!at || d < at)) at = d; return at }

/** The rows of one listing set, in words: chips, state, next step (notes fetched for problem-less picks only). */
async function rowsOf<T extends { id: string; members: MemberSummary[] }>(rows: readonly T[], problems: Map<string, Map<string, ProblemSummary[]>>,
  order: ReadonlyMap<string, number>, infos: ReadonlyMap<string, DestinationInfo>, listingsOf: (row: T) => FoldedListing[]) {
  const built = rows.map(row => {
    const issues = problems.get(row.id)
    const chips = chipsOf(listingsOf(row), order, issues)
    const pick = pickNextStep(chips, issues, order)
    const sample = pick && !pick.problem ? sampleOf(row.members, pick.chip.destinationKey, pick.chip.state, infos) : undefined
    return { row, chips, pick, sample }
  })
  const notes = await notesOf(built.flatMap(b => b.sample?.listing.worstRowId ? [b.sample.listing.worstRowId] : []))
  const at = (key: string) => infos.get(key)
  return built.map(({ row, chips, pick, sample }) => ({ row, chips, state: rowStateOf(chips),
    nextStep: nextStepOf(pick, at, sample && { productId: sample.productId, locale: sample.locale, note: sample.listing.worstRowId ? notes.get(sample.listing.worstRowId) : null }),
    computedAt: oldest(chips.map(c => c.computedAt)), pending: chips.some(c => c.pending) }))
}

export const DAY_MS = 24 * 60 * 60 * 1000

/** The header's "checked …": the newest check, and the listings last checked more than a day ago (filled ones have none). */
export function checkedOf(rows: ReadonlyArray<{ computedAt: Date }>, listings: ReadonlyArray<Pick<FoldedListing, 'computedAt'>>, now = Date.now()): ReadinessFamiliesPage['checked'] {
  const latest = rows.reduce<Date | null>((at, r) => !at || r.computedAt > at ? r.computedAt : at, null)
  return { latest: iso(latest), olderThanDay: listings.filter(l => l.computedAt && now - l.computedAt.getTime() > DAY_MS).length }
}

/** GET /api/catalog-transfer/readiness/families */
export async function readinessFamilies(query: Record<string, unknown>, userId: string | null): Promise<ReadinessFamiliesPage> {
  const input = familiesQuery(query)
  // One snapshot: the page's problems are read by the row ids of the light pass, which a rebuild replaces.
  return inDatabaseReadTransaction(prisma, async () => {
    const where = await scopedWhere(query, input.q, userId)
    const rows: LightRow[] = await prisma.readinessIndex.findMany({ where, select: LIGHT })
    const products = await productsOf(rows.map(r => r.productId))
    const infos = destinationInfos(rows)
    const destinations = describeDestinations(infos.values(), await storeNamesFor(infos.values()))
    const order = new Map(destinations.map((d, i) => [d.key, i]))
    const families = [...familiesOf(foldListings(rows).values(), id => products.get(id)?.parentId).entries()].map(([rootId, family]) => {
      // A listing selection names listings, not destinations: a sibling outside it was not asked about (2026-10-25).
      if (!input.listingIds) fillNotComputed(family)
      const root = products.get(rootId) ?? { id: rootId, sku: '', name: null, parentId: null, isParent: false }
      const members = summarizeMembers(family, rootId, root.isParent || family.size > 1, id => products.get(id), input.state)
      const listings = members.flatMap(m => m.listings)
      return { id: rootId, root, members, listings, state: listings.reduce<ReadinessScopeState>((s, l) => worse(s, l.state), 'ready'),
        matchingCount: members.filter(m => m.matches).length, pending: listings.some(l => l.pending) }
    })
    const all = families.flatMap(f => f.listings)
    const stats = countStates(all)
    const shown = families.filter(f => f.matchingCount > 0)
      .sort((a, b) => compareRows({ ...a.root, state: a.state }, { ...b.root, state: b.state }))
    const page = shown.slice((input.page - 1) * input.pageSize, input.page * input.pageSize)
    const [problems, variants, faces] = await Promise.all([
      problemAggregates(page.flatMap(f => f.listings.flatMap(l => l.rowIds)), 'root'),
      variantCountsOf(page.map(f => f.id)), facesOf(page.map(f => f.id)),
    ])
    const built = await rowsOf(page, problems, order, infos, f => f.listings)
    return {
      page: input.page, pageSize: input.pageSize, total: shown.length, listingCount: all.length,
      productCount: families.reduce((n, f) => n + f.members.length, 0),
      stats: { ...stats, all: all.length }, destinations,
      computedAt: iso(rows.reduce<Date | null>((at, r) => !at || r.computedAt < at ? r.computedAt : at, null)),
      checked: checkedOf(rows, all), pendingCount: families.filter(f => f.pending).length,
      rows: built.map(({ row, chips, state, nextStep, computedAt, pending }): ReadinessFamilyRow => ({
        id: row.id, sku: row.root.sku, name: row.root.name, imageUrl: faces.get(row.id)?.imageUrl ?? null, photoCount: faces.get(row.id)?.photoCount ?? 0,
        state, chips, nextStep, computedAt, pending, editorHref: productHref(row.id),
        isParent: row.root.isParent || (variants.get(row.id) ?? 0) > 0, variantCount: variants.get(row.id) ?? 0, matchingCount: row.matchingCount,
      })),
    }
  })
}

/** GET /api/catalog-transfer/readiness/families/:rootId/members — the open family (the parent's own listing first). */
export async function readinessFamilyMembers(rootId: string, query: Record<string, unknown>, userId: string | null): Promise<ReadinessMembersPage> {
  const input = membersQuery(rootId, query)
  return inDatabaseReadTransaction(prisma, async () => {
    const where = await scopedWhere(query, input.q, userId, familyScope(input.rootId))
    const [rows, variantCount] = await Promise.all([
      prisma.readinessIndex.findMany({ where, select: LIGHT }) as Promise<LightRow[]>,
      prisma.product.count({ where: { parentId: input.rootId, deletedAt: null } }),
    ])
    const products = await productsOf([input.rootId, ...rows.map(r => r.productId)])
    const infos = destinationInfos(rows)
    const order = new Map(describeDestinations(infos.values(), await storeNamesFor(infos.values())).map((d, i) => [d.key, i]))
    const folded = familiesOf(foldListings(rows).values(), () => input.rootId).get(input.rootId) ?? new Map()
    const family = input.listingIds ? folded : fillNotComputed(folded)
    const root = products.get(input.rootId)
    const members = summarizeMembers(family, input.rootId, !!root?.isParent || variantCount > 0, id => products.get(id), input.state).filter(m => m.matches)
    const page = members.slice(input.offset, input.offset + input.limit).map(m => ({ id: m.product.id, members: [m], member: m }))
    const [problems, faces] = await Promise.all([problemAggregates(page.flatMap(m => m.member.listings.flatMap(l => l.rowIds)), 'product'), facesOf(page.map(m => m.id))])
    const built = await rowsOf(page, problems, order, infos, m => m.member.listings)
    return { rootId: input.rootId, shown: built.length, total: members.length, variantCount,
      rows: built.map(({ row, chips, state, nextStep, computedAt, pending }): ReadinessMemberRow => ({
        id: row.id, sku: row.member.product.sku, name: row.member.product.name, imageUrl: faces.get(row.id)?.imageUrl ?? null, photoCount: faces.get(row.id)?.photoCount ?? 0,
        state, chips, nextStep, computedAt, pending, editorHref: productHref(row.id),
        parentId: row.member.product.parentId, isParentListing: row.member.isParentListing,
      })) }
  })
}

/** The Fix window's problems, one per field: most urgent kind first, then listings touched; products in member order. */
export function detailProblems(rows: ReadonlyArray<{ productId: string; language: string; missing: unknown }>, rank: (productId: string) => number,
  product: (id: string) => { sku: string; name: string | null } | undefined, link: (productId: string, locale: string, field: string) => string): ReadinessProblem[] {
  const ordered = [...rows].sort((a, b) => rank(a.productId) - rank(b.productId) || cmp(a.productId, b.productId) || cmp(a.language, b.language))
  const fields = new Map<string, { field: string; label: string; kind: ReadinessProblemKind; message: string; requiredBy: Set<string>; languages: Set<string>; products: Map<string, string> }>()
  for (const row of ordered) {
    for (const entry of Array.isArray(row.missing) ? row.missing as Array<Record<string, unknown>> : []) {
      const field = typeof entry.field === 'string' ? entry.field : ''
      const kind = readinessProblemKind(entry)
      let problem = fields.get(field)
      if (!problem) fields.set(field, problem = { field, label: String(entry.label || field), kind, message: String(entry.reason ?? ''), requiredBy: new Set(), languages: new Set(), products: new Map() })
      else if (kindRank(kind) < kindRank(problem.kind)) Object.assign(problem, { kind, message: String(entry.reason ?? '') })
      for (const source of Array.isArray(entry.requiredBy) ? entry.requiredBy : []) if (typeof source === 'string') problem.requiredBy.add(source)
      problem.languages.add(row.language)
      if (!problem.products.has(row.productId)) problem.products.set(row.productId, row.language)
    }
  }
  return [...fields.values()]
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.products.size - a.products.size || cmp(a.label.toLowerCase(), b.label.toLowerCase()) || cmp(a.field, b.field))
    .map(p => {
      const [first] = p.products
      return { field: p.field || null, label: p.label, kind: p.kind, message: p.message, requiredBy: [...p.requiredBy], languages: [...p.languages].sort(),
        products: [...p.products.keys()].slice(0, 50).map(id => ({ id, sku: product(id)?.sku ?? '', name: product(id)?.name ?? null })), productCount: p.products.size,
        href: p.field && first ? link(first[0], first[1], p.field) : null }
    })
}

/** GET /api/catalog-transfer/readiness/detail — one product (or its whole family) on one destination. */
export async function readinessDetail(query: Record<string, unknown>, userId: string | null): Promise<ReadinessDetail> {
  const input = detailQuery(query)
  const { destination } = input
  return inDatabaseReadTransaction(prisma, async () => {
    const asked = await prisma.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: { id: true, parentId: true } })
    if (!asked) throw Object.assign(new Error('Product not found'), { statusCode: 404 })
    const rootId = asked.parentId ?? asked.id
    // The state filter is not applied here: the window explains a chip, and chips always tell the whole destination.
    const result = await scopedWhere(query, input.q, userId)
    const base: Prisma.ReadinessIndexWhereInput = { AND: [result, familyScope(rootId)] }
    const [members, rows, stores] = await Promise.all([
      prisma.readinessIndex.groupBy({ by: ['productId'], where: base }),
      prisma.readinessIndex.findMany({ where: { AND: [base, { coordinateKey: destination.key }] },
        select: { ...LIGHT, note: true, missing: true } }),
      // The page's result, not only this family: a chip names its store when another store sells on that market there.
      destination.channel ? prisma.readinessIndex.groupBy({ by: ['accountId'], where: { AND: [result, { channel: destination.channel, market: destination.market }] } }) : [],
    ])
    const products = await productsOf([rootId, ...members.map(m => m.productId)])
    // Members of the family that lack this destination while a sibling has it were not checked there yet.
    const family: FamilyListings = new Map(members.map(m => [m.productId, new Map()]))
    for (const listing of foldListings(rows).values()) family.get(listing.productId)?.set(listing.destinationKey, listing)
    if (rows.length && !input.listingIds) fillNotComputed(family)
    const rootHasVariants = rootId !== asked.id || await prisma.product.count({ where: { parentId: rootId, deletedAt: null } }) > 0
    const ordered = summarizeMembers(family, rootId, !!products.get(rootId)?.isParent || rootHasVariants, id => products.get(id))
      .filter(m => input.family || m.product.id === asked.id)
    const rank = new Map(ordered.map((m, i) => [m.product.id, i]))
    const listings = ordered.flatMap(m => m.listings)
    const scoped = rows.filter(r => rank.has(r.productId))
    const infos = destinationInfos(rows)
    if (!infos.size) infos.set(destination.key, { key: destination.key, ...destination, label: '', languages: new Set() })
    const otherStores = stores.map(s => ({ channel: destination.channel, market: destination.market, accountId: s.accountId }))
    const described = describeDestinations(infos.values(), await storeNamesFor([...infos.values(), ...otherStores]), otherStores).find(d => d.key === destination.key)!
    const counts = countStates(listings)
    const state = listings.reduce<ReadinessScopeState>((s, l) => worse(s, l.state), listings.length ? 'ready' : 'notComputed')
    const byLanguage = new Map<string, ReadinessScopeState>()
    for (const row of scoped) byLanguage.set(row.language, worse(byLanguage.get(row.language) ?? 'ready', stateOf(row.state)))
    if (listings.some(l => l.filled)) for (const language of byLanguage.keys()) byLanguage.set(language, worse(byLanguage.get(language)!, 'notComputed'))
    const languages = [...byLanguage].sort(([a], [b]) => Number(b === PRIMARY_CONTENT_LOCALE) - Number(a === PRIMARY_CONTENT_LOCALE) || cmp(a, b)).map(([locale, s]) => ({ locale, state: s }))
    const problems = detailProblems(scoped, id => rank.get(id) ?? Infinity, id => products.get(id), (productId, locale, field) => studioHref(productId, destination, locale, field))
    // Why a listing has no verdict worth a problem list: a "not set up" reason, or a warning/block with no recorded problem.
    const notes = new Set<string>()
    for (const row of scoped) if (row.note?.trim() && (row.state === 'absent' || (row.state !== 'ready' && !(Array.isArray(row.missing) && row.missing.length)))) notes.add(row.note.trim())
    if (counts.notComputed || !listings.length) notes.add(NOT_CHECKED_MESSAGE)
    const worstLanguage = languages.find(l => l.state === state)?.locale ?? languages[0]?.locale ?? PRIMARY_CONTENT_LOCALE
    return { productId: input.productId, family: input.family, destination: described, state, counts,
      computedAt: oldest(listings.map(l => iso(l.computedAt))), pending: listings.some(l => l.pending), languages, problems, notes: [...notes],
      editorHref: studioHref(input.productId, destination, worstLanguage) }
  })
}
