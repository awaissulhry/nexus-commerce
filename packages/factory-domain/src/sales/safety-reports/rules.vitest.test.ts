import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { REGISTER_SOURCE_TYPES } from '../../compliance/register/rules'
import { SALES_SAFETY_PERMISSIONS } from './permissions'
import {
  accidentNeeded,
  caseProblemOf,
  closeProblems,
  injuryKeyOf,
  intakeOutcomeOf,
  intakeProblems,
  logStateOf,
  moveHeld,
  PHOTO_TICKET,
  registerDescriptionOf,
  reportActions,
  revisionProblems,
  type ActionFacts,
} from './rules'

/** Made-up facts only; every day is fixed in the test (never today's). */
const TODAY = '2026-06-15'
const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)

describe('the intake (SAL-414, SAL-415)', () => {
  it('asks what happened; outside doors ask whether anyone was hurt and the serial or the batch', () => {
    expect(paths(intakeProblems({ whatHappened: '  ' }, TODAY, false))).toEqual(['body/whatHappened'])
    expect(paths(intakeProblems({ whatHappened: 'The zip opened in a slide.' }, TODAY, true))).toEqual(['body/injured', 'body/serial'])
    expect(intakeProblems({ whatHappened: 'The zip opened in a slide.', injured: false, batchNumber: 'BT-1' }, TODAY, true)).toEqual([])
    // The office may leave the injury unsaid (a mail that does not say).
    expect(intakeProblems({ whatHappened: 'The zip opened in a slide.' }, TODAY, false)).toEqual([])
  })

  it('keeps the injury words only when someone was hurt and with the consent tick', () => {
    expect(paths(intakeProblems({ whatHappened: 'x', injured: false, injuryWords: 'a bruise' }, TODAY, false))).toEqual(['body/injuryWords'])
    expect(intakeProblems({ whatHappened: 'x', injured: true, injuryWords: 'a bruise', occurredOn: '2026-06-01', place: 'a road' }, TODAY, false)).toContainEqual({
      path: 'body/injuryConsent',
      message: 'Tick the consent first: the injury words are health data (GDPR art. 9), kept only with an explicit consent.',
    })
    expect(intakeProblems({ whatHappened: 'x', injured: true, injuryConsent: true, injuryWords: 'a bruise', occurredOn: '2026-06-01', place: 'a road' }, TODAY, false)).toEqual([])
    expect(paths(intakeProblems({ whatHappened: 'x', injured: true, injuryConsent: true, injuryWords: 'y'.repeat(2001), occurredOn: '2026-06-01', place: 'a road' }, TODAY, false))).toEqual(['body/injuryWords'])
  })

  it('an accident, or anyone hurt, asks the day and the place (the accident log); never a day after today', () => {
    expect(accidentNeeded({ accident: true })).toBe(true)
    expect(accidentNeeded({ injured: true })).toBe(true)
    expect(accidentNeeded({ injured: false, accident: false })).toBe(false)
    expect(paths(intakeProblems({ whatHappened: 'x', accident: true }, TODAY, false))).toEqual(['body/occurredOn', 'body/place'])
    expect(paths(intakeProblems({ whatHappened: 'x', occurredOn: '2026-06-16' }, TODAY, false))).toEqual(['body/occurredOn'])
    expect(paths(intakeProblems({ whatHappened: 'x', accident: true, occurredOn: '2026-06-01', place: 'two\nlines' }, TODAY, false))).toEqual(['body/place'])
    expect(intakeOutcomeOf(false)).toBe('NO_HARM')
    expect(intakeOutcomeOf(true)).toBe('NOT_KNOWN')
    expect(intakeOutcomeOf(undefined)).toBe('NOT_KNOWN')
  })

  it('checks the reporter as they gave themselves, the labels and the size', () => {
    expect(paths(intakeProblems({ whatHappened: 'x', reporter: { name: 'A rider', email: 'not-an-address', phone: 'call me' }, serial: 'a\nb', size: 'x'.repeat(21) }, TODAY, false))).toEqual([
      'body/serial',
      'body/size',
      'body/reporter/email',
      'body/reporter/phone',
    ])
    expect(intakeProblems({ whatHappened: 'x', reporter: { name: 'A rider', email: 'rider@example.com', phone: '+39 055 000 0000' } }, TODAY, false)).toEqual([])
  })

  it('never repeats the reporter’s words in the case or the register: they name the report', () => {
    expect(caseProblemOf('PSR-2026-0007', 'PUBLIC_LINK')).toBe('Product-safety report PSR-2026-0007, from the public DoC page: what happened is on the report, and whether someone was hurt only for the product-safety role.')
    expect(registerDescriptionOf({ number: 'PSR-2026-0007', source: 'MAIL', receivedOn: '2026-06-02', serial: 'SN-1', batchNumber: 'BT-1' })).toBe('Product-safety report PSR-2026-0007 received on 2026-06-02 from a mail (batch BT-1, serial SN-1): what happened is on the report.')
    expect(injuryKeyOf('0190e0a0-0000-7000-8000-000000000001')).toBe('injury:0190e0a0-0000-7000-8000-000000000001')
  })
})

describe('the moves', () => {
  it('NEW → ASSESSING | CLOSED, ASSESSING → CLOSED; CLOSED is final; closed with words', () => {
    expect(moveHeld('NEW', 'ASSESSING')).toBeNull()
    expect(moveHeld('NEW', 'CLOSED')).toBeNull()
    expect(moveHeld('ASSESSING', 'CLOSED')).toBeNull()
    expect(moveHeld('ASSESSING', 'ASSESSING')).toBe('ALREADY')
    expect(moveHeld('CLOSED', 'ASSESSING')).toBe('CLOSED')
    expect(paths(closeProblems(' '))).toEqual(['body/note'])
    expect(closeProblems('The pocket was not closed; the garment protects as certified.')).toEqual([])
  })

  it('offers what the state and the roles allow, with the held code', () => {
    const facts: ActionFacts = { status: 'NEW', seen: false, filed: false, hasStyle: true, photos: 0, reporterKept: true, injury: { words: true, erased: false }, mayManage: true, mayInjury: false, mayLog: false, mayOpenRegister: true }
    const by = (list: ReturnType<typeof reportActions>) => Object.fromEntries(list.map((entry) => [entry.action, entry.held ?? 'OK']))
    expect(by(reportActions(facts))).toMatchObject({ seen: 'OK', assess: 'OK', close: 'OK', file: 'OK', photos: 'OK', eraseReporter: 'OK', openInjury: 'NO_PERMISSION', logAccident: 'NO_PERMISSION' })
    expect(by(reportActions({ ...facts, status: 'CLOSED', seen: true, filed: true, mayInjury: true, mayLog: true, injury: { words: false, erased: true } }))).toMatchObject({
      seen: 'CLOSED',
      assess: 'CLOSED',
      file: 'CLOSED',
      logAccident: 'OK',
      openInjury: 'OK',
      recordInjury: 'INJURY_RECORDED',
      eraseInjury: 'ERASED',
    })
    expect(by(reportActions({ ...facts, hasStyle: false, photos: 6, injury: null, mayInjury: true }))).toMatchObject({ file: 'NO_STYLE', photos: 'NO_PHOTOS_LEFT', openInjury: 'NO_INJURY', recordInjury: 'OK' })
  })
})

describe('the accident log (SAL-423)', () => {
  const base = { first: true, occurredOn: '2026-06-01', place: 'a track day', outcome: 'MINOR_HARM' as const, serial: null, batchNumber: null, authorityToldAt: null, authorityReference: null, authorityNoticeId: null, note: null, receivedOn: '2026-06-02', today: TODAY, now: new Date('2026-06-15T10:00:00Z'), authorityDay: null }

  it('revision 1 names the day, the place and what came of it; a later one says why', () => {
    expect(revisionProblems(base)).toEqual([])
    expect(paths(revisionProblems({ ...base, occurredOn: null, place: null, outcome: null }))).toEqual(['body/occurredOn', 'body/place', 'body/outcome'])
    expect(paths(revisionProblems({ ...base, first: false }))).toEqual(['body/note'])
    expect(paths(revisionProblems({ ...base, occurredOn: '2026-06-03' }))).toEqual(['body/occurredOn'])
  })

  it('the authority told: when (not ahead, not before the accident), then its reference and notice', () => {
    expect(paths(revisionProblems({ ...base, authorityReference: 'SBG-1' }))).toEqual(['body/authorityReference'])
    expect(paths(revisionProblems({ ...base, authorityToldAt: new Date('2026-06-16T10:00:00Z'), authorityDay: '2026-06-16' }))).toEqual(['body/authorityToldAt'])
    expect(paths(revisionProblems({ ...base, authorityToldAt: new Date('2026-05-30T10:00:00Z'), authorityDay: '2026-05-30' }))).toEqual(['body/authorityToldAt'])
    expect(revisionProblems({ ...base, first: false, note: 'Told through the Safety Business Gateway.', authorityToldAt: new Date('2026-06-05T10:00:00Z'), authorityDay: '2026-06-05', authorityReference: 'SBG-1' })).toEqual([])
  })

  it('a death or serious harm not told is to tell (GPSR art. 20); the rest is logged', () => {
    expect(logStateOf(null)).toMatchObject({ told: false, mustTell: false })
    expect(logStateOf({ outcome: 'SERIOUS_HARM', authorityToldAt: null })).toMatchObject({ told: false, mustTell: true })
    expect(logStateOf({ outcome: 'DEATH', authorityToldAt: new Date('2026-06-05T10:00:00Z') })).toMatchObject({ told: true, mustTell: false })
    expect(logStateOf({ outcome: 'MINOR_HARM', authorityToldAt: null })).toMatchObject({ told: false, mustTell: false })
  })
})

describe('the catalogues', () => {
  it('declares the four permissions; quality is the product-safety role; read-only never reads an injury', () => {
    for (const name of SALES_SAFETY_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    const holds = (key: string) => ROLE_TEMPLATES.find((template) => template.key === key)!.permissions.filter((name) => name.startsWith('sales.safety.'))
    expect(holds('quality_inspector')).toEqual(['sales.safety.injury', 'sales.safety.log', 'sales.safety.manage', 'sales.safety.view'])
    expect(holds('sales')).toEqual(['sales.safety.manage', 'sales.safety.view'])
    expect(holds('production_manager')).toEqual(['sales.safety.view'])
    expect(holds('read_only')).toEqual(['sales.safety.view'])
    expect(holds('owner')).toEqual(['sales.safety.injury', 'sales.safety.log', 'sales.safety.manage', 'sales.safety.view'])
    expect(holds('finance')).toEqual([])
  })

  it('declares its events (ids, numbers, codes; never words or an injury) and the register takes a report as a source', () => {
    const types = EVENT_DEFINITIONS.filter((event) => event.context === 'safety-reports').map((event) => event.type)
    expect(types).toEqual(['safety_report.received', 'safety_report.changed', 'safety_report.status_changed', 'safety_report.filed', 'safety_report.erased', 'accident_log.revised'])
    expect(REGISTER_SOURCE_TYPES).toContain('ProductSafetyReport')
  })

  it('the public photo ticket has one shape', () => {
    expect(PHOTO_TICKET.test(`0190e0a0-0000-7000-8000-000000000001.0190e0a0-0000-7000-8000-000000000002.1781000000.${'a'.repeat(43)}`)).toBe(true)
    expect(PHOTO_TICKET.test('not-a-ticket')).toBe(false)
  })
})
