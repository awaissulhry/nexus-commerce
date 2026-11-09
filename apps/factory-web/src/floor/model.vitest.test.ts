import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { readScan } from './scan/scan-model'
import { taskForScan } from './tasks/routes'
import { enrolmentCodeOf, floorLocale, homeTiles, idleWarnAfterMs, isBadgeCode, MAX_TILES, modeOf, newPinProblem, noticePages, tilePage, NOTICE_PAGE_CHARS, rosterLetters, TILE_RULES } from './model'

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
  it('Clock is on every tablet, a phone too; the worker notice does not hold it', () => {
    expect(homeTiles(null, ['floor.work'], false, 'PHONE').map((tile) => tile.key)).toEqual(['clock', 'myday', 'incident', 'scan'])
    expect(homeTiles('sewing', ['floor.work'], true)).toEqual([
      { key: 'mywork', held: null },
      { key: 'clock', held: null },
      { key: 'myday', held: null },
      { key: 'training', held: null },
      { key: 'help', held: null },
      { key: 'incident', held: null },
      { key: 'scan', held: 'notice' },
    ])
    // A line tablet's Home: no station's tiles, no warehouse tile; My day (design Modes: sewing, phone) stays in the operator's menu.
    expect(modeOf(null, 'LINE')).toBeNull()
    expect(homeTiles(null, ['floor.work', 'floor.lead'], false, 'LINE').map((tile) => tile.key)).toEqual(['clock', 'training', 'incident', 'lineview', 'scan'])
    expect(homeTiles(null, ['floor.work', 'floor.lead'], false, 'PHONE').map((tile) => tile.key)).toEqual(['clock', 'myday', 'incident', 'lineview', 'scan'])
    for (const device of ['LINE', 'PHONE']) for (const tile of homeTiles(null, [...OPERATOR, 'inventory.receive', 'sales.returns.receive', 'purchasing.subcontract.kit'], false, device)) expect(['receive', 'pick', 'returnsin', 'kits']).not.toContain(tile.key)
  })

  it('B-W2b-73: nothing falls off a full Home: five tiles and More, the kept tiles first, Back on the last page', () => {
    const lead = [...OPERATOR, 'plant.report', 'floor.lead']
    const pageOf = (mode: 'cutting' | 'packing' | 'warehouse' | 'sewing' | 'inspection', page: number) => tilePage(homeTiles(mode, lead, false), page)
    // B-W2b-137: Report an incident is kept on the first page with the Line view and Scan anything.
    expect(pageOf('cutting', 0).tiles.map((tile) => tile.key)).toEqual(['mywork', 'operation', 'incident', 'lineview', 'scan'])
    expect(pageOf('cutting', 0)).toMatchObject({ page: 0, pages: 3, more: 5 })
    // B-W2b-145: Training & PPE sign-off makes a lead's cutting Home three pages. B-W2b-121: Fabric cutting after Cut a hide.
    expect(pageOf('cutting', 1).tiles.map((tile) => tile.key)).toEqual(['cut', 'fabriccut', 'bundles', 'machine', 'clock'])
    expect(pageOf('cutting', 1)).toMatchObject({ page: 1, pages: 3, more: 2 })
    expect(pageOf('cutting', 2).tiles.map((tile) => tile.key)).toEqual(['training', 'help'])
    expect(pageOf('cutting', 2)).toMatchObject({ page: 2, pages: 3, more: 0 })
    // A page past the end (a person with fewer tiles took over) is the last one.
    expect(pageOf('cutting', 9).page).toBe(2)
    for (const mode of ['cutting', 'packing', 'warehouse', 'sewing', 'inspection'] as const) {
      const all = homeTiles(mode, lead, false)
      const seen = [0, 1, 2].flatMap((page) => (page < tilePage(all, page).pages ? tilePage(all, page).tiles : []))
      expect(seen.map((tile) => tile.key).sort()).toEqual(all.map((tile) => tile.key).sort())
      expect(seen.map((tile) => tile.key)).toEqual(expect.arrayContaining(['clock', 'help', 'incident', 'lineview', 'scan']))
      const pages = tilePage(all, 0).pages
      for (let page = 0; page < pages; page++) expect(tilePage(all, page).tiles.length + (pages > 1 ? 1 : 0)).toBeLessThanOrEqual(MAX_TILES)
    }
    // Six fit one page, with no More tile; seven do not.
    // B-W2b-145: a cutter with only Cut a hide now has seven (Training & PPE sign-off); a warehouse operator has six.
    const six = homeTiles('warehouse', OPERATOR, false)
    expect(tilePage(six, 0)).toEqual({ tiles: six, page: 0, pages: 1, more: 0 })
    expect(tilePage(homeTiles('cutting', ['floor.work', 'production.cut'], false), 0).pages).toBe(2)
    const many = Array.from({ length: 13 }, (_, at) => ({ key: at === 12 ? ('scan' as const) : ('help' as const), held: null }))
    expect(tilePage(many, 0).pages).toBe(3)
    expect(tilePage(many, 2).tiles).toHaveLength(3)
  })

  it('a cutting operator sees My work, Operation (the cutting operation\'s report), Cut a hide, Bundles and Scan (all open)', () => {
    expect(homeTiles('cutting', OPERATOR, false)).toEqual([
      { key: 'mywork', held: null },
      { key: 'operation', held: null },
      { key: 'cut', held: null },
      // B-W2b-121
      { key: 'fabriccut', held: null },
      { key: 'bundles', held: null },
      { key: 'clock', held: null },
      { key: 'training', held: null },
      { key: 'help', held: null },
      { key: 'incident', held: null },
      { key: 'scan', held: null },
    ])
  })

  // B-W2b-203: the Owner's answer of 2026-11-09 to B-W2b-151's question 1 (B: the inspection bench's own jobs on page one).
  it('at the inspection bench a floor inspector\'s first page is My work, Incoming, Final, Report an incident, Scan + More; other stations keep theirs', () => {
    const roleOf = (key: string) => [...templateOf(key)!.permissions] as string[]
    const pageKeys = (mode: 'cutting' | 'sewing' | 'packing' | 'inspection' | 'warehouse', role: string, page: number) => tilePage(homeTiles(mode, roleOf(role), false), page).tiles.map((tile) => tile.key)
    expect(pageKeys('inspection', 'floor_inspector', 0)).toEqual(['mywork', 'incoming', 'final', 'incident', 'scan'])
    expect(tilePage(homeTiles('inspection', roleOf('floor_inspector'), false), 0)).toMatchObject({ pages: 3, more: 5 })
    expect(pageKeys('inspection', 'floor_inspector', 1)).toEqual(['inline', 'operation', 'machine', 'clock', 'training'])
    expect(pageKeys('inspection', 'floor_inspector', 2)).toEqual(['help'])
    // Every other station: today's order (B-W2b-151's walk), Operation second.
    expect(pageKeys('cutting', 'cutting_operator', 0)).toEqual(['mywork', 'operation', 'cut', 'incident', 'scan'])
    expect(pageKeys('cutting', 'cutting_operator', 1)[0]).toBe('fabriccut') // Owner answer 2: Fabric cutting stays first on page two.
    for (const mode of ['sewing', 'packing'] as const) expect(pageKeys(mode, 'operator', 0).slice(0, 2), mode).toEqual(['mywork', 'operation'])
    // An operator at the bench holds no inspection tile: Operation keeps its place.
    expect(homeTiles('inspection', roleOf('operator'), false).map((tile) => tile.key).slice(0, 2)).toEqual(['mywork', 'operation'])
    // The scan router reads every tile, whatever its page: a bundle still opens Operation at the bench, a work order Final.
    const bench = homeTiles('inspection', roleOf('floor_inspector'), false)
    const tag = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
    expect(taskForScan('inspection', readScan(formatScanId({ type: 'BUNDLE', tenantTag: tag, ref: 123 }), tag), bench)).toBe('operation')
    expect(taskForScan('inspection', readScan('WO-0042', tag), bench)).toBe('final')
  })

  it('a tile asks the permission its page\'s API needs (fail closed)', () => {
    expect(homeTiles('cutting', ['floor.work', 'production.cut'], false).map((tile) => tile.key)).toEqual(['mywork', 'cut', /* B-W2b-121 */ 'fabriccut', 'clock', 'training', 'help', 'incident', 'scan'])
    // B-W2b-203: at the bench Operation comes after the inspection tiles (Owner answer 2026-11-09).
    expect(homeTiles('inspection', ['floor.work', 'production.scan', 'quality.inspections.view'], false).map((tile) => tile.key)).toEqual(['mywork', 'final', 'operation', 'clock', 'training', 'help', 'incident', 'scan'])
    expect(homeTiles('sewing', ['floor.work'], false).map((tile) => tile.key)).toEqual(['mywork', 'clock', 'myday', 'training', 'help', 'incident', 'scan'])
    expect(homeTiles('sewing', ['floor.work', 'production.scan'], false).map((tile) => tile.key)).toEqual(['mywork', 'operation', 'clock', 'myday', 'training', 'help', 'incident', 'scan'])
    expect(homeTiles('inspection', ['floor.work', 'quality.inspections.view'], false)).toEqual([
      { key: 'mywork', held: null },
      { key: 'final', held: null },
      { key: 'clock', held: null },
      { key: 'training', held: null },
      { key: 'help', held: null },
      { key: 'incident', held: null },
      { key: 'scan', held: null },
    ])
    // Garment labels at the packing station (SCR-096) ask production.serials, the permission of its API; Pack is built (SCR-098).
    expect(homeTiles('packing', OPERATOR, false)).toEqual([
      { key: 'mywork', held: null },
      { key: 'operation', held: null },
      { key: 'pack', held: null },
      { key: 'clock', held: null },
      { key: 'training', held: null },
      { key: 'help', held: null },
      { key: 'incident', held: null },
      { key: 'scan', held: null },
    ])
    expect(homeTiles('packing', [...OPERATOR, 'production.serials'], false)).toEqual([
      { key: 'mywork', held: null },
      { key: 'operation', held: null },
      { key: 'labels', held: null },
      { key: 'pack', held: null },
      { key: 'clock', held: null },
      { key: 'training', held: null },
      { key: 'help', held: null },
      { key: 'incident', held: null },
      { key: 'scan', held: null },
    ])
  })

  it('drops a tile whose permission the person lacks (Receive needs an office permission)', () => {
    expect(homeTiles('warehouse', OPERATOR, false).map((tile) => tile.key)).toEqual(['pick', 'clock', 'training', 'help', 'incident', 'scan'])
    expect(homeTiles('packing', ['floor.work', 'print.labels'], false).map((tile) => tile.key)).toEqual(['mywork', 'clock', 'training', 'help', 'incident', 'scan'])
    expect(homeTiles('packing', ['floor.work', 'production.serials'], false).map((tile) => tile.key)).toEqual(['mywork', 'labels', 'clock', 'training', 'help', 'incident', 'scan'])
    // A subcontract station: Scan only.
    expect(homeTiles(null, OPERATOR, false, 'STATION').map((tile) => tile.key)).toEqual(['scan'])
  })

  it('shows nothing without floor.work; at most six tiles on a page', () => {
    expect(homeTiles('cutting', ['production.cut'], false)).toEqual([])
    expect(MAX_TILES).toBe(6)
    for (const mode of ['cutting', 'sewing', 'packing', 'inspection', 'warehouse'] as const) {
      const shown = tilePage(homeTiles(mode, OPERATOR, false), 0)
      expect(shown.tiles.length + (shown.pages > 1 ? 1 : 0)).toBeLessThanOrEqual(MAX_TILES)
    }
  })

  it('holds every scan tile with "Read the notice first" while the notice blocks scans (My work only reads: never held)', () => {
    // B-W2b-121: Fabric cutting takes scans (its ticket, rolls, bundles): held too.
    expect(homeTiles('cutting', OPERATOR, true).map((tile) => tile.held)).toEqual([null, 'notice', 'notice', 'notice', 'notice', null, null, null, null, 'notice'])
  })

  it('the floor tasks are built: receive (SCR-092) and garment labels (SCR-096) too', () => {
    expect(TILE_RULES.filter((rule) => rule.built).map((rule) => rule.key)).toEqual(['mywork', 'operation', 'cut', /* B-W2b-121 */ 'fabriccut', 'bundles', 'receive', 'pick', /* B-W2a-76 */ 'returnsin', 'kits', 'labels', 'pack', /* B-W2b-115 */ 'incoming', 'final', /* B-W2b-105 */ 'inline', 'machine', 'clock', /* B-W2b-68 */ 'myday', /* B-W2b-145 */ 'training', /* B-W2b-70 */ 'help', /* B-W2b-137 */ 'incident', 'lineview', 'scan'])
  })

  it('B-W2a-73: Machine problem at every station mode for whoever may report (plant.report), never held by the worker notice', () => {
    const reporter = [...OPERATOR, 'plant.report']
    expect(homeTiles('sewing', reporter, false).map((tile) => tile.key)).toEqual(['mywork', 'operation', 'machine', 'clock', 'myday', 'training', 'help', 'incident', 'scan'])
    expect(homeTiles('warehouse', reporter, false).map((tile) => tile.key)).toEqual(['pick', 'machine', 'clock', 'training', 'help', 'incident', 'scan'])
    // A safety report never waits for the privacy notice (the station is named instead of the worker).
    expect(homeTiles('cutting', reporter, true).find((tile) => tile.key === 'machine')).toEqual({ key: 'machine', held: null })
    // A subcontract station (no floor mode): Scan only; without plant.report: no tile.
    expect(homeTiles(null, reporter, false, 'STATION').map((tile) => tile.key)).toEqual(['scan'])
    expect(homeTiles('sewing', OPERATOR, false).map((tile) => tile.key)).not.toContain('machine')
  })

  it('B-W2b-137: Report an incident on every Home, a line tablet and a phone, on the first page, never held by the notice', () => {
    const lead = [...OPERATOR, 'plant.report', 'floor.lead', 'inventory.receive', 'sales.returns.receive', 'purchasing.subcontract.kit', 'production.serials', 'quality.inspections.view']
    for (const mode of ['cutting', 'sewing', 'packing', 'inspection', 'warehouse'] as const) {
      for (const permissions of [['floor.work'], OPERATOR, lead]) {
        expect(tilePage(homeTiles(mode, permissions, false), 0).tiles.map((tile) => tile.key), `${mode}`).toContain('incident')
        expect(homeTiles(mode, permissions, true).find((tile) => tile.key === 'incident'), mode).toEqual({ key: 'incident', held: null })
      }
    }
    for (const device of ['LINE', 'PHONE']) expect(tilePage(homeTiles(null, lead, false, device), 0).tiles.map((tile) => tile.key)).toContain('incident')
    // A subcontract station (no floor mode): Scan only; without floor.work: nothing.
    expect(homeTiles(null, lead, false, 'STATION').map((tile) => tile.key)).toEqual(['scan'])
    expect(homeTiles('sewing', ['plant.report'], false)).toEqual([])
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
