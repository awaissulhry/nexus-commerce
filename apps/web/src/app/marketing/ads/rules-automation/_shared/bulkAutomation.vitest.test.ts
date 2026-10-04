import { describe, expect, it } from 'vitest'
import { bulkAutomationNotice, effectiveLevel, planBulkAutomation, type BulkRuleState } from './bulkAutomation'
import { LEVELS, RANK } from '../automations/ModeNotches'

const rule = (level: string, extra: Partial<BulkRuleState> = {}): BulkRuleState => ({
  level, enabled: true, dryRun: level !== 'AUTO', automation: level === 'AUTO', ...extra,
})

/** The shapes a selection really holds, by id. */
const RULES: Record<string, BulkRuleState> = {
  auto: rule('AUTO'),
  propose: rule('PROPOSE'),
  observe: rule('OBSERVE'),
  off: rule('OFF', { enabled: false }),
  // stored AUTO but disabled — the engine runs it at Off
  disabledAuto: rule('AUTO', { enabled: false, automation: false }),
  // a builder rule belted to Manual at AUTO: the toggle reads Off, the stored level is still Auto
  beltedAuto: rule('AUTO', { automation: false }),
}
const stateOf = (id: string) => RULES[id]
const never = () => false

describe('effectiveLevel — the web mirror of resolveAutonomy', () => {
  it('a disabled rule is Off whatever its dial says', () => {
    for (const level of LEVELS) expect(effectiveLevel({ level, enabled: false, dryRun: false })).toBe('OFF')
  })
  it('an enabled rule runs at its dial; a missing or Off dial falls back to dryRun', () => {
    expect(effectiveLevel({ level: 'OBSERVE', enabled: true })).toBe('OBSERVE')
    expect(effectiveLevel({ level: 'OFF', enabled: true, dryRun: true })).toBe('PROPOSE')
    expect(effectiveLevel({ level: 'OFF', enabled: true, dryRun: false })).toBe('AUTO')
    expect(effectiveLevel({ level: '', enabled: true, dryRun: true })).toBe('PROPOSE')
    expect(effectiveLevel({ level: 'toString', enabled: true, dryRun: true })).toBe('PROPOSE')
  })
})

describe('planBulkAutomation — Automation Off (writes Propose)', () => {
  it('writes only the rules running above Propose; Propose, Observe, Off and disabled rules are left and counted', () => {
    const plan = planBulkAutomation(Object.keys(RULES), 'PROPOSE', stateOf, never)
    expect(plan.change).toEqual(['auto', 'beltedAuto'])
    expect(plan.already).toEqual([
      { id: 'propose', level: 'PROPOSE' },
      { id: 'observe', level: 'OBSERVE' },
      { id: 'off', level: 'OFF' },
      { id: 'disabledAuto', level: 'OFF' },
    ])
    expect(plan.capped).toEqual([])
    expect(plan.missing).toEqual([])
  })

  it('ignores the ceiling — turning a rule down is never capped', () => {
    expect(planBulkAutomation(['auto'], 'PROPOSE', stateOf, () => true).change).toEqual(['auto'])
  })

  it('never raises a rule, for any target below Auto and any rule shape', () => {
    for (const target of ['OFF', 'OBSERVE', 'PROPOSE'] as const) {
      for (const level of [...LEVELS, '']) {
        for (const enabled of [true, false]) {
          for (const dryRun of [true, false, undefined]) {
            for (const automation of [true, false]) {
              const s: BulkRuleState = { level, enabled, dryRun, automation }
              const plan = planBulkAutomation(['x'], target, () => s, never)
              const raised = plan.change.length === 1 && RANK[effectiveLevel(s)] <= RANK[target]
              expect(raised, JSON.stringify({ target, ...s })).toBe(false)
              expect(plan.change.length + plan.already.length).toBe(1)
            }
          }
        }
      }
    }
  })
})

describe('planBulkAutomation — Automation On (writes Auto)', () => {
  it('raises every rule not already on, except the ones the ceiling holds below Auto', () => {
    const capped = new Set(['observe'])
    const plan = planBulkAutomation(Object.keys(RULES), 'AUTO', stateOf, (id) => capped.has(id))
    expect(plan.change).toEqual(['propose', 'off', 'disabledAuto', 'beltedAuto'])
    expect(plan.already).toEqual([{ id: 'auto', level: 'AUTO' }])
    expect(plan.capped).toEqual(['observe'])
  })
})

it('a selected rule that is no longer listed is never written', () => {
  for (const target of ['AUTO', 'PROPOSE'] as const) {
    const plan = planBulkAutomation(['gone', 'auto'], target, stateOf, never)
    expect(plan.change).not.toContain('gone')
    expect(plan.missing).toEqual(['gone'])
  }
})

describe('bulkAutomationNotice', () => {
  it('says nothing when every selected rule was written', () => {
    expect(bulkAutomationNotice(planBulkAutomation(['auto', 'beltedAuto'], 'PROPOSE', stateOf, never), 0, 'bid rule')).toBeNull()
  })

  it('Off: how many changed, how many were left, at which levels, and why', () => {
    const plan = planBulkAutomation(Object.keys(RULES), 'PROPOSE', stateOf, never)
    expect(bulkAutomationNotice(plan, 0, 'bid rule')).toBe(
      '2 of 6 bid rules set to Automation Off. 4 left as they were — already at Propose or below (1 Propose, 1 Observe, 2 Off), and Automation Off never turns a rule up.',
    )
  })

  it('Off on one rule that is already off reads in the singular', () => {
    expect(bulkAutomationNotice(planBulkAutomation(['off'], 'PROPOSE', stateOf, never), 0, 'bid rule')).toBe(
      '0 of 1 bid rule set to Automation Off. 1 left as it was — already at Propose or below (1 Off), and Automation Off never turns a rule up.',
    )
  })

  it('On: already on, above the ceiling, no longer listed and failed writes are each counted', () => {
    const plan = planBulkAutomation(['auto', 'observe', 'propose', 'off', 'gone'], 'AUTO', stateOf, (id) => id === 'observe')
    expect(bulkAutomationNotice(plan, 1, 'bid rule')).toBe(
      '1 of 5 bid rules set to Automation On. 1 was already on. 1 left unchanged — above the graduation ceiling, which only Automations can raise. 1 is no longer listed and was not changed. 1 failed to write.',
    )
  })
})
