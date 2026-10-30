import { describe, expect, it } from 'vitest'
import { enrolmentCodeOf, floorLocale, homeTiles, idleWarnAfterMs, isBadgeCode, MAX_TILES, modeOf, newPinProblem, noticePages, NOTICE_PAGE_CHARS, rosterLetters, TILE_RULES } from './model'

const OPERATOR = ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'production.cut', 'production.bundles', 'production.scan', 'shipping.pack']

describe('the station\'s mode (design floor.home: from the work centre)', () => {
  it('maps every work centre kind; no station is a warehouse device; subcontract has none', () => {
    expect(modeOf({ workCentreKind: 'CUTTING' })).toBe('cutting')
    expect(modeOf({ workCentreKind: 'SEWING' })).toBe('sewing')
    expect(modeOf({ workCentreKind: 'ASSEMBLY' })).toBe('sewing')
    expect(modeOf({ workCentreKind: 'FINISHING' })).toBe('packing')
    expect(modeOf({ workCentreKind: 'PACKING' })).toBe('packing')
    expect(modeOf({ workCentreKind: 'INSPECTION' })).toBe('inspection')
    expect(modeOf({ workCentreKind: 'SUBCONTRACT' })).toBeNull()
    expect(modeOf(null)).toBe('warehouse')
  })
})

describe('the home tiles: mode AND permission, fail closed, only built pages open', () => {
  it('a cutting operator sees Operation (the cutting operation\'s report), Cut a hide, Bundles and Scan (all open)', () => {
    expect(homeTiles('cutting', OPERATOR, false)).toEqual([
      { key: 'operation', held: null },
      { key: 'cut', held: null },
      { key: 'bundles', held: null },
      { key: 'scan', held: null },
    ])
  })

  it('a tile asks the permission its page\'s API needs (fail closed)', () => {
    expect(homeTiles('cutting', ['floor.work', 'production.cut'], false).map((tile) => tile.key)).toEqual(['cut', 'scan'])
    expect(homeTiles('inspection', ['floor.work', 'production.scan', 'quality.inspections.view'], false).map((tile) => tile.key)).toEqual(['operation', 'final', 'scan'])
    expect(homeTiles('sewing', ['floor.work'], false).map((tile) => tile.key)).toEqual(['scan'])
    expect(homeTiles('sewing', ['floor.work', 'production.scan'], false).map((tile) => tile.key)).toEqual(['operation', 'scan'])
    expect(homeTiles('inspection', ['floor.work', 'quality.inspections.view'], false)).toEqual([
      { key: 'final', held: null },
      { key: 'scan', held: null },
    ])
    // Garment labels at the packing station (SCR-096) ask production.serials, the permission of its API; Pack is built (SCR-098).
    expect(homeTiles('packing', OPERATOR, false)).toEqual([
      { key: 'operation', held: null },
      { key: 'pack', held: null },
      { key: 'scan', held: null },
    ])
    expect(homeTiles('packing', [...OPERATOR, 'production.serials'], false)).toEqual([
      { key: 'operation', held: null },
      { key: 'labels', held: null },
      { key: 'pack', held: null },
      { key: 'scan', held: null },
    ])
  })

  it('drops a tile whose permission the person lacks (Receive needs an office permission)', () => {
    expect(homeTiles('warehouse', OPERATOR, false).map((tile) => tile.key)).toEqual(['pick', 'scan'])
    expect(homeTiles('packing', ['floor.work', 'print.labels'], false).map((tile) => tile.key)).toEqual(['scan'])
    expect(homeTiles('packing', ['floor.work', 'production.serials'], false).map((tile) => tile.key)).toEqual(['labels', 'scan'])
    // A subcontract station: Scan only.
    expect(homeTiles(null, OPERATOR, false).map((tile) => tile.key)).toEqual(['scan'])
  })

  it('shows nothing without floor.work; at most six tiles', () => {
    expect(homeTiles('cutting', ['production.cut'], false)).toEqual([])
    expect(MAX_TILES).toBe(6)
    for (const mode of ['cutting', 'sewing', 'packing', 'inspection', 'warehouse'] as const) expect(homeTiles(mode, OPERATOR, false).length).toBeLessThanOrEqual(MAX_TILES)
  })

  it('holds every scan tile with "Read the notice first" while the notice blocks scans', () => {
    expect(homeTiles('cutting', OPERATOR, true).map((tile) => tile.held)).toEqual(['notice', 'notice', 'notice', 'notice'])
  })

  it('the floor tasks are built: receive (SCR-092) and garment labels (SCR-096) too', () => {
    expect(TILE_RULES.filter((rule) => rule.built).map((rule) => rule.key)).toEqual(['operation', 'cut', 'bundles', 'receive', 'pick', 'labels', 'pack', 'final', 'scan'])
  })
})

describe('the screen\'s language (PLT-062)', () => {
  it('follows the person, else the one picked, else the tenant\'s, else Italian', () => {
    expect(floorLocale({ person: 'en', picked: 'it', tenant: 'it' })).toBe('en')
    expect(floorLocale({ person: 'ro', picked: 'en', tenant: 'it' })).toBe('en')
    expect(floorLocale({ person: 'ro', tenant: 'en' })).toBe('en')
    expect(floorLocale({ picked: 'en', tenant: 'it' })).toBe('en')
    expect(floorLocale({ tenant: 'it-IT' })).toBe('it')
    expect(floorLocale({})).toBe('it')
  })
})

describe('badges and set-up codes', () => {
  it('knows a badge by its shape (26 Crockford base32 characters, grouped or not)', () => {
    expect(isBadgeCode('0123456789ABCDEFGHJKMNPQRS')).toBe(true)
    expect(isBadgeCode('0123-4567-89AB-CDEF-GHJK-MNPQ-RS')).toBe(true)
    expect(isBadgeCode('O123456789abcdefghjkmnpqrs')).toBe(true)
    expect(isBadgeCode('HD-7K-0003RJ-M')).toBe(false)
    expect(isBadgeCode('0123456789ABCDEFGHJKMNPQR')).toBe(false)
    expect(isBadgeCode('0123456789ABCDEFGHJKMNPQRU')).toBe(false)
  })

  it('reads the set-up code from the QR code\'s link or from the code itself', () => {
    const code = 't.s.e.secret'
    expect(enrolmentCodeOf(`https://factory.example/floor/enrol#token=${code}`)).toBe(code)
    expect(enrolmentCodeOf(`#token=${code}`)).toBe(code)
    expect(enrolmentCodeOf(`  ${code} `)).toBe(code)
    expect(enrolmentCodeOf('https://factory.example/floor/enrol')).toBeNull()
    expect(enrolmentCodeOf('#other=1')).toBeNull()
    expect(enrolmentCodeOf('not a code')).toBeNull()
    expect(enrolmentCodeOf('')).toBeNull()
  })
})

describe('the worker notice\'s pages', () => {
  it('groups short paragraphs, never cuts one, keeps the order', () => {
    const body = ['A one.', 'B two.', 'C three.', 'D four.', 'E five.'].join('\n\n')
    const pages = noticePages(body)
    expect(pages).toEqual(['A one.\n\nB two.', 'C three.\n\nD four.', 'E five.'])
    expect(pages.join('\n\n')).toBe(body)
  })

  it('gives a long paragraph a page of its own; an empty text is one empty page', () => {
    const long = 'x'.repeat(NOTICE_PAGE_CHARS + 10)
    expect(noticePages(`short\n\n${long}\n\nend`)).toEqual(['short', long, 'end'])
    expect(noticePages('one\r\n\r\ntwo')).toEqual(['one\n\ntwo'])
    expect(noticePages('  ')).toEqual([''])
  })
})

describe('idle sign-out and the new PIN', () => {
  it('warns 30 seconds before the site\'s idle minutes end, never before a minute', () => {
    expect(idleWarnAfterMs(10)).toBe(10 * 60_000 - 30_000)
    expect(idleWarnAfterMs(1)).toBe(60_000)
    expect(idleWarnAfterMs(Number.NaN)).toBe(10 * 60_000 - 30_000)
  })

  it('says the two rules before the API checks the rest', () => {
    expect(newPinProblem('12345')).toBe('length')
    expect(newPinProblem('111111')).toBe('repeat')
    expect(newPinProblem('123456')).toBe('run')
    expect(newPinProblem('987654')).toBe('run')
    expect(newPinProblem('482913')).toBeNull()
  })

  it('names the letters of the roster for the letter strip', () => {
    expect(rosterLetters([{ name: 'luca' }, { name: 'Ada' }, { name: 'Bea' }, { name: 'Adele' }])).toEqual(['A', 'B', 'L'])
  })
})
