import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { I18nProvider } from '../../../lib/i18n/provider'
import { ROLE_PERMISSIONS } from '../../quality/_shared/fixtures'
import { BRANDS, byNumber, CERTIFICATES, COMPANIES, COVERAGE_0001, coveredBy, demoCoverage, demoDetail, designScreen as listScreen, JACKET, refusedFor, STYLE_FACTS, TODAY, TROUSERS } from './fixtures'
import {
  addressOf,
  blankCheck,
  blankCoverage,
  blankDraft,
  certCan,
  certificatesCsv,
  checkHeld,
  coverageGrid,
  coverageHeld,
  defaultLapseDate,
  draftFieldOf,
  draftProblems,
  draftSpan,
  filterRows,
  filtersFromAddress,
  firstProblem,
  holderOf,
  inputOf,
  kindOf,
  lapseCells,
  lapseSummary,
  leftOf,
  monthsBetween,
  noticesOf,
  registerChecks,
  registerHeld,
  retainUntil,
  tileCounts,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

const owner = certCan(ROLE_PERMISSIONS.owner)
const production = certCan(ROLE_PERMISSIONS.production)

describe('kinds, states and the validity in words', () => {
  it('names what a standard certifies', () => {
    expect(kindOf('EN 17092-4:2020')).toBe('GARMENT')
    expect(kindOf(' en 1621-2:2014 ')).toBe('PROTECTOR')
    expect(kindOf('EN 13594:2015')).toBe('GLOVE')
    expect(kindOf('EN ISO 20471:2013')).toBe('OTHER')
  })

  it('says how long a certificate still holds, with the tone of its horizon', () => {
    const valid = (validTo: string) => ({ status: 'VALID' as const, validFrom: '2024-01-01', validTo })
    expect(leftOf(valid('2029-03-11'), '2026-10-29')).toEqual({ kind: 'span', tone: 'success', years: 2, months: 4 })
    expect(leftOf(valid('2027-02-26'), '2026-10-29')).toMatchObject({ kind: 'span', tone: 'info', years: 0, months: 3 })
    expect(leftOf(valid('2026-11-23'), '2026-10-29')).toEqual({ kind: 'days', tone: 'danger', days: 25 })
    expect(leftOf(valid('2026-12-20'), '2026-10-29')).toEqual({ kind: 'days', tone: 'warning', days: 52 })
    expect(leftOf(valid('2026-10-29'), '2026-10-29')).toEqual({ kind: 'lastDay', tone: 'danger' })
    expect(leftOf(valid('2026-09-30'), '2026-10-29')).toEqual({ kind: 'expired', tone: 'danger', days: 29 })
    expect(leftOf({ ...valid('2028-01-01'), status: 'WITHDRAWN' }, '2026-10-29').kind).toBe('withdrawn')
    expect(leftOf({ status: 'DRAFT', validFrom: '2026-10-20', validTo: '2031-10-19' }, '2026-10-29')).toMatchObject({ kind: 'notRegistered', years: 4, months: 11 })
    expect(monthsBetween('2026-03-12', '2026-04-11')).toBe(0)
    expect(monthsBetween('2026-03-12', '2026-04-12')).toBe(1)
  })
})

describe('views, tiles and notices: one filter model (a tile is a view)', () => {
  it('reads the filters from the address and writes them back', () => {
    expect(filtersFromAddress(new URLSearchParams('view=expiring&kind=PROTECTOR&q=0000'))).toEqual({ view: 'expiring', kind: 'PROTECTOR', q: '0000' })
    expect(filtersFromAddress(new URLSearchParams('view=nonsense&kind=x'))).toEqual({ view: 'all', kind: 'all', q: '' })
    expect(addressOf({ view: 'drafts', kind: 'all', q: ' demo ' })).toBe('?view=drafts&q=demo')
    expect(addressOf({ view: 'all', kind: 'all', q: '' })).toBe('')
  })

  it('counts each tile from the register, and the view shows exactly those rows', () => {
    const counts = tileCounts(CERTIFICATES)
    expect(counts).toEqual({ valid: 4, expiring: 2, suspended: 2, drafts: 1, within90: 1, within30: 1 })
    expect(filterRows(CERTIFICATES, { view: 'expiring', kind: 'all', q: '' }).map((row) => row.number)).toEqual(['CERT-DEMO-0002', 'CERT-DEMO-0003'])
    expect(filterRows(CERTIFICATES, { view: 'suspended', kind: 'all', q: '' }).map((row) => row.number)).toEqual(['CERT-DEMO-0004', 'CERT-DEMO-0007'])
    expect(filterRows(CERTIFICATES, { view: 'expired', kind: 'all', q: '' }).map((row) => row.number)).toEqual(['CERT-DEMO-0006'])
    expect(filterRows(CERTIFICATES, { view: 'all', kind: 'PROTECTOR', q: '9990' }).map((row) => row.number)).toEqual(['CERT-DEMO-0003', 'CERT-DEMO-0007'])
    expect(filterRows(CERTIFICATES, { view: 'all', kind: 'all', q: 'touring aa' }).map((row) => row.number)).toEqual(['CERT-DEMO-0001'])
  })

  it('puts the most serious notice first: a suspension, then a day past validity, then 30 days', () => {
    const notices = noticesOf(CERTIFICATES)
    expect(notices.map((notice) => notice.key)).toEqual(['notice.suspended', 'notice.expiringSoon'])
    expect(notices[0]).toMatchObject({ tone: 'danger', params: { number: 'CERT-DEMO-0004', body: '0000', count: 2 } })
    const past = { ...byNumber('CERT-DEMO-0002'), daysToExpiry: -1 }
    expect(noticesOf([past]).map((notice) => notice.key)).toEqual(['notice.pastValidity'])
  })

  it('names the holder: our company or the brand, unknown without its name', () => {
    expect(holderOf(byNumber('CERT-DEMO-0001'), COMPANIES, BRANDS)).toEqual({ kind: 'company', name: 'Officina Demo S.r.l.' })
    expect(holderOf(byNumber('CERT-DEMO-0008'), COMPANIES, BRANDS)).toEqual({ kind: 'brand', name: 'Demo Moto' })
    expect(holderOf(byNumber('CERT-DEMO-0008'), COMPANIES, null)).toEqual({ kind: 'brand', name: null })
  })

  it('exports one CSV line per certificate with the values as the register holds them', () => {
    const rows = certificatesCsv([byNumber('CERT-DEMO-0003')], ['h'], { status: () => 'Valid', kind: () => 'Protector', holder: () => 'Demo' })
    expect(rows[1]).toEqual(['CERT-DEMO-0003', 'EN 1621-1:2012', '2', 'Protector', 'Demo', 'Demo Certification Office', '9990', 'DEMO PROT SPALLA L2', 1, '2022-02-27', '2027-02-26', 120, 'Valid'])
  })
})

describe('Add certificate: the domain checks in our words, as the person leaves each field', () => {
  const filled = { ...blankDraft('c1'), number: 'CERT-X', notifiedBodyName: 'Demo Test Lab', notifiedBodyNumber: '0000', validFrom: '2026-10-15', validTo: '2031-10-14' }

  it('a complete EN 17092 draft passes; the class follows the part', () => {
    expect(draftProblems(filled)).toEqual({})
    expect(inputOf(filled)).toMatchObject({ companyId: 'c1', holderPartyId: null, standard: 'EN 17092-4:2020', ppeClass: 'A', modelReference: null })
    expect(inputOf({ ...filled, holder: 'brand:b1' })).toMatchObject({ companyId: null, holderPartyId: 'b1' })
    expect(draftSpan(filled)).toEqual({ years: 5, months: 0 })
  })

  it('refuses the sixth year with the latest day, a 3-digit body and a protector without its level', () => {
    expect(draftProblems({ ...filled, validTo: '2031-12-14' }).validTo).toEqual({ key: 'add.problem.fiveYears', params: { years: 5, latest: '2031-10-15' } })
    expect(draftProblems({ ...filled, validTo: '2026-10-01' }).validTo?.key).toBe('add.problem.validToOrder')
    expect(draftProblems({ ...filled, notifiedBodyNumber: '000' }).notifiedBodyNumber?.key).toBe('add.problem.bodyNumber')
    expect(draftProblems({ ...filled, standard: 'EN 1621-1:2012' }).ppeClass?.key).toBe('add.problem.level')
    expect(draftProblems({ ...filled, standard: 'EN 1621-1:2012', ppeClass: '2' })).toEqual({})
    expect(draftProblems({ ...filled, standard: 'EN 17092-1:2020' }).standard?.key).toBe('add.problem.standardPart')
    expect(draftProblems({ ...filled, holder: '' }).holder?.key).toBe('add.problem.holder')
    expect(firstProblem(draftProblems({ ...blankDraft(null) }))?.key).toBe('add.problem.number')
  })

  it('maps the API refusal paths back to the fields', () => {
    expect(draftFieldOf('body/validTo')).toBe('validTo')
    expect(draftFieldOf('body/holderPartyId')).toBe('holder')
    expect(draftFieldOf('body/unknown')).toBeNull()
  })
})

describe('Register: the checklist and its held reasons', () => {
  const draft = byNumber('CERT-DEMO-0005')

  it('holds Register with the first open check, and never for a role without manage', () => {
    const bare = demoDetail(draft, [], false)
    expect(registerChecks(bare, TODAY).map((check) => [check.id, check.ok])).toEqual([
      ['pdf', false],
      ['data', true],
      ['validity', true],
      ['coverage', false],
    ])
    expect(registerHeld(bare, owner, TODAY)).toBe('register.held.pdf')
    expect(registerHeld(demoDetail(draft, [], true), owner, TODAY)).toBe('register.held.coverage')
    const ready = demoDetail(draft, [demoCoverage(90, draft.id, { styleId: JACKET.id })], true)
    expect(registerHeld(ready, owner, TODAY)).toBeNull()
    expect(registerHeld(ready, production, TODAY)).toBe('held.manage')
    expect(registerHeld(demoDetail(byNumber('CERT-DEMO-0001'), COVERAGE_0001), owner, TODAY)).toBe('held.notDraft')
  })
})

describe('the coverage grid of a style', () => {
  it('all colourways and the whole range cover every offered cell; a size a colourway lacks is not offered', () => {
    const grid = coverageGrid({ colourwayIds: [], sizes: [] }, JACKET)
    expect(grid.allColours && grid.wholeRange).toBe(true)
    expect(grid.rows.map((row) => row.code)).toEqual(['BLK', 'GRY', 'RED'])
    expect(grid.rows[1]!.cells.find((cell) => cell.size === '58')!.state).toBe('notOffered')
    expect(grid.covered).toBe(grid.offered)
    expect(grid.offered).toBe(7 + 6 + 4)
  })

  it('some colourways and sizes: the rest is said "not covered"; an archived colourway only when named', () => {
    const grid = coverageGrid({ colourwayIds: [TROUSERS.colourways[0]!.id], sizes: ['46', '48'] }, TROUSERS)
    expect(grid.rows.map((row) => row.code)).toEqual(['BLK', 'SND'])
    expect(grid.rows[0]!.cells.map((cell) => cell.state)).toEqual(['covered', 'covered', 'notCovered', 'notCovered', 'notCovered', 'notCovered'])
    expect(grid.rows[1]!.cells.every((cell) => cell.state !== 'covered')).toBe(true)
    expect(grid.covered).toBe(2)
  })

  it('holds Add coverage until the target is chosen, and refuses a style covered already', () => {
    const certificate = demoDetail(byNumber('CERT-DEMO-0001'), COVERAGE_0001)
    expect(coverageHeld(blankCoverage(), certificate, false)).toBe('coverage.held.style')
    expect(coverageHeld({ ...blankCoverage(), style: { value: JACKET, problem: null } }, certificate, false)).toBe('coverage.held.already')
    expect(coverageHeld({ ...blankCoverage(), style: { value: TROUSERS, problem: null }, allColours: false }, demoDetail(byNumber('CERT-DEMO-0005')), false)).toBe('coverage.held.colourways')
    expect(coverageHeld({ ...blankCoverage(), style: { value: TROUSERS, problem: null } }, demoDetail(byNumber('CERT-DEMO-0005')), false)).toBeNull()
  })
})

describe('the lapse check: what the gate refuses on a later day', () => {
  const certificate = demoDetail(byNumber('CERT-DEMO-0001'), COVERAGE_0001)

  it('asks about every garment it covers today (the day after its last valid day by default)', () => {
    expect(defaultLapseDate('2029-03-11')).toBe('2029-03-12')
    const { cells, capped } = lapseCells(certificate, STYLE_FACTS)
    expect(capped).toBe(false)
    expect(cells.length).toBe(7 + 6 + 4 + 4)
    expect(cells.filter((cell) => cell.styleCode === 'DEMO-PNT-01').map((cell) => cell.size)).toEqual(['46', '48', '50', '52'])
  })

  it('groups the answers by style, colourway and why, refusals first', () => {
    const black = JACKET.colourways[0]!
    const date = '2029-03-12'
    const answers = [
      { cell: { styleId: JACKET.id, styleCode: JACKET.code, colourwayId: black.id, colourwayCode: 'BLK', size: '50' }, result: refusedFor(JACKET, black.id, '50', date, [{ code: 'certificate_expired' as const, message: 'ended' }]) },
      { cell: { styleId: JACKET.id, styleCode: JACKET.code, colourwayId: black.id, colourwayCode: 'BLK', size: '52' }, result: refusedFor(JACKET, black.id, '52', date, [{ code: 'certificate_expired' as const, message: 'ended' }]) },
      { cell: { styleId: JACKET.id, styleCode: JACKET.code, colourwayId: JACKET.colourways[2]!.id, colourwayCode: 'RED', size: '50' }, result: coveredBy(byNumber('CERT-DEMO-0008'), JACKET, JACKET.colourways[2]!.id, '50', date) },
      { cell: { styleId: JACKET.id, styleCode: JACKET.code, colourwayId: JACKET.colourways[2]!.id, colourwayCode: 'RED', size: '52' }, result: null },
    ]
    const summary = lapseSummary(answers)
    expect([summary.total, summary.refused, summary.covered, summary.unknown]).toEqual([4, 2, 1, 1])
    expect(summary.groups.map((group) => [group.outcome, group.colourwayCode, group.sizes.join(','), group.codes.join(','), group.coveredBy])).toEqual([
      ['refused', 'BLK', '50,52', 'certificate_expired', null],
      ['unknown', 'RED', '52', '', null],
      ['covered', 'RED', '50', '', 'CERT-DEMO-0008'],
    ])
    expect(summary.groups[0]!.messages).toEqual(['ended'])
  })

  it('keeps the PDF ten years after the last valid day', () => {
    expect(retainUntil('2029-03-11')).toBe('2039-03-11')
  })
})

describe('Check a garment: held until style, colourway, size and day are given', () => {
  it('says the first thing missing', () => {
    expect(checkHeld(blankCheck(TODAY), certCan(['compliance.certificates.view']))).toBe('check.held.styles')
    expect(checkHeld(blankCheck(TODAY), owner)).toBe('check.held.style')
    const picked = { ...blankCheck(TODAY), style: { value: JACKET, problem: null } }
    expect(checkHeld(picked, owner)).toBe('check.held.colourway')
    expect(checkHeld({ ...picked, colourwayId: 'x' }, owner)).toBe('check.held.size')
    expect(checkHeld({ ...picked, colourwayId: 'x', size: '52' }, owner)).toBeNull()
    expect(checkHeld({ ...picked, colourwayId: 'x', size: '52', date: '' }, owner)).toBe('check.held.date')
  })
})

describe('every design case draws in both languages with no key left on screen', () => {
  const keys = new Set<string>()
  for (const namespace of ['certificates', 'quality']) for (const key of Object.keys(CATALOGUE.en[namespace] ?? {})) keys.add(key.replace(/_(one|other)$/, ''))
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  const leftKey = (html: string): string | null => {
    for (const key of keys) {
      const at = html.indexOf(key)
      if (at < 0) continue
      const before = html[at - 1] ?? ' '
      const after = html[at + key.length] ?? ' '
      if (!/[\w.-]/.test(before) && !/[\w.]/.test(after)) return key
    }
    return null
  }
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(500)
          expect(leftKey(html), `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('sales sees no certificate: the permission is named, no number is drawn', () => {
    for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
      const html = render(screen, screen.cases.find((item) => item.id === 'no-permission')!.model, 'en')
      expect(html).toContain('compliance.certificates.view')
      expect(html).not.toContain('CERT-DEMO-0001')
    }
  })

  it('no money anywhere on these screens', () => {
    for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) for (const item of screen.cases) expect(render(screen, item.model, 'en'), item.id).not.toMatch(/€|EUR\b/)
  })
})
