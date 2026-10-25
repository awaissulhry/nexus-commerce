/**
 * Listings live layer, step 7 (docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md) — the Problems view: fix by problem,
 * not product by product. `GET /api/catalog-transfer/readiness/problems` takes the families page's own query and answers
 * one row per problem × destination over the SAME result (`readinessFilter` + `resultCtes`: filters, search, live
 * filters; the readiness `state` tile keeps the families it keeps, as the Products view does):
 *
 *   readiness  the fields the index rows name in `missing[]` (Blocked and Warnings rows), aggregated in SQL per
 *              destination × field like `problemAggregates`: the field's most urgent kind and its first sentence;
 *   channel    open `ListingIssue`s of the result's listings, grouped by destination, code and message word for word;
 *   notListed  products Ready on a destination with no listing on the channel there (none, a draft, one Nexus removed).
 * The last two only for a caller with `listings.view`. "Products" counts the page's rows (family roots), "Listings" the
 * readiness listings (product × destination) or, for channel messages, the listings on the channel.
 *
 * Statements, whatever the size of the result: the destinations 1, readiness 1, and with live data channel 1 and
 * not-listed 1 (+ the store names, the footprint and the extra destinations' facts when a message sits on one).
 * Order: Blocked, Warnings, channel messages, Ready-not-listed; then most products. At most 500 rows (`total` says how
 * many there were). Show products is `problem=<row id>` on the families endpoint (listing-readiness-problem-filter.ts).
 */
import { Prisma } from '@prisma/client'
import type { ReadinessDestination, ReadinessProblemKind, ReadinessProblemRow, ReadinessProblemsPage, ReadinessScopeState } from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { inDatabaseReadTransaction } from '../../lib/database-context.js'
import { readinessProblemKind } from './listing-readiness.service.js'
import {
  channelName, describeDestinations, familiesQuery, kindRank, readinessEtag, readinessFilter, resultCtes, storeNamesFor,
  type DestinationInfo, type FreshAnswer,
} from './listing-readiness-families.service.js'
import {
  canonicalDestinationKey, extraDestination, extraDestinationFacts, liveDestinationKey, liveSqlView, readinessFootprint,
  type LiveOptions, type LiveSqlView,
} from './listing-readiness-live.service.js'
import { canonMarketSql, listingScopeSql, notListedSql, problemIdOf } from './listing-readiness-problem-filter.js'
import { scopeStateRank } from './readiness-model.js'

/** The Problems view shows at most this many rows. */
export const PROBLEMS_LIMIT = 500

export const NOT_LISTED_LABEL = 'Ready, not listed'
export const NOT_LISTED_MESSAGE = 'Ready here, and not on the channel: no listing yet, a draft, or one Nexus removed.'

/* ── the rows' SQL ────────────────────────────────────────────────────────────────────────── */

type Input = ReturnType<typeof familiesQuery>
const rank = (state: ReadinessScopeState) => Prisma.raw(String(Math.trunc(scopeStateRank(state))))

/**
 * `pr_keep(root)`: the families the page lists. The readiness `state` tile keeps a family with a member's listing in
 * that state (a "not computed" fill counts for Not computed / Not checked), as `familiesSummary`'s `matched` does.
 */
export function keptFamiliesCtes(input: Pick<Input, 'state' | 'listingIds'>): Prisma.Sql {
  const states: readonly ReadinessScopeState[] | null = input.state === 'notChecked' ? ['absent', 'notComputed'] : input.state ? [input.state] : null
  if (!states) return Prisma.sql`pr_keep AS (SELECT DISTINCT root FROM f)`
  const filled = !input.listingIds && states.includes('notComputed') ? Prisma.sql` OR count(DISTINCT pid) * count(DISTINCT ck) - count(*) > 0` : Prisma.empty
  return Prisma.sql`pr_listing AS (SELECT root, pid, ck, min(rank) AS rank FROM f GROUP BY root, pid, ck),
    pr_keep AS (SELECT root FROM pr_listing GROUP BY root HAVING bool_or(rank IN (${Prisma.join(states.map(rank))}))${filled})`
}

/** A row of the readiness statement: a destination × field × (kind, requiredEmpty) group, or (`level` 1) the field's own total. */
export interface ReadinessProblemAggregate {
  ck: string; field: string; pair: string | null; level: number
  products: number; listings: number; sev: number; label: string | null; reason: string | null
}
export interface ChannelProblemAggregate {
  channel: string; market: string; account: string | null; alias: string | null; code: string; message: string; hash: string
  sev: number; products: number; listings: number; total: number
}
export interface NotListedAggregate { ck: string; products: number; listings: number }

async function readinessAggregates(base: Prisma.Sql, filter: Prisma.Sql): Promise<ReadinessProblemAggregate[]> {
  return prisma.$queryRaw<ReadinessProblemAggregate[]>(Prisma.sql`
    WITH ${base}, pr_x AS (
      SELECT r."coordinateKey" AS ck, r."productId" AS pid, COALESCE(p."parentId", p.id) AS root, r.language AS lang,
        CASE WHEN r.state = 'blocked' THEN 0 ELSE 1 END AS sev,
        COALESCE(e->>'field', '') AS field, e->>'label' AS label, e->>'reason' AS reason,
        COALESCE(e->>'kind', '') || '|' || CASE WHEN e->>'requiredEmpty' = 'true' THEN '1' ELSE '0' END AS pair
      FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.missing) = 'array' THEN r.missing ELSE '[]'::jsonb END) e
      WHERE ${filter} AND r.state IN ('blocked', 'warn') AND COALESCE(p."parentId", p.id) IN (SELECT root FROM pr_keep)
    )
    SELECT ck, field, pair, GROUPING(pair)::int AS level, count(DISTINCT root)::int AS products, count(DISTINCT pid)::int AS listings,
      min(sev)::int AS sev, min(label) AS label, (array_agg(reason ORDER BY pid, lang))[1] AS reason
    FROM pr_x GROUP BY GROUPING SETS ((ck, field, pair), (ck, field))`)
}

async function channelAggregates(base: Prisma.Sql, view: LiveSqlView): Promise<ChannelProblemAggregate[]> {
  return prisma.$queryRaw<ChannelProblemAggregate[]>(Prisma.sql`
    WITH ${base}, pr_m AS (SELECT DISTINCT root, pid FROM f WHERE root IN (SELECT root FROM pr_keep)),
    pr_i AS (
      SELECT l.id, m.root, upper(btrim(l.channel)) AS channel, ${canonMarketSql('l.marketplace')} AS market, l."channelConnectionId" AS account,
        NULLIF(l."aliasKey", '') AS alias, i.code, i.message, CASE upper(btrim(i.severity)) WHEN 'ERROR' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END AS sev
      FROM pr_m m JOIN "ChannelListing" l ON l."productId" = m.pid
      JOIN "ListingIssue" i ON i."listingId" = l.id AND i."resolvedAt" IS NULL
      WHERE TRUE${listingScopeSql(view.scope)}
    ), pr_g AS (
      SELECT channel, market, account, alias, code, message, md5(message) AS hash, min(sev)::int AS sev,
        count(DISTINCT root)::int AS products, count(DISTINCT id)::int AS listings
      FROM pr_i GROUP BY channel, market, account, alias, code, message
    )
    SELECT pr_g.*, (count(*) OVER ())::int AS total FROM pr_g
    ORDER BY products DESC, sev, listings DESC, channel, market, account, alias, code, message
    LIMIT ${PROBLEMS_LIMIT}`)
}

async function notListedAggregates(base: Prisma.Sql, view: LiveSqlView): Promise<NotListedAggregate[]> {
  return prisma.$queryRaw<NotListedAggregate[]>(Prisma.sql`
    WITH ${base}, ${notListedSql('pr_nl', 'f', view, { keep: 'pr_keep' })}
    SELECT ck, count(DISTINCT root)::int AS products, count(*)::int AS listings FROM pr_nl GROUP BY ck`)
}

async function destinationRows(filter: Prisma.Sql, input: Input, view: LiveSqlView | null): Promise<DestinationInfo[]> {
  const rows = await prisma.$queryRaw<Array<{ key: string; channel: string | null; market: string | null; accountId: string | null; aliasId: string | null; label: string; languages: string[] }>>(Prisma.sql`
    WITH ${resultCtes(filter, input, view)}
    SELECT ck AS key, channel, market, account AS "accountId", alias AS "aliasId", min(label) AS label, array_agg(DISTINCT lang) AS languages
    FROM f GROUP BY ck, channel, market, account, alias`)
  return rows.map(d => ({ ...d, languages: new Set(d.languages) }))
}

/* ── the rows in words (pure) ─────────────────────────────────────────────────────────────── */

const pairOf = (pair: string | null) => {
  const at = (pair ?? '').lastIndexOf('|')
  return { kind: at > 0 ? pair!.slice(0, at) : undefined, requiredEmpty: pair?.slice(at + 1) === '1' }
}
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/** Readiness rows: one per destination × field — its most urgent kind (then most listings), that group's label and sentence. */
export function readinessProblemRows(rows: readonly ReadinessProblemAggregate[], destinationOf: (key: string) => ReadinessDestination): ReadinessProblemRow[] {
  const fields = new Map<string, { total?: ReadinessProblemAggregate; best?: { kind: ReadinessProblemKind; row: ReadinessProblemAggregate } }>()
  for (const row of rows) {
    const key = `${row.ck}\u0000${row.field}`
    let entry = fields.get(key)
    if (!entry) fields.set(key, entry = {})
    if (Number(row.level) === 1) { entry.total = row; continue }
    const kind = readinessProblemKind(pairOf(row.pair)), best = entry.best
    const order = best ? kindRank(kind) - kindRank(best.kind) || Number(best.row.listings) - Number(row.listings) || cmp(row.pair ?? '', best.row.pair ?? '') : -1
    if (order < 0) entry.best = { kind, row }
  }
  const out: ReadinessProblemRow[] = []
  for (const { total, best } of fields.values()) {
    if (!best || !total) continue
    out.push({
      id: problemIdOf({ source: 'readiness', destinationKey: total.ck, field: total.field }), source: 'readiness',
      label: best.row.label || total.field || 'Readiness check', state: Number(total.sev) === 0 ? 'blocked' : 'warn', kind: best.kind,
      field: total.field, code: null, severity: null, message: best.row.reason ?? '', destination: destinationOf(total.ck),
      products: Number(total.products), listings: Number(total.listings),
    })
  }
  return out
}

const SEVERITY = ['error', 'warning', 'info'] as const
export function channelProblemRows(rows: readonly ChannelProblemAggregate[], destinationOf: (key: string) => ReadinessDestination): ReadinessProblemRow[] {
  return rows.map((row): ReadinessProblemRow => {
    const key = liveDestinationKey({ channel: row.channel, marketplace: row.market, channelConnectionId: row.account, aliasKey: row.alias })
    return {
      id: problemIdOf({ source: 'channel', destinationKey: key, hash: row.hash, code: row.code }), source: 'channel',
      label: `Message from ${channelName(row.channel)}`, state: null, kind: null, field: null, code: row.code,
      severity: SEVERITY[Math.min(2, Math.max(0, Number(row.sev)))], message: row.message, destination: destinationOf(key),
      products: Number(row.products), listings: Number(row.listings),
    }
  })
}

export function notListedProblemRows(rows: readonly NotListedAggregate[], destinationOf: (key: string) => ReadinessDestination): ReadinessProblemRow[] {
  return rows.map((row): ReadinessProblemRow => ({
    id: problemIdOf({ source: 'notListed', destinationKey: row.ck }), source: 'notListed', label: NOT_LISTED_LABEL, state: null, kind: null,
    field: null, code: null, severity: null, message: NOT_LISTED_MESSAGE, destination: destinationOf(row.ck),
    products: Number(row.products), listings: Number(row.listings),
  }))
}

const groupOf = (row: ReadinessProblemRow) => row.source === 'readiness' ? (row.state === 'blocked' ? 0 : 1) : row.source === 'channel' ? 2 : 3
const severityRank = (row: ReadinessProblemRow) => row.severity ? SEVERITY.indexOf(row.severity) : 0

/** Blocked, Warnings, channel messages, Ready-not-listed; then most products; then errors first, most listings, the chips' order, the words. */
export function compareProblems(order: (key: string) => number) {
  return (a: ReadinessProblemRow, b: ReadinessProblemRow): number =>
    groupOf(a) - groupOf(b) || b.products - a.products || severityRank(a) - severityRank(b) || b.listings - a.listings
    || order(a.destination.key) - order(b.destination.key) || cmp(a.label.toLowerCase(), b.label.toLowerCase()) || cmp(a.message, b.message) || cmp(a.id, b.id)
}

/* ── the read ─────────────────────────────────────────────────────────────────────────────── */

/** The families page's query, its own `problem` left out: the Problems view lists every problem of the result. */
const problemsAsked = (query: Record<string, unknown>) => ({ ...query, problem: undefined })

/** GET /api/catalog-transfer/readiness/problems */
export async function readinessProblems(query: Record<string, unknown>, userId: string | null, options: LiveOptions = {}): Promise<ReadinessProblemsPage> {
  return (await problemsRead(query, userId, undefined, options)).page!
}
/** The same, with its ETag; `page` is null when `unchanged(etag)` (the route says 304). */
export function readinessProblemsIfChanged(query: Record<string, unknown>, userId: string | null, unchanged: (etag: string) => boolean,
  options: LiveOptions = {}): Promise<FreshAnswer<ReadinessProblemsPage>> {
  return problemsRead(query, userId, unchanged, options)
}

async function problemsRead(query: Record<string, unknown>, userId: string | null, unchanged?: (etag: string) => boolean, options: LiveOptions = {}): Promise<FreshAnswer<ReadinessProblemsPage>> {
  const asked = problemsAsked(query)
  const input = familiesQuery(asked)
  return inDatabaseReadTransaction(prisma, async () => {
    const filter = await readinessFilter(asked, input.q, userId)
    const view = await liveSqlView(input, options.live === true)
    const etag = unchanged
      ? await readinessEtag(filter, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), { endpoint: 'problems', query: asked, userId }, undefined, !!view)
      : null
    if (etag && unchanged!(etag)) return { etag, page: null }

    const infos = await destinationRows(filter, input, view)
    const described = describeDestinations(infos, await storeNamesFor(infos))
    const position = new Map(described.map((d, i) => [d.key, i]))
    const byKey = new Map(described.map(d => [d.key, d]))
    const byCanonical = new Map(described.map(d => [canonicalDestinationKey(d.key), d]))
    const base = Prisma.sql`${resultCtes(filter, input, view)}, ${keptFamiliesCtes(input)}`

    const readiness = readinessProblemRows(await readinessAggregates(base, filter), key => byKey.get(key) ?? byCanonical.get(canonicalDestinationKey(key))!)
    let channel: ReadinessProblemRow[] = [], channelTotal = 0, notListed: ReadinessProblemRow[] = []
    if (view) {
      const messages = await channelAggregates(base, view)
      channelTotal = messages[0] ? Number(messages[0].total) : 0
      // A message on a listing no readiness destination of the result names (an extra chip on the page) keeps its words.
      const keys = messages.map(m => liveDestinationKey({ channel: m.channel, marketplace: m.market, channelConnectionId: m.account, aliasKey: m.alias }))
      const missing = [...new Set(keys.filter(key => !byCanonical.has(key)))]
      const extras = new Map<string, ReadinessDestination>()
      if (missing.length) {
        const [footprint, facts] = [await readinessFootprint(), await extraDestinationFacts(missing)]
        for (const key of missing) extras.set(key, extraDestination(key, footprint, facts))
      }
      channel = channelProblemRows(messages, key => byCanonical.get(key) ?? extras.get(key)!)
      notListed = notListedProblemRows(await notListedAggregates(base, view), key => byKey.get(key)!)
    }
    const order = (key: string) => position.get(key) ?? described.length
    const rows = [...readiness, ...channel, ...notListed].sort(compareProblems(order))
    return { etag, page: { rows: rows.slice(0, PROBLEMS_LIMIT), total: readiness.length + channelTotal + notListed.length, limit: PROBLEMS_LIMIT, live: !!view } }
  })
}
