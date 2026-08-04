/**
 * ADX N2 — the intensity dial.
 *
 * The property that matters most is the last one: a row written before this column
 * existed must behave exactly as it did before. The dial is worthless if shipping it
 * silently changes what 22 live rules do.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveAutonomy, levelActs, levelProposes, nextLevel, prevLevel,
  AUTONOMY_LEVELS, isAutonomyLevel,
} from './ads-autonomy.js'

describe('resolveAutonomy', () => {
  it('a disabled rule is OFF whatever the dial says', () => {
    expect(resolveAutonomy({ enabled: false, dryRun: false, autonomyLevel: 'AUTO' })).toBe('OFF')
  })

  it('honours an explicit level', () => {
    expect(resolveAutonomy({ enabled: true, dryRun: true, autonomyLevel: 'AUTO' })).toBe('AUTO')
    expect(resolveAutonomy({ enabled: true, dryRun: false, autonomyLevel: 'OBSERVE' })).toBe('OBSERVE')
  })

  it('BACK-COMPAT: no level falls back to the old binary', () => {
    // 21 rules were dryRun and 1 was live when this shipped. Both must be unchanged.
    expect(resolveAutonomy({ enabled: true, dryRun: true })).toBe('PROPOSE')
    expect(resolveAutonomy({ enabled: true, dryRun: false })).toBe('AUTO')
    expect(resolveAutonomy({ enabled: true, dryRun: true, autonomyLevel: null })).toBe('PROPOSE')
  })

  it('an unrecognised level falls back rather than failing open', () => {
    // Falling open to AUTO on a garbage value would be the worst possible failure.
    expect(resolveAutonomy({ enabled: true, dryRun: true, autonomyLevel: 'BANANA' })).toBe('PROPOSE')
    expect(resolveAutonomy({ enabled: true, dryRun: false, autonomyLevel: 'BANANA' })).toBe('AUTO')
  })

  it('an explicit OFF on an enabled rule falls back — enabled is the real gate', () => {
    expect(resolveAutonomy({ enabled: true, dryRun: true, autonomyLevel: 'OFF' })).toBe('PROPOSE')
  })
})

describe('what each level permits', () => {
  it('only AUTO writes', () => {
    expect(levelActs('AUTO')).toBe(true)
    for (const l of ['OFF', 'OBSERVE', 'PROPOSE'] as const) expect(levelActs(l)).toBe(false)
  })

  it('only PROPOSE queues a suggestion — OBSERVE is the quiet mode', () => {
    expect(levelProposes('PROPOSE')).toBe(true)
    expect(levelProposes('OBSERVE')).toBe(false)
    expect(levelProposes('AUTO')).toBe(false)
    expect(levelProposes('OFF')).toBe(false)
  })
})

describe('ramping', () => {
  it('moves one notch at a time', () => {
    expect(nextLevel('OFF')).toBe('OBSERVE')
    expect(nextLevel('OBSERVE')).toBe('PROPOSE')
    expect(nextLevel('PROPOSE')).toBe('AUTO')
    expect(prevLevel('AUTO')).toBe('PROPOSE')
  })

  it('clamps at both ends rather than wrapping — wrapping AUTO to OFF would be a disaster', () => {
    expect(nextLevel('AUTO')).toBe('AUTO')
    expect(prevLevel('OFF')).toBe('OFF')
  })

  it('the ladder is ordered least to most autonomous', () => {
    expect(AUTONOMY_LEVELS).toEqual(['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'])
  })
})

describe('account-wide SUGGEST demotes rather than silences', () => {
  // The engine applies this, but the semantics belong with the levels: a mode whose
  // whole purpose is "nothing acts, everything asks" must not stop things asking.
  // The first cut of N2 silenced an AUTO rule under forceDryRun and the ADX.2 test
  // written for that exact case caught it.
  const demote = (declared: string, forced: boolean) =>
    forced && declared === 'AUTO' ? 'PROPOSE' : declared

  it('AUTO demotes to PROPOSE, not to silence', () => {
    expect(demote('AUTO', true)).toBe('PROPOSE')
    expect(levelProposes(demote('AUTO', true) as never)).toBe(true)
  })

  it('OBSERVE stays OBSERVE — a per-rule instruction quieter than the account setting wins', () => {
    expect(demote('OBSERVE', true)).toBe('OBSERVE')
    expect(levelProposes(demote('OBSERVE', true) as never)).toBe(false)
  })

  it('unforced, AUTO stays AUTO', () => {
    expect(demote('AUTO', false)).toBe('AUTO')
    expect(levelActs(demote('AUTO', false) as never)).toBe(true)
  })
})

describe('isAutonomyLevel', () => {
  it('accepts only the four', () => {
    expect(isAutonomyLevel('AUTO')).toBe(true)
    expect(isAutonomyLevel('auto')).toBe(false)
    expect(isAutonomyLevel(null)).toBe(false)
    expect(isAutonomyLevel(3)).toBe(false)
  })
})
