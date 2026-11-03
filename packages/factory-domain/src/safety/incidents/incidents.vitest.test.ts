import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { SAFETY_INCIDENTS_PERMISSIONS } from './permissions'
import {
  anonymousRefusal,
  certificateRefusal,
  closeRefusal,
  countdownOf,
  dueAtOf,
  fileRefusal,
  filingsToAdd,
  filingStateOf,
  filingTypeFor,
  floorPhotoRefusal,
  INAIL_RULE,
  injuryProblems,
  lockHazardWords,
  personProblems,
  reminderHoursOf,
  reminderPlan,
  reportRefusal,
  whatOf,
} from './rules'

const at = (iso: string) => new Date(iso)
const H = 3_600_000

describe('the INAIL rule (D.Lgs. 81/2008 art. 18 c.1 r)', () => {
  it('asks a statistical communication from one day beyond the event, the insurance report over three days, none before', () => {
    expect(INAIL_RULE).toEqual({ statisticalFromDays: 1, insuranceAboveDays: 3, hoursAfterCertificate: 48 })
    expect(filingTypeFor(0)).toBeNull()
    expect(filingTypeFor(1)).toBe('STATISTICAL')
    expect(filingTypeFor(3)).toBe('STATISTICAL')
    expect(filingTypeFor(4)).toBe('INSURANCE')
  })

  it('adds the insurance report when a statistical one grows past three days, and nothing twice', () => {
    expect(filingsToAdd(2, [])).toEqual(['STATISTICAL'])
    expect(filingsToAdd(2, ['STATISTICAL'])).toEqual([])
    expect(filingsToAdd(5, ['STATISTICAL'])).toEqual(['INSURANCE'])
    expect(filingsToAdd(5, ['STATISTICAL', 'INSURANCE'])).toEqual([])
    expect(filingsToAdd(0, [])).toEqual([])
  })

  it('is due 48 hours after the certificate exactly, OVERDUE once past (shown, never refused)', () => {
    const received = at('2026-11-03T09:00:00.000Z')
    expect(dueAtOf(received).toISOString()).toBe('2026-11-05T09:00:00.000Z')
    expect(filingStateOf({ status: 'DUE', dueAt: dueAtOf(received) }, at('2026-11-05T08:59:00.000Z'))).toBe('DUE')
    expect(filingStateOf({ status: 'DUE', dueAt: dueAtOf(received) }, at('2026-11-05T09:01:00.000Z'))).toBe('OVERDUE')
    expect(filingStateOf({ status: 'FILED', dueAt: dueAtOf(received) }, at('2026-11-06T00:00:00.000Z'))).toBe('FILED')
    expect(filingStateOf({ status: 'WAITING_CERTIFICATE', dueAt: null }, at('2026-11-06T00:00:00.000Z'))).toBe('WAITING_CERTIFICATE')
  })

  it('counts down in minutes and hours, critical under 24 hours, late after', () => {
    const due = at('2026-11-05T09:00:00.000Z')
    expect(countdownOf(due, at('2026-11-04T00:00:00.000Z'))).toMatchObject({ hoursLeft: 33, under24h: false, late: false })
    expect(countdownOf(due, at('2026-11-05T00:30:00.000Z'))).toMatchObject({ hoursLeft: 8, minutesLeft: 510, under24h: true, late: false })
    expect(countdownOf(due, at('2026-11-05T10:30:00.000Z'))).toMatchObject({ hoursLeft: -2, minutesLeft: -90, under24h: false, late: true })
  })
})

describe('the reminders of a DUE filing (never missed under 24 hours)', () => {
  const due = at('2026-11-05T09:00:00.000Z')

  it('sets 24 hours before, 4 hours before and at the deadline', () => {
    const plan = reminderPlan(due, at('2026-11-03T09:00:00.000Z'))
    expect(plan.map((stage) => [stage.timerKey, stage.fireAt.toISOString()])).toEqual([
      ['INAIL_FILING_DUE:-24h', '2026-11-04T09:00:00.000Z'],
      ['INAIL_FILING_DUE:-4h', '2026-11-05T05:00:00.000Z'],
      ['INAIL_FILING_DUE', '2026-11-05T09:00:00.000Z'],
    ])
  })

  it('folds the stages that passed into one that fires at once (a certificate recorded late): never two at the same minute', () => {
    const now = at('2026-11-05T06:00:00.000Z') // 3 hours left: -24h and -4h have passed
    const plan = reminderPlan(due, now)
    expect(plan.map((stage) => [stage.timerKey, stage.fireAt.toISOString()])).toEqual([
      ['INAIL_FILING_DUE:-4h', now.toISOString()],
      ['INAIL_FILING_DUE', '2026-11-05T09:00:00.000Z'],
    ])
    const late = reminderPlan(due, at('2026-11-05T12:00:00.000Z'))
    expect(late.map((stage) => stage.timerKey)).toEqual(['INAIL_FILING_DUE'])
    expect(late[0]!.fireAt.toISOString()).toBe('2026-11-05T12:00:00.000Z')
  })

  it('reads a reminder key back, and nothing else', () => {
    expect(reminderHoursOf('INAIL_FILING_DUE:-24h')).toBe(24)
    expect(reminderHoursOf('INAIL_FILING_DUE:-4h')).toBe(4)
    expect(reminderHoursOf('INAIL_FILING_DUE')).toBe(0)
    expect(reminderHoursOf('INAIL_FILING_DUE:-5h')).toBeNull()
    expect(reminderHoursOf('RESTORE_DRILL_DUE:-14d')).toBeNull()
  })
})

describe('a report', () => {
  const base = { kind: 'HAZARD' as const, anonymous: false, via: 'FLOOR' as const, people: [], where: { stationId: 'x' }, occurredAt: at('2026-11-03T08:00:00Z'), now: at('2026-11-03T09:00:00Z') }

  it('may stay unnamed only as a near miss or a hazard from a tablet, naming nobody, sent at once', () => {
    expect(reportRefusal({ ...base, anonymous: true })).toBeNull()
    expect(reportRefusal({ ...base, anonymous: true, kind: 'INJURY' })?.code).toBe('ANONYMOUS_INJURY')
    expect(reportRefusal({ ...base, anonymous: true, via: 'OFFICE' })?.code).toBe('ANONYMOUS_FROM_OFFICE')
    expect(anonymousRefusal({ ...base, anonymous: true, people: [{}] })?.code).toBe('ANONYMOUS_NAMES_NOBODY')
    expect(anonymousRefusal({ ...base, anonymous: true, queued: true })?.code).toBe('ANONYMOUS_NOT_QUEUED')
    expect(anonymousRefusal({ ...base, queued: true })).toBeNull()
  })

  it('says where, happened at the latest now, injures only in an injury, names a person once', () => {
    expect(reportRefusal({ ...base, where: {} })?.code).toBe('WHERE_MISSING')
    expect(reportRefusal({ ...base, where: { place: '  ' } })?.code).toBe('WHERE_MISSING')
    expect(reportRefusal({ ...base, occurredAt: at('2026-11-03T10:00:00Z') })?.code).toBe('OCCURRED_IN_FUTURE')
    expect(reportRefusal({ ...base, people: [{ involvement: 'INJURED', employeeId: 'e1' }] })?.code).toBe('INJURED_NOT_INJURY')
    expect(reportRefusal({ ...base, kind: 'INJURY', people: [{ involvement: 'INJURED', employeeId: 'e1' }, { involvement: 'INVOLVED', employeeId: 'e1' }] })?.code).toBe('PERSON_TWICE')
    expect(reportRefusal({ ...base, kind: 'INJURY', people: [{ involvement: 'INJURED', employeeId: 'e1' }] })).toBeNull()
  })

  it('stores the tile’s words when nothing was typed', () => {
    expect(whatOf('HAZARD', '', 'en')).toBe('A hazard (reported from a tablet).')
    expect(whatOf('NEAR_MISS', undefined, 'it')).toBe('Un quasi incidente (segnalato da tablet).')
    expect(whatOf('INJURY', ' Cut on the press ', 'en')).toBe('Cut on the press')
  })

  it('checks each person as the guard does: one of the two, parts once, a side with parts, someone involved not hurt', () => {
    expect(personProblems({ involvement: 'INJURED', employeeId: 'e1', bodyParts: ['HAND'], bodySide: 'LEFT', nature: 'CUT' })).toEqual([])
    expect(personProblems({ involvement: 'INJURED', employeeId: 'e1', outsideName: 'A visitor' })[0]?.path).toBe('people/0/employeeId')
    expect(personProblems({ involvement: 'INJURED' })[0]?.path).toBe('people/0/employeeId')
    expect(injuryProblems({ involvement: 'INJURED', bodyParts: ['HAND', 'HAND'] })[0]?.path).toBe('people/0/bodyParts')
    expect(injuryProblems({ involvement: 'INJURED', bodySide: 'LEFT' })[0]?.path).toBe('people/0/bodySide')
    expect(injuryProblems({ involvement: 'INVOLVED', firstAidGiven: true })[0]?.path).toBe('people/0/involvement')
  })
})

describe('closing, the certificate, the filing and the photos', () => {
  it('holds the close while an action is open or a filing waits', () => {
    expect(closeRefusal({ status: 'OPEN', actionsOpen: 0, filingsWaiting: 0 })).toBeNull()
    expect(closeRefusal({ status: 'OPEN', actionsOpen: 1, filingsWaiting: 0 })?.code).toBe('ACTIONS_OPEN')
    expect(closeRefusal({ status: 'OPEN', actionsOpen: 0, filingsWaiting: 1 })?.code).toBe('FILING_WAITING')
    expect(closeRefusal({ status: 'CLOSED', actionsOpen: 0, filingsWaiting: 0 })?.code).toBe('NOT_OPEN')
  })

  it('takes a certificate after the event and at the latest now; a filing after the certificate, with the certificate first', () => {
    const facts = { occurredAt: at('2026-11-02T08:00:00Z'), now: at('2026-11-03T09:00:00Z') }
    expect(certificateRefusal(at('2026-11-03T08:00:00Z'), facts)).toBeNull()
    expect(certificateRefusal(at('2026-11-03T10:00:00Z'), facts)?.code).toBe('CERTIFICATE_IN_FUTURE')
    expect(certificateRefusal(at('2026-11-01T10:00:00Z'), facts)?.code).toBe('CERTIFICATE_BEFORE_EVENT')
    const received = at('2026-11-03T08:00:00Z')
    expect(fileRefusal({ status: 'DUE', certificateReceivedAt: received }, at('2026-11-03T08:30:00Z'), facts.now)).toBeNull()
    expect(fileRefusal({ status: 'WAITING_CERTIFICATE', certificateReceivedAt: null }, at('2026-11-03T08:30:00Z'), facts.now)?.code).toBe('CERTIFICATE_MISSING')
    expect(fileRefusal({ status: 'DUE', certificateReceivedAt: received }, at('2026-11-03T07:00:00Z'), facts.now)?.code).toBe('FILED_BEFORE_CERTIFICATE')
    expect(fileRefusal({ status: 'DUE', certificateReceivedAt: received }, at('2026-11-03T10:00:00Z'), facts.now)?.code).toBe('FILED_IN_FUTURE')
    expect(fileRefusal({ status: 'FILED', certificateReceivedAt: received }, at('2026-11-03T08:30:00Z'), facts.now)?.code).toBe('FILING_FILED')
  })

  it('lets a tablet add up to four photos within 30 minutes of its report', () => {
    const reportedAt = at('2026-11-03T09:00:00Z')
    expect(floorPhotoRefusal({ reportedAt, photos: 3, now: new Date(reportedAt.getTime() + 29 * 60_000) })).toBeNull()
    expect(floorPhotoRefusal({ reportedAt, photos: 4, now: reportedAt })?.code).toBe('PHOTOS_FULL')
    expect(floorPhotoRefusal({ reportedAt, photos: 0, now: new Date(reportedAt.getTime() + 0.6 * H) })?.code).toBe('PHOTO_WINDOW')
  })

  it('words the hazard a machine lock opens in the company’s language', () => {
    expect(lockHazardWords('it', 'PR-01', 'Protezione mancante').what).toBe('Macchina PR-01 bloccata perché non sicura: Protezione mancante.')
    expect(lockHazardWords('en-GB', 'PR-01', null).what).toBe('Machine PR-01 was locked as unsafe.')
  })
})

describe('permissions, templates and events', () => {
  it('declares the four incident permissions, the people one as a write so the read-only role never holds it', () => {
    for (const name of SAFETY_INCIDENTS_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name), name).toBe(true)
    expect(FACTORY_PERMISSIONS.get('safety.incidents.view')?.risk).toBe('read')
    expect(FACTORY_PERMISSIONS.get('safety.incidents.people')?.risk).toBe('write')
    expect(templateOf('read_only')!.permissions).toContain('safety.incidents.view')
    expect(templateOf('read_only')!.permissions).not.toContain('safety.incidents.people')
  })

  it('gives the safety officer everything, HR the people and filings, the plant roles the anonymised view and the report; the doctor none', () => {
    expect(templateOf('safety_officer')!.permissions).toEqual(expect.arrayContaining(['safety.incidents.view', 'safety.incidents.report', 'safety.incidents.manage', 'safety.incidents.people']))
    expect(templateOf('hr')!.permissions).toEqual(expect.arrayContaining(['safety.incidents.view', 'safety.incidents.report', 'safety.incidents.people']))
    expect(templateOf('hr')!.permissions).not.toContain('safety.incidents.manage')
    for (const key of ['production_manager', 'maintenance', 'floor_supervisor']) {
      expect(templateOf(key)!.permissions, key).toEqual(expect.arrayContaining(['safety.incidents.view', 'safety.incidents.report']))
      expect(templateOf(key)!.permissions, key).not.toContain('safety.incidents.people')
    }
    expect(templateOf('company_doctor')!.permissions.filter((name) => name.startsWith('safety.incidents.'))).toEqual([])
    for (const key of ['operator', 'cutting_operator', 'floor_inspector', 'team_leader', 'technician']) expect(templateOf(key)!.permissions.filter((name) => name.startsWith('safety.')), key).toEqual([])
  })

  it('declares the incident events; only "seen" reaches the tablets, and none carries a person', () => {
    const types = EVENT_DEFINITIONS.filter((event) => ['incident.reported', 'incident.changed', 'incident.seen', 'incident_action.changed', 'inail_filing.changed'].includes(event.type))
    expect(types).toHaveLength(5)
    expect(types.filter((event) => event.live?.floor).map((event) => event.type)).toEqual(['incident.seen'])
    for (const event of types) expect(Object.keys((event.payload as unknown as { shape: Record<string, unknown> }).shape).filter((key) => /person|employee|worker|name|type$/i.test(key)), event.type).toEqual([])
  })
})
