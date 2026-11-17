import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROJECT_REFUSALS } from '@nexus/factory-domain/projects/rules'
import { ApiError } from '../../../../../lib/api/errors'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { doorHolds, type HeadModel } from '../../../../../lib/record-thread/head/model'
import { RecordThreadHead } from '../../../../../lib/record-thread/head/view/RecordThreadHead'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../../lib/testing/two-brands'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { LinkedRecord, ProjectView } from '../../api'
import { designScreen, LINKED_DEMO } from './fixtures'
import {
  candidatesOf,
  GROUP_ORDER,
  groupsOf,
  inProjectChangeFor,
  inProjectOf,
  linkBody,
  linkHeld,
  linkProblemOf,
  LINKED_NS,
  noteProblem,
  rowOf,
  scopePhrase,
  shownRows,
  takesProjects,
  type SearchHit,
} from './model'
import { LinkedBlock } from './view/LinkedBlock'

/**
 * B-TH-251 — a project's linked records (PROJ.linked-F01…F05, F09, F10; walls W01, W09, W12, W27, W38): grouped by kind in the
 * domain's order, a record you cannot open has no link and no status, status in words never an amount, a refusal for another outside
 * company's record names NEITHER company, the Link dialog keeps to the project's company and the kinds a project links, "In project …"
 * on a record's thread head, every design case drawn in Italian and English with no key left on screen.
 */

const PREFIX = '/w/DEMO'
const ALPHA_PROJECT = {
  id: 'p1',
  number: 'PRJ-26-012',
  name: 'FW27 airbag line',
  companyId: 'c1',
  status: 'ACTIVE',
  party: { id: 'party-alpha', code: BRAND_ALPHA.code, name: BRAND_ALPHA.tradeName, roles: ['CUSTOMER'] },
  may: { manage: true, post: true, moves: ['HOLD', 'CLOSE'] },
} as unknown as ProjectView

const record = (over: Partial<LinkedRecord>): LinkedRecord => ({
  linkId: 'l1',
  recordType: 'Style',
  recordId: 'r1',
  group: 'STYLES',
  label: 'AX-100',
  status: 'RELEASED',
  mayOpen: true,
  note: null,
  linkedAt: '2026-11-10T09:30:00.000Z',
  linkedBy: { id: 'u1', name: 'Marco Demo' },
  ...over,
})

const words = (locale: (typeof LOCALES)[number], ns: string) => createTranslator(locale, CATALOGUE[locale][ns] ?? {})

function render(View: ComponentType<{ model: never }>, model: unknown, locale: (typeof LOCALES)[number] = 'en'): string {
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: model as never })))
}

describe('the Linked block groups by kind in the domain order', () => {
  it('Styles, Samples, Quotes, Orders, Requests, Shipments, Changes, Purchase orders, Certificates, Measurement profiles', () => {
    expect(GROUP_ORDER).toEqual(['STYLES', 'SAMPLES', 'QUOTES', 'ORDERS', 'REQUESTS', 'SHIPMENTS', 'CHANGES', 'PURCHASE_ORDERS', 'CERTIFICATES', 'MEASUREMENTS'])
    const shuffled = [
      record({ linkId: 'a', group: 'CERTIFICATES', recordType: 'Certificate', label: 'CERT-1' }),
      record({ linkId: 'b', group: 'ORDERS', recordType: 'SalesOrder', label: 'SO-1' }),
      record({ linkId: 'c', group: 'STYLES' }),
      record({ linkId: 'd', group: 'SAMPLES', recordType: 'SampleRound', label: 'SR-1' }),
    ]
    expect(groupsOf(shuffled, PREFIX, OFFICE_PAGES).map((group) => group.group)).toEqual(['STYLES', 'SAMPLES', 'ORDERS', 'CERTIFICATES'])
  })

  it('folds a long group past five rows until opened', () => {
    const many = Array.from({ length: 12 }, (_, index) => record({ linkId: `l${index}`, label: `AX-${200 + index}` }))
    const [styles] = groupsOf(many, PREFIX, OFFICE_PAGES)
    expect(shownRows(styles!, false)).toHaveLength(5)
    expect(shownRows(styles!, true)).toHaveLength(12)
  })

  it('a record you may not open: no link, no status, no note — its kind and "you cannot open it" (PROJ.linked-F10)', () => {
    const hidden = rowOf(record({ recordType: 'MeasurementProfile', group: 'MEASUREMENTS', label: null, mayOpen: false, status: 'ACTIVE', note: 'Rider fit' }), PREFIX, OFFICE_PAGES)
    expect(hidden).toMatchObject({ label: null, href: null, statusKey: null, note: null })
    const html = render(LinkedBlock as never, { ...LINKED_DEMO.customer, groups: groupsOf([record({ recordType: 'MeasurementProfile', group: 'MEASUREMENTS', label: null, mayOpen: false })], PREFIX, OFFICE_PAGES), count: 1 })
    expect(html).toContain('Measurement profile — you cannot open it')
    expect(html).not.toMatch(/<a [^>]*href="[^"]*made-to-measure/)
  })

  it('a record you open is a real link to its own page, its status in words (search catalogue), never an amount', () => {
    const row = rowOf(record({}), PREFIX, OFFICE_PAGES)
    expect(row.href).toBe('/w/DEMO/products/styles/r1')
    expect(row.statusKey).toBe('status.RELEASED')
    // A status without words shows nothing (never the raw code).
    expect(rowOf(record({ status: 'IN_SOME_STAGE' }), PREFIX, OFFICE_PAGES).statusKey).toBeNull()
    const html = render(LinkedBlock as never, LINKED_DEMO.customer)
    expect(html).toContain('href="/w/DEMO/products/styles/')
    expect(html).not.toMatch(/€|EUR\b|\d+,\d{2}\b/)
  })
})

describe('who may link and unlink', () => {
  it('projects.manage over this project, an open project and the network', () => {
    expect(linkHeld(ALPHA_PROJECT, false)).toBeNull()
    expect(linkHeld({ ...ALPHA_PROJECT, may: { ...ALPHA_PROJECT.may, manage: false } }, false)?.key).toBe('held.noManage')
    expect(linkHeld({ ...ALPHA_PROJECT, status: 'CLOSED' }, false)).toEqual({ key: 'held.closed' })
    expect(linkHeld(ALPHA_PROJECT, true)).toEqual({ key: 'held.offline' })
  })

  it('says what may join: the project’s own outside company or none; an office-only project: none', () => {
    expect(scopePhrase(ALPHA_PROJECT)).toEqual({ key: 'block.scopeParty', params: { party: BRAND_ALPHA.tradeName } })
    expect(scopePhrase({ party: null })).toEqual({ key: 'block.scopeOffice' })
  })
})

describe('the Link dialog', () => {
  const hit = (over: Partial<SearchHit>): SearchHit => ({ recordType: 'Style', recordId: 's1', number: 'AX-102', title: 'Airbag jacket', status: 'DRAFT', companyId: 'c1', ...over })

  it('offers only the kinds a project links, of the project’s company (or of every company); a record linked already is marked', () => {
    const items = candidatesOf(
      [hit({}), hit({ recordId: 's2', companyId: 'c2' }), hit({ recordType: 'WorkOrder', recordId: 'w1' }), hit({ recordId: 'r1', number: 'AX-100' }), hit({ recordType: 'SalesOrder', recordId: 'o1', number: 'SO-1', companyId: null }), hit({})],
      ALPHA_PROJECT,
      { records: [record({})] },
    )
    expect(items.map((item) => `${item.recordType}:${item.recordId}`)).toEqual(['Style:s1', 'Style:r1', 'SalesOrder:o1'])
    expect(items.find((item) => item.recordId === 'r1')?.linked).toBe(true)
  })

  it('a note is one line of at most 500 characters; the body leaves a blank note out', () => {
    expect(noteProblem('')).toBeNull()
    expect(noteProblem('x'.repeat(501))).toEqual({ key: 'link.noteTooLong' })
    expect(noteProblem('two\nlines')).toEqual({ key: 'link.noteOneLine' })
    expect(linkBody({ recordType: 'Style', recordId: 's1' }, '  ')).toEqual({ recordType: 'Style', recordId: 's1' })
    expect(linkBody({ recordType: 'Style', recordId: 's1' }, ' why ')).toEqual({ recordType: 'Style', recordId: 's1', note: 'why' })
  })
})

describe('W12, W27, W38 — another outside company’s record is refused in words that name neither company', () => {
  // The office linking Brand Beta's order into Brand Alpha's project: the API answers refusal/LINK_PARTY (its English may say more).
  const betaOrder = BRAND_BETA.numbers.order
  const refusal = new ApiError('conflict', 409, 'invalid_state', `${betaOrder} is ${BRAND_BETA.legalName}'s order`, null, [{ path: 'refusal/LINK_PARTY', message: PROJECT_REFUSALS.LINK_PARTY.en }])

  it('is said from its code: the number typed and the rule, never the API’s sentence', () => {
    expect(linkProblemOf(refusal, betaOrder)).toEqual({ title: { key: 'refused.party', params: { label: betaOrder } }, body: { key: 'refusal.LINK_PARTY' } })
  })

  it('the words name neither Brand Alpha nor Brand Beta, in Italian and English', () => {
    for (const locale of LOCALES) {
      const title = words(locale, LINKED_NS)('refused.party', { label: betaOrder })
      const body = words(locale, 'products-projects')('refusal.LINK_PARTY')
      const said = `${title} ${body}`
      expect(said, locale).toContain(betaOrder)
      for (const brand of [BRAND_ALPHA, BRAND_BETA]) for (const name of [brand.tradeName, brand.legalName, brand.code]) expect(said, `${locale} ${name}`).not.toContain(name)
      // The shared words are the domain's own.
      expect(body).toBe(PROJECT_REFUSALS.LINK_PARTY[locale])
    }
  })

  it('every other refusal is said from its code too; linked already and not found have their own words', () => {
    const with409 = (code: string) => new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: `refusal/${code}`, message: 'x' }])
    expect(linkProblemOf(with409('LINK_OFFICE_ONLY'), 'SO-1')).toEqual({ title: { key: 'refused.label', params: { label: 'SO-1' } }, body: { key: 'refusal.LINK_OFFICE_ONLY' } })
    expect(linkProblemOf(with409('LINK_COMPANY'), 'SO-1').body).toEqual({ key: 'refusal.LINK_COMPANY' })
    expect(linkProblemOf(with409('ALREADY_LINKED'), 'AX-100')).toEqual({ title: { key: 'refused.already', params: { label: 'AX-100' } }, body: null })
    expect(linkProblemOf(new ApiError('not_found', 404, 'not_found', 'x'), 'SO-9').title).toEqual({ key: 'refused.notFound', params: { label: 'SO-9' } })
    expect(linkProblemOf(new ApiError('conflict', 409, 'conflict', 'x'), 'SO-9').title.key).toBe('problem.stale')
  })
})

describe('"In project …" on a record’s thread head (PROJ.linked-F05)', () => {
  it('only records a project may link read their projects; a live link or unlink of THIS record reads again', () => {
    expect(takesProjects('Style')).toBe(true)
    expect(takesProjects('SampleRound')).toBe(true)
    expect(takesProjects('WorkOrder')).toBe(false)
    expect(takesProjects('Project')).toBe(false)
    expect(inProjectChangeFor({ type: 'project.linked', fields: { recordType: 'Style', recordId: 'r1' } }, { type: 'Style', id: 'r1' })).toBe(true)
    expect(inProjectChangeFor({ type: 'project.unlinked', fields: { recordType: 'Style', recordId: 'r2' } }, { type: 'Style', id: 'r1' })).toBe(false)
    expect(inProjectChangeFor({ type: 'project.changed', fields: { recordType: 'Style', recordId: 'r1' } }, { type: 'Style', id: 'r1' })).toBe(false)
  })

  it('open projects first, each with its page', () => {
    const projects = inProjectOf(
      [
        { id: 'p0', number: 'PRJ-26-001', name: 'Old line', status: 'CLOSED' },
        { id: 'p1', number: 'PRJ-26-012', name: 'FW27 airbag line', status: 'ACTIVE' },
      ],
      PREFIX,
    )
    expect(projects.map((project) => project.id)).toEqual(['p1', 'p0'])
    expect(projects[0]!.href).toBe('/w/DEMO/products/projects/p1')
  })

  const head = (over: Partial<HeadModel> = {}): HeadModel => ({
    record: 'AX-100',
    party: { name: BRAND_ALPHA.tradeName, role: 'customer' },
    answers: null,
    closed: null,
    offline: null,
    view: 'all',
    views: ['all'],
    counts: {},
    holds: doorHolds({ can: { task: true, approve: true, share: true, follow: true, remind: true, manage: false, audit: false }, hasParty: true, offline: false }),
    follow: { following: false, muted: false },
    reminder: null,
    canManage: false,
    width: 'forty',
    now: Date.UTC(2026, 10, 17, 10, 42),
    ...over,
  })

  it('the chip links to the first project and says how many more; no projects: no chip (every other caller unchanged)', () => {
    const projects = inProjectOf(
      [
        { id: 'p1', number: 'PRJ-26-012', name: 'FW27 airbag line', status: 'ACTIVE' },
        { id: 'p2', number: 'PRJ-26-014', name: 'Leather change', status: 'ON_HOLD' },
      ],
      PREFIX,
    )
    const html = render(RecordThreadHead as never, head({ projects }))
    expect(html).toContain('href="/w/DEMO/products/projects/p1"')
    expect(html).toContain('In project: FW27 airbag line')
    expect(html).toContain('+1')
    expect(render(RecordThreadHead as never, head())).not.toContain('fw-rth-project')
    expect(render(RecordThreadHead as never, head({ projects: [] }))).not.toContain('fw-rth-project')
    expect(render(RecordThreadHead as never, head({ projects, compact: true }))).not.toContain('fw-rth-project')
  })
})

const LEFT_KEY = /\b(?:block|type|link|refused|unlink|notice|addTo|group|refusal|problem|held|status|common|field|project)\.[a-zA-Z]+/

describe('SCR-701-linked — every case draws in Italian and English with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        const html = render(designScreen.view as never, item.model, locale).replace(/(?:href|src)="[^"]*"/g, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        // Brand Alpha's project: nothing of Brand Beta anywhere.
        for (const name of [BRAND_BETA.tradeName, BRAND_BETA.legalName, BRAND_BETA.code]) expect(html, `${item.id} (${locale})`).not.toContain(name)
      }
    })
  }

  it('the Italian words are Italian', () => {
    const html = render(designScreen.view as never, LINKED_DEMO.customer, 'it')
    expect(html).toContain('Record collegati (8)')
    expect(html).not.toContain('Linked records')
  })

  it('every key of the catalogue is in both languages', () => {
    const italian = Object.keys(CATALOGUE.it[LINKED_NS] ?? {}).sort()
    const english = Object.keys(CATALOGUE.en[LINKED_NS] ?? {}).sort()
    expect(italian.length).toBeGreaterThan(40)
    expect(italian).toEqual(english)
  })
})
