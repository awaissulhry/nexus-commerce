/**
 * `matchesAccept` — the POSITIVE half of gaps item (1)'s acceptance.
 *
 * Why it lives here rather than in a component test: `FileDropzone.handle()` calls `onFiles(picked)`
 * in the same pass as the check, so on PES.7's surfaces an accepted file IS an uploaded file — the
 * positive case cannot be verified in situ without a live upload to the ASIN-global gallery. PES.7
 * verifies the negative there (a `.pdf` refused, `onFiles` never called); the positive is asserted
 * here, on the pure function.
 */
import { describe, expect, it } from 'vitest'
import { matchesAccept, parseAccept } from './accept-match'

const file = (name: string, type: string) => ({ name, type })
const imageOrCsv = parseAccept('image/*,.csv')

describe('parseAccept', () => {
  it('splits, trims, lowercases and drops empties', () => {
    expect(parseAccept('.CSV, .tsv ,, .Json')).toEqual(['.csv', '.tsv', '.json'])
  })
  it('an empty attribute is an empty list', () => {
    expect(parseAccept('')).toEqual([])
    expect(parseAccept('  ,  ')).toEqual([])
  })
})

describe('matchesAccept — the wildcard that never matched', () => {
  const imageStar = parseAccept('image/*')

  it('accepts a .png against image/*', () => {
    expect(matchesAccept(file('shot.png', 'image/png'), imageStar)).toBe(true)
  })
  it('accepts image/jpeg against image/*', () => {
    expect(matchesAccept(file('shot.jpg', 'image/jpeg'), imageStar)).toBe(true)
  })
  it('accepts a bare .png extension entry', () => {
    expect(matchesAccept(file('shot.png', 'image/png'), parseAccept('.png'))).toBe(true)
  })

  // The regression itself: before the fix every one of the three above returned false, because
  // `file.type === 'image/*'` is never true for a real file.
  it('refuses a .pdf against image/* — the case PES.7 verifies in situ', () => {
    expect(matchesAccept(file('sheet.pdf', 'application/pdf'), imageStar)).toBe(false)
  })
  it('a wildcard matches on the slash, so image/* never accepts imagex/png', () => {
    expect(matchesAccept(file('x.bin', 'imagex/png'), imageStar)).toBe(false)
  })
})

describe('matchesAccept — the forms already in use', () => {
  // Every accept= passed by a caller today is an extension list; none contains a wildcard, so the
  // fix is inert for existing surfaces. These pin that.
  const sheets = parseAccept('.csv,.tsv,.xlsx,.xls,.json')

  it('matches by extension regardless of MIME', () => {
    expect(matchesAccept(file('rows.csv', 'text/csv'), sheets)).toBe(true)
    expect(matchesAccept(file('rows.csv', ''), sheets)).toBe(true)
    expect(matchesAccept(file('ROWS.CSV', 'text/csv'), sheets)).toBe(true)
  })
  it('refuses an extension not on the list', () => {
    expect(matchesAccept(file('rows.pdf', 'application/pdf'), sheets)).toBe(false)
  })
  it('an exact MIME entry still matches exactly', () => {
    expect(matchesAccept(file('a', 'text/csv'), parseAccept('text/csv'))).toBe(true)
    expect(matchesAccept(file('a', 'text/plain'), parseAccept('text/csv'))).toBe(false)
  })
  it('an empty list accepts anything', () => {
    expect(matchesAccept(file('anything.exe', 'application/octet-stream'), [])).toBe(true)
  })
  it('an untyped file matches no MIME entry but still matches by extension', () => {
    expect(matchesAccept(file('mystery', ''), imageOrCsv)).toBe(false)
    expect(matchesAccept(file('mystery.csv', ''), imageOrCsv)).toBe(true)
  })
})
