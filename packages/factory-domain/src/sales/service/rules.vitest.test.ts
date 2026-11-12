import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { mailLanguageOf, statusMailOf } from './mail'
import { SALES_SERVICE_PERMISSIONS } from './permissions'
import {
  addYears,
  buyerOfParty,
  caseActions,
  CASE_ACTIONS,
  coverProblems,
  coverStateOf,
  coverWarnings,
  daysBetween,
  factProblems,
  legalGuaranteeEndOf,
  moveAllowed,
  moveHeld,
  moveProblems,
  warrantyCheckOf,
  type CaseAction,
} from './rules'

/**
 * Warranty and service cases (B-W2b-345): the moves as the guard allows them, the warranty check in words (the legal
 * guarantee of a consumer against the factory's own; a business customer's and an unnamed rider's), the cover decision's
 * rules, the status mail in both languages, the permissions and events declared. Dates are made up and never compared with
 * today's real date.
 */

const TODAY = '2026-06-15'
const all = (value: boolean): Record<CaseAction, boolean> => Object.fromEntries(CASE_ACTIONS.map((action) => [action, value])) as Record<CaseAction, boolean>

describe('the moves (ServiceCase_guard)', () => {
  it('allows the database moves only', () => {
    expect(moveAllowed('NEW', 'OPEN')).toBe(true)
    expect(moveAllowed('NEW', 'CLOSED')).toBe(true)
    expect(moveAllowed('NEW', 'RESOLVED')).toBe(false)
    expect(moveAllowed('OPEN', 'WAITING_PART')).toBe(true)
    expect(moveAllowed('WAITING_PART', 'WAITING_CUSTOMER')).toBe(true)
    expect(moveAllowed('WAITING_CUSTOMER', 'RESOLVED')).toBe(true)
    expect(moveAllowed('RESOLVED', 'OPEN')).toBe(true)
    expect(moveAllowed('RESOLVED', 'WAITING_PART')).toBe(false)
    expect(moveAllowed('CLOSED', 'OPEN')).toBe(false)
  })

  it('holds a warranty claim from being resolved before its cover is decided, and says why', () => {
    expect(moveHeld({ from: 'OPEN', to: 'RESOLVED', kind: 'WARRANTY', coverDecided: false })).toBe('COVER_UNDECIDED')
    expect(moveHeld({ from: 'OPEN', to: 'RESOLVED', kind: 'QUESTION', coverDecided: false })).toBeNull()
    expect(moveHeld({ from: 'NEW', to: 'WAITING_PART', kind: 'REPAIR', coverDecided: false })).toBe('NOT_NEW')
    expect(moveHeld({ from: 'CLOSED', to: 'OPEN', kind: 'REPAIR', coverDecided: true })).toBe('CLOSED')
    expect(moveProblems({ from: 'OPEN', to: 'RESOLVED' })).toEqual([{ path: 'body/resolution', message: 'Say what was done, in words.' }])
    expect(moveProblems({ from: 'OPEN', to: 'CLOSED' })).toEqual([{ path: 'body/reason', message: 'Closed without a resolution: say why, in words.' }])
    expect(moveProblems({ from: 'RESOLVED', to: 'CLOSED' })).toEqual([])
    expect(moveProblems({ from: 'OPEN', to: 'WAITING_PART', reason: 'x' })).toEqual([{ path: 'body/reason', message: 'A reason goes with the close only.' }])
  })

  it("lists the record's actions with the held code of each", () => {
    const actions = caseActions({ status: 'NEW', kind: 'WARRANTY', coverDecided: false, hasParty: false, hasContactEmail: false, notifyCustomer: false, may: all(true) })
    const of = (action: CaseAction) => actions.find((entry) => entry.action === action)
    expect(of('open')).toEqual({ action: 'open', allowed: true, held: null })
    expect(of('resolve')?.held).toBe('NOT_NEW')
    expect(of('makeRepair')?.held).toBe('NO_CUSTOMER')
    expect(of('notify')?.held).toBe('NO_CONTACT_EMAIL')
    const reader = caseActions({ status: 'OPEN', kind: 'WARRANTY', coverDecided: true, hasParty: true, hasContactEmail: true, notifyCustomer: true, may: all(false) })
    expect(reader.every((entry) => entry.held === 'NO_PERMISSION')).toBe(true)
    const resolved = caseActions({ status: 'RESOLVED', kind: 'REPAIR', coverDecided: false, hasParty: true, hasContactEmail: true, notifyCustomer: true, may: all(true) })
    expect(resolved.find((entry) => entry.action === 'reopen')).toEqual({ action: 'reopen', allowed: true, held: null })
    expect(resolved.find((entry) => entry.action === 'resume')?.held).toBe('NOT_FROM_HERE')
  })
})

describe('the warranty check (SAL-368)', () => {
  it('counts periods in years as Reg. 1182/71 does', () => {
    expect(addYears('2026-03-10', 2)).toBe('2028-03-10')
    expect(addYears('2028-02-29', 1)).toBe('2029-02-28')
    expect(daysBetween('2026-06-15', '2026-06-20')).toBe(5)
    expect(legalGuaranteeEndOf('CONSUMER', '2025-01-20')).toBe('2027-01-20')
    expect(legalGuaranteeEndOf('BUSINESS', '2025-01-20')).toBeNull()
    expect(buyerOfParty({ kind: 'PERSON' })).toBe('CONSUMER')
    expect(buyerOfParty({ kind: 'ORGANISATION' })).toBe('BUSINESS')
    expect(buyerOfParty(null)).toBe('NOT_NAMED')
  })

  it('a consumer within the first year: the legal guarantee runs and the defect is presumed', () => {
    const check = warrantyCheckOf({ today: TODAY, buyer: 'CONSUMER', deliveredOn: '2026-01-10', legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: null })
    expect(check.legal).toMatchObject({ state: 'RUNS', endsOn: '2028-01-10' })
    expect(check.legal.words).toContain('Directive (EU) 2019/771 art. 10')
    expect(check.presumption).toMatchObject({ applies: true, until: '2027-01-10' })
    expect(check).toMatchObject({ suggested: 'LEGAL_GUARANTEE', state: 'LEGAL_GUARANTEE' })
    expect(check.remedies).toContain('repair or a replacement free of charge')
    expect(check.liable).toContain('as the seller')
  })

  it('a consumer after the legal guarantee: the factory guarantee when it runs, else out of cover', () => {
    const factory = warrantyCheckOf({ today: TODAY, buyer: 'CONSUMER', deliveredOn: '2023-05-01', legalGuaranteeEndsOn: '2025-05-01', factoryGuaranteeEndsOn: '2026-12-31' })
    expect(factory.legal.state).toBe('ENDED')
    expect(factory.presumption?.applies).toBe(false)
    expect(factory).toMatchObject({ suggested: 'FACTORY_GUARANTEE', state: 'FACTORY_GUARANTEE' })
    expect(factory.factory).toMatchObject({ state: 'RUNS', daysLeft: 199 })
    const out = warrantyCheckOf({ today: TODAY, buyer: 'CONSUMER', deliveredOn: '2023-05-01', legalGuaranteeEndsOn: '2025-05-01', factoryGuaranteeEndsOn: '2025-05-01' })
    expect(out).toMatchObject({ suggested: 'NONE', state: 'OUT_OF_COVER' })
  })

  it('a business customer: not the consumer guarantee (the contract, the Civil Code, the dealer’s redress); an unknown delivery day: unknown', () => {
    const business = warrantyCheckOf({ today: TODAY, buyer: 'BUSINESS', deliveredOn: '2026-02-01', legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: '2027-02-01' })
    expect(business.legal.state).toBe('NONE')
    expect(business.legal.words).toContain('art. 1490-1495 c.c.')
    expect(business.legal.words).toContain('right of redress')
    expect(business.presumption).toBeNull()
    expect(business.suggested).toBe('FACTORY_GUARANTEE')
    const unknown = warrantyCheckOf({ today: TODAY, buyer: 'CONSUMER', deliveredOn: null, legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: null })
    expect(unknown).toMatchObject({ suggested: null, state: 'UNKNOWN' })
    expect(unknown.legal.state).toBe('UNKNOWN')
    const rider = warrantyCheckOf({ today: TODAY, buyer: 'NOT_NAMED', deliveredOn: null, legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: null })
    expect(rider.legal.words).toContain('not by us')
    expect(coverStateOf('NONE', unknown)).toBe('OUT_OF_COVER')
    expect(coverStateOf(null, unknown)).toBe('UNKNOWN')
  })

  it('decides the cover as the guard does, and warns where the check says otherwise', () => {
    expect(coverProblems({ cover: 'NONE', decision: 'COVERED', note: 'ok', legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: null }).map((issue) => issue.path)).toEqual(['body/cover'])
    expect(coverProblems({ cover: 'LEGAL_GUARANTEE', decision: 'NOT_COVERED', note: ' ', legalGuaranteeEndsOn: '2027-01-01', factoryGuaranteeEndsOn: null }).map((issue) => issue.path)).toEqual(['body/cover', 'body/note'])
    expect(coverProblems({ cover: 'LEGAL_GUARANTEE', decision: 'COVERED', note: 'Seam opened in normal use.', legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: null })[0]!.message).toContain("legal guarantee's last day")
    expect(coverProblems({ cover: 'FACTORY_GUARANTEE', decision: 'PARTLY', note: 'Zip only.', legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: '2027-01-01' })).toEqual([])
    const check = warrantyCheckOf({ today: TODAY, buyer: 'BUSINESS', deliveredOn: '2026-01-10', legalGuaranteeEndsOn: '2028-01-10', factoryGuaranteeEndsOn: null })
    expect(coverWarnings({ cover: 'LEGAL_GUARANTEE', decision: 'COVERED', check }).map((issue) => issue.message)[0]).toContain('not a consumer we sold to')
  })

  it("checks the facts' shapes", () => {
    expect(factProblems({}, TODAY, true)).toEqual([{ path: 'body/problem', message: "Say what is wrong, in the customer's words." }])
    expect(factProblems({ problem: 'x', serial: 'a\nb', deliveredOn: '2026-07-01', factoryGuaranteeEndsOn: '2026-06-30' }, TODAY, true).map((issue) => issue.path)).toEqual(['body/serial', 'body/deliveredOn', 'body/factoryGuaranteeEndsOn'])
  })
})

describe('the status mail (SAL-436)', () => {
  it("speaks the contact's language, names the case and where it is, and adds the office's words", () => {
    expect(mailLanguageOf(null, 'en-GB')).toBe('en')
    expect(mailLanguageOf('de', 'fr')).toBe('it')
    const it = statusMailOf({ language: 'it', number: 'SVC-2026-0007', from: 'OPEN', to: 'WAITING_PART', contactName: 'Marta', companyName: 'Made-up Leathers', message: null })
    expect(it.subject).toBe('Pratica di assistenza SVC-2026-0007: in attesa di un ricambio')
    expect(it.body.split('\n')[0]).toBe('Gentile Marta,')
    const en = statusMailOf({ language: 'en', number: 'SVC-2026-0007', from: 'RESOLVED', to: 'OPEN', contactName: null, companyName: 'Made-up Leathers', message: 'We will call you tomorrow.' })
    expect(en.subject).toBe('Service case SVC-2026-0007: in progress')
    expect(en.body).toContain('Dear customer,')
    expect(en.body).toContain('opened again')
    expect(en.body).toContain('We will call you tomorrow.')
  })
})

describe('declared', () => {
  it('the permissions, the role templates that hold them and the events', () => {
    for (const name of SALES_SERVICE_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name), name).toBe(true)
    expect(templateOf('sales')!.permissions).toEqual(expect.arrayContaining(['sales.service.view', 'sales.service.manage', 'sales.service.decide']))
    expect(templateOf('quality_inspector')!.permissions).toEqual(expect.arrayContaining(['sales.service.view', 'sales.service.manage']))
    expect(templateOf('quality_inspector')!.permissions).not.toContain('sales.service.decide')
    expect(templateOf('finance')!.permissions).toContain('sales.service.view')
    for (const type of ['service_case.opened', 'service_case.changed', 'service_case.cover_decided', 'service_case.status_changed', 'service_case.linked']) expect(EVENT_CATALOGUE.find(type, 1), type).toBeDefined()
  })
})
