import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { PROJECT_LIMITS, PROJECT_LINK_TYPES, PROJECT_REFUSALS } from '@nexus/factory-domain/projects/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import type { ProjectRow } from './api'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressText,
  BULK_CLOSE_HELD,
  bulkHeld,
  bulkReceipt,
  bulkStatusPlan,
  doorsOf,
  emptyNewDraft,
  hiddenBy,
  HOME_ADDRESS,
  isFiltered,
  nameProblem,
  newBodyOf,
  newDraftHeld,
  newMarkOf,
  partyGroupsOf,
  queryOf,
  setOnceLine,
  targetDoorOf,
  viewOfStatus,
  type NewDraft,
} from './list-model'
import { projectsCan, refusalCode, refusalPhrase, REFUSAL_CODES, writeProblem } from './model'

/**
 * B-TH-248 (threads plan TH-5; design PROJ.list, PROJ.new; walls W19, W27, W38): the projects list and New project — the address and
 * the API query (My projects by default), the filters and what hides rows, every cell's door, the bulk rules (Close never in bulk;
 * what is skipped counted), the New project rules (name, lead and target date required; the outside company set once, said before
 * Create; the body sent), the refusal words equal to the domain's, the page in the navigation and the record links, and every design
 * case drawn in Italian and English with no key left on screen.
 */

const params = (text: string) => new URLSearchParams(text)
const ID = '0190f0e2-5101-7000-8000-000000000001'
const OTHER = '0190f0e2-3333-7000-8000-000000000007'
const owner = projectsCan(templateOf('owner')!.permissions)
const reader = projectsCan(templateOf('read_only')!.permissions)

function row(over: Partial<ProjectRow>): ProjectRow {
  return {
    id: '0190f0e2-7001-7000-8000-000000000001',
    number: 'PRJ-26-001',
    name: 'Demo project',
    companyId: '0190f0e2-1111-7000-8000-000000000001',
    party: null,
    lead: { id: OTHER, name: 'Mara Demo' },
    status: 'ACTIVE',
    targetDate: '2026-12-18',
    target: { state: 'LATER', days: 31 },
    seasonCode: null,
    lastMessageAt: null,
    newForMe: 0,
    muted: false,
    mine: true,
    linked: 0,
    version: 3,
    ...over,
  }
}

describe('the address and the API query', () => {
  it('opens on My projects (the API’s MINE, nearest target first) with no filter', () => {
    expect(addressOf(params(''))).toEqual(HOME_ADDRESS)
    expect(queryOf(HOME_ADDRESS)).toMatchObject({ view: 'MINE', sort: 'TARGET', partyId: null, officeOnly: false, leadId: null, seasonCode: null, target: null, q: null, cursor: null, limit: 50 })
    expect(addressText(HOME_ADDRESS)).toBe('')
    expect(isFiltered(HOME_ADDRESS)).toBe(false)
  })

  it('each view asks its API view: By outside company is the active ones sorted by outside company; Closed by last message', () => {
    expect(queryOf(addressOf(params('view=active')))).toMatchObject({ view: 'ACTIVE', sort: 'TARGET' })
    expect(queryOf(addressOf(params('view=party')))).toMatchObject({ view: 'ACTIVE', sort: 'PARTY' })
    expect(queryOf(addressOf(params('view=onHold')))).toMatchObject({ view: 'ON_HOLD' })
    expect(queryOf(addressOf(params('view=closed')))).toMatchObject({ view: 'CLOSED', sort: 'RECENT' })
    expect(queryOf(addressOf(params('view=all')))).toMatchObject({ view: 'ALL' })
    expect(addressOf(params('view=nonsense')).view).toBe('mine')
  })

  it('keeps the filters in the address, and reads the API’s own terms (a link made from GET /projects)', () => {
    const address = addressOf(params(`view=active&party=${ID}&lead=${OTHER}&season=FW27&target=OVERDUE&q=airbag`))
    expect(address).toMatchObject({ view: 'active', party: ID, office: false, lead: OTHER, season: 'FW27', target: 'OVERDUE', q: 'airbag' })
    expect(addressOf(params(addressText(address).slice(1)))).toEqual(address)
    expect(queryOf(address, '50')).toMatchObject({ partyId: ID, leadId: OTHER, seasonCode: 'FW27', target: 'OVERDUE', q: 'airbag', cursor: '50' })
    expect(addressOf(params(`view=CLOSED&partyId=${ID}&leadId=${OTHER}&seasonCode=SS27`))).toMatchObject({ view: 'closed', party: ID, lead: OTHER, season: 'SS27' })
    // Office only wins over a party: the API asks `outside=none`.
    const office = addressOf(params(`office=1&party=${ID}`))
    expect(office).toMatchObject({ office: true, party: null })
    expect(queryOf(office)).toMatchObject({ officeOnly: true, partyId: null })
    expect(addressOf(params('outside=none')).office).toBe(true)
    expect(addressOf(params('target=SOMEDAY')).target).toBeNull()
    expect(addressOf(params('party=not an id')).party).toBeNull()
  })

  it('reads New project from a record (`?link=<Type>:<id>`) only for a type a project links', () => {
    expect(addressOf(params(`new=1&link=Style:${ID}&linkLabel=JK-210`))).toMatchObject({ isNew: true, link: { type: 'Style', id: ID, label: 'JK-210' } })
    expect(addressOf(params(`new=1&link=Invoice:${ID}`)).link).toBeNull()
    expect(addressOf(params('new=1&link=Style:')).link).toBeNull()
  })

  it('says which view and filters hide the rows of an empty view', () => {
    const address = addressOf(params(`view=active&party=${ID}&season=FW27&q=zzz`))
    expect(hiddenBy(address, { party: 'Brand Alpha' })).toEqual([
      { key: 'view.active' },
      { key: 'filter.partyChip', params: { name: 'Brand Alpha' } },
      { key: 'filter.seasonChip', params: { code: 'FW27' } },
      { key: 'filter.searchChip', params: { q: 'zzz' } },
    ])
    expect(hiddenBy(addressOf(params('view=onHold')))).toEqual([{ key: 'view.onHold' }])
  })
})

describe('every cell is a door', () => {
  it('the project, its thread at what is new, its Linked block', () => {
    expect(doorsOf('/w/DEMO', { id: 'p1' })).toEqual({ project: '/w/DEMO/products/projects/p1', thread: '/w/DEMO/products/projects/p1?thread=new', linked: '/w/DEMO/products/projects/p1#linked' })
  })

  it('a status opens its view; a target date the overdue or this month’s filter (else the project)', () => {
    expect(viewOfStatus('ACTIVE')).toBe('active')
    expect(viewOfStatus('ON_HOLD')).toBe('onHold')
    expect(viewOfStatus('CLOSED')).toBe('closed')
    expect(targetDoorOf(row({ target: { state: 'OVERDUE', days: -3 }, targetDate: '2026-11-14' }), '2026-11-17')).toBe('OVERDUE')
    expect(targetDoorOf(row({ target: { state: 'SOON', days: 4 }, targetDate: '2026-11-21' }), '2026-11-17')).toBe('THIS_MONTH')
    expect(targetDoorOf(row({ target: { state: 'LATER', days: 73 }, targetDate: '2027-01-29' }), '2026-11-17')).toBeNull()
    expect(targetDoorOf(row({ status: 'CLOSED', target: { state: 'CLOSED', days: -40 }, targetDate: '2026-10-08' }), '2026-11-17')).toBeNull()
  })

  it('New for me is my own unread count; a muted project shows the muted mark, never a count', () => {
    expect(newMarkOf(row({ newForMe: 3 }))).toEqual({ kind: 'new', count: 3 })
    expect(newMarkOf(row({ newForMe: 0 }))).toEqual({ kind: 'none' })
    expect(newMarkOf(row({ newForMe: 0, muted: true }))).toEqual({ kind: 'muted' })
  })
})

describe('the bulk bar (PROJ.list-F03)', () => {
  const active = row({ id: 'a', status: 'ACTIVE' })
  const held = row({ id: 'h', status: 'ON_HOLD' })
  const closed = row({ id: 'c', status: 'CLOSED' })

  it('On hold holds the active ones; the ones on hold already and the closed ones are counted, not sent', () => {
    const plan = bulkStatusPlan([active, held, closed], 'ON_HOLD')
    expect(plan.moves.map((move) => [move.row.id, move.move])).toEqual([['a', 'HOLD']])
    expect(plan).toMatchObject({ already: 1, closed: 1 })
  })

  it('Active resumes the ones on hold', () => {
    const plan = bulkStatusPlan([active, held, closed], 'ACTIVE')
    expect(plan.moves.map((move) => [move.row.id, move.move])).toEqual([['h', 'RESUME']])
    expect(plan).toMatchObject({ already: 1, closed: 1 })
  })

  it('the receipt says what moved, what already was and what was skipped (a warning when anything was skipped)', () => {
    expect(bulkReceipt('hold', { done: 2, already: 0, closed: 0, refused: 0 })).toEqual({ tone: 'success', lines: [{ key: 'bulk.done.hold', params: { count: 2 } }] })
    const mixed = bulkReceipt('resume', { done: 1, already: 1, closed: 1, refused: 2 })
    expect(mixed.tone).toBe('warning')
    expect(mixed.lines.map((line) => line.key)).toEqual(['bulk.done.resume', 'bulk.already.resume', 'bulk.skippedClosed', 'bulk.skippedRefused'])
  })

  it('Close is never offered in bulk: the bar says why in words; the writes are held without their right or offline', () => {
    expect(BULK_CLOSE_HELD).toEqual({ key: 'bulk.closeHeld' })
    for (const locale of LOCALES) expect((CATALOGUE[locale]['products-projects'] ?? {})['bulk.closeHeld'], locale).toBeTruthy()
    expect(bulkHeld('status', owner, false, false)).toBeNull()
    expect(bulkHeld('status', reader, false, false)?.key).toBe('held.noManage')
    expect(bulkHeld('colleague', reader, false, false)?.key).toBe('held.noPost')
    expect(bulkHeld('status', owner, true, false)?.key).toBe('held.offline')
    expect(bulkHeld('colleague', owner, false, true)?.key).toBe('held.busy')
  })
})

describe('New project (PROJ.new)', () => {
  const ready: NewDraft = { ...emptyNewDraft(), name: 'FW27 airbag jacket line', targetDate: '2027-02-12' }
  const input = { can: owner, offline: false, leadId: OTHER, companyId: '0190f0e2-1111-7000-8000-000000000001' }

  it('name, lead and target date are required; the name is one line of at most 200 characters', () => {
    expect(newDraftHeld(ready, input)).toBeNull()
    expect(newDraftHeld({ ...ready, name: '  ' }, input)?.key).toBe('new.nameRequired')
    expect(newDraftHeld({ ...ready, name: 'Two\nlines' }, input)?.key).toBe('new.nameOneLine')
    expect(newDraftHeld({ ...ready, name: 'x'.repeat(PROJECT_LIMITS.name + 1) }, input)?.key).toBe('new.nameTooLong')
    expect(nameProblem('x'.repeat(PROJECT_LIMITS.name))).toBeNull()
    expect(newDraftHeld(ready, { ...input, leadId: null })?.key).toBe('new.leadRequired')
    expect(newDraftHeld({ ...ready, targetDate: '' }, input)?.key).toBe('new.targetRequired')
    expect(newDraftHeld({ ...ready, goal: 'x'.repeat(PROJECT_LIMITS.goal + 1) }, input)?.key).toBe('new.goalTooLong')
  })

  it('is held without projects.manage, offline, or with no company open', () => {
    expect(newDraftHeld(ready, { ...input, can: reader })?.key).toBe('held.noManage')
    expect(newDraftHeld(ready, { ...input, offline: true })?.key).toBe('held.offline')
    expect(newDraftHeld(ready, { ...input, companyId: null })?.key).toBe('new.noCompany')
  })

  it('says the outside company is set once BEFORE Create — with its name, or that no outside company can be added later', () => {
    expect(setOnceLine('Brand Alpha')).toEqual({ key: 'new.setOnceParty', params: { name: 'Brand Alpha' } })
    expect(setOnceLine(null)).toEqual({ key: 'new.setOnceOffice' })
    const en = CATALOGUE.en['products-projects'] ?? {}
    expect(en['new.setOnceParty']).toContain('{name}')
    expect(en['new.setOnceParty']).toContain('cannot be changed later')
    expect(CATALOGUE.it['products-projects']?.['new.setOnceParty']).toContain('{name}')
  })

  it('sends partyId null for an office-only project, the lead, the record started from, and nothing it was not given', () => {
    const companyId = input.companyId
    expect(newBodyOf(ready, { companyId, leadId: OTHER, link: null })).toEqual({ companyId, name: 'FW27 airbag jacket line', partyId: null, leadId: OTHER, targetDate: '2027-02-12' })
    const full = newBodyOf({ ...ready, name: '  Touring family ', partyId: ID, seasonCode: 'FW27', goal: '  Six styles to production in March.  ' }, { companyId, leadId: OTHER, link: { type: 'Style', id: ID, label: 'JK-210' } })
    expect(full).toEqual({ companyId, name: 'Touring family', partyId: ID, leadId: OTHER, targetDate: '2027-02-12', seasonCode: 'FW27', goal: 'Six styles to production in March.', links: [{ recordType: 'Style', recordId: ID }] })
  })

  it('offers customers and brands apart from suppliers and subcontractors (one outside company per project)', () => {
    const groups = partyGroupsOf([
      { id: '1', code: 'A', legalName: 'Brand Alpha S.r.l.', tradeName: 'Brand Alpha', roles: ['CUSTOMER'] },
      { id: '2', code: 'B', legalName: 'Brand Beta S.p.A.', tradeName: null, roles: ['BRAND'] },
      { id: '3', code: 'P', legalName: 'Pelli Demo S.r.l.', tradeName: null, roles: ['SUPPLIER'] },
      { id: '4', code: 'C', legalName: 'Carrier Demo', tradeName: null, roles: ['CARRIER'] },
    ])
    expect(groups.customers.map((party) => party.id)).toEqual(['1', '2'])
    expect(groups.suppliers.map((party) => party.id)).toEqual(['3'])
  })

  it('every link type a project takes has its words for "Will link: …"', () => {
    for (const locale of LOCALES) for (const type of PROJECT_LINK_TYPES) expect((CATALOGUE[locale]['products-projects'] ?? {})[`linkType.${type}`], `${locale} ${type}`).toBeTruthy()
  })
})

describe('refusals in words (the wall: neutral, never naming a customer)', () => {
  it('every refusal’s words equal the domain’s, in Italian and English', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['products-projects'] ?? {}
      for (const [code, domain] of Object.entries(PROJECT_REFUSALS)) expect(words[`refusal.${code}`], `${locale} ${code}`).toBe(domain[locale])
      expect(words['refusal.other'], locale).toBeTruthy()
    }
    expect(REFUSAL_CODES.length).toBe(Object.keys(PROJECT_REFUSALS).length)
  })

  it('a refusal is said from its code; an unknown code says the general words', () => {
    const error = new ApiError('conflict', 409, 'invalid_state', 'This record belongs to another outside company', null, [{ path: 'refusal/LINK_PARTY', message: 'x' }])
    expect(refusalCode(error)).toBe('LINK_PARTY')
    expect(writeProblem(error)).toMatchObject({ key: 'refusal.LINK_PARTY', stale: false })
    expect(refusalPhrase('SOMETHING_NEW')).toEqual({ key: 'refusal.other' })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'stale'))).toMatchObject({ key: 'problem.stale', stale: true })
  })
})

describe('the page in the navigation and the record links', () => {
  it('is built: the list and the project page open; a project opens its page; the API list opens the list with its terms', () => {
    expect(OFFICE_PAGES.has('/products/projects')).toBe(true)
    expect(OFFICE_PAGES.has('/products/projects/[id]')).toBe(true)
    expect(recordAddress({ type: 'Project', id: 'p1' }, OFFICE_PAGES)).toBe('/products/projects/p1')
    const list = listAddress('/projects', { view: 'CLOSED' }, OFFICE_PAGES)
    expect(list).toBe('/products/projects?view=CLOSED')
    expect(addressOf(params(list!.split('?')[1]!)).view).toBe('closed')
  })

  it('shows to every office role (open to every office person who reads threads), after Changes', () => {
    const roles = ['owner', 'admin', 'production_manager', 'quality_inspector', 'planner', 'sales', 'buyer', 'warehouse', 'floor_supervisor', 'finance', 'read_only']
    for (const role of roles) {
      const hrefs = officeNavFor(permissionCheck([...templateOf(role)!.permissions])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
      expect(hrefs, role).toContain('/products/projects')
    }
    expect(officeNavFor(permissionCheck(['home.view'])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))).not.toContain('/products/projects')
  })

  it('has its page file (the export source products.projects names this page)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    expect(existsSync(join(here, '../../../app/(office)/w/[company]/products/projects/page.tsx'))).toBe(true)
  })
})

const LEFT_KEY = /\b(?:common|held|list|row|col|view|filter|bulk|keys|new|noAccess|live|status|outcome|target|refusal|problem|field|linkType|group)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('SCR-700: every design case draws in both languages with no key left on screen, made-up data only', () => {
  for (const locale of LOCALES) {
    it(`${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        const html = render(designScreen as DesignScreen<unknown>, item.model, locale)
        const text = html.replace(/https?:\/\/[^"\s<]+/g, '').replace(/\b(?:products|example)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
        expect(text.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html, item.id).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
        expect(html, item.id).not.toMatch(/gmail/i)
      }
    })
  }

  it('the set-once line said before Create: with an outside company it names it; office only, no company can join later', () => {
    // The dialog itself draws only in a browser (the DS Modal waits for hydration): its words are checked from its model.
    const customer = designScreen.cases.find((item) => item.id === 'new-customer')!.model as { model: { newProject: { draft: NewDraft } | null } }
    const office = designScreen.cases.find((item) => item.id === 'new-office')!.model as { model: { newProject: { draft: NewDraft } | null } }
    expect(customer.model.newProject?.draft.partyId).toBeTruthy()
    expect(office.model.newProject?.draft.partyId).toBeNull()
    const en = createTranslator('en', CATALOGUE.en['products-projects'] ?? {})
    const line = (phrase: { key: string; params?: Readonly<Record<string, string | number>> }) => en(phrase.key, phrase.params)
    expect(line(setOnceLine('Brand Alpha'))).toBe('Only Brand Alpha and our team will be in this project. This cannot be changed later.')
    expect(line(setOnceLine(null))).toContain('No outside company can be added later.')
  })
})
