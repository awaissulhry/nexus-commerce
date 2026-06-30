import { describe, it, expect } from 'vitest'
import { stageActions, resolveCampaigns, type CampaignInput } from './actions'
import type { OpsObject } from './types'

const camps: CampaignInput[] = [
  { id: 'c1', name: 'AIREON', dailyBudget: 50, status: 'ENABLED' },
  { id: 'c2', name: 'MISANO', dailyBudget: 100, status: 'PAUSED' },
]

describe('stageActions', () => {
  it('budget incPct computes after + sums blast-radius budget delta', () => {
    const s = stageActions(camps, { kind: 'budget', mode: 'incPct', value: 10 })
    expect(s.changes[0].body).toEqual({ dailyBudget: 55 })
    expect(s.changes[0].path).toBe('/campaigns/c1')
    expect(s.changes[0].label).toBe('Daily budget')
    expect(s.changes[1].body).toEqual({ dailyBudget: 110 })
    expect(s.blastRadius).toEqual({ count: 2, budgetDeltaEur: 15 }) // +5 +10
  })

  it('budget set + min-€1 floor', () => {
    const s = stageActions([{ id: 'c1', name: 'A', dailyBudget: 50 }], { kind: 'budget', mode: 'set', value: 0 })
    expect(s.changes[0].body).toEqual({ dailyBudget: 1 }) // clamped to MIN_BUDGET
    expect(s.blastRadius.budgetDeltaEur).toBe(-49)
  })

  it('status change targets the campaign endpoint', () => {
    const s = stageActions(camps, { kind: 'status', status: 'PAUSED' })
    expect(s.changes[0].body).toEqual({ status: 'PAUSED' })
    expect(s.changes[0].path).toBe('/campaigns/c1')
    expect(s.blastRadius.budgetDeltaEur).toBe(0)
  })

  it('targetAcos converts percent → fraction on the automation endpoint', () => {
    const s = stageActions([camps[0]], { kind: 'targetAcos', pct: 25 })
    expect(s.changes[0].body).toEqual({ targetAcos: 0.25 })
    expect(s.changes[0].path).toBe('/campaigns/c1/automation')
  })

  it('placement builds the adjustments body on the placements endpoint', () => {
    const s = stageActions([camps[0]], { kind: 'placement', placement: 'PLACEMENT_TOP', percentage: 30 })
    expect(s.changes[0].body).toEqual({ adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 30 }] })
    expect(s.changes[0].path).toBe('/campaigns/c1/placements')
  })
})

describe('resolveCampaigns', () => {
  const objs: OpsObject[] = [
    { id: 'm:DE', kind: 'market', name: 'DE' },
    { id: 'p:DE:none', kind: 'portfolio', name: 'No pf', parentId: 'm:DE' },
    { id: 'c:1', kind: 'campaign', name: 'A', parentId: 'p:DE:none' },
    { id: 'c:2', kind: 'campaign', name: 'B', parentId: 'p:DE:none' },
    { id: 'm:IT', kind: 'market', name: 'IT' },
    { id: 'p:IT:none', kind: 'portfolio', name: 'No pf', parentId: 'm:IT' },
    { id: 'c:3', kind: 'campaign', name: 'C', parentId: 'p:IT:none' },
  ]
  it('cascades a market selection to its campaigns', () => {
    expect(resolveCampaigns(objs, new Set(['m:DE'])).map((o) => o.id)).toEqual(['c:1', 'c:2'])
  })
  it('cascades a portfolio selection', () => {
    expect(resolveCampaigns(objs, new Set(['p:IT:none'])).map((o) => o.id)).toEqual(['c:3'])
  })
  it('returns just the campaign when a campaign is selected', () => {
    expect(resolveCampaigns(objs, new Set(['c:1'])).map((o) => o.id)).toEqual(['c:1'])
  })
})
