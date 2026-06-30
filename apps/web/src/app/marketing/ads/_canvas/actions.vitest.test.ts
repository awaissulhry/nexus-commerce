import { describe, it, expect } from 'vitest'
import { stageActions, type CampaignInput } from './actions'

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
