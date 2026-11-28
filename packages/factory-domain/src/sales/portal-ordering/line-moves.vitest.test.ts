import { describe, expect, it } from 'vitest'
import { isMaterialTopic, lineModelOf, LINE_MOVE_WORDS, materialOf, MATERIAL_TOPIC, removedLineWords, sizesText } from './line-moves'

/** owb- po1.3 + po1.1: the ONE lines table's facts — material (settle 4), the model of a line, sizes in words, a line taken out. */
describe('line moves and facts (owb- po1.3)', () => {
  it('material: the "Material" choice (any case, EN or IT topic) wins over the colourway; nothing picked falls back; none is null', () => {
    expect(isMaterialTopic(MATERIAL_TOPIC)).toBe(true)
    expect(isMaterialTopic(' pelle ')).toBe(true)
    expect(isMaterialTopic('Protection class')).toBe(false)
    expect(materialOf({ choices: [{ topic: 'Leather', picked: 'Kangaroo' }], colourwayName: 'Black' })).toBe('Kangaroo')
    expect(materialOf({ choices: [{ topic: 'Material', picked: null }], colourwayName: 'Black' })).toBe('Black')
    expect(materialOf({ choices: [{ topic: 'Protection class', picked: 'AAA' }], colourwayName: null })).toBeNull()
    expect(materialOf({ choices: null, colourwayName: '  ' })).toBeNull()
  })

  it('the model of a line: the customer’s own label, the factory’s range, a new design, the customer’s words', () => {
    const party = 'p-1'
    expect(lineModelOf({ styleId: 's-1', styleBrandPartyId: party, styleWords: 'SEED-JKT-02 Racing jacket', description: null, garmentType: null }, party)).toEqual({ kind: 'OWN', words: 'SEED-JKT-02 Racing jacket', garmentType: null })
    expect(lineModelOf({ styleId: 's-2', styleBrandPartyId: null, styleWords: 'SEED-JKT-09 Range jacket', description: null, garmentType: null }, party).kind).toBe('RANGE')
    expect(lineModelOf({ styleId: null, styleBrandPartyId: null, styleWords: null, description: 'A new race suit', garmentType: 'RACE_SUIT' }, party)).toEqual({ kind: 'NEW', words: 'A new race suit', garmentType: 'RACE_SUIT' })
    expect(lineModelOf({ styleId: null, styleBrandPartyId: null, styleWords: null, description: 'As in my message', garmentType: '  ' }, party)).toEqual({ kind: 'TEXT', words: 'As in my message', garmentType: null })
  })

  it('sizes in words and a taken-out line’s words', () => {
    expect(sizesText([{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }])).toBe('50 × 2 · 52 × 3')
    expect(sizesText([{ size: null, quantity: 4 }])).toBe('4')
    expect(sizesText([{ size: '50', quantity: 0 }])).toBeNull()
    expect(removedLineWords({ seq: 3, styleWords: null, description: null, garmentType: 'JACKET' })).toBe('JACKET')
    expect(removedLineWords({ seq: 3, styleWords: null, description: null, garmentType: null })).toBe('#3')
  })

  it('says its refusals in English and Italian', () => {
    expect(LINE_MOVE_WORDS.NOT_TAKEN_OUT.it.length).toBeGreaterThan(10)
    expect(LINE_MOVE_WORDS.TOO_MANY(200)).toEqual({ en: 'At most 200 lines per order: take one out first.', it: 'Al massimo 200 righe per ordine: togliete prima una riga.' })
  })
})
