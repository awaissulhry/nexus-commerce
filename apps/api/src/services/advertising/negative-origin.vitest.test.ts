/**
 * Negative Targeting (2026-10-11) — the author of a negative, as the one write door stores it (ads-negative-kw.service.ts
 * negativeOriginOf, pure): Harvest, the brain's funnel, the brain, the playbook, a rule, Claude, a person. Made-up words.
 */
import { describe, expect, it } from 'vitest'
import { negativeOriginOf } from './ads-negative-kw.service.js'

describe('negativeOriginOf — who made a negative', () => {
  it('what the caller says wins', () => {
    expect(negativeOriginOf({ origin: 'HARVEST', userId: 'user:u-1' })).toBe('HARVEST')
  })

  it('any source with "harvest": the brain\'s harvest writer, a harvest tool or rule, a harvest run', () => {
    expect(negativeOriginOf({ userId: 'automation:ads-brain-harvest' })).toBe('HARVEST')
    expect(negativeOriginOf({ userId: 'user:u-1', evidence: { metric: 'brainHarvest', note: 'pair' } as never })).toBe('HARVEST')
    expect(negativeOriginOf({ userId: 'user:u-1', approval: { toolName: 'harvest-search-term', via: 'claude' } })).toBe('HARVEST')
    expect(negativeOriginOf({ userId: 'user:u-1', approval: { toolName: 'apply-brain-harvest', via: 'app' } })).toBe('HARVEST')
    expect(negativeOriginOf({ userId: 'automation:rule-h', evidence: { metric: 'harvestAndNegate' } as never })).toBe('HARVEST')
  })

  it('the brain: its funnel, or another reason (its actor, its request, its run)', () => {
    const funnel = { metric: 'searchTermClicks', note: 'ads brain (IT) adds negative exact "made up" — funnel: match-type funnel: the product buys it in 1 ad group' }
    expect(negativeOriginOf({ userId: 'automation:ads-brain-negatives', evidence: funnel as never })).toBe('BRAIN_FUNNEL')
    expect(negativeOriginOf({ userId: 'automation:ads-brain-negatives', evidence: { metric: 'searchTermClicks', note: 'ads brain (IT) adds negative exact "x" — waste: no orders' } as never })).toBe('BRAIN')
    // PROPOSE: the brain's change plan, approved by a person, runs add-negative-targets as that person.
    expect(negativeOriginOf({ userId: 'user:u-1', evidence: { metric: 'claudeRequest', note: 'Approved request ap-1: Ads brain: match-type funnel: …' } as never })).toBe('BRAIN_FUNNEL')
    expect(negativeOriginOf({ userId: 'user:u-1', evidence: { metric: 'claudeRequest', note: 'Approved request ap-1: Ads brain: waste' } as never })).toBe('BRAIN')
    expect(negativeOriginOf({ userId: 'user:u-1', approval: { toolName: 'submit-change-plan', via: null, agentKey: 'ads-brain-negatives' } })).toBe('BRAIN')
  })

  it('a launch or the playbook: creationFlow, isolation, playbook sync', () => {
    expect(negativeOriginOf({ userId: 'user:u-1', creationFlow: true })).toBe('PLAYBOOK')
    expect(negativeOriginOf({ userId: 'automation:rule-iso', evidence: { targetKey: 'isolation:brand', note: 'x' } as never })).toBe('PLAYBOOK')
    expect(negativeOriginOf({ userId: 'user:u-1', evidence: { targetKey: 'playbook-sync:negative', note: 'x' } as never })).toBe('PLAYBOOK')
  })

  it('any other automation is a rule', () => {
    expect(negativeOriginOf({ userId: 'automation:cmrule12345678901234567' })).toBe('RULE')
    expect(negativeOriginOf({ userId: 'automation:negatives-ngrams' })).toBe('RULE')
  })

  it('an approved request: Claude (or the agent fleet) asked, or a person on a page', () => {
    expect(negativeOriginOf({ userId: 'user:u-1', approval: { toolName: 'add-negative-targets', via: 'claude' } })).toBe('CLAUDE')
    expect(negativeOriginOf({ userId: 'user:u-1', approval: { toolName: 'add-negative-targets', via: 'fleet' } })).toBe('CLAUDE')
    expect(negativeOriginOf({ userId: 'user:u-1', approval: { toolName: 'submit-change-plan', via: 'app' } })).toBe('PERSON')
  })

  it('a person, else not known', () => {
    expect(negativeOriginOf({ userId: 'user:u-1' })).toBe('PERSON')
    expect(negativeOriginOf({})).toBeNull()
  })
})
