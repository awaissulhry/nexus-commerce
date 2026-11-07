import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import type { PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { GROUPS_OF_KIND, PARTNER_SEARCH_LIMITS, type PartnerSearchAnswer, type PartnerSearchGroup, type PartnerSearchResult } from '@nexus/factory-domain/search/partner/contracts'
import { compareHits, partnerMatchOf, singleOf, type PartnerHit } from '@nexus/factory-domain/search/partner/match'
import { PORTAL_SEARCH } from '@nexus/factory-domain/search/partner/permissions'
import { queryWords, SEARCH_LIMITS, type SearchQuery } from '@nexus/factory-domain/search/text'
import { systemCallerOf } from '../../files/files'
import { kindsOfSession, partnerCallerOf, type PartnerCaller } from './session'
import type { PartnerRecord, PartnerView } from './view'
import { PARTNER_VIEWS, viewFits } from './views'

/**
 * GET /portal/search (B-W2b-168; SAL-084; design portal.frame › top-bar "Search orders, documents… (your PO number works)",
 * portal.customer.home › search-hero). A partner finds its own records by their references and ours:
 *
 *   1. candidates from the office's search index (B-W2a-32, B-W2b-23: SearchEntry, read in the tenant's system scope — the
 *      partner role reads no entry): entries of the party (the entry's party column, which is the record's), of the record
 *      types the person's portal shows, of the session's company or tenant-wide, matching every word as the office search
 *      does (as typed, or alike: pg_trgm word similarity) or the number typed whole; at most `candidates`;
 *   2. the partner's own references the index may not hold (their reference, their article codes, a tracking number): each
 *      partner view's lookup, in the PARTNER scope;
 *   3. the wall: every candidate read again through its partner view in the PARTNER scope (factory_partner_runtime: the
 *      party's row-level security, the partner column grants), only in the states the partner knows it in; can()
 *      portal.search over its company and party (the session's company), and a grain where the view asks one (an
 *      invoice: the price);
 *   4. kept only when the query matches its PARTNER fields (factory-domain search/partner/match): a word only the office
 *      sees finds nothing; their reference typed whole first, our number second, every word, words alike; then the
 *      newest; grouped by the portal's groups (orders, documents, returns, jobs, pos) in the kind's order.
 * Enter opens `single` directly. Nothing here is money; nothing is written.
 */

export interface PartnerSearchParams {
  readonly q: string
  readonly group?: PartnerSearchGroup | undefined
  readonly limit: number
}

interface Candidate {
  readonly recordType: string
  readonly recordId: string
}

/** Bound values as `$n` placeholders. */
class Values {
  readonly list: unknown[] = []
  add(value: unknown): string {
    this.list.push(value)
    return `$${this.list.length}`
  }
}

/** The index entries of the party that match the query (step 1), best first, one more than `candidates` (to say `capped`). */
async function indexCandidates(client: FactoryClient, where: { partyId: string; companyId: string; recordTypes: readonly string[] }, query: SearchQuery): Promise<Candidate[]> {
  const values = new Values()
  const text = 'e."searchText"'
  const threshold = values.add(SEARCH_LIMITS.wordSimilarity)
  const words = query.words.map((word) => ({ at: values.add(word), fuzzy: word.length >= SEARCH_LIMITS.fuzzyWordLength }))
  const inside = words.map(({ at }) => `strpos(${text}, ${at}) > 0`)
  const each = words.map(({ at, fuzzy }, index) => (fuzzy ? `(${inside[index]} OR word_similarity(${at}, ${text}) >= ${threshold}::real)` : inside[index]!))
  const score = words.map(({ at, fuzzy }, index) => (fuzzy ? `word_similarity(${at}, ${text})` : `CASE WHEN ${inside[index]} THEN 1 ELSE 0 END`))
  const exact = `(e."number" IS NOT NULL AND lower(e."number") = ${values.add(query.whole.toLowerCase())})`
  const match = each.length > 0 ? `(${exact} OR (${each.join(' AND ')}))` : exact
  return client.$queryRawUnsafe<Candidate[]>(
    `SELECT e."recordType", e."recordId"::text AS "recordId"
       FROM "SearchEntry" e
      WHERE e."partyId" = ${values.add(where.partyId)}::uuid
        AND e."recordType" = ANY(string_to_array(${values.add(where.recordTypes.join(','))}::text, ','))
        AND (e."companyId" IS NULL OR e."companyId" = ${values.add(where.companyId)}::uuid)
        AND ${match}
      ORDER BY ${exact} DESC, ${inside.length > 0 ? `(${inside.join(' AND ')})` : 'false'} DESC, ${score.length > 0 ? `(${score.join(' + ')})` : '0'} DESC, e."indexedAt" DESC, e."id"
      LIMIT ${values.add(PARTNER_SEARCH_LIMITS.candidates + 1)}::int`,
    ...values.list,
  )
}

/** The groups the person's portal shows (the kinds' groups, in the first kind's order), or the one asked. */
function groupsOf(kinds: readonly PartnerKind[], asked: PartnerSearchGroup | undefined): PartnerSearchGroup[] {
  const groups = [...new Set(kinds.flatMap((kind) => GROUPS_OF_KIND[kind]))]
  return asked ? groups.filter((group) => group === asked) : groups
}

/** The person may find this record: portal.search over its company and the party, and the view's grain. */
function mayFind(caller: PartnerCaller, view: PartnerView, record: PartnerRecord): boolean {
  const scope = { companyId: record.companyId, partyId: caller.context.partyId }
  if (!can(caller.actor, PORTAL_SEARCH, scope)) return false
  return view.grain === undefined || can(caller.actor, grainPermission(view.grain), scope)
}

const timeOf = (record: PartnerRecord): number => record.date?.getTime() ?? 0

function emptyAnswer(query: SearchQuery): PartnerSearchAnswer {
  return { query: query.text, words: [...query.words], tooShort: query.tooShort, groups: [], found: 0, single: null, capped: false }
}

export async function searchForPartner(request: FastifyRequest, params: PartnerSearchParams): Promise<PartnerSearchAnswer> {
  const caller = partnerCallerOf(request)
  const query = queryWords(params.q)
  if (query.tooShort) return emptyAnswer(query)
  const kinds = await request.withClient((client) => kindsOfSession(client, caller))
  const groups = groupsOf(kinds, params.group)
  const views = PARTNER_VIEWS.filter((view) => view.group !== null && groups.includes(view.group) && viewFits(view, kinds))
  if (views.length === 0) return emptyAnswer(query)

  // 1. The index, in the tenant's system scope: only the party's entries of these types in the session's company.
  const system = systemCallerOf(request)(caller.context.tenantId)
  const indexed = await system.withClient((client) =>
    indexCandidates(client, { partyId: caller.context.partyId, companyId: caller.session.company.id, recordTypes: views.map((view) => view.recordType) }, query),
  )
  const capped = indexed.length > PARTNER_SEARCH_LIMITS.candidates

  // 2.–4. Lookups, the wall and the match, in the partner's own scope.
  return request.withClient(async (client) => {
    const wanted = new Map<string, Set<string>>(views.map((view) => [view.recordType, new Set<string>()]))
    for (const candidate of indexed.slice(0, PARTNER_SEARCH_LIMITS.candidates)) wanted.get(candidate.recordType)?.add(candidate.recordId)
    const typed = query.whole.trim()
    for (const view of views) {
      if (!view.lookup) continue
      for (const id of await view.lookup(client, typed, PARTNER_SEARCH_LIMITS.lookup)) wanted.get(view.recordType)!.add(id)
    }

    const found: { result: PartnerSearchResult; hit: PartnerHit; time: number }[] = []
    for (const view of views) {
      const ids = [...wanted.get(view.recordType)!]
      if (ids.length === 0) continue
      for (const record of await view.read(client, ids)) {
        if (!mayFind(caller, view, record)) continue
        const hit = partnerMatchOf(query, record)
        if (!hit) continue
        found.push({
          hit,
          time: timeOf(record),
          result: {
            recordType: view.recordType,
            recordId: record.id,
            group: view.group!,
            theirRef: record.theirRef,
            ourRef: record.ourRef,
            subtitle: record.subtitle,
            status: record.status,
            date: record.date ? toUtcIso(record.date) : null,
            match: hit.match,
          },
        })
      }
    }
    found.sort((a, b) => compareHits(a.hit, b.hit) || b.time - a.time || a.result.recordId.localeCompare(b.result.recordId))
    const ordered = found.map((entry) => entry.result)
    return {
      query: query.text,
      words: [...query.words],
      tooShort: false,
      groups: groups.flatMap((group) => {
        const inGroup = ordered.filter((result) => result.group === group)
        return inGroup.length > 0 ? [{ group, count: inGroup.length, results: inGroup.slice(0, params.limit) }] : []
      }),
      found: ordered.length,
      single: singleOf(ordered),
      capped,
    }
  })
}
