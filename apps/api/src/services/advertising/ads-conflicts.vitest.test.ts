/**
 * AUTO.A4 — the by-entity conflict model, pinned on the cases the old detector provably missed
 * (measured on prod: it flagged 0 of 22 live rules).
 */
import { describe, it, expect } from 'vitest'
import { classifyConflicts, type ConflictActor } from './ads-conflicts.service.js'

const actor = (over: Partial<ConflictActor>): ConflictActor => ({
  key: over.key ?? `k:${over.name}`,
  name: over.name ?? 'x',
  kind: 'rule',
  ruleId: over.ruleId ?? null,
  level: 'AUTO',
  fields: {},
  reach: [],
  reachLabel: 'test',
  trigger: null,
  windowDays: null,
  capPerDay: null,
  compoundingPct: null,
  ...over,
})

describe('classifyConflicts — the cases the trigger-blind detector missed', () => {
  it('🔴 flags the ratchet shape: same field, DIFFERENT triggers, shared campaigns', () => {
    // The old detector's first line skipped this pair because their triggers differ.
    const { pairs } = classifyConflicts([
      actor({ name: 'Trim budget on weak ACOS', ruleId: 'r1', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', fields: { budget: ['either'] }, reach: ['c1', 'c2'] }),
      actor({ name: 'Campaign ACOS rebalance', ruleId: 'r2', trigger: 'CAC_SPIKE', fields: { budget: ['either'] }, reach: ['c2', 'c3'] }),
    ])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.cls).toBe('SAME-FIELD')
    expect(pairs[0]!.shared).toBe(1)
  })

  it('flags OPPOSED directions over the shared reach', () => {
    const { pairs } = classifyConflicts([
      actor({ name: 'Raiser', fields: { bid: ['up'] }, reach: ['c1'] }),
      actor({ name: 'Lowerer', fields: { bid: ['down'] }, reach: ['c1'] }),
    ])
    expect(pairs[0]!.cls).toBe('OPPOSED')
    expect(pairs[0]!.note).toContain('opposite directions')
  })

  it('sees an ENGINE beside a rule — the population the old model could not contain', () => {
    const { pairs, byField } = classifyConflicts([
      actor({ name: 'Bid rule', ruleId: 'r1', fields: { bid: ['either'] }, reach: ['c1', 'c2'] }),
      actor({ name: 'automation:rank-defend', kind: 'engine', fields: { bid: ['either'] }, reach: ['c2'] }),
    ])
    expect(pairs).toHaveLength(1)
    const bid = byField.find((f) => f.field === 'bid')!
    expect(bid.reachable).toBe(2)
    expect(bid.contested).toBe(1)
    expect(bid.worst?.actors.map((a) => a.kind).sort()).toEqual(['engine', 'rule'])
  })

  it('no shared campaign ⇒ no pair, whatever the fields', () => {
    const { pairs } = classifyConflicts([
      actor({ name: 'DE', fields: { bid: ['up'] }, reach: ['c1'] }),
      actor({ name: 'IT', fields: { bid: ['down'] }, reach: ['c2'] }),
    ])
    expect(pairs).toHaveLength(0)
  })

  it('perRule indexes both sides, OPPOSED ranked first', () => {
    const { perRule } = classifyConflicts([
      actor({ name: 'A', ruleId: 'ra', fields: { bid: ['up'], budget: ['either'] }, reach: ['c1'] }),
      actor({ name: 'B', ruleId: 'rb', fields: { bid: ['down'], budget: ['either'] }, reach: ['c1'] }),
    ])
    expect(perRule.ra![0]).toContain('Opposed to')
    expect(perRule.rb![0]).toContain('Opposed to')
    expect(perRule.ra!.some((l) => l.includes('Shares a field'))).toBe(true)
  })
})
