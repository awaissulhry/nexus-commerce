/**
 * Listings live layer, step 7 (docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md) — the Problems view's ids and the
 * `problem=<id>` filter of the families page (its Show products).
 *
 * One problem is one row of the Problems view: a thing to fix on one destination. Three sources, three id shapes; the
 * destination key is the JSON tuple `[channel, market, account, alias]` the index and the live layer use:
 *   r:<destinationKey>:<field>        a readiness problem — an index row of that destination names the field in `missing[]`
 *   c:<destinationKey>:<md5>:<code>   a channel message — an open `ListingIssue` with that code and, word for word, the
 *                                     message whose md5 is given; the key is the listing's own (`liveDestinationKey`)
 *   n:<destinationKey>                Ready, not listed — the product is Ready there and has no listing on the channel
 *                                     (none, a draft, or one Nexus removed)
 *
 * The filter keeps whole FAMILIES (`pf_keep`): a family stays when one of its products has the problem, under the page's
 * own filters. `resultCtes` (listing-readiness-families.service.ts) applies it beside the live filters, so the total, the
 * paging and every tile follow it. The channel sources need `listings.view`; without it they are ignored, like the live
 * filters. This file reads no other readiness module: the families service imports it.
 */
import { Prisma } from '@prisma/client'
import { liveJoinsSql, type LiveScope, type LiveSqlView } from './listing-readiness-live.service.js'
import { scopeStateRank } from './readiness-model.js'

export type ProblemSource = 'readiness' | 'channel' | 'notListed'
export type ProblemId =
  | { source: 'readiness'; destinationKey: string; field: string }
  | { source: 'channel'; destinationKey: string; hash: string; code: string }
  | { source: 'notListed'; destinationKey: string }

/** A problem id never needs more: a key of four ids, a field or a code. */
export const PROBLEM_ID_MAX = 1200
const MD5 = /^[0-9a-f]{32}$/

export function problemIdOf(problem: ProblemId): string {
  switch (problem.source) {
    case 'readiness': return `r:${problem.destinationKey}:${problem.field}`
    case 'channel': return `c:${problem.destinationKey}:${problem.hash}:${problem.code}`
    case 'notListed': return `n:${problem.destinationKey}`
  }
}

/** The destination key at the start of `rest` (a JSON array of four strings or nulls), re-serialized, and what follows. */
function splitKey(rest: string): { key: string; parts: Array<string | null>; tail: string } | null {
  if (!rest.startsWith('[')) return null
  for (let at = rest.indexOf(']'); at >= 0; at = rest.indexOf(']', at + 1)) {
    let parsed: unknown
    try { parsed = JSON.parse(rest.slice(0, at + 1)) } catch { continue }
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some(v => v !== null && (typeof v !== 'string' || v.length > 200))) return null
    return { key: JSON.stringify(parsed), parts: parsed as Array<string | null>, tail: rest.slice(at + 1) }
  }
  return null
}

/** An id back into its parts; null when it is not one. */
export function parseProblemId(raw: string): ProblemId | null {
  if (raw.length > PROBLEM_ID_MAX || raw[1] !== ':') return null
  const split = splitKey(raw.slice(2))
  if (!split) return null
  const hasChannel = !!split.parts[0]
  switch (raw[0]) {
    case 'n':
      return split.tail === '' && hasChannel ? { source: 'notListed', destinationKey: split.key } : null
    case 'r':
      return split.tail.startsWith(':') ? { source: 'readiness', destinationKey: split.key, field: split.tail.slice(1) } : null
    case 'c': {
      const tail = split.tail.slice(1), hash = tail.slice(0, 32)
      if (!split.tail.startsWith(':') || !hasChannel || !MD5.test(hash) || tail[32] !== ':') return null
      return { source: 'channel', destinationKey: split.key, hash, code: tail.slice(33) }
    }
  }
  return null
}

/** `problem` of a request: none → nothing; anything that is not an id is refused (400), never guessed. */
export function problemQuery(query: Record<string, unknown>): { problem?: ProblemId } {
  const raw = query.problem
  if (raw === undefined || raw === '') return {}
  const problem = typeof raw === 'string' ? parseProblemId(raw) : null
  if (!problem) throw new Error('Select a problem from the Problems view')
  return { problem }
}

/* ── SQL shared by the filter and the Problems view ───────────────────────────────────────── */

/** A market code as the live layer's join rule reads it (GB = UK), in SQL (`listing-readiness-live.service.ts`' own rule). */
export const canonMarketSql = (column: string) => Prisma.raw(`CASE upper(btrim(COALESCE(${column}, ''))) WHEN 'GB' THEN 'UK' ELSE upper(btrim(COALESCE(${column}, ''))) END`)

/** The page's channel / market / account / listing selection as it narrows the listings `l` (as `liveCtes` applies it). */
export function listingScopeSql(scope: LiveScope): Prisma.Sql {
  const parts: Prisma.Sql[] = []
  if (scope.channel) parts.push(scope.channel === 'SHARED' ? Prisma.sql`FALSE` : Prisma.sql`upper(btrim(l.channel)) = ${scope.channel}`)
  if (scope.marketplace) {
    const market = scope.marketplace.trim().toUpperCase()
    parts.push(Prisma.sql`${canonMarketSql('l.marketplace')} = ${market === 'GB' ? 'UK' : market}`)
  }
  if (scope.accountId) parts.push(Prisma.sql`l."channelConnectionId" = ${scope.accountId}`)
  if (scope.listingIds) parts.push(Prisma.sql`l.id = ANY(${[...scope.listingIds]}::text[])`)
  return parts.length ? Prisma.sql` AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

const READY_RANK = Prisma.raw(String(scopeStateRank('ready')))

/**
 * `<name>(root, pid, ck)`: the product × destination pairs of `src` (readiness rows with `root, pid, ck, channel, market,
 * account, alias, rank`) that are Ready there — every language of the pair — and have no listing on the channel there:
 * none, a draft, or one Nexus removed (the live layer's join rule and selling state, `liveJoinsSql`). Shared has no
 * channel. `key` narrows to one destination; `keep` to the families of a CTE with a `root` column.
 */
export function notListedSql(name: string, src: string, view: LiveSqlView, options: { key?: string; keep?: string } = {}): Prisma.Sql {
  const where = [Prisma.sql`channel IS NOT NULL`]
  if (options.key !== undefined) where.push(Prisma.sql`ck = ${options.key}`)
  if (options.keep) where.push(Prisma.sql`root IN (SELECT root FROM ${Prisma.raw(options.keep)})`)
  return Prisma.sql`${Prisma.raw(name)} AS (
      SELECT x.root, x.pid, x.ck FROM (
        SELECT root, pid, ck, channel, market, account, alias FROM ${Prisma.raw(src)} WHERE ${Prisma.join(where, ' AND ')}
         GROUP BY root, pid, ck, channel, market, account, alias HAVING min(rank) = ${READY_RANK}) x
       WHERE NOT EXISTS (
        SELECT 1 FROM "ChannelListing" l ${liveJoinsSql({ presence: view.presence })}
         WHERE l."productId" = x.pid AND upper(btrim(l.channel)) = upper(btrim(x.channel)) AND ${canonMarketSql('l.marketplace')} = ${canonMarketSql('x.market')}
           AND l."channelConnectionId" = x.account AND NULLIF(l."aliasKey", '') IS NOT DISTINCT FROM x.alias${listingScopeSql(view.scope)}
           AND live_s.state NOT IN ('not_listed', 'draft')))`
}

/**
 * The `problem=<id>` filter as the CTE `pf_keep(root)`: the families of `src` (the page's filtered readiness rows, as
 * `resultCtes`' `f0`) with that problem, or null when there is nothing to filter (no problem; a channel source without
 * `listings.view`). `filter` is the page's own readiness selection over `"ReadinessIndex" r JOIN "Product" p`, so a
 * readiness problem counts under the same filters (a language, a selection, the search) as the rows the page shows.
 */
export function problemFilterCtes(src: string, filter: Prisma.Sql, problem: ProblemId | undefined, view: LiveSqlView | null): Prisma.Sql | null {
  if (!problem) return null
  if (problem.source === 'readiness') {
    return Prisma.sql`pf_keep AS (
      SELECT DISTINCT COALESCE(p."parentId", p.id) AS root FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
       WHERE ${filter} AND r."coordinateKey" = ${problem.destinationKey} AND r.state IN ('blocked', 'warn') AND jsonb_typeof(r.missing) = 'array'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.missing) e WHERE COALESCE(e->>'field', '') = ${problem.field}))`
  }
  if (!view) return null
  if (problem.source === 'notListed') {
    return Prisma.sql`${notListedSql('pf_nl', src, view, { key: problem.destinationKey })}, pf_keep AS (SELECT DISTINCT root FROM pf_nl)`
  }
  const [channel, market, account, alias] = JSON.parse(problem.destinationKey) as Array<string | null>
  return Prisma.sql`pf_keep AS (
      SELECT DISTINCT m.root FROM (SELECT DISTINCT root, pid FROM ${Prisma.raw(src)}) m
        JOIN "ChannelListing" l ON l."productId" = m.pid
       WHERE upper(btrim(l.channel)) = ${channel ?? ''} AND ${canonMarketSql('l.marketplace')} = ${market ?? ''}
         AND l."channelConnectionId" IS NOT DISTINCT FROM ${account} AND NULLIF(l."aliasKey", '') IS NOT DISTINCT FROM ${alias}${listingScopeSql(view.scope)}
         AND EXISTS (SELECT 1 FROM "ListingIssue" i WHERE i."listingId" = l.id AND i."resolvedAt" IS NULL AND i.code = ${problem.code} AND md5(i.message) = ${problem.hash}))`
}
