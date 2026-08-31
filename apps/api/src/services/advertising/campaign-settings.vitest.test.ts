// PH.6 — campaign settings. None of this was testable while it lived in a
// Fastify handler; all of it decides what an operator can do to a live campaign.

import { describe, it, expect, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))

import {
  applyAutomationPatch, clampCpcMultiple, groupSelfCompetition, BID_ALGORITHMS,
} from './campaign-settings.service.js'

describe('applyAutomationPatch — undefined vs null are different intents', () => {
  it('leaves a field alone when it is not supplied', () => {
    // `undefined` = "not in the request". Treating it as "clear" would wipe a
    // setting every time an unrelated field was patched.
    const r = applyAutomationPatch({ targetAcos: 0.25, bidAlgorithm: 'MAX_ORDERS' }, { bidAutomation: true })
    expect(r.value).toEqual({ targetAcos: 0.25, bidAlgorithm: 'MAX_ORDERS', bidAutomation: true })
  })

  it('clears a field when it is explicitly null', () => {
    const r = applyAutomationPatch({ targetAcos: 0.25, bidAlgorithm: 'MAX_ORDERS' }, { targetAcos: null, bidAlgorithm: null })
    expect(r.value).toEqual({})
  })

  it('does not mutate the caller\'s object', () => {
    const current = { targetAcos: 0.25 }
    applyAutomationPatch(current, { targetAcos: 0.9 })
    expect(current).toEqual({ targetAcos: 0.25 })
  })
})

describe('applyAutomationPatch — the bidAlgorithm whitelist', () => {
  it.each(BID_ALGORITHMS)('accepts %s', (algo) => {
    expect(applyAutomationPatch({}, { bidAlgorithm: algo }).value).toEqual({ bidAlgorithm: algo })
  })

  it('rejects anything else with a 400 naming the options', () => {
    // C1 — an unknown value renders as a blank cell in the picker rather than
    // an error, so it has to be refused at the boundary.
    const r = applyAutomationPatch({}, { bidAlgorithm: 'GO_FASTER' })
    expect(r.status).toBe(400)
    expect(r.error).toMatch(/TARGET_ACOS, MAX_IMPRESSIONS, MAX_ORDERS/)
    expect(r.value).toBeUndefined()
  })

  it('refuses without applying any other field in the same patch', () => {
    // A partially-applied rejected patch is the worst outcome: the caller is
    // told it failed while some of it landed.
    const r = applyAutomationPatch({}, { bidAutomation: true, bidAlgorithm: 'NOPE' })
    expect(r.error).toBeTruthy()
    expect(r.value).toBeUndefined()
  })
})

describe('applyAutomationPatch — the targetAcos clamp', () => {
  it.each([
    [0.25, 0.25],
    [-1, 0],       // below floor
    [99, 5],       // above the 500% ceiling
    ['0.4', 0.4],  // numeric string from JSON
  ])('clamps %p to %p', (input, expected) => {
    expect(applyAutomationPatch({}, { targetAcos: input as number }).value?.targetAcos).toBe(expected)
  })
})

describe('clampCpcMultiple', () => {
  it('defaults to 1.5 when unspecified', () => {
    expect(clampCpcMultiple(undefined)).toBe(1.5)
    expect(clampCpcMultiple(null)).toBe(1.5)
  })
  it.each([[1, 1], [10, 10], [0.1, 1], [999, 10], [3.5, 3.5]])('clamps %p to %p', (i, o) => {
    expect(clampCpcMultiple(i)).toBe(o)
  })
})

describe('groupSelfCompetition', () => {
  const ad = (asin: string | null, id: string, name = id, status = 'ENABLED') => ({
    asin, adGroup: { campaign: { id, name, status } },
  })

  it('groups ASINs by competing campaign', () => {
    const r = groupSelfCompetition([ad('B1', 'c1'), ad('B2', 'c1'), ad('B1', 'c2')])
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ campaignId: 'c1', asins: ['B1', 'B2'] })
  })

  it('orders by overlap size — the worst cannibalisation first', () => {
    const r = groupSelfCompetition([ad('B1', 'small'), ad('B1', 'big'), ad('B2', 'big'), ad('B3', 'big')])
    expect(r.map((g) => g.campaignId)).toEqual(['big', 'small'])
  })

  it('de-duplicates a repeated ASIN within one campaign', () => {
    expect(groupSelfCompetition([ad('B1', 'c1'), ad('B1', 'c1')])[0].asins).toEqual(['B1'])
  })

  it('skips rows with no ASIN or no campaign', () => {
    expect(groupSelfCompetition([
      ad(null, 'c1'),
      { asin: 'B1', adGroup: null },
      { asin: 'B2', adGroup: { campaign: null } },
    ])).toEqual([])
  })
})
