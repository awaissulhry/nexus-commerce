import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { DIE_CONDITIONS, DIE_REFUSALS, DIE_ROW_CONDITIONS, DIE_ROWS, dieDraftProblems, dieRefusal, isSettableCondition, normalDieCode, retiredNote, sizeFits } from './dies'
import { events } from '../../plant-dies/events'

/** The clicking-die register's rules (B-W2b-136; QHS-173): what the API checks before the database's guard does. */

describe('a die number', () => {
  it('is stamped upper case without spaces', () => {
    expect(normalDieCode('  d-0007 a ')).toBe('D-0007A')
    expect(dieDraftProblems({ code: 'd 12', piece: 'Sleeve' }, true)).toEqual([])
  })

  it('refuses no number, a number with odd signs, and one too long', () => {
    expect(dieDraftProblems({ code: '  ', piece: 'Sleeve' }, true).map((p) => p.path)).toEqual(['code'])
    expect(dieDraftProblems({ code: 'D#1', piece: 'Sleeve' }, true).map((p) => p.path)).toEqual(['code'])
    expect(dieDraftProblems({ code: 'D'.repeat(41), piece: 'Sleeve' }, true).map((p) => p.path)).toEqual(['code'])
  })
})

describe('a die as typed', () => {
  it('asks the piece in words when creating, and words that are not blank when given', () => {
    expect(dieDraftProblems({ code: 'D-1', piece: ' ' }, true).map((p) => p.path)).toEqual(['piece'])
    expect(dieDraftProblems({ rackLocation: ' ', material: '', size: '' }, false).map((p) => p.path)).toEqual(['size', 'rackLocation', 'material'])
    expect(dieDraftProblems({ rackLocation: null, material: null, size: null }, false)).toEqual([])
  })

  it('takes a cost from 0 in whole cents, never a fraction or a negative', () => {
    expect(dieDraftProblems({ purchaseCost: 0 }, false)).toEqual([])
    expect(dieDraftProblems({ purchaseCost: 1850 }, false)).toEqual([])
    expect(dieDraftProblems({ purchaseCost: -1 }, false).map((p) => p.path)).toEqual(['purchaseCost'])
    expect(dieDraftProblems({ purchaseCost: 12.5 }, false).map((p) => p.path)).toEqual(['purchaseCost'])
  })

  it('a change checks only what it sends', () => {
    expect(dieDraftProblems({ note: 'Re-sharpened' }, false)).toEqual([])
  })
})

describe('sizes, conditions and the saved rows', () => {
  it('a size is one of the style\'s, or none for every size', () => {
    expect(sizeFits(null, ['48', '50'])).toBe(true)
    expect(sizeFits('50', ['48', '50'])).toBe(true)
    expect(sizeFits('56', ['48', '50'])).toBe(false)
  })

  it('a person sets good, worn or damaged by hand; retired only through Retire', () => {
    expect(isSettableCondition('WORN')).toBe(true)
    expect(isSettableCondition('RETIRED')).toBe(false)
    expect(DIE_CONDITIONS).toEqual(['GOOD', 'WORN', 'DAMAGED', 'RETIRED'])
  })

  it('in use hides retired dies; worn lists those to replace', () => {
    expect(DIE_ROW_CONDITIONS.inUse).not.toContain('RETIRED')
    expect(DIE_ROW_CONDITIONS.worn).toEqual(['WORN', 'DAMAGED'])
    expect(DIE_ROW_CONDITIONS.all).toEqual(DIE_CONDITIONS)
    expect(DIE_ROWS).toEqual(['inUse', 'worn', 'retired', 'all'])
  })

  it('retiring keeps the note and adds the reason on its own line', () => {
    expect(retiredNote(null, ' Cracked ', '2026-11-07')).toBe('Retired 2026-11-07: Cracked')
    expect(retiredNote('Re-sharpened in May', 'Cracked', '2026-11-07')).toBe('Re-sharpened in May\nRetired 2026-11-07: Cracked')
    expect(retiredNote('x'.repeat(1000), 'Cracked', '2026-11-07')).toHaveLength(1000)
  })
})

describe('refusals and the event', () => {
  it('every refusal has its words and its fix', () => {
    const all = [dieRefusal.retired('D-1'), dieRefusal.numberTaken('D-1'), dieRefusal.sizeNotInStyle('56', 'JKT'), dieRefusal.pieceOtherStyle('JKT'), dieRefusal.retiredByRetire(), dieRefusal.styleUnknown()]
    expect(all.map((refusal) => refusal.code).sort()).toEqual([...DIE_REFUSALS].sort())
    for (const refusal of all) {
      expect(refusal.message.length).toBeGreaterThan(10)
      expect(refusal.fix.length).toBeGreaterThan(5)
    }
  })

  it('clicking_die.changed is declared, assembled in the catalogue, and carries no cost', () => {
    expect(events.map((event) => event.type)).toEqual(['clicking_die.changed'])
    const declared = EVENT_CATALOGUE.definitions.find((event) => event.type === 'clicking_die.changed')
    expect(declared?.live?.permission).toBe('plant.view')
    const payload = { dieId: '00000000-0000-4000-8000-000000000001', code: 'D-1', styleId: '00000000-0000-4000-8000-000000000002', change: 'CHANGED', fields: ['rackLocation'] }
    expect(declared!.payload.parse(payload)).toEqual(payload)
    expect(() => declared!.payload.parse({ ...payload, purchaseCost: 100 })).toThrow()
  })
})
