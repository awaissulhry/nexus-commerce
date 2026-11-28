import { describe, expect, it } from 'vitest'
import { cleanName, closeRefusal, defaultOperationCode, DEPARTMENT_REFUSAL_CODES, DEPARTMENT_REFUSALS, departmentRefusalWords, DEPARTMENT_TONES, nameTakenBy, nextDepartmentNumber, renameRefusal, toneForNew } from './rules'

/** owb-pd1 1.3: keeping the factory's departments, pure. */
describe('a new department (S4 settle 7)', () => {
  it('takes the first grid tone no ACTIVE department uses, else slate', () => {
    // The seed's nine: blue, orange, pink, cyan, purple, yellow, violet, slate, emerald → red is the first free one.
    expect(toneForNew(['blue', 'orange', 'pink', 'cyan', 'purple', 'yellow', 'violet', 'slate', 'emerald'])).toBe('red')
    expect(toneForNew([])).toBe('slate')
    expect(toneForNew([...DEPARTMENT_TONES])).toBe('slate')
  })

  it('takes the highest number ever given + 1 (a closed one keeps its number: none comes back)', () => {
    expect(nextDepartmentNumber([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(10)
    expect(nextDepartmentNumber([1, 9, 4])).toBe(10)
    expect(nextDepartmentNumber([])).toBe(1)
    expect(defaultOperationCode(10)).toBe('DEPT-10')
  })
})

describe('names', () => {
  const seeded = [
    { id: 'a', name: 'Patchwork & printing', shortName: 'Patch & print' },
    { id: 'b', name: 'Quality check', shortName: 'Quality' },
  ]

  it('cleans a name: trimmed, one space between words', () => {
    expect(cleanName('  Laser   cutting ')).toBe('Laser cutting')
    expect(cleanName('   ')).toBe('')
    expect(cleanName(undefined)).toBe('')
  })

  it('is taken by another department’s name or short name, letter case aside; never by the department itself', () => {
    expect(nameTakenBy('quality', seeded)?.id).toBe('b')
    expect(nameTakenBy('PATCH & PRINT', seeded)?.id).toBe('a')
    expect(nameTakenBy(' quality   check ', seeded)?.id).toBe('b')
    expect(nameTakenBy('Quality', seeded, 'b')).toBeNull()
    expect(nameTakenBy('Embroidery', seeded)).toBeNull()
  })

  it('refuses a blank name, a rename of a floor department and of a closed one', () => {
    const open = { floorReady: false, status: 'ACTIVE', name: 'Embroidery', shortName: 'Embroidery' }
    expect(renameRefusal(open, { name: '  ' })).toBe('NAME_EMPTY')
    expect(renameRefusal(open, { name: 'Embroidery hall' })).toBeNull()
    expect(renameRefusal({ ...open, floorReady: true }, { name: 'Embroidery hall' })).toBe('FLOOR_FIXED')
    expect(renameRefusal({ ...open, floorReady: true }, { shortName: 'Emb.' })).toBe('FLOOR_FIXED')
    // The same names again change nothing: no refusal, even on the floor.
    expect(renameRefusal({ ...open, floorReady: true }, { name: 'Embroidery' })).toBeNull()
    expect(renameRefusal({ ...open, status: 'CLOSED' }, { name: 'Embroidery hall' })).toBe('CLOSED')
    expect(closeRefusal({ floorReady: true })).toBe('FLOOR_FIXED')
    expect(closeRefusal({ floorReady: false })).toBeNull()
  })
})

describe('the words of a refusal', () => {
  it('has English and Italian words for every code, the code filled in', () => {
    for (const code of DEPARTMENT_REFUSAL_CODES) {
      expect(DEPARTMENT_REFUSALS[code].en.length, code).toBeGreaterThan(0)
      expect(DEPARTMENT_REFUSALS[code].it.length, code).toBeGreaterThan(0)
    }
    expect(departmentRefusalWords('CODE_TAKEN', 'en', { code: 'DEPT-10' })).toContain('DEPT-10')
    expect(departmentRefusalWords('NAME_EMPTY')).toBe('A department needs a name.')
  })
})
