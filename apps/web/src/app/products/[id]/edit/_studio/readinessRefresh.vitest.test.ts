/**
 * P2 (2026-09-30, I4-9) — after a save on a channel coordinate the page reads THAT coordinate's readiness
 * (`only=coordinate`) and merges it into the family-wide answer the scope menu shows. Measured before: every save
 * re-read the whole family (GALE eBay IT: 11.1 MB raw, 34 coordinates).
 */
import { describe, expect, it } from 'vitest'
import { mergeCoordinateReadiness, readinessUrl } from './readiness'
import type { ReadinessMatrixEntry } from './types'

const entry = (channel: string | null, market: string | null, pct: number, accountId: string | null = channel ? 'acc-1' : null) => ({
  coordinateKey: `${channel ?? 'master'}:${market ?? ''}:${accountId ?? ''}`, channel, market, accountId, aliasId: null, language: 'it',
  label: channel ?? 'Shared product', id: channel ?? 'master', pct, state: 'warn', required: { filled: pct, total: 100 }, missing: [], optionalMissing: [], byProduct: {}, computedAt: null, note: '',
})
const scope = (id: string, pct: number) => ({ id, pct, state: 'warn', required: { filled: pct, total: 100 } })

describe('readinessUrl', () => {
  it('asks for the coordinate only when told to, with the family read unchanged', () => {
    const q = { market: 'IT', locale: 'it', channel: 'EBAY', accountId: 'acc-1' }
    expect(readinessUrl('p1', q)).toMatch(/\/api\/products\/p1\/readiness\?market=IT&locale=it&channel=EBAY&accountId=acc-1$/)
    expect(readinessUrl('p1', { ...q, only: 'coordinate' })).toMatch(/\?market=IT&locale=it&channel=EBAY&accountId=acc-1&only=coordinate$/)
  })
})

describe('mergeCoordinateReadiness', () => {
  const previous = {
    status: 'ready' as const, at: 1, coordinate: 'c',
    byScope: { master: scope('master', 70), EBAY: scope('EBAY', 40), AMAZON: scope('AMAZON', 90) } as never,
    matrix: [entry(null, null, 70), entry('EBAY', 'IT', 40), entry('AMAZON', 'IT', 90)] as unknown as ReadinessMatrixEntry[],
  }

  it('takes the open channel from the answer and keeps every other scope and coordinate', () => {
    // A coordinate-only answer may carry a Shared chip computed from nothing and nothing else.
    const answer = { scopes: [scope('master', 0), scope('EBAY', 55)], matrix: [entry('EBAY', 'IT', 55)] }
    const merged = mergeCoordinateReadiness(previous, answer, { channel: 'EBAY', market: 'IT', accountId: 'acc-1' })
    expect((merged.byScope as Record<string, { pct: number }>).EBAY.pct).toBe(55)
    expect((merged.byScope as Record<string, { pct: number }>).master.pct).toBe(70)
    expect((merged.byScope as Record<string, { pct: number }>).AMAZON.pct).toBe(90)
    expect(merged.matrix.map((m) => `${m.channel}:${m.pct}`).sort()).toEqual(['AMAZON:90', 'EBAY:55', 'null:70'])
    expect(merged.coordinate).toBe('c')
  })

  it('an API that still answers for the whole family changes only the open coordinate too', () => {
    const family = { scopes: [scope('master', 71), scope('EBAY', 56), scope('AMAZON', 10)], matrix: [entry(null, null, 71), entry('EBAY', 'IT', 56), entry('AMAZON', 'IT', 10), entry('EBAY', 'DE', 5)] }
    const merged = mergeCoordinateReadiness(previous, family, { channel: 'EBAY', market: 'IT', accountId: 'acc-1' })
    expect(merged.matrix.map((m) => `${m.channel}:${m.market}:${m.pct}`).sort()).toEqual(['AMAZON:IT:90', 'EBAY:IT:56', 'null:null:70'])
    expect((merged.byScope as Record<string, { pct: number }>).AMAZON.pct).toBe(90)
  })

  it('an answer without the coordinate leaves everything as it was', () => {
    const merged = mergeCoordinateReadiness(previous, { scopes: [], matrix: [] }, { channel: 'EBAY', market: 'IT', accountId: 'acc-1' })
    expect(merged.byScope).toBe(previous.byScope)
    expect(merged.matrix).toBe(previous.matrix)
  })
})
