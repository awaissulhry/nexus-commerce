import { describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, step 4 — the publish history core: merging sources with one keyset cursor.
 *
 * Fake sources share timestamps on purpose: a page boundary that falls inside a run of equal times, across two
 * sources, must neither repeat nor skip a run. The query parser refuses wrong values with words a person can act on,
 * and every source is named in `coverage`, so a missing one is never silent.
 */
vi.mock('../../db.js', () => ({ default: {
  product: { findFirst: async ({ where }: { where: { id: string } }) =>
    where.id === 'child' ? { id: 'child', parentId: 'family' } : where.id === 'family' ? { id: 'family', parentId: null } : null },
  userProfile: { findMany: async () => [{ id: 'u1', displayName: 'Publisher Person' }, { id: 'u2', displayName: 'Checker Person' }] },
} }))

import type { HistoryCoverage, HistorySource } from '@nexus/shared/publication-history'
import { decodeCursor, encodeCursor, listPublicationHistory, parseHistoryQuery, publicationRunDetail, sourceOfRunId, coverageOf } from './publication-history.service.js'
import type { HistoryListInput, HistorySourceRow, PublicationHistoryAdapter } from './publication-history/types.js'

const T = (minute: number) => Date.UTC(2026, 9, 1, 10, minute)

function row(source: HistorySource, localId: string, minute: number, extra: Partial<HistorySourceRow> = {}): HistorySourceRow {
  return {
    id: source === 'studio' ? localId : `${source}:${localId}`, source, batchId: null, startedAt: new Date(T(minute)).toISOString(), finishedAt: null,
    state: 'succeeded', status: 'VERIFIED', kind: 'update', productId: 'family', familySku: 'FAM', familyTitle: 'Family', channel: 'AMAZON',
    marketplace: 'IT', accountId: 'acct', accountLabel: 'Account', aliasLabel: null, fieldCount: 1, productCount: 1,
    counts: { accepted: 0, verified: 1, failed: 0, waiting: 0, notSent: 0, skipped: 0, unknown: 0 }, userId: 'u1', reference: null, message: null,
    lastCheckedAt: null, needsCheck: false, checkedAt: null, sortAt: T(minute), localId, checkedByUserId: null, ...extra,
  }
}

/** A source over an in-memory list, implementing the contract exactly: strictly after the cursor, sortAt DESC, id DESC. */
function fake(source: HistorySource, rank: number, rows: HistorySourceRow[], calls: HistoryListInput[] = []): PublicationHistoryAdapter {
  const ordered = [...rows].sort((a, b) => b.sortAt - a.sortAt || (a.localId < b.localId ? 1 : a.localId > b.localId ? -1 : 0))
  return {
    source, rank,
    async list(input) {
      calls.push(input)
      const c = input.cursor
      return ordered.filter(r => !c || r.sortAt < c.at || (r.sortAt === c.at && (rank > c.rank || (rank === c.rank && r.localId < c.id))))
        .slice(0, input.limit)
    },
    async detail(localId) {
      const found = rows.find(r => r.localId === localId)
      if (!found) return null
      const { sortAt: _s, localId: _l, checkedByUserId: _c, ...run } = found
      return { run: { ...run, userName: null, checkedBy: null }, steps: [], products: [], hasRequest: false, rawResponse: null }
    },
    async coverage(): Promise<HistoryCoverage> { return { source, included: true, since: null, note: null } },
  }
}

const query = (limit: number, cursor: string | null = null) => ({ filters: {}, sources: ['studio', 'amazon-flat-file', 'ebay-flat-file', 'photos'] as HistorySource[],
  limit, cursor: cursor ? decodeCursor(cursor) : null })

describe('publish history core', () => {
  // Minute 9 holds four runs from two sources; minute 5 two more. Every page size must walk the same order.
  const studio = [row('studio', 'b', 9), row('studio', 'a', 9), row('studio', 'c', 5), row('studio', 'z', 1)]
  const amazon = [row('amazon-flat-file', 'y', 9), row('amazon-flat-file', 'x', 9), row('amazon-flat-file', 'w', 5)]
  const adapters = () => [fake('amazon-flat-file', 1, amazon), fake('studio', 0, studio)]
  const expected = ['b', 'a', 'amazon-flat-file:y', 'amazon-flat-file:x', 'c', 'amazon-flat-file:w', 'z']

  it.each([1, 2, 3, 4, 7, 50])('walks every run exactly once, newest first, at page size %i — equal times across sources never repeat or skip', async size => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const result = await listPublicationHistory(query(size, cursor), { adapters: adapters() })
      seen.push(...result.runs.map(run => run.id))
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(expected)
  })

  it('asks every source for one row more than a page, and says when there is no next page', async () => {
    const calls: HistoryListInput[] = []
    const result = await listPublicationHistory(query(50), { adapters: [fake('studio', 0, studio, calls)] })
    expect(calls[0].limit).toBe(51)
    expect(result.nextCursor).toBeNull()
  })

  it('fills user names in one read and keeps the source fields out of the run', async () => {
    const result = await listPublicationHistory(query(10), { adapters: [fake('studio', 0, [row('studio', 'k', 3, { checkedAt: new Date(T(4)).toISOString(), checkedByUserId: 'u2' })])] })
    expect(result.runs[0]).toMatchObject({ id: 'k', userName: 'Publisher Person', checkedBy: 'Checker Person' })
    expect(result.runs[0]).not.toHaveProperty('sortAt')
    expect(result.runs[0]).not.toHaveProperty('localId')
    expect(result.runs[0]).not.toHaveProperty('checkedByUserId')
  })

  it('a source filter asks only those sources', async () => {
    const calls: HistoryListInput[] = []
    const result = await listPublicationHistory({ ...query(10), sources: ['amazon-flat-file'] }, { adapters: [fake('studio', 0, studio, calls), fake('amazon-flat-file', 1, amazon)] })
    expect(calls).toHaveLength(0)
    expect(result.runs.every(run => run.source === 'amazon-flat-file')).toBe(true)
  })

  it('coverage names every source; one without an adapter is not included and says so', async () => {
    const coverage = await coverageOf([fake('studio', 0, studio)])
    expect(coverage.map(c => c.source)).toEqual(['studio', 'amazon-flat-file', 'ebay-flat-file', 'photos'])
    expect(coverage.find(c => c.source === 'studio')).toMatchObject({ included: true })
    expect(coverage.find(c => c.source === 'ebay-flat-file')).toMatchObject({ included: false, note: expect.stringMatching(/eBay flat file/) })
  })

  it('a cursor round-trips, and a damaged one is refused with plain words', () => {
    expect(decodeCursor(encodeCursor({ at: T(3), rank: 1, id: 'abc' }))).toEqual({ at: T(3), rank: 1, id: 'abc' })
    expect(() => decodeCursor('not-a-cursor')).toThrow(/no longer valid/)
  })

  it('run ids name their source; the product sheet keeps its own id', () => {
    const list = [fake('studio', 0, studio), fake('amazon-flat-file', 1, amazon)]
    expect(sourceOfRunId('b', list)).toMatchObject({ localId: 'b', adapter: { source: 'studio' } })
    expect(sourceOfRunId('amazon-flat-file:y', list)).toMatchObject({ localId: 'y', adapter: { source: 'amazon-flat-file' } })
    expect(() => sourceOfRunId('photos:q', list)).toThrow(/not found/)
  })

  it('a run that is not there is a 404', async () => {
    await expect(publicationRunDetail('missing', { adapters: [fake('studio', 0, studio)] })).rejects.toMatchObject({ statusCode: 404 })
    await expect(publicationRunDetail('a', { adapters: [fake('studio', 0, studio)] })).resolves.toMatchObject({ run: { id: 'a' } })
  })
})

describe('publish history query', () => {
  it('normalises filters, resolves a family member to its family, and caps the page', async () => {
    const parsed = await parseHistoryQuery({ channel: 'amazon', market: 'it', state: 'failed,needs_check', source: ['studio'], productId: 'child',
      from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', q: '  GALE  ', limit: '500' })
    expect(parsed.filters).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', states: ['failed', 'needs_check'], familyId: 'family', q: 'GALE',
      from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-10-02T00:00:00Z') })
    expect(parsed.sources).toEqual(['studio'])
    expect(parsed.limit).toBe(100)
    expect((await parseHistoryQuery({})).limit).toBe(50)
  })

  it.each([
    [{ state: 'done' }, /Unknown state "done"/],
    [{ source: 'ftp' }, /Unknown source "ftp"/],
    [{ limit: '0' }, /at least 1/],
    [{ from: 'yesterday' }, /"from" must be a date/],
    [{ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }, /must not be after/],
    [{ productId: 'nobody' }, /does not exist/],
  ])('refuses %o', async (raw, message) => {
    await expect(parseHistoryQuery(raw as Record<string, unknown>)).rejects.toThrow(message)
  })
})
