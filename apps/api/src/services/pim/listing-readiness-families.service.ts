/**
 * Listing readiness — the family view (rebuild 2026-10-23, docs/listings/READINESS-REBUILD-2026-10-23.md, layout A).
 *
 * Reads the materialized `ReadinessIndex` only (never a live resolve). One top-level row per family root
 * (`parentId ?? id`); a "listing" is one product on one destination, its languages folded into one verdict (worst wins).
 * The top level keeps a business of ~11,300 index rows fast without moving them: ONE SQL summary of the whole filtered
 * result (tiles, totals, the destinations, and the ids of the requested page's families in row order — `familiesSummary`),
 * then the LIGHT columns of the page's families only, through the same fold, fill and words as the members, and their
 * problems (`missing[]`) aggregated in SQL. A cheap fingerprint of the result answers an unchanged poll with 304.
 * Filters are `listingReadinessWhere()`'s selection (the same as Translate); the state filter applies after the language fold.
 */
import { Prisma } from '@prisma/client'
import {
  READINESS_LIVE_FLAGS, READINESS_LIVE_STATES,
  type ReadinessChip, type ReadinessDestination, type ReadinessDetail, type ReadinessFamiliesPage, type ReadinessFamilyRow, type ReadinessLiveFlag,
  type ReadinessLiveState, type ReadinessMemberRow, type ReadinessMembersPage, type ReadinessNextStep, type ReadinessProblem, type ReadinessProblemKind,
  type ReadinessScopeState, type ReadinessStateCounts, type ReadinessStateFilter,
} from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { inDatabaseReadTransaction } from '../../lib/database-context.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { listingReadinessWhere, readinessProblemKind, readinessQuery, readinessSelection } from './listing-readiness.service.js'
import { SCOPE_STATES, scopeStateRank } from './readiness-model.js'
import { workspaceContext } from '../../lib/workspace-context.js'
import { weakEtag } from '../../utils/list-etag.js'
import {
  attachLive, liveFilterCtes, liveScopeOf, liveSqlView, liveTileCtes, liveTilesOf, readChannelSection, resolveSearchTokens, SEARCH_MAX_CHARS, SEARCH_MAX_TERMS,
  searchProductHits, searchTerms, type LiveOptions, type LiveSqlView, type LiveTiles,
} from './listing-readiness-live.service.js'
// Live layer step 7: the Problems view's `problem=<id>` filter.
import { problemFilterCtes, problemQuery } from './listing-readiness-problem-filter.js'

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
  // Live layer step 3: a search may be a pasted list (SKUs, ASINs, Item IDs) — up to 500 terms / 4,000 characters.
  const q = text(query.q, 'search', SEARCH_MAX_CHARS)
  if (q && searchTerms(q).length > SEARCH_MAX_TERMS) throw new Error(`Search for up to ${SEARCH_MAX_TERMS} terms at once`)
  const state = text(query.state, 'state')
  if (state && !STATE_FILTERS.includes(state)) throw new Error('Select a readiness state')
  if (query.pageSize !== undefined && query.pageSize !== '' && !PAGE_SIZES.includes(query.pageSize as string)) throw new Error('Show 50, 100 or 200 rows per page')
  // Live layer step 7: `problem=<id>` (the Problems view's Show products), applied in `resultCtes`.
  return { ...base, q, state: state as ReadinessStateFilter | undefined, pageSize: Number(query.pageSize || 50), ...liveFilters(query), ...problemQuery(query) }
}

/**
 * Live layer step 3 — the live filters (`resultCtes` applies them in the SQL summary): `live` = channel states (any of
 * them: OR), `flags` = live flags (all of them, on one listing: AND), comma lists. They keep or drop whole families; the
 * open family's members are not narrowed by them. Unknown values are dropped, never refused; a caller without
 * `listings.view` has them ignored.
 */
export function liveFilters(query: Record<string, unknown>): { liveStates?: ReadinessLiveState[]; liveFlags?: ReadinessLiveFlag[] } {
  const list = <T extends string>(value: unknown, allowed: readonly T[]) => {
    const raw = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : ''
    const picked = [...new Set(raw.split(',').map(v => v.trim()).filter((v): v is T => (allowed as readonly string[]).includes(v)))]
    return picked.length ? picked : undefined
  }
  const liveStates = list(query.live, READINESS_LIVE_STATES), liveFlags = list(query.flags, READINESS_LIVE_FLAGS)
  return { ...(liveStates ? { liveStates } : {}), ...(liveFlags ? { liveFlags } : {}) }
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
export async function storeNamesFor(entries: Iterable<StoreKey>): Promise<Map<string, string>> {
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

export interface ProductInfo { id: string; sku: string; name: string | null; parentId: string | null; isParent: boolean }
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
  // Today's phrase search (SKU, name, barcode) AND each term exactly on the channel ids (live layer step 3).
  if (q) parts.push(searchScope(await searchProductHits(q)))
  return parts.length === 1 ? parts[0] : { AND: parts }
}
/** A product matches itself; a family's own product (the root) matching brings the whole family. */
export function searchScope(hits: ReadonlyArray<{ id: string; parentId: string | null }>): Prisma.ReadinessIndexWhereInput {
  return { product: { OR: [{ id: { in: hits.map(h => h.id) } }, { parentId: { in: hits.filter(h => !h.parentId).map(h => h.id) } }] } }
}
const familyScope = (rootId: string): Prisma.ReadinessIndexWhereInput => ({ product: { OR: [{ id: rootId }, { parentId: rootId }] } })

export async function productsOf(ids: Iterable<string>): Promise<Map<string, ProductInfo>> {
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

/* ── the top level in SQL: one summary of the whole result, then the page's families only ─────────────────────────── */

const RANK = Object.fromEntries(SCOPE_STATES.map(state => [state, scopeStateRank(state)])) as Record<ReadinessScopeState, number>
/** A rank from `SCOPE_STATES` (code, never input), written into the statement as a literal. */
const rankLiteral = (rank: number) => Prisma.raw(String(Math.trunc(rank)))
/** `stateOf` + `scopeStateRank` in SQL: a stored state outside the vocabulary reads as not computed. */
const RANK_SQL = Prisma.sql`CASE r.state ${Prisma.join(SCOPE_STATES.map(state => Prisma.sql`WHEN ${state} THEN ${rankLiteral(RANK[state])}`), ' ')} ELSE ${rankLiteral(RANK.notComputed)} END`
const FROM_INDEX = Prisma.sql`"ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"`
/** The line of `checked.olderThanDay`, 24 hours ago, as the index stores time (UTC wall clock, `::timestamp`). */
const dayAgo = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

/** `searchScope` in SQL: the row's product matches, or its family's own product (the root) does; Prisma's case-insensitive `contains`. */
function searchSql(q: string): Prisma.Sql {
  const pattern = `%${q}%`
  const hit = (alias: string) => {
    const t = Prisma.raw(alias)
    return Prisma.sql`${t}."deletedAt" IS NULL AND (${t}.sku ILIKE ${pattern} OR ${t}.name ILIKE ${pattern} OR ${t}.gtin ILIKE ${pattern} OR ${t}.ean ILIKE ${pattern} OR ${t}.upc ILIKE ${pattern})`
  }
  return Prisma.sql`((${hit('p')}) OR EXISTS (SELECT 1 FROM "Product" s WHERE s.id = p."parentId" AND s."parentId" IS NULL AND ${hit('s')}))`
}

/**
 * `scopedWhere` in SQL, over `FROM_INDEX`: `listingReadinessWhere`'s selection (a product selector resolved to product ids
 * first, `listingIds` to their coordinates), channel / market / account / language on the index columns, and the search,
 * inside the statement (never a list of every matching product). Parameterised throughout.
 */
async function readinessFilter(query: Record<string, unknown>, q: string | undefined, userId: string | null, ...extra: Prisma.Sql[]): Promise<Prisma.Sql> {
  const { input, product, productSelected, listings } = await readinessSelection({ ...query, state: undefined }, userId)
  const parts = [Prisma.sql`p."deletedAt" IS NULL`]
  if (productSelected) {
    const ids = (await prisma.product.findMany({ where: product, select: { id: true } })).map(found => found.id)
    parts.push(Prisma.sql`r."productId" = ANY(${ids}::text[])`)
  }
  if (input.channel) parts.push(input.channel === 'SHARED' ? Prisma.sql`r.channel IS NULL` : Prisma.sql`r.channel = ${input.channel}`)
  if (input.marketplace) parts.push(Prisma.sql`r.market = ${input.marketplace}`)
  if (input.accountId) parts.push(Prisma.sql`r."accountId" = ${input.accountId}`)
  if (input.language) parts.push(Prisma.sql`r.language = ${input.language}`)
  if (listings) {
    parts.push(listings.length ? Prisma.sql`(${Prisma.join(listings.map(l => Prisma.sql`(r."productId" = ${l.productId} AND r.channel IS NOT DISTINCT FROM ${l.channel}
      AND r.market IS NOT DISTINCT FROM ${l.market} AND r."accountId" IS NOT DISTINCT FROM ${l.accountId} AND r."aliasId" IS NOT DISTINCT FROM ${l.aliasId})`), ' OR ')})` : Prisma.sql`FALSE`)
  }
  if (q) parts.push(await searchFilterSql(q))
  return Prisma.join([...parts, ...extra], ' AND ')
}

/**
 * The search (live layer step 3): today's phrase search (`searchSql`) OR each term matched exactly on the products' and
 * listings' ids (`resolveSearchTokens`: SKU, barcodes, ASIN, eBay Item ID, channel SKUs, a customization's SKU) — one
 * term or a pasted list. The family rule is `searchScope`'s: a hit is itself; a root hit brings its family.
 */
async function searchFilterSql(q: string): Promise<Prisma.Sql> {
  const { hits } = await resolveSearchTokens(q)
  if (!hits.length) return searchSql(q)
  return Prisma.sql`(${searchSql(q)} OR p.id = ANY(${hits.map(h => h.id)}::text[]) OR p."parentId" = ANY(${hits.filter(h => !h.parentId).map(h => h.id)}::text[]))`
}

interface FamiliesSummary extends ReadinessStateCounts {
  listingCount: number; productCount: number; total: number; pendingCount: number; olderThanDay: number
  oldest: Date | null; latest: Date | null
  /** The requested page's family roots, in row order. */
  roots: string[]
  destinations: Array<{ key: string; channel: string | null; market: string | null; accountId: string | null; aliasId: string | null; label: string; languages: string[] }> | null
}

/**
 * The whole filtered result in ONE statement, counted as the TypeScript model counts it:
 *   listing — the languages of one product on one destination folded: the worst state, the oldest check, pending when any
 *             row is (`foldListings`);
 *   family  — listings grouped by `COALESCE(parentId, id)` (`familiesOf`); `fillNotComputed` is members × destinations −
 *             listings present, each one `notComputed` (none for a `listingIds` selection);
 *   ranked  — the family's state (the worst of its listings, a filled one included) and whether the state filter keeps it
 *             (a member with a matching listing: `matchingCount > 0`).
 * It returns the tiles, the totals, the checked times, the destinations (first label: the smallest), and the requested
 * page's roots in `compareRows` order: state, then the root's name lower-cased, SKU, id, compared bytewise (`COLLATE "C"`).
 */
/**
 * The result's rows as `f` (step 3): the filtered index rows (`f0`), narrowed — when the caller may see listings and asked
 * for live filters — to the families with a member's listing on a destination in view that satisfies them
 * (`liveFilterCtes`). Live filters narrow the RESULT, like channel and market: every tile follows them; only the readiness
 * `state` tile stays a filter after the fold.
 */
function resultCtes(filter: Prisma.Sql, input: ReturnType<typeof familiesQuery>, view: LiveSqlView | null): Prisma.Sql {
  const f0 = Prisma.sql`f0 AS (
      SELECT r."productId" AS pid, r."coordinateKey" AS ck, r.channel, r.market, r."accountId" AS account, r."aliasId" AS alias, r.language AS lang,
        r.label, ${RANK_SQL} AS rank, r."computedAt" AS at, r."pendingSince" IS NOT NULL AS pending, COALESCE(p."parentId", p.id) AS root
      FROM ${FROM_INDEX} WHERE ${filter}
    )`
  const live = liveFilterCtes('f0', !input.listingIds, view)
  // Live layer step 7: `problem=<id>` keeps the families with that problem (`pf_keep`, listing-readiness-problem-filter.ts).
  const problem = problemFilterCtes('f0', filter, input.problem, view)
  const keep = [...(live ? [Prisma.sql`root IN (SELECT root FROM lf_keep)`] : []), ...(problem ? [Prisma.sql`root IN (SELECT root FROM pf_keep)`] : [])]
  return Prisma.sql`${Prisma.join([f0, ...(live ? [live] : []), ...(problem ? [problem] : [])], ', ')}, f AS (SELECT * FROM f0${keep.length ? Prisma.sql` WHERE ${Prisma.join(keep, ' AND ')}` : Prisma.empty})`
}

async function familiesSummary(filter: Prisma.Sql, input: ReturnType<typeof familiesQuery>, cutoff: string, view: LiveSqlView | null = null): Promise<FamiliesSummary> {
  const fill = !input.listingIds
  const ranks = input.state === 'notChecked' ? [RANK.absent, RANK.notComputed] : input.state ? [RANK[input.state]] : null
  const hit = ranks ? Prisma.sql`bool_or(rank IN (${Prisma.join(ranks.map(rankLiteral))}))` : Prisma.sql`TRUE`
  const filledHit = !ranks || ranks.includes(RANK.notComputed) ? Prisma.sql`filled > 0` : Prisma.sql`FALSE`
  const [summary] = await prisma.$queryRaw<FamiliesSummary[]>(Prisma.sql`
    WITH ${resultCtes(filter, input, view)}, listing AS (
      SELECT root, pid, ck, min(rank) AS rank, min(at) AS at, bool_or(pending) AS pending FROM f GROUP BY root, pid, ck
    ), family AS (
      SELECT root, count(*) AS present, count(DISTINCT pid) AS members,
        ${fill ? Prisma.sql`count(DISTINCT pid) * count(DISTINCT ck) - count(*)` : Prisma.sql`0`} AS filled,
        min(rank) AS worst, bool_or(pending) AS pending, count(*) FILTER (WHERE at < ${cutoff}::timestamp) AS old, ${hit} AS hit,
        count(*) FILTER (WHERE rank = ${rankLiteral(RANK.blocked)}) AS blocked, count(*) FILTER (WHERE rank = ${rankLiteral(RANK.warn)}) AS warn,
        count(*) FILTER (WHERE rank = ${rankLiteral(RANK.notComputed)}) AS not_computed, count(*) FILTER (WHERE rank = ${rankLiteral(RANK.absent)}) AS absent,
        count(*) FILTER (WHERE rank = ${rankLiteral(RANK.ready)}) AS ready
      FROM listing GROUP BY root
    ), ranked AS (
      SELECT family.*, CASE WHEN filled > 0 THEN LEAST(worst, ${rankLiteral(RANK.notComputed)}) ELSE worst END AS state, (hit OR ${filledHit}) AS matched FROM family
    )
    SELECT COALESCE(sum(blocked), 0)::int AS blocked, COALESCE(sum(warn), 0)::int AS warn, COALESCE(sum(not_computed + filled), 0)::int AS "notComputed",
      COALESCE(sum(absent), 0)::int AS absent, COALESCE(sum(ready), 0)::int AS ready,
      COALESCE(sum(present + filled), 0)::int AS "listingCount", COALESCE(sum(members), 0)::int AS "productCount",
      (count(*) FILTER (WHERE matched))::int AS total, (count(*) FILTER (WHERE pending))::int AS "pendingCount", COALESCE(sum(old), 0)::int AS "olderThanDay",
      (SELECT min(at) FROM f) AS oldest, (SELECT max(at) FROM f) AS latest,
      ARRAY(SELECT x.root FROM ranked x LEFT JOIN "Product" rp ON rp.id = x.root WHERE x.matched
        ORDER BY x.state, lower(COALESCE(rp.name, '')) COLLATE "C", COALESCE(rp.sku, '') COLLATE "C", x.root COLLATE "C"
        LIMIT ${input.pageSize} OFFSET ${(input.page - 1) * input.pageSize}) AS roots,
      (SELECT json_agg(json_build_object('key', d.ck, 'channel', d.channel, 'market', d.market, 'accountId', d.account, 'aliasId', d.alias,
          'label', d.label, 'languages', d.languages))
        FROM (SELECT ck, channel, market, account, alias, min(label) AS label, array_agg(DISTINCT lang) AS languages FROM f GROUP BY ck, channel, market, account, alias) d) AS destinations
    FROM ranked`)
  return summary
}

/** The live tiles over the whole result (after the live filters), in one statement (`liveTileCtes`). */
async function liveTiles(filter: Prisma.Sql, input: ReturnType<typeof familiesQuery>, view: LiveSqlView): Promise<LiveTiles> {
  const [row] = await prisma.$queryRaw<Array<Parameters<typeof liveTilesOf>[0]>>(Prisma.sql`
    WITH ${resultCtes(filter, input, view)}, ${liveTileCtes('f', !input.listingIds, view, !!input.language)}
    SELECT * FROM lt_tiles`)
  return liveTilesOf(row)
}

/** The LIGHT columns of the given families' rows, under the same filter (a family: the root itself and its variants). */
async function familyRowsOf(filter: Prisma.Sql, roots: readonly string[]): Promise<LightRow[]> {
  if (!roots.length) return []
  return prisma.$queryRaw<LightRow[]>(Prisma.sql`
    SELECT r.id, r."productId", r."coordinateKey", r.channel, r.market, r."accountId", r."aliasId", r.language, r.label, r.state, r."computedAt", r."pendingSince"
    FROM ${FROM_INDEX}
    WHERE ${filter} AND r."productId" IN (SELECT m.id FROM "Product" m WHERE m."parentId" = ANY(${[...roots]}::text[]) OR (m."parentId" IS NULL AND m.id = ANY(${[...roots]}::text[])))`)
}

interface Fingerprint { rows: number; latest: Date | null; pending: number; old: number; products: Date | null; roots: Date | null; variants: number
  listings?: number; listed?: Date | null; issues?: number; issueAt?: Date | null; suppressionAt?: Date | null; driftAt?: Date | null; snapshotAt?: Date | null }
/**
 * What an answer depends on, in one aggregate (the `list-etag.ts` pattern): the filtered index rows (how many, the newest
 * check, the pending marks, how many are older than the 24-hour line), the newest edit of their products and of the
 * family roots (names, SKUs, families), and the roots' live variants; with the request's query, business and user. An
 * equal fingerprint is the same answer, so the route can say 304. With the live layer on (`live`, step 3) it also holds
 * what the channel side of those products shows — their listings (how many, the newest edit), open channel messages,
 * suppressions, drift and the publish/delete records — and the permission bit itself: a live change is never a 304.
 */
async function readinessEtag(filter: Prisma.Sql, cutoff: string, context: Record<string, unknown>, rootId?: string, live = false): Promise<string> {
  const facts = live ? Prisma.sql`,
      (SELECT count(*)::int FROM ll) AS listings, (SELECT max(ll.at) FROM ll) AS listed,
      (SELECT count(*)::int FROM "ListingIssue" i WHERE i."listingId" IN (SELECT id FROM ll) AND i."resolvedAt" IS NULL) AS issues,
      (SELECT max(GREATEST(i."lastSeenAt", COALESCE(i."resolvedAt", i."lastSeenAt"))) FROM "ListingIssue" i WHERE i."listingId" IN (SELECT id FROM ll)) AS "issueAt",
      (SELECT max(s."updatedAt") FROM "AmazonSuppression" s WHERE s."listingId" IN (SELECT id FROM ll)) AS "suppressionAt",
      (SELECT max(d."updatedAt") FROM "ChannelDrift" d WHERE d."channelListingId" IN (SELECT id FROM ll)) AS "driftAt",
      (SELECT max(GREATEST(n."createdAt", COALESCE(n."acceptedAt", n."createdAt"))) FROM "ChannelListingSnapshot" n WHERE n."channelListingId" IN (SELECT id FROM ll)) AS "snapshotAt"` : Prisma.empty
  const [row] = await prisma.$queryRaw<Fingerprint[]>(Prisma.sql`
    WITH f AS (
      SELECT r."computedAt" AS at, r."pendingSince" AS ps, p."updatedAt" AS pu, r."productId" AS pid, COALESCE(p."parentId", p.id) AS root FROM ${FROM_INDEX} WHERE ${filter}
    ), roots AS (${rootId ? Prisma.sql`SELECT root AS id FROM f UNION SELECT ${rootId}::text` : Prisma.sql`SELECT DISTINCT root AS id FROM f`})${live ? Prisma.sql`,
    ll AS (SELECT l.id, l."updatedAt" AS at FROM "ChannelListing" l WHERE l."productId" IN (SELECT pid FROM f UNION SELECT id FROM roots))` : Prisma.empty}
    SELECT count(*)::int AS rows, max(at) AS latest, count(ps)::int AS pending, (count(*) FILTER (WHERE at < ${cutoff}::timestamp))::int AS old, max(pu) AS products,
      (SELECT max(rp."updatedAt") FROM roots JOIN "Product" rp ON rp.id = roots.id) AS roots,
      (SELECT count(*)::int FROM "Product" v WHERE v."parentId" IN (SELECT id FROM roots) AND v."deletedAt" IS NULL) AS variants${facts}
    FROM f`)
  const time = (at: Date | null | undefined) => at ? new Date(at).getTime() : null
  return weakEtag([row.rows, time(row.latest), row.pending, row.old, time(row.products), time(row.roots), row.variants,
    ...(live ? [row.listings, time(row.listed), row.issues, time(row.issueAt), time(row.suppressionAt), time(row.driftAt), time(row.snapshotAt)] : [])],
    { ...context, live, workspaceId: workspaceContext()?.workspaceId ?? null })
}

/** An answer, or `page: null` when the caller already holds it (`unchanged(etag)`: the route says 304). */
export interface FreshAnswer<T> { etag: string | null; page: T | null }

/** GET /api/catalog-transfer/readiness/families */
export async function readinessFamilies(query: Record<string, unknown>, userId: string | null, options: LiveOptions = {}): Promise<ReadinessFamiliesPage> {
  return (await familiesRead(query, userId, undefined, options)).page!
}
/** The same, with its ETag; `page` is null when `unchanged(etag)`. */
export function readinessFamiliesIfChanged(query: Record<string, unknown>, userId: string | null, unchanged: (etag: string) => boolean,
  options: LiveOptions = {}): Promise<FreshAnswer<ReadinessFamiliesPage>> {
  return familiesRead(query, userId, unchanged, options)
}

async function familiesRead(query: Record<string, unknown>, userId: string | null, unchanged?: (etag: string) => boolean, options: LiveOptions = {}): Promise<FreshAnswer<ReadinessFamiliesPage>> {
  const input = familiesQuery(query)
  const cutoff = dayAgo()
  // One snapshot: the fingerprint, the summary and the page's rows (whose ids the problems are read by) see the same index.
  return inDatabaseReadTransaction(prisma, async () => {
    const filter = await readinessFilter(query, input.q, userId)
    // The live layer (step 3): only for a caller with listings.view; without it the live filters are ignored.
    const view = await liveSqlView(input, options.live === true)
    const etag = unchanged ? await readinessEtag(filter, cutoff, { endpoint: 'families', query, userId }, undefined, !!view) : null
    if (etag && unchanged!(etag)) return { etag, page: null }
    const summary = await familiesSummary(filter, input, cutoff, view)
    const infos = new Map<string, DestinationInfo>((summary.destinations ?? []).map(d => [d.key,
      { key: d.key, channel: d.channel, market: d.market, accountId: d.accountId, aliasId: d.aliasId, label: d.label, languages: new Set(d.languages) }]))
    const destinations = describeDestinations(infos.values(), await storeNamesFor(infos.values()))
    const order = new Map(destinations.map((d, i) => [d.key, i]))
    // The page's families only: the same fold, fill and words as before, over their own rows.
    const rows = await familyRowsOf(filter, summary.roots)
    const products = await productsOf(rows.map(r => r.productId))
    const families = familiesOf(foldListings(rows).values(), id => products.get(id)?.parentId)
    const page = summary.roots.flatMap((rootId): FamilyPageItem[] => {
      const family = families.get(rootId)
      if (!family) return []
      if (!input.listingIds) fillNotComputed(family)
      const root = products.get(rootId) ?? { id: rootId, sku: '', name: null, parentId: null, isParent: false }
      const members = summarizeMembers(family, rootId, root.isParent || family.size > 1, id => products.get(id), input.state)
      return [{ id: rootId, root, members, listings: members.flatMap(m => m.listings), matchingCount: members.filter(m => m.matches).length }]
    })
    const { blocked, warn, notComputed, absent, ready } = summary
    const result: ReadinessFamiliesPage = {
      page: input.page, pageSize: input.pageSize, total: summary.total, listingCount: summary.listingCount, productCount: summary.productCount,
      stats: { blocked, warn, notComputed, absent, ready, all: summary.listingCount }, destinations,
      computedAt: iso(summary.oldest), checked: { latest: iso(summary.latest), olderThanDay: summary.olderThanDay }, pendingCount: summary.pendingCount,
      rows: await familyPageRows(page, order, infos),
    }
    // Live layer step 3 (listing-readiness-live.service.ts): the live tiles over the whole result (SQL), then ONE post-step over the page.
    const tiles = view ? await liveTiles(filter, input, view) : null
    return { etag, page: await attachLive(result, { query: input, live: !!view, rowProducts: new Map(page.map(f => [f.id, f.members.map(m => m.product.id)])), tiles }) }
  })
}

/** One page's families, folded and filled, in row order. */
export interface FamilyPageItem { id: string; root: ProductInfo; members: MemberSummary[]; listings: FoldedListing[]; matchingCount: number }
/** The page's families in words: chips, state, next step, picture, variants. */
export async function familyPageRows(page: readonly FamilyPageItem[], order: ReadonlyMap<string, number>, infos: ReadonlyMap<string, DestinationInfo>): Promise<ReadinessFamilyRow[]> {
  const [problems, variants, faces] = await Promise.all([
    problemAggregates(page.flatMap(f => f.listings.flatMap(l => l.rowIds)), 'root'),
    variantCountsOf(page.map(f => f.id)), facesOf(page.map(f => f.id)),
  ])
  const built = await rowsOf(page, problems, order, infos, f => f.listings)
  return built.map(({ row, chips, state, nextStep, computedAt, pending }): ReadinessFamilyRow => ({
    id: row.id, sku: row.root.sku, name: row.root.name, imageUrl: faces.get(row.id)?.imageUrl ?? null, photoCount: faces.get(row.id)?.photoCount ?? 0,
    state, chips, nextStep, computedAt, pending, editorHref: productHref(row.id),
    isParent: row.root.isParent || (variants.get(row.id) ?? 0) > 0, variantCount: variants.get(row.id) ?? 0, matchingCount: row.matchingCount,
  }))
}

/** GET /api/catalog-transfer/readiness/families/:rootId/members — the open family (the parent's own listing first). */
export async function readinessFamilyMembers(rootId: string, query: Record<string, unknown>, userId: string | null, options: LiveOptions = {}): Promise<ReadinessMembersPage> {
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
    const result: ReadinessMembersPage = { rootId: input.rootId, shown: built.length, total: members.length, variantCount,
      rows: built.map(({ row, chips, state, nextStep, computedAt, pending }): ReadinessMemberRow => ({
        id: row.id, sku: row.member.product.sku, name: row.member.product.name, imageUrl: faces.get(row.id)?.imageUrl ?? null, photoCount: faces.get(row.id)?.photoCount ?? 0,
        state, chips, nextStep, computedAt, pending, editorHref: productHref(row.id),
        parentId: row.member.product.parentId, isParentListing: row.member.isParentListing,
      })) }
    // Live layer step 3 (listing-readiness-live.service.ts): ONE post-step over the built page. Keep this call when the computation above changes.
    return attachLive(result, { query: input, live: options.live === true, rowProducts: new Map(page.map(m => [m.id, [m.id]])) })
  })
}

/** The members with their ETag; `page` is null when `unchanged(etag)` (the route says 304). */
export async function readinessFamilyMembersIfChanged(rootId: string, query: Record<string, unknown>, userId: string | null,
  unchanged: (etag: string) => boolean, options: LiveOptions = {}): Promise<FreshAnswer<ReadinessMembersPage>> {
  const input = membersQuery(rootId, query)
  return inDatabaseReadTransaction(prisma, async () => {
    const filter = await readinessFilter(query, input.q, userId, Prisma.sql`(p.id = ${input.rootId} OR p."parentId" = ${input.rootId})`)
    const etag = await readinessEtag(filter, dayAgo(), { endpoint: 'members', rootId: input.rootId, query, userId }, input.rootId, options.live === true)
    return unchanged(etag) ? { etag, page: null } : { etag, page: await readinessFamilyMembers(rootId, query, userId, options) }
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
export async function readinessDetail(query: Record<string, unknown>, userId: string | null, options: LiveOptions = {}): Promise<ReadinessDetail> {
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
    // Live layer step 3: what the channel says here (null on Shared and without listings.view).
    const channel = options.live === true ? await readChannelSection(ordered.length ? ordered.map(m => m.product.id) : [asked.id], destination, liveScopeOf(input)) : null
    return { productId: input.productId, family: input.family, destination: described, state, counts,
      computedAt: oldest(listings.map(l => iso(l.computedAt))), pending: listings.some(l => l.pending), languages, problems, notes: [...notes],
      editorHref: studioHref(input.productId, destination, worstLanguage), channel }
  })
}

/* ── Live layer step 7: the Problems view (listing-readiness-problems.service.ts) reads the same result ──────────── */
export { readinessFilter, resultCtes, readinessEtag }
