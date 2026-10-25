/**
 * Listings live layer, step 7 — the Problems view's pure parts: the ids (round trip, refusals, the families query's
 * `problem`), the readiness fold (the field's most urgent kind, its sentence, the worst state), the channel and
 * not-listed rows' words, and the order (Blocked, Warnings, channel messages, Ready-not-listed; then most products).
 * No database.
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
import type { ReadinessDestination, ReadinessProblemRow } from '@nexus/shared/listing-readiness'
import { familiesQuery } from './listing-readiness-families.service.js'
import { parseProblemId, problemIdOf, problemQuery, PROBLEM_ID_MAX } from './listing-readiness-problem-filter.js'
import {
  channelProblemRows, compareProblems, keptFamiliesCtes, notListedProblemRows, NOT_LISTED_LABEL, readinessProblemRows, type ReadinessProblemAggregate,
} from './listing-readiness-problems.service.js'

const key = (c: Array<string | null>) => JSON.stringify(c)
const AMAZON_DE = key(['AMAZON', 'DE', 'a1', null]), EBAY_IT = key(['EBAY', 'IT', 'e1', null]), SHARED = key([null, null, null, null])
const HASH = '0123456789abcdef0123456789abcdef'
const destination = (k: string): ReadinessDestination => ({ key: k, channel: JSON.parse(k)[0] ?? 'SHARED', marketplace: JSON.parse(k)[1] ?? '', accountId: JSON.parse(k)[2], aliasKey: '', label: `Label ${k}` })

describe('problem ids', () => {
  it('round-trip every source, a field or code with colons included', () => {
    for (const problem of [
      { source: 'readiness' as const, destinationKey: AMAZON_DE, field: 'size_chart' },
      { source: 'readiness' as const, destinationKey: SHARED, field: 'attributes:color:name' },
      { source: 'readiness' as const, destinationKey: AMAZON_DE, field: '' },
      { source: 'channel' as const, destinationKey: AMAZON_DE, hash: HASH, code: '90220' },
      { source: 'channel' as const, destinationKey: key(['EBAY', '', null, null]), hash: HASH, code: 'a:b' },
      { source: 'channel' as const, destinationKey: EBAY_IT, hash: HASH, code: '' },
      { source: 'notListed' as const, destinationKey: EBAY_IT },
    ]) expect(parseProblemId(problemIdOf(problem))).toEqual(problem)
  })

  it('read a key written with spaces as the stored key, and a key with "]" in a value', () => {
    expect(parseProblemId('r:["AMAZON", "DE", "a1", null]:brand')).toEqual({ source: 'readiness', destinationKey: AMAZON_DE, field: 'brand' })
    const odd = key(['AMAZON', 'DE', 'a]1', null])
    expect(parseProblemId(`n:${odd}`)).toEqual({ source: 'notListed', destinationKey: odd })
  })

  it('refuse what is not an id', () => {
    for (const raw of ['', 'x', 'r:', 'r:AMAZON:brand', `r:${AMAZON_DE}`, `q:${AMAZON_DE}:x`, `n:${AMAZON_DE}:extra`, `n:${SHARED}`, `c:${SHARED}:${HASH}:1`,
      `c:${AMAZON_DE}:nothex:1`, `c:${AMAZON_DE}:${HASH}`, 'r:["A","B"]:x', 'r:[1,2,3,4]:x', `r:${AMAZON_DE}:${'x'.repeat(PROBLEM_ID_MAX)}`])
      expect(parseProblemId(raw), raw).toBeNull()
  })

  it('the families query takes `problem=<id>` and refuses anything else', () => {
    expect(problemQuery({})).toEqual({})
    expect(familiesQuery({ problem: `n:${EBAY_IT}` }).problem).toEqual({ source: 'notListed', destinationKey: EBAY_IT })
    expect(() => familiesQuery({ problem: 'nonsense' })).toThrow('Select a problem from the Problems view')
    expect(() => problemQuery({ problem: ['a'] })).toThrow()
  })
})

describe('the readiness rows', () => {
  const agg = (field: string, pair: string | null, level: number, extra: Partial<ReadinessProblemAggregate> = {}): ReadinessProblemAggregate =>
    ({ ck: AMAZON_DE, field, pair, level, products: 1, listings: 1, sev: 1, label: 'Size chart', reason: null, ...extra })

  it('one row per destination × field: the most urgent kind and its sentence; the field’s own totals; the worst state', () => {
    const rows = readinessProblemRows([
      agg('size_chart', 'language-fallback|0', 0, { listings: 5, reason: 'Not translated' }),
      agg('size_chart', 'value-missing|1', 0, { listings: 2, reason: 'Required and empty' }),
      agg('size_chart', null, 1, { products: 3, listings: 6, sev: 0 }),
      agg('', '|0', 0, { label: null, reason: 'Check failed' }),
      agg('', null, 1, { label: null }),
    ], destination)
    expect(rows).toEqual([
      { id: `r:${AMAZON_DE}:size_chart`, source: 'readiness', label: 'Size chart', state: 'blocked', kind: 'required', field: 'size_chart', code: null, severity: null,
        message: 'Required and empty', destination: destination(AMAZON_DE), products: 3, listings: 6 },
      expect.objectContaining({ id: `r:${AMAZON_DE}:`, label: 'Readiness check', state: 'warn', kind: 'check', message: 'Check failed' }),
    ])
  })

  it('a tie in kind goes to the group with more listings', () => {
    const [row] = readinessProblemRows([
      agg('brand', '|0', 0, { listings: 1, reason: 'one' }), agg('brand', 'other|0', 0, { listings: 4, reason: 'four' }), agg('brand', null, 1),
    ], destination)
    expect(row.message).toBe('four')
  })
})

describe('the channel and not-listed rows', () => {
  it('a channel message keeps its words; its key is the listing’s own (GB reads UK)', () => {
    const [row] = channelProblemRows([{ channel: 'AMAZON', market: 'UK', account: 'a1', alias: null, code: '90220', message: 'The value is not allowed.', hash: HASH,
      sev: 0, products: 2, listings: 3, total: 1 }], destination)
    expect(row).toEqual({ id: `c:${key(['AMAZON', 'UK', 'a1', null])}:${HASH}:90220`, source: 'channel', label: 'Message from Amazon', state: null, kind: null,
      field: null, code: '90220', severity: 'error', message: 'The value is not allowed.', destination: destination(key(['AMAZON', 'UK', 'a1', null])), products: 2, listings: 3 })
  })
  it('Ready, not listed names its destination', () => {
    expect(notListedProblemRows([{ ck: EBAY_IT, products: 4, listings: 9 }], destination)[0]).toMatchObject({ id: `n:${EBAY_IT}`, label: NOT_LISTED_LABEL, products: 4, listings: 9 })
  })
})

describe('the order', () => {
  const row = (id: string, extra: Partial<ReadinessProblemRow>): ReadinessProblemRow => ({ id, source: 'readiness', label: id, state: 'warn', kind: 'check', field: id,
    code: null, severity: null, message: '', destination: destination(AMAZON_DE), products: 1, listings: 1, ...extra })
  it('Blocked, Warnings, channel messages, Ready-not-listed; then most products; then errors first and most listings', () => {
    const rows = [
      row('nl', { source: 'notListed', state: null, products: 50 }),
      row('warn-big', { products: 9 }),
      row('ch-warning', { source: 'channel', state: null, severity: 'warning', products: 3 }),
      row('ch-error', { source: 'channel', state: null, severity: 'error', products: 3 }),
      row('ch-big', { source: 'channel', state: null, severity: 'info', products: 7 }),
      row('blocked-small', { state: 'blocked', products: 1 }),
      row('blocked-big', { state: 'blocked', products: 2, listings: 1 }),
      row('blocked-big-more', { state: 'blocked', products: 2, listings: 5 }),
    ].sort(compareProblems(() => 0))
    expect(rows.map(r => r.id)).toEqual(['blocked-big-more', 'blocked-big', 'blocked-small', 'warn-big', 'ch-big', 'ch-error', 'ch-warning', 'nl'])
  })
})

describe('the families the page lists', () => {
  const sql = (input: Parameters<typeof keptFamiliesCtes>[0]) => keptFamiliesCtes(input).sql.replace(/\s+/g, ' ')
  it('every family without a state tile; with one, the families with a listing in that state (the fill counts as Not computed)', () => {
    expect(sql({})).toBe('pr_keep AS (SELECT DISTINCT root FROM f)')
    expect(sql({ state: 'blocked' })).toContain('HAVING bool_or(rank IN (0)))')
    expect(sql({ state: 'notChecked' })).toContain('bool_or(rank IN (3,2)) OR count(DISTINCT pid) * count(DISTINCT ck) - count(*) > 0')
    expect(sql({ state: 'notChecked', listingIds: ['l1'] })).not.toContain('count(DISTINCT pid)')
  })
})
