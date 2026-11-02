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
    // B-W2b-67: a line tablet or a person's own phone with no station is no warehouse device.
    expect(modeOf(null, 'STATION')).toBe('warehouse')
    expect(modeOf(null, 'LINE')).toBeNull()
    expect(modeOf(null, 'PHONE')).toBeNull()
    expect(modeOf({ workCentreKind: 'SEWING' }, 'LINE')).toBe('sewing')
  })
})

describe('the home tiles: mode AND permission, fail closed, only built pages open', () => {
  it('Clock is on every tablet, a phone too; the worker notice does not hold it; Scan anything stays last on a full home', () => {
    expect(homeTiles(null, ['floor.work'], false).map((tile) => tile.key)).toEqual(['clock', 'scan'])
    expect(homeTiles('sewing', ['floor.work'], true)).toEqual([
      { key: 'mywork', held: null },
      { key: 'clock', held: null },
      { key: 'help', held: null },
      { key: 'scan', held: 'notice' },
    ])
    // A line tablet's Home: no station's tiles; a team leader keeps the Line view.
    expect(homeTiles(null, ['floor.work', 'floor.lead'], false).map((tile) => tile.key)).toEqual(['clock', 'lineview', 'scan'])
    const full = homeTiles('cutting', [...OPERATOR, 'production.bundles', 'production.cut', 'plant.report'], false).map((tile) => tile.key)
    expect(full).toHaveLength(MAX_TILES)
    expect(full[full.length - 1]).toBe('scan')
  })

  it('a cutting operator sees My work, Operation (the cutting operation\'s report), Cut a hide, Bundles and Scan (all open)', () => {
    expect(homeTiles('cutting', OPERATOR, false)).toEqual([
      { key: 'mywork', held: null },
      { key: 'operation', held: null },
      { key: 'cut', held: null },
      { key: 'bundles', held: null },
      { key: 'clock', held: null },
      { key: 'help', held: null },
      { key: 'scan', held: null },
    ])
  })

  it('a tile asks the permission its page\'s API needs (fail closed)', () => {
    expect(homeTiles('cutting', ['floor.work', 'production.cut'], false).map((tile) => tile.key)).toEqual(['mywork', 'cut', 'clock', 'help', 'scan'])
    expect(homeTiles('inspection', ['floor.work', 'production.scan', 'quality.inspections.view'], false).map((tile) => tile.key)).toEqual(['mywork', 'operation', 'final', 'clock', 'help', 'scan'])
    expect(homeTiles('sewing', ['floor.work'], false).map((tile) => tile.key)).toEqual(['mywork', 'clock', 'help', 'scan'])
    expect(homeTiles('sewing', ['floor.work', 'production.scan'], false).map((tile) => tile.key)).toEqual(['mywork', 'operation', 'clock', 'help', 'scan'])
    expect(homeTiles('inspection', ['floor.work', 'quality.inspections.view'], false)).toEqual([
      { key: 'mywork', held: null },
      { key: 'final', held: null },
      { key: 'clock', held: null },
      { key: 'help', held: null },
      { key: 'scan', held: null },
    ])
    // Garment labels at the packing station (SCR-096) ask production.serials, the permission of its API; Pack is built (SCR-098).
    expect(homeTiles('packing', OPERATOR, false)).toEqual([
      { key: 'mywork', held: null },
      { key: 'operation', held: null },
      { key: 'pack', held: null },
      { key: 'clock', held: null },
      { key: 'help', held: null },
      { key: 'scan', held: null },
    ])
    expect(homeTiles('packing', [...OPERATOR, 'production.serials'], false)).toEqual([
      { key: 'mywork', held: null },
      { key: 'operation', held: null },
      { key: 'labels', held: null },
      { key: 'pack', held: null },
      { key: 'clock', held: null },
      { key: 'help', held: null },
      { key: 'scan', held: null },
    ])
  })

  it('drops a tile whose permission the person lacks (Receive needs an office permission)', () => {
    expect(homeTiles('warehouse', OPERATOR, false).map((tile) => tile.key)).toEqual(['pick', 'clock', 'help', 'scan'])
    expect(homeTiles('packing', ['floor.work', 'print.labels'], false).map((tile) => tile.key)).toEqual(['mywork', 'clock', 'help', 'scan'])
    expect(homeTiles('packing', ['floor.work', 'production.serials'], false).map((tile) => tile.key)).toEqual(['mywork', 'labels', 'clock', 'help', 'scan'])
    // A subcontract station: Scan only.
    expect(homeTiles(null, OPERATOR, false).map((tile) => tile.key)).toEqual(['clock', 'scan'])
  })

  it('shows nothing without floor.work; at most six tiles', () => {
    expect(homeTiles('cutting', ['production.cut'], false)).toEqual([])
    expect(MAX_TILES).toBe(6)
    for (const mode of ['cutting', 'sewing', 'packing', 'inspection', 'warehouse'] as const) expect(homeTiles(mode, OPERATOR, false).length).toBeLessThanOrEqual(MAX_TILES)
  })

  it('holds every scan tile with "Read the notice first" while the notice blocks scans (My work only reads: never held)', () => {
    expect(homeTiles('cutting', OPERATOR, true).map((tile) => tile.held)).toEqual([null, 'notice', 'notice', 'notice', null, 'notice'])
  })

  it('the floor tasks are built: receive (SCR-092) and garment labels (SCR-096) too', () => {
    expect(TILE_RULES.filter((rule) => rule.built).map((rule) => rule.key)).toEqual(['mywork', 'operation', 'cut', 'bundles', 'receive', 'pick', /* B-W2a-76 */ 'returnsin', 'kits', 'labels', 'pack', 'final', 'machine', 'clock', /* B-W2b-70 */ 'help', 'lineview', 'scan'])
  })

  it('B-W2a-73: Machine problem at every station mode for whoever may report (plant.report), never held by the worker notice', () => {
    const reporter = [...OPERATOR, 'plant.report']
    expect(homeTiles('sewing', reporter, false).map((tile) => tile.key)).toEqual(['mywork', 'operation', 'machine', 'clock', 'help', 'scan'])
    expect(homeTiles('warehouse', reporter, false).map((tile) => tile.key)).toEqual(['pick', 'machine', 'clock', 'help', 'scan'])
    // A safety report never waits for the privacy notice (the station is named instead of the worker).
    expect(homeTiles('cutting', reporter, true).find((tile) => tile.key === 'machine')).toEqual({ key: 'machine', held: null })
    // A subcontract station (no floor mode): Scan only; without plant.report: no tile.
    expect(homeTiles(null, reporter, false).map((tile) => tile.key)).toEqual(['clock', 'scan'])
    expect(homeTiles('sewing', OPERATOR, false).map((tile) => tile.key)).not.toContain('machine')
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
