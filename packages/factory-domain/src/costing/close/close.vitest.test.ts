import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { WORKORDERS_REOPEN } from './permissions'
import { beyondOf, beyondWords, CLOSE_REASON_WORDS, CLOSE_REASONS, isBeyond, mayUndo, reasonRefusal, undoUntil, type CloseFigures } from './rules'

/**
 * The work order close (B-W2b-411; MES-012, MES-013), pure: planned against actual judged as the database judges it
 * (factory_work_order_close_check), the reason it needs, the closer's Undo. Every figure is made up.
 */

const figures = (fields: Partial<CloseFigures> = {}): CloseFigures => ({
  plannedQuantity: 10,
  actualQuantity: 10,
  plannedScrapQuantity: 0,
  scrapQuantity: 0,
  plannedMaterialCost: 10_000,
  actualMaterialCost: 10_000,
  plannedMinutes: '100',
  actualMinutes: '100',
  ...fields,
})

describe('planned against actual, against the tolerance (MES-012)', () => {
  it('a figure is beyond when it differs by more than the tolerance of the planned one; nothing planned: anything actual', () => {
    expect(isBeyond(100, 105, '5')).toBe(false)
    expect(isBeyond(100, 105.01, '5')).toBe(true)
    expect(isBeyond('100', '94.5', '5')).toBe(true)
    expect(isBeyond(0, 0, '5')).toBe(false)
    expect(isBeyond(0, 1, '5')).toBe(true)
  })

  it('judges garments, material, minutes and scrap as the database does', () => {
    expect(beyondOf(figures(), '5')).toEqual({ quantity: false, material: false, minutes: false, scrap: false, any: false })
    // 9 of 10 garments (10 %), material 104.00 of 100.00 (4 %), minutes 104.5 of 100 (4.5 %), 1 scrapped (10 % of the planned).
    expect(beyondOf(figures({ actualQuantity: 9, actualMaterialCost: 10_400, actualMinutes: '104.5', scrapQuantity: 1 }), '5')).toEqual({ quantity: true, material: false, minutes: false, scrap: true, any: true })
    // With a 10 % tolerance the same garments and scrap are within it.
    expect(beyondOf(figures({ actualQuantity: 9, scrapQuantity: 1 }), '10').any).toBe(false)
    // Nothing planned: any scrap is beyond.
    expect(beyondOf(figures({ plannedQuantity: 0, actualQuantity: 0, scrapQuantity: 1 }), '5').scrap).toBe(true)
  })

  it('asks a reason exactly when beyond; OTHER needs words; within it takes none', () => {
    const beyond = beyondOf(figures({ actualQuantity: 9, scrapQuantity: 1 }), '5')
    expect(beyondWords(beyond, '5')).toBe('Beyond the 5 % tolerance (garments made and scrap): give a reason.')
    expect(reasonRefusal(beyond, undefined, undefined, '5')).toEqual({ code: 'REASON_NEEDED', message: 'Beyond the 5 % tolerance (garments made and scrap): give a reason.' })
    expect(reasonRefusal(beyond, 'OTHER', ' ', '5')).toMatchObject({ code: 'NOTE_NEEDED' })
    expect(reasonRefusal(beyond, 'OTHER', 'A size was cut twice', '5')).toBeNull()
    expect(reasonRefusal(beyond, 'SHORT_PRODUCED', undefined, '5')).toBeNull()
    const within = beyondOf(figures(), '5')
    expect(beyondWords(within, '5')).toBe('Within the 5 % tolerance: no reason is needed.')
    expect(reasonRefusal(within, 'SHORT_PRODUCED', undefined, '5')).toMatchObject({ code: 'REASON_NOT_NEEDED' })
    expect(reasonRefusal(within, undefined, 'Closed after the fair', '5')).toBeNull()
  })

  it('every reason has words and fits the database shape (capitals, digits, underscores)', () => {
    for (const code of CLOSE_REASONS) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]{0,39}$/)
      expect(CLOSE_REASON_WORDS[code].length).toBeGreaterThan(3)
    }
  })
})

describe('the Undo and the reopen (MES-013)', () => {
  const closedAt = new Date('2026-11-14T09:00:00.000Z')
  it('the person who closed it undoes it within 60 seconds; anyone else, or later, reopens it with a reason', () => {
    const close = { closedAt, closedById: 'closer' }
    expect(mayUndo(close, 'closer', new Date('2026-11-14T09:00:59.000Z'))).toBe(true)
    expect(mayUndo(close, 'closer', new Date('2026-11-14T09:01:00.000Z'))).toBe(true)
    expect(mayUndo(close, 'closer', new Date('2026-11-14T09:01:00.001Z'))).toBe(false)
    expect(mayUndo(close, 'someone else', new Date('2026-11-14T09:00:05.000Z'))).toBe(false)
    expect(undoUntil(closedAt).toISOString()).toBe('2026-11-14T09:01:00.000Z')
  })

  it('reopening is its own permission, given to the production manager', () => {
    expect(FACTORY_PERMISSIONS.get(WORKORDERS_REOPEN)).toMatchObject({ area: 'workorders', risk: 'write' })
    expect(templateOf('production_manager')!.permissions).toContain(WORKORDERS_REOPEN)
    expect(templateOf('planner')!.permissions).not.toContain(WORKORDERS_REOPEN)
    expect(templateOf('finance')!.permissions).not.toContain(WORKORDERS_REOPEN)
  })
})
