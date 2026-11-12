import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { PLANNING_STRATEGY_MANAGE } from './permissions'
import { DEFAULT_STRATEGY, effectiveStrategy, isStrategy, reasonProblem, strategyItemProblem, strategySummary, takesStrategy } from './rules'

/** B-W2b-319 (PLN-061): the production strategy per item. Every code is made up. */

describe('the production strategy per item', () => {
  it('is make to order until a person sets another, and only for finished garments and components', () => {
    expect(DEFAULT_STRATEGY).toBe('MAKE_TO_ORDER')
    expect(effectiveStrategy(null)).toBe('MAKE_TO_ORDER')
    expect(effectiveStrategy('MAKE_TO_STOCK')).toBe('MAKE_TO_STOCK')
    expect(effectiveStrategy('SOMETHING')).toBe('MAKE_TO_ORDER')
    expect(isStrategy('ASSEMBLE_TO_ORDER')).toBe(true)
    expect(takesStrategy('FINISHED')).toBe(true)
    expect(takesStrategy('COMPONENT')).toBe(true)
    expect(takesStrategy('LEATHER')).toBe(false)
    expect(strategyItemProblem({ code: 'SEED-LEA-01', kind: 'LEATHER', status: 'ACTIVE' })).toEqual({ path: 'body/itemId', message: 'SEED-LEA-01 is a leather material: only finished garments and components we make have a production strategy.' })
    expect(strategyItemProblem({ code: 'SEED-JKT-02-BLK-52', kind: 'FINISHED', status: 'ARCHIVED' }, 'body/items/0/itemId')).toMatchObject({ path: 'body/items/0/itemId' })
    expect(strategyItemProblem({ code: 'SEED-JKT-02-BLK-52', kind: 'FINISHED', status: 'ACTIVE' })).toBeNull()
  })

  it('takes an optional reason of a few words', () => {
    expect(reasonProblem(undefined)).toBeNull()
    expect(reasonProblem('Builds ahead for the spring fair')).toBeNull()
    expect(reasonProblem('   ')).toMatchObject({ path: 'body/reason' })
    expect(reasonProblem('x'.repeat(501))).toMatchObject({ path: 'body/reason' })
  })

  it('says one word for a style-colour’s SKUs: their one strategy, or MIXED', () => {
    expect(strategySummary([])).toBe('MAKE_TO_ORDER')
    expect(strategySummary(['MAKE_TO_STOCK', 'MAKE_TO_STOCK'])).toBe('MAKE_TO_STOCK')
    expect(strategySummary(['MAKE_TO_STOCK', 'MAKE_TO_ORDER'])).toBe('MIXED')
  })

  it('is kept by the planner and the production manager (a write), declared in the catalogue', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PLANNING_STRATEGY_MANAGE)).toBe(true)
    const holders = ROLE_TEMPLATES.filter((template) => template.permissions.includes(PLANNING_STRATEGY_MANAGE)).map((template) => template.key).sort()
    expect(holders).toEqual(['owner', 'planner', 'production_manager'])
  })
})
