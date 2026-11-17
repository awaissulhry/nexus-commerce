import type { FactoryClient } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { Actor, Grant } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { SearchAnswer, SearchMatch } from '@nexus/factory-domain/search/contracts'
import { queryWords, SEARCH_LIMITS, type SearchQuery } from '@nexus/factory-domain/search/text'
import type { CommandCaller } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { ApiError } from '../../core/errors'
// B-TH-097: each message hit is read again against its thread (the record type's gate, the thread's scope now).
import { mayOnThread } from '../threads/records'
import { wallScopesOf } from '../threads/records' // B-PR-08a part 2: a work order's, hold's or NCR's message hit through its customer

/**
 * GET /search (B-W2a-32; PLT-153; design shell.search: the palette's Exact number and Records groups, the All results
 * page). Finds the reader's records by number and name with typos forgiven:
 *
 *   - the query is folded as the entries' text is (factory-domain search/text: lower case, no accents) and cut into
 *     words; EVERY word must be in the entry's text — as typed (inside a word: `42` finds `ord-2026-00042`), or, for a
 *     word of 3 letters or more, as a similar word (pg_trgm `word_similarity` ≥ SEARCH_LIMITS.wordSimilarity: `pisra`
 *     finds `pista`). The query typed whole also matches an entry's number exactly, case aside (a scan, a paste).
 *     Why not `"searchText" % $1` (whole-text similarity): an entry's text is its number, name and more, so one name in
 *     it scores far under any threshold (`pista` against an order's text: 0.125); word similarity scores the best
 *     matching extent of the text instead (1.0);
 *   - only what the reader may open: an entry is seen through a grant that holds its view permission AND reaches its
 *     company, site and party (a null column is not limited), exactly as can()/scopeWhere() treat the record itself;
 *     B-PR-08a: an entry of several customers (`everyParty`) only through a grant that reaches every customer;
 *   - ordered: the number typed whole first, then every word found as typed, then by how alike, then by where the
 *     words sit (a record's own number and name come first in its text), the screen's company (and tenant-wide records)
 *     before other companies', the newest entry first;
 *   - `counts` per record type (the type filter aside) for the results page's chips; `asOf` = the tenant index's newest
 *     write. Results hold no money (entries have none);
 *   - B-TH-097: messages only when asked (type=Message, optionally of one record's thread), each read again against its thread.
 * The query runs as one raw statement of the reader's office scope (row-level security holds the tenant), values bound.
 */

interface Row {
  recordType: string
  recordId: string
  number: string | null
  title: string
  subtitle: string | null
  status: string | null
  area: string
  companyId: string | null
  siteId: string | null
  exact: boolean
  inside: boolean
  indexedAt: Date
  total: number
}

/** Bound values as `$n` placeholders. */
class Values {
  readonly list: unknown[] = []
  add(value: unknown): string {
    this.list.push(value)
    return `$${this.list.length}`
  }
  /** A list of plain ids or names (no comma in any) as a text array. */
  textArray(values: readonly string[]): string {
    return `string_to_array(${this.add(values.join(','))}::text, ',')`
  }
}

const SCOPE_COLUMNS = [
  ['companyId', 'companies'],
  ['siteId', 'sites'],
  ['partyId', 'parties'],
] as const satisfies readonly (readonly [string, keyof Grant])[]

/** The entries the reader may see: OR over their grants of (view permission held AND company, site, party reached). */
function visibleSql(actor: Actor, values: Values): string | null {
  if (actor.audience !== 'office') return null
  const seen = new Set<string>()
  const clauses: string[] = []
  for (const grant of actor.grants) {
    if (grant.permissions.length === 0) continue
    const key = JSON.stringify([[...grant.permissions].sort(), grant.companies, grant.sites, grant.parties])
    if (seen.has(key)) continue
    seen.add(key)
    const parts = [`e."viewPermission" = ANY(${values.textArray(grant.permissions)})`]
    for (const [column, scope] of SCOPE_COLUMNS) {
      const set = grant[scope]
      if (set === 'all') continue
      parts.push(`(e."${column}" IS NULL OR e."${column}"::text = ANY(${values.textArray(set as readonly string[])}))`)
    }
    // ---- B-PR-08a part 2 (the brand wall): an entry of several customers, or of customer work of none (SearchEntry.everyParty, the
    // ONE marker, B-PR-01), only through a grant that reaches every customer — a list never does, however long.
    if (grant.parties !== 'all') parts.push(`NOT e."everyParty"`)
    // ---- end B-PR-08a
    clauses.push(`(${parts.join(' AND ')})`)
  }
  return clauses.length > 0 ? `(${clauses.join(' OR ')})` : null
}

/** The match of the query's words and its number, and the expressions the order reads. */
function matchSql(query: SearchQuery, values: Values) {
  const text = 'e."searchText"'
  const threshold = values.add(SEARCH_LIMITS.wordSimilarity)
  const words = query.words.map((word) => ({ word, at: values.add(word), fuzzy: word.length >= SEARCH_LIMITS.fuzzyWordLength }))
  const inside = words.map(({ at }) => `strpos(${text}, ${at}) > 0`)
  const each = words.map(({ at, fuzzy }, index) => (fuzzy ? `(${inside[index]} OR word_similarity(${at}, ${text}) >= ${threshold}::real)` : inside[index]!))
  const score = words.map(({ at, fuzzy }, index) => (fuzzy ? `word_similarity(${at}, ${text})` : `CASE WHEN ${inside[index]} THEN 1 ELSE 0 END`))
  // Where in the text the words sit: the text starts with the number and the name, so a record found by its own name
  // comes before one that only names it among its other words (an order naming its customer).
  const position = words.map(({ at }) => `CASE WHEN strpos(${text}, ${at}) > 0 THEN strpos(${text}, ${at}) ELSE ${SEARCH_LIMITS.maxText} END`)
  const exact = `(e."number" IS NOT NULL AND lower(e."number") = ${values.add(query.whole.toLowerCase())})`
  return {
    exact,
    inside: inside.length > 0 ? `(${inside.join(' AND ')})` : 'false',
    match: each.length > 0 ? `(${exact} OR (${each.join(' AND ')}))` : exact,
    score: score.length > 0 ? `(${score.join(' + ')})` : '0',
    position: position.length > 0 ? `(${position.join(' + ')})` : '0',
  }
}

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (context.audience !== 'office') throw new ApiError('forbidden')
  return context
}

export interface SearchParams {
  readonly q: string
  readonly type?: string | undefined
  readonly limit: number
  readonly offset: number
  /** B-TH-097: with type=Message, the messages of this record's thread only. */
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  /** B-TH-231: only these record types (the files' "Use on" picker: the types a thread resolver knows). */
  readonly types?: readonly string[] | undefined
}

// ---- B-TH-097 (threads plan TH-9, G11: search inside messages, office only) -----------------------------------------------------
/**
 * Messages are found only when asked (type=Message: the results page's Messages chip, "Search in the thread" with its record):
 * never among the records of the palette or of every type. Their entries are seen as the thread is read (threads.read over the
 * thread's company, site and party; a gated record type's notes are never indexed: indexers/message.ts); each hit is then read
 * again here, against its thread as it is NOW (its gate and scope: a thread that took its customer since is that customer's), and
 * named with the record it opens. A hit that fails is left out, unannounced.
 */
export const MESSAGE_TYPE = 'Message'

async function messageRecords(client: FactoryClient, actor: Actor, ids: readonly string[]): Promise<Map<string, { type: string; id: string }>> {
  const seen = new Map<string, { type: string; id: string }>()
  if (ids.length === 0) return seen
  const rows = await client.message.findMany({ where: { id: { in: [...ids] } }, select: { id: true, thread: { select: { recordType: true, recordId: true, companyId: true, siteId: true, partyId: true } } } })
  const scopeOf = await wallScopesOf(client, rows.map((row) => row.thread)) // B-PR-08a part 2: the thread's customer now
  for (const row of rows) {
    if (mayOnThread(actor, THREADS_READ, row.thread.recordType, scopeOf(row.thread))) seen.set(row.id, { type: row.thread.recordType, id: row.thread.recordId })
  }
  return seen
}
// ---- end B-TH-097

const matchOf = (row: Pick<Row, 'exact' | 'inside'>): SearchMatch => (row.exact ? 'number' : row.inside ? 'words' : 'similar')

export async function searchRecords(caller: CommandCaller, params: SearchParams): Promise<SearchAnswer> {
  const context = officeOf(caller)
  const query = queryWords(params.q)
  const empty: SearchAnswer = { query: query.text, words: [...query.words], tooShort: query.tooShort, results: [], counts: [], total: 0, nextOffset: null, asOf: null }
  return caller.withClient(async (client) => {
    const newest = await client.searchEntry.aggregate({ _max: { indexedAt: true } })
    const asOf = newest._max.indexedAt ? toUtcIso(newest._max.indexedAt) : null
    if (query.tooShort) return { ...empty, asOf }
    const values = new Values()
    const visible = visibleSql(actorOf(context), values)
    if (!visible) return { ...empty, asOf }
    const sql = matchSql(query, values)
    // B-TH-097: messages only when asked (and then, with a record, that record's thread alone).
    const asked = params.type === MESSAGE_TYPE
    const thread =
      asked && params.recordType && params.recordId
        ? ` AND EXISTS (SELECT 1 FROM "Message" m JOIN "Thread" t ON t."tenantId" = m."tenantId" AND t.id = m."threadId" WHERE m.id = e."recordId" AND t."recordType" = ${values.add(params.recordType)} AND t."recordId" = ${values.add(params.recordId)}::uuid)`
        : ''
    // B-TH-231: a caller may keep to some record types (the picker of a file's other record).
    const among = params.types && params.types.length > 0 ? ` AND e."recordType" = ANY(${values.textArray(params.types)})` : ''
    const where = `${visible} AND ${sql.match}${asked ? thread : ` AND e."recordType" <> '${MESSAGE_TYPE}'`}${among}`
    const countValues = values.list.length
    const typed = params.type ? ` AND e."recordType" = ${values.add(params.type)}` : ''
    // B-W2b-36: with no company chosen this term is left out (a bare `true DESC` is a constant ORDER BY: PostgreSQL refuses it).
    const here = context.companyId ? `coalesce(e."companyId" = ${values.add(context.companyId)}::uuid, true) DESC, ` : ''
    const limit = values.add(params.limit)
    const offset = values.add(params.offset)
    const rows = await client.$queryRawUnsafe<Row[]>(
      `SELECT e."recordType", e."recordId"::text AS "recordId", e."number", e."title", e."subtitle", e."status", e."area",
              e."companyId"::text AS "companyId", e."siteId"::text AS "siteId", ${sql.exact} AS "exact", ${sql.inside} AS "inside",
              e."indexedAt", (count(*) OVER ())::int AS "total"
         FROM "SearchEntry" e
        WHERE ${where}${typed}
        ORDER BY ${sql.exact} DESC, ${sql.inside} DESC, ${sql.score} DESC, ${sql.position} ASC, ${here}e."indexedAt" DESC, e."id"
        LIMIT ${limit}::int OFFSET ${offset}::int`,
      ...values.list,
    )
    const counts = await client.$queryRawUnsafe<{ recordType: string; count: number }[]>(
      `SELECT e."recordType", (count(*))::int AS "count" FROM "SearchEntry" e WHERE ${where} GROUP BY e."recordType" ORDER BY 2 DESC, 1`,
      ...values.list.slice(0, countValues),
    )
    const total = rows[0]?.total ?? (params.offset > 0 ? (params.type ? (counts.find((entry) => entry.recordType === params.type)?.count ?? 0) : counts.reduce((sum, entry) => sum + entry.count, 0)) : 0)
    // B-TH-097: each message hit read again against its thread now, with the record it opens.
    const records = await messageRecords(client, actorOf(context), rows.filter((row) => row.recordType === MESSAGE_TYPE).map((row) => row.recordId))
    const shown = rows.filter((row) => row.recordType !== MESSAGE_TYPE || records.has(row.recordId))
    return {
      query: query.text,
      words: [...query.words],
      tooShort: false,
      results: shown.map((row) => ({
        recordType: row.recordType,
        recordId: row.recordId,
        number: row.number,
        title: row.title,
        subtitle: row.subtitle,
        status: row.status,
        area: row.area,
        companyId: row.companyId,
        siteId: row.siteId,
        match: matchOf(row),
        indexedAt: toUtcIso(new Date(row.indexedAt)),
        ...(records.has(row.recordId) ? { record: records.get(row.recordId)! } : {}),
      })),
      counts,
      total,
      nextOffset: params.offset + rows.length < total ? params.offset + rows.length : null,
      asOf,
    }
  })
}
