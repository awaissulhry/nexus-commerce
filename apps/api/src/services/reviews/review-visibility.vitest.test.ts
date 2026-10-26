/**
 * Reviews area — the visible-rows, kind and needs-a-reply rules. Pure `where` builders: the test reads the objects
 * Prisma would receive and checks them against rows the way PostgreSQL would answer them (NULL never equals a value).
 */
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_SOURCE,
  needsReplyWhere,
  reviewKindOf,
  reviewKindWhere,
  visibleReviewWhere,
} from './review-visibility.js'

type Row = { channel: string; ingestSource: string | null; triageStatus: string | null; rating?: number | null }

/** A tiny evaluator for the shapes these builders produce (AND / OR / equals / not / in / null), SQL style. */
function matches(where: any, row: Record<string, unknown>): boolean {
  if (!where || typeof where !== 'object') return true
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as any[]).every(c => matches(c, row))
    if (key === 'OR') return (cond as any[]).some(c => matches(c, row))
    const value = row[key]
    if (cond === null) return value === null
    if (typeof cond !== 'object') return value === cond
    const c = cond as Record<string, unknown>
    if ('not' in c) return value !== null && value !== c.not
    if ('in' in c) return value !== null && (c.in as unknown[]).includes(value)
    if ('equals' in c) return value === c.equals
    throw new Error(`unexpected condition on ${key}`)
  })
}

const row = (patch: Partial<Row>): Row => ({ channel: 'AMAZON', ingestSource: 'AMAZON_VOC', triageStatus: null, ...patch })

describe('visibleReviewWhere', () => {
  it('hides fixture rows and keeps rows with no source', () => {
    const where = visibleReviewWhere()
    expect(matches(where, row({ ingestSource: FIXTURE_SOURCE }))).toBe(false)
    expect(matches(where, row({ ingestSource: null }))).toBe(true)
    for (const source of ['IMPORT_CSV', 'AMAZON_VOC', 'EBAY_API', 'SHOPIFY_WEBHOOK', 'MANUAL']) {
      expect(matches(where, row({ ingestSource: source }))).toBe(true)
    }
  })

  it('narrows with an extra condition without widening past the fixture rule', () => {
    const where = visibleReviewWhere({ OR: [{ rating: 1 }, { rating: 2 }] })
    expect(where).toHaveProperty('AND')
    expect(matches(where, { ...row({}), rating: 1 })).toBe(true)
    expect(matches(where, { ...row({}), rating: 5 })).toBe(false)
    expect(matches(where, { ...row({ ingestSource: FIXTURE_SOURCE }), rating: 1 })).toBe(false)
  })
})

describe('review kind', () => {
  it('reads eBay as seller feedback and every other channel as a product review', () => {
    expect(reviewKindOf('EBAY', 'EBAY_API')).toBe('seller')
    expect(reviewKindOf('ebay')).toBe('seller')
    for (const channel of ['AMAZON', 'SHOPIFY', 'ETSY', '', null, undefined]) expect(reviewKindOf(channel)).toBe('product')
  })

  it('selects the same rows as reviewKindOf', () => {
    for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']) {
      const r = row({ channel })
      expect(matches(reviewKindWhere('seller'), r)).toBe(reviewKindOf(channel) === 'seller')
      expect(matches(reviewKindWhere('product'), r)).toBe(reviewKindOf(channel) === 'product')
    }
  })
})

describe('needsReplyWhere', () => {
  it('counts open rows only: no status yet, New or In progress', () => {
    const where = needsReplyWhere()
    expect(matches(where, row({ triageStatus: null }))).toBe(true)
    expect(matches(where, row({ triageStatus: 'NEW' }))).toBe(true)
    expect(matches(where, row({ triageStatus: 'IN_PROGRESS' }))).toBe(true)
    for (const status of ['RESPONDED', 'RESOLVED', 'IGNORED']) expect(matches(where, row({ triageStatus: status }))).toBe(false)
  })

  it('never counts a fixture row', () => {
    expect(matches(needsReplyWhere(), row({ ingestSource: FIXTURE_SOURCE, triageStatus: 'NEW' }))).toBe(false)
    expect(matches(needsReplyWhere(), row({ ingestSource: FIXTURE_SOURCE, triageStatus: null }))).toBe(false)
  })
})
