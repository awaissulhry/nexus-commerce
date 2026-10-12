import { describe, expect, it } from 'vitest'
import { candidateSearch, refusalOf } from './harvestApi'
import { ALL_STATES } from './types'

describe('harvestApi — candidateSearch', () => {
  it('sends only what is set, market first; no market reads every market', () => {
    expect(candidateSearch({ market: 'IT' })).toBe('market=IT')
    expect(candidateSearch({ market: '' })).toBe('market=all')
    expect(candidateSearch({ market: 'IT', productId: null, q: '  ', page: 2, pageSize: 50, sort: '-orders' })).toBe('market=IT&page=2&pageSize=50&sort=-orders')
  })

  it('joins the states and keeps the scope filters', () => {
    const s = new URLSearchParams(candidateSearch({ market: 'IT', state: ['READY', 'WAITING'], owner: 'BRAIN', kind: 'keyword', q: 'jacket', campaignId: 'c1' }))
    expect(s.get('state')).toBe('READY,WAITING')
    expect(s.get('owner')).toBe('BRAIN')
    expect(s.get('kind')).toBe('keyword')
    expect(s.get('q')).toBe('jacket')
    expect(s.get('campaignId')).toBe('c1')
  })
})

describe('harvestApi — the page\'s filter bar', () => {
  it('sends its lists with the terms read (OR inside, AND across: the server\'s)', () => {
    const s = new URLSearchParams(candidateSearch({ market: 'IT', lists: { campaignIds: 'c1,c2', adGroupIds: 'g1' } }))
    expect(s.get('campaignIds')).toBe('c1,c2')
    expect(s.get('adGroupIds')).toBe('g1')
    expect(s.has('portfolioIds')).toBe(false)
    expect(candidateSearch({ market: 'IT', lists: null })).toBe('market=IT')
  })
})

describe('harvestApi — refusalOf', () => {
  it('uses the server words, else the status', () => {
    expect(refusalOf(409, { error: ' The plan moved. ' })).toBe('The plan moved.')
    expect(refusalOf(500, null)).toBe('HTTP 500')
    expect(refusalOf(400, { error: '' })).toBe('HTTP 400')
  })
})

describe('types — states', () => {
  it('every state the engine answers, the open work and what was harvested first', () => {
    expect(ALL_STATES.slice(0, 7)).toEqual(['READY', 'NEEDS_DESTINATION', 'NEEDS_CAMPAIGN', 'HELD', 'WAITING', 'IN_FLIGHT', 'HARVESTED'])
    expect(ALL_STATES).toHaveLength(11)
  })
})
