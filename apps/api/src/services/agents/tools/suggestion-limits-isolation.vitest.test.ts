/**
 * PB-7 — an isolation card (`isolate_product_terms`, one product's own negatives) decided by Claude is judged like any
 * negative: each of its items is one negative into one ad group, handed to the limits kit (whose checks refuse a
 * protected term by rule). A card that lists none cannot be measured, so a person decides it. Mocked reads; made-up values.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ subjects: vi.fn(), buildLimitFacts: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: { adTarget: { findMany: vi.fn(async () => []) }, campaign: { findMany: vi.fn(async () => []) } } }))
vi.mock('../../advertising/ads-suggestion-decide.service.js', () => ({ suggestionSubjects: h.subjects }))
vi.mock('./ads-autonomy-kit.js', async (importOriginal) => ({ ...(await importOriginal<object>()), buildLimitFacts: h.buildLimitFacts, limitsNote: () => [] }))

import { suggestionLimitFacts } from './suggestion-limits.js'

const card = (items: unknown) => ({ id: 's1', ruleId: 'r1', entityType: 'ACCOUNT', entityId: 'account', proposedKey: 'isolate_product_terms', proposedAction: { type: 'isolate_product_terms', items } })

beforeEach(() => {
  vi.clearAllMocks()
  h.buildLimitFacts.mockResolvedValue({ v: 1, this: { items: 0 }, markets: {}, scopes: {}, unplaced: [], protectedHit: [], engineOwned: [], today: {} })
})

describe('suggestion limits — an isolation card', () => {
  it('each item is one negative into its ad group, exact or phrase', async () => {
    h.subjects.mockResolvedValue([card([{ text: 'test x', match: 'EXACT', adGroupId: 'g1' }, { text: 'testa', match: 'PHRASE', adGroupId: 'g2' }])])
    const out = await suggestionLimitFacts([{ suggestionId: 's1', decide: 'apply' } as never])
    expect(h.buildLimitFacts.mock.calls[0][0].items).toEqual([
      { entity: { kind: 'adGroup', id: 'g1' }, change: { field: 'negative', term: 'test x', matchType: 'NEGATIVE_EXACT' } },
      { entity: { kind: 'adGroup', id: 'g2' }, change: { field: 'negative', term: 'testa', matchType: 'NEGATIVE_PHRASE' } },
    ])
    expect(out.suggestions).toMatchObject({ applies: 1, unjudged: 0 })
  })

  it('a card that lists no negative cannot be measured: a person decides it', async () => {
    h.subjects.mockResolvedValue([card([])])
    const out = await suggestionLimitFacts([{ suggestionId: 's1', decide: 'apply', rule: 'TEST rule', entity: 'the whole account' } as never])
    expect(out.suggestions).toMatchObject({ unjudged: 1, firstUnjudged: expect.stringMatching(/it lists no negative/) })
    expect(h.buildLimitFacts.mock.calls[0][0].items).toEqual([])
  })
})
