import { describe, expect, it } from 'vitest'
import { planTeams, ruleDead, ruleFor, rulePlace, sameOrdersRule, structureOf, tryOrder, type StructureRuleFacts } from './rules'

/**
 * owb-ss6 step 6.1: the pure rules of order structures (written, not run in the build: Owner rule, checks at the end). The cases of
 * the design's table "Your cases" (order-workflow-2026-11-25 plan.md § 5zj C), with made-up customers and structures: SEED (a brand
 * with its race team), ALPHA (another brand), and "Molded parts" stood in by the category OTHER (S4's product types come later).
 */

const SEED = 'party-seed'
const ALPHA = 'party-alpha'
const BETA = 'party-beta'

let place = 0
const rule = (id: string, partyId: string | null, category: string | null, structureId: string, extra: Partial<StructureRuleFacts> = {}): StructureRuleFacts => ({
  id,
  sortOrder: ++place,
  partyId,
  category,
  structureId,
  active: true,
  closed: false,
  structureClosed: false,
  ...extra,
})
const PARTY_NAMES: Readonly<Record<string, string>> = { [SEED]: 'Seed Racing', [ALPHA]: 'Brand Alpha', [BETA]: 'Brand Beta' }
const STRUCTURE_NAMES: Readonly<Record<string, string>> = { race: 'Seed Racing · race team', gloves: 'Gloves · short way', molded: 'Molded parts', alpha: 'Brand Alpha line' }
const names = { party: (id: string) => PARTY_NAMES[id] ?? null, structure: (id: string) => STRUCTURE_NAMES[id] ?? null }

describe('your cases (design § 5zj C)', () => {
  it('“a certain structure for a certain brand”: Seed Racing · any category → the race team; another brand goes the normal way', () => {
    const rules = [rule('r-seed', SEED, null, 'race')]
    expect(structureOf({ partyId: SEED, category: 'JACKET' }, rules, null, names)).toEqual({ structureId: 'race', ruleId: 'r-seed', from: 'RULE', why: 'Rule 1 fits (Seed Racing · any category).' })
    expect(structureOf({ partyId: ALPHA, category: 'JACKET' }, rules, null, names)).toMatchObject({ structureId: null, ruleId: null, from: 'NORMAL' })
  })

  it('“a different one for the other brands”: a rule for each brand; a brand with no rule goes the normal way', () => {
    const rules = [rule('r-seed', SEED, null, 'race'), rule('r-alpha', ALPHA, null, 'alpha')]
    expect(ruleFor({ partyId: SEED, category: 'SUIT' }, rules)?.id).toBe('r-seed')
    expect(ruleFor({ partyId: ALPHA, category: 'SUIT' }, rules)?.id).toBe('r-alpha')
    expect(ruleFor({ partyId: BETA, category: 'SUIT' }, rules)).toBeNull()
  })

  it('“just certain categories”: Seed Racing · Gloves stands ABOVE the brand rule and wins for the gloves only', () => {
    const rules = [rule('r-gloves', SEED, 'GLOVES', 'gloves'), rule('r-seed', SEED, null, 'race')]
    expect(structureOf({ partyId: SEED, category: 'GLOVES' }, rules, null, names)).toMatchObject({ structureId: 'gloves', ruleId: 'r-gloves', from: 'RULE' })
    expect(structureOf({ partyId: SEED, category: 'JACKET' }, rules, null, names)).toMatchObject({ structureId: 'race', ruleId: 'r-seed', why: 'Rule 2 fits (Seed Racing · any category).' })
  })

  it('“categories which have a completely different structure”: any customer · Molded parts above the brand rules wins for every brand', () => {
    const rules = [rule('r-molded', null, 'OTHER', 'molded'), rule('r-seed', SEED, null, 'race'), rule('r-alpha', ALPHA, null, 'alpha')]
    for (const partyId of [SEED, ALPHA, BETA]) expect(ruleFor({ partyId, category: 'OTHER' }, rules)?.id).toBe('r-molded')
    expect(ruleFor({ partyId: SEED, category: 'JACKET' }, rules)?.id).toBe('r-seed')
  })

  it('“some exceptions”: a more exact rule above takes its orders first', () => {
    const rules = [rule('r-alpha-vest', ALPHA, 'VEST', 'race'), rule('r-alpha', ALPHA, null, 'alpha')]
    expect(ruleFor({ partyId: ALPHA, category: 'VEST' }, rules)?.id).toBe('r-alpha-vest')
    expect(ruleFor({ partyId: ALPHA, category: 'JACKET' }, rules)?.id).toBe('r-alpha')
  })

  it('“some specific orders”: by hand wins over every rule (a structure, or the normal way); a closed structure by hand gives way to the rules', () => {
    const rules = [rule('r-seed', SEED, null, 'race')]
    expect(structureOf({ partyId: SEED, category: 'JACKET' }, rules, { structureId: 'molded', why: 'A show piece.', structureClosed: false })).toEqual({ structureId: 'molded', ruleId: null, from: 'ORDER', why: 'Chosen by hand for this order: A show piece.' })
    expect(structureOf({ partyId: SEED, category: 'JACKET' }, rules, { structureId: null, why: 'Made as before.', structureClosed: false })).toMatchObject({ structureId: null, ruleId: null, from: 'ORDER' })
    const fallen = structureOf({ partyId: SEED, category: 'JACKET' }, rules, { structureId: 'molded', why: 'A show piece.', structureClosed: true }, names)
    expect(fallen).toMatchObject({ structureId: 'race', ruleId: 'r-seed', from: 'RULE' })
    expect(fallen.why).toContain('closed')
  })

  it('a rule that is off, closed or gives a closed structure is skipped', () => {
    const rules = [rule('r-off', SEED, null, 'molded', { active: false }), rule('r-shut', SEED, null, 'gloves', { closed: true }), rule('r-gone', SEED, null, 'alpha', { structureClosed: true }), rule('r-any', null, null, 'race')]
    expect(ruleFor({ partyId: SEED, category: 'JACKET' }, rules)?.id).toBe('r-any')
  })
})

describe('“Never used”, the place of a new rule, two rules for the same orders', () => {
  it('a rule a broader rule ABOVE takes whole is dead, with the rule that takes it; one partly taken is not', () => {
    const rules = [rule('r-seed', SEED, null, 'race'), rule('r-gloves', SEED, 'GLOVES', 'gloves'), rule('r-molded', null, 'OTHER', 'molded')]
    const dead = ruleDead(rules)
    expect(dead.get('r-gloves')).toBe('r-seed')
    // Seed's molded parts are taken by rule 1; every other brand's are not: it is used.
    expect(dead.has('r-molded')).toBe(false)
    expect(dead.size).toBe(1)
  })

  it('a broad rule that is off, or gives a closed structure, takes nothing', () => {
    expect(ruleDead([rule('r-seed', SEED, null, 'race', { active: false }), rule('r-gloves', SEED, 'GLOVES', 'gloves')]).size).toBe(0)
    expect(ruleDead([rule('r-seed', SEED, null, 'race', { structureClosed: true }), rule('r-gloves', SEED, 'GLOVES', 'gloves')]).size).toBe(0)
  })

  it('a new rule goes above the first rule that would take all its orders, so it is never dead; else at the end', () => {
    const rules = [rule('r-molded', null, 'OTHER', 'molded'), rule('r-seed', SEED, null, 'race'), rule('r-alpha', ALPHA, null, 'alpha')]
    expect(rulePlace({ partyId: SEED, category: 'GLOVES' }, rules)).toBe(1)
    expect(rulePlace({ partyId: SEED, category: 'OTHER' }, rules)).toBe(0)
    expect(rulePlace({ partyId: BETA, category: null }, rules)).toBe(3)
    const placed = [...rules.slice(0, 1), rule('r-new', SEED, 'GLOVES', 'gloves'), ...rules.slice(1)].map((entry, index) => ({ ...entry, sortOrder: index + 1 }))
    expect(ruleDead(placed).has('r-new')).toBe(false)
  })

  it('two open rules for exactly the same orders: the other is found (a closed one is not)', () => {
    const rules = [rule('r-seed', SEED, null, 'race'), rule('r-any-gloves', null, 'GLOVES', 'gloves'), rule('r-old', ALPHA, null, 'alpha', { closed: true })]
    expect(sameOrdersRule({ partyId: SEED, category: null }, rules)?.id).toBe('r-seed')
    expect(sameOrdersRule({ partyId: null, category: 'GLOVES' }, rules)?.id).toBe('r-any-gloves')
    expect(sameOrdersRule({ partyId: SEED, category: null }, rules, 'r-seed')).toBeNull()
    expect(sameOrdersRule({ partyId: ALPHA, category: null }, rules)).toBeNull()
    expect(sameOrdersRule({ partyId: SEED, category: 'GLOVES' }, rules)).toBeNull()
  })
})

describe('Try an order', () => {
  it('the winner, and why each other rule does not win', () => {
    const rules = [rule('r-gloves', SEED, 'GLOVES', 'gloves'), rule('r-off', null, null, 'molded', { active: false }), rule('r-seed', SEED, null, 'race'), rule('r-alpha', ALPHA, null, 'alpha'), rule('r-any', null, null, 'molded')]
    const answer = tryOrder({ partyId: SEED, category: 'JACKET' }, rules, names)
    expect(answer.winner).toEqual({ ruleId: 'r-seed', structureId: 'race', words: 'Rule 3 wins → Seed Racing · race team' })
    expect(answer.others).toEqual([
      { ruleId: 'r-gloves', words: 'Rule 1 (Seed Racing · Gloves): it is for another category.' },
      { ruleId: 'r-off', words: 'Rule 2 (Any customer · any category): it is off.' },
      { ruleId: 'r-alpha', words: 'Rule 4 (Brand Alpha · any category): it is for another customer.' },
      { ruleId: 'r-any', words: 'Rule 5 (Any customer · any category): a rule above fits first.' },
    ])
  })

  it('no rule fits → the normal way', () => {
    const answer = tryOrder({ partyId: BETA, category: 'VEST' }, [rule('r-seed', SEED, null, 'race')], names)
    expect(answer.winner).toEqual({ ruleId: null, structureId: null, words: 'No rule fits → The normal way' })
    expect(answer.others).toHaveLength(1)
  })
})

describe('planTeams: the teams the structures give at Confirm', () => {
  it('no structure names a team: none (the team by hand, as today)', () => {
    expect(planTeams([])).toEqual([])
    expect(planTeams([{ pieces: 4, teamIds: [] }])).toEqual([])
  })

  it('the same teams for every line: together, the first in charge, no share', () => {
    expect(planTeams([{ pieces: 4, teamIds: ['t1', 't2'] }, { pieces: 3, teamIds: ['t1', 't2'] }])).toEqual([
      { teamId: 't1', inCharge: true, basketShare: null },
      { teamId: 't2', inCharge: false, basketShare: null },
    ])
  })

  it('one team per line group (suits and gloves): a split, each team its lines’ pieces, the first line’s team in charge', () => {
    expect(planTeams([{ pieces: 5, teamIds: ['suits'] }, { pieces: 12, teamIds: ['gloves'] }, { pieces: 2, teamIds: ['suits'] }])).toEqual([
      { teamId: 'suits', inCharge: true, basketShare: 7 },
      { teamId: 'gloves', inCharge: false, basketShare: 12 },
    ])
  })

  it('a line with no team or with several beside other lines: they work together', () => {
    expect(planTeams([{ pieces: 5, teamIds: ['suits'] }, { pieces: 3, teamIds: [] }])).toEqual([{ teamId: 'suits', inCharge: true, basketShare: null }])
    expect(planTeams([{ pieces: 5, teamIds: ['a', 'b'] }, { pieces: 3, teamIds: ['c'] }])).toEqual([
      { teamId: 'a', inCharge: true, basketShare: null },
      { teamId: 'b', inCharge: false, basketShare: null },
      { teamId: 'c', inCharge: false, basketShare: null },
    ])
  })
})
