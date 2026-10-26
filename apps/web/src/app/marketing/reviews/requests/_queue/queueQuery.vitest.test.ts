import { describe, expect, it } from 'vitest'
import {
  EMPTY_QUEUE_QUERY,
  activeFilterCount,
  clearFilters,
  pageCount,
  parseQueueQuery,
  queueApiParams,
  queueReadKey,
  serializeQueueQuery,
  toggleStatus,
  withFilter,
  withPage,
  withPageSize,
  withSort,
} from './queueQuery'

describe('queue address', () => {
  it('reads every filter, the sort, the page and the open request', () => {
    const { query, flags } = parseQueueQuery('?status=retrying&channel=amazon&market=de&rule=r1&productType=Jacket&reason=amazon_too_early&q=405-&sort=next:asc&page=3&pageSize=100&results=7d&request=req-9')
    expect(query).toEqual({
      status: 'RETRYING', channel: 'AMAZON', market: 'DE', rule: 'r1', productType: 'Jacket', reason: 'amazon_too_early', q: '405-',
      sort: { column: 'next', dir: 'asc' }, page: 3, pageSize: 100, results: '7d', request: 'req-9',
    })
    expect(flags).toEqual({ inserts: false, preview: false })
  })

  it('falls back to everything for unknown values', () => {
    const { query } = parseQueueQuery('status=LOST&sort=buyer:asc&page=-2&pageSize=7&results=1y')
    expect(query).toEqual(EMPTY_QUEUE_QUERY)
  })

  it('opens the inserts and e-mail windows once and never writes the flags back', () => {
    const { query, flags } = parseQueueQuery('?inserts=1&preview=true&status=SENT')
    expect(flags).toEqual({ inserts: true, preview: true })
    expect(serializeQueueQuery(query)).toBe('?status=SENT')
  })

  it('round-trips through the address and leaves defaults out', () => {
    expect(serializeQueueQuery(EMPTY_QUEUE_QUERY)).toBe('')
    const q = { ...EMPTY_QUEUE_QUERY, status: 'DUE' as const, market: 'IT', q: ' gloves ', sort: { column: 'tries' as const, dir: 'desc' as const }, page: 2 }
    const text = serializeQueueQuery(q)
    expect(text).toBe('?status=DUE&market=IT&q=gloves&sort=tries%3Adesc&page=2')
    expect(parseQueueQuery(text).query).toEqual({ ...q, q: 'gloves' })
  })

  it('asks the API for the last 30 days and upcoming, with its own sort names', () => {
    const q = { ...EMPTY_QUEUE_QUERY, status: 'FAILED' as const, sort: { column: 'next' as const, dir: 'asc' as const } }
    expect(queueApiParams(q)).toMatchObject({ status: 'FAILED', sort: 'nextTry:asc', page: 1, pageSize: 50, period: '30d', q: null })
    expect(queueApiParams(withSort(q, 'delivered', 'desc')).sort).toBe('deliveredAt:desc')
  })

  it('goes back to page 1 when a filter changes, and a tile press toggles its status', () => {
    const on = withPage(EMPTY_QUEUE_QUERY, 4)
    expect(withFilter(on, 'channel', 'ebay')).toMatchObject({ channel: 'EBAY', page: 1 })
    expect(withFilter(on, 'status', 'nonsense').status).toBeNull()
    const pressed = toggleStatus(on, 'FAILED')
    expect(pressed).toMatchObject({ status: 'FAILED', page: 1 })
    expect(toggleStatus(pressed, 'FAILED').status).toBeNull()
    expect(withSort(on, 'buyer', 'asc').sort).toBeNull()
    expect(withPageSize(on, 999).pageSize).toBe(50)
  })

  it('counts and clears the filters, keeping sort and page size', () => {
    const q = { ...EMPTY_QUEUE_QUERY, status: 'SENT' as const, rule: 'r1', q: 'x', pageSize: 200, sort: { column: 'status' as const, dir: 'asc' as const } }
    expect(activeFilterCount(q)).toBe(3)
    expect(clearFilters(q)).toEqual({ ...EMPTY_QUEUE_QUERY, pageSize: 200, sort: q.sort })
  })

  it('pages at least once, and the read key ignores the pop-up and the results period', () => {
    expect(pageCount(0, 50)).toBe(1)
    expect(pageCount(101, 50)).toBe(3)
    expect(queueReadKey({ ...EMPTY_QUEUE_QUERY, request: 'a', results: '90d' })).toBe(queueReadKey(EMPTY_QUEUE_QUERY))
  })
})
