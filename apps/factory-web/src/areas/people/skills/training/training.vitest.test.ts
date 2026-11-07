import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as RECORDS from '@nexus/factory-domain/safety/records/rules'
import * as TRAINING from '@nexus/factory-domain/safety/training/rules'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as safetyScreen } from '../../employees/record/safety/fixtures'
import { designScreen as personScreen } from '../record/training/fixtures'
import { designScreen as certificateScreen } from './certificate/fixtures'
import { designScreen as dueScreen } from './due/fixtures'
import { designScreen as trainingScreen } from './fixtures'
import type { Course } from './api'
import * as C from './constants'
import { DEMO_COURSES, DEMO_PERSON_TRAINING, DEMO_REQUIREMENTS } from './_demo'
import {
  archiveHeld,
  classBody,
  classLinesHeld,
  closeHeld,
  courseChanges,
  courseDraftOf,
  courseHeld,
  dueValueOf,
  emptyCourseDraft,
  emptyInstructionDraft,
  emptyRecordDraft,
  entryState,
  expiryOf,
  hoursIn,
  impactWords,
  instructionBody,
  instructionHeld,
  languageWarning,
  lensOf,
  needRowsOf,
  newCourseBody,
  recordBody,
  recordHeld,
  readProblemOf,
  recordPerson,
  standardBody,
  standardHeld,
  standardRowsOf,
  trainingAddressOf,
  trainingAddressText,
  trainingCan,
  trainingProblem,
} from './model'
import { trainingRowsOf } from '../record/training/view/EmployeeTrainingView'

const TODAY = '2026-11-02'
const course: Course = DEMO_COURSES[2]!
const refusal = (code: string) => new ApiError('conflict', 409, 'conflict', 'Refused', null, [{ path: `refusal/${code}`, message: 'x' }])

describe('the lists kept in the web equal the domain’s (the domain files reach node:crypto)', () => {
  it('holds every list and bound the API checks', () => {
    expect(C.COURSE_TYPES).toEqual(TRAINING.COURSE_TYPES)
    expect(C.COURSE_STATUSES).toEqual(TRAINING.COURSE_STATUSES)
    expect(C.COURSE_FIELDS).toEqual(TRAINING.COURSE_FIELDS)
    expect(C.NEED_STATES).toEqual(TRAINING.NEED_STATES)
    expect(C.TRAINING_REFUSALS).toEqual(TRAINING.TRAINING_REFUSALS)
    expect(C.DUE_STATES).toEqual(RECORDS.DUE_STATES)
    expect(C.DUE_VIEWS).toEqual(RECORDS.DUE_VIEWS)
    expect(C.RECORD_RESULTS).toEqual(RECORDS.RECORD_RESULTS)
    expect(C.SESSION_STATUSES).toEqual(RECORDS.SESSION_STATUSES)
    expect(C.SIGN_METHODS).toEqual(RECORDS.SIGN_METHODS)
    expect(C.VALIDITY_STATES).toEqual(RECORDS.VALIDITY_STATES)
    expect(C.RECORDS_REFUSAL_CODES).toEqual(RECORDS.RECORDS_REFUSAL_CODES)
    expect(C.COURSE_CODE.source).toBe(TRAINING.COURSE_CODE.source)
    expect(C.HOURS.source).toBe(TRAINING.HOURS.source)
    expect(C.LANGUAGE.source).toBe(RECORDS.LANGUAGE.source)
    expect(C.LAWS).toMatchObject({ training: TRAINING.TRAINING_LAW, language: RECORDS.LANGUAGE_LAW, instruction: RECORDS.INSTRUCTION_LAW, machines: TRAINING.MACHINE_TRAINING_LAW })
    expect(C.LIMITS).toMatchObject({ code: TRAINING.TRAINING_LIMITS.code, name: TRAINING.TRAINING_LIMITS.name, courseHours: TRAINING.TRAINING_LIMITS.hours, refresherMonths: TRAINING.TRAINING_LIMITS.refresherMonths, withinDays: TRAINING.TRAINING_LIMITS.withinDays, requirements: TRAINING.TRAINING_LIMITS.requirements, standard: TRAINING.TRAINING_LIMITS.standard, people: RECORDS.RECORD_LIMITS.people, minutes: RECORDS.RECORD_LIMITS.minutes, soonDays: RECORDS.RECORD_LIMITS.soonDays, reason: RECORDS.RECORD_LIMITS.reason })
  })
})

describe('rights and the lens in the address', () => {
  it('opens the matrix with people.skills.view and the registers with safety.view', () => {
    const safety = trainingCan(['safety.view', 'safety.training.manage'])
    expect(lensOf(null, safety)).toBe('courses')
    expect(lensOf('matrix', safety)).toBe('courses')
    const hr = trainingCan(['safety.view', 'people.skills.view', 'safety.training.record'])
    expect(lensOf(null, hr)).toBe('matrix')
    expect(lensOf('instruction', hr)).toBe('instruction')
    expect(lensOf('needs', trainingCan(['people.skills.view']))).toBe('matrix')
  })

  it('keeps the matrix terms and leaves the defaults out', () => {
    const can = trainingCan(['safety.view', 'people.skills.view'])
    const address = trainingAddressOf(new URLSearchParams('view=courses&status=all&tq=fire&tile=TRAINEES&course=c1'), can)
    expect(address).toMatchObject({ lens: 'courses', status: 'all', q: 'fire', course: 'c1' })
    expect(trainingAddressText({ ...address, course: null }, new URLSearchParams('tile=TRAINEES&view=courses'), 'matrix')).toBe('?tile=TRAINEES&view=courses&status=all&tq=fire')
    expect(trainingAddressText({ ...address, lens: 'matrix', status: 'ACTIVE', course: null, q: '' }, null, 'matrix')).toBe('')
    expect(trainingAddressOf(new URLSearchParams('need=evil<script>'), can).need).toBeNull()
  })
})

describe('a course: hours typed, only what changed sent, archive held while it is asked', () => {
  it('reads hours as typed and never above the database bound', () => {
    expect(hoursIn('12,5')).toBe('12.5')
    expect(hoursIn('0')).toBeNull()
    expect(hoursIn('201')).toBeNull()
    expect(hoursIn('1.234')).toBeNull()
  })

  it('holds Add until code, name and hours are there', () => {
    expect(courseHeld(emptyCourseDraft(), true)).toBe('held.code')
    expect(courseHeld({ ...emptyCourseDraft(), code: 'bad code' }, true)).toBe('held.codeShape')
    expect(courseHeld({ ...emptyCourseDraft(), code: 'FIRE-1', nameIt: 'Antincendio' }, true)).toBe('held.hours')
    expect(courseHeld({ ...emptyCourseDraft(), code: 'FIRE-1', nameIt: 'Antincendio', hours: '4', refresherMonths: '200' }, true)).toBe('held.refresher')
    expect(courseHeld({ ...emptyCourseDraft(), code: 'FIRE-1', nameIt: 'Antincendio', hours: '4', refresherMonths: '60' }, true)).toBeNull()
  })

  it('sends a new course in capitals with its names and leaves the law to the type when none is typed', () => {
    const body = newCourseBody({ ...emptyCourseDraft('FIRE'), code: 'fire-1', nameIt: 'Antincendio', nameEn: 'Fire', hours: '4,5', refresherMonths: '' })
    expect(body).toEqual({ code: 'FIRE-1', type: 'FIRE', name: 'Antincendio', nameI18n: { it: 'Antincendio', en: 'Fire' }, hours: '4.5', refresherMonths: null, refresherHours: null, inPersonRequired: false, provider: null })
  })

  it('sends only the fields that changed ("8" = "8.00")', () => {
    const draft = courseDraftOf(course)
    expect(courseChanges(course, draft)).toEqual({})
    expect(courseChanges(course, { ...draft, hours: '8.00', refresherMonths: '36' })).toEqual({ refresherMonths: 36 })
    expect(courseChanges(course, { ...draft, refresherMonths: '' })).toEqual({ refresherMonths: null })
    expect(courseChanges(course, { ...draft, provider: '' })).toEqual({ provider: null })
  })

  it('holds Archive while a role sheet or a machine type asks it', () => {
    expect(archiveHeld({ ...course, requiredBy: { roleSheets: 1, machineClasses: 0 } })).toBe('held.archiveAsked')
    expect(archiveHeld({ ...course, requiredBy: { roleSheets: 0, machineClasses: 0 } })).toBeNull()
    expect(archiveHeld({ ...course, canManage: false })).toBe('held.manage')
  })

  it('reviews the standard list: hours typed for each course taken, never a number of the law', () => {
    const rows = standardRowsOf([
      { code: 'GEN', type: 'GENERAL', name: 'G', nameI18n: { it: 'Generale', en: 'General' }, legalBasis: 'art. 37', codeTaken: false, existing: [] },
      { code: 'PRE', type: 'SUPERVISOR', name: 'P', nameI18n: { it: 'Preposto', en: 'Supervisor' }, legalBasis: 'art. 37 c.7', codeTaken: true, existing: [] },
    ])
    expect(rows.map((row) => [row.take, row.hours])).toEqual([[true, ''], [false, '']])
    expect(standardHeld(rows)).toBe('held.standardHours')
    const typed = rows.map((row) => ({ ...row, hours: '4' }))
    expect(standardHeld(typed)).toBeNull()
    expect(standardBody(typed)).toEqual([{ code: 'GEN', type: 'GENERAL', name: 'Generale', nameI18n: { it: 'Generale', en: 'General' }, hours: '4', refresherMonths: null, legalBasis: 'art. 37' }])
  })
})

describe('who needs what', () => {
  it('counts person × course per role and machine type, never a name', () => {
    const rows = needRowsOf(DEMO_REQUIREMENTS, 'en')
    expect(rows.map((row) => [row.id.split(':')[0], row.label, row.met, row.due, row.overdue])).toEqual([
      ['role', 'Team leader', 4, 1, 1],
      ['role', 'Cutter', 6, 1, 1],
      ['class', 'Clicking press', 1, 0, 1],
    ])
    expect(JSON.stringify(rows)).not.toContain('Esempio')
  })

  it('holds a machine type’s lines with a course twice or days out of bounds', () => {
    expect(classLinesHeld([{ courseId: 'a', withinDays: '', note: '' }, { courseId: 'a', withinDays: '3', note: '' }])).toBe('held.lineTwice')
    expect(classLinesHeld([{ courseId: 'a', withinDays: '400', note: '' }])).toBe('held.lineDays')
    expect(classBody([{ courseId: 'a', withinDays: '', note: ' ' }, { courseId: 'b', withinDays: '30', note: 'x' }])).toEqual([{ courseId: 'a', withinDays: null, note: null }, { courseId: 'b', withinDays: 30, note: 'x' }])
    expect(impactWords({ kind: 'COURSE_DEADLINE', people: 2, already: 0, withinDays: { from: 60, to: null } }).key).toBe('impact.deadlineBefore')
  })
})

describe('Record training', () => {
  const people = [recordPerson({ employeeId: 'p1', name: 'A', companyId: 'c' }), recordPerson({ employeeId: 'p2', name: 'B', companyId: 'c' })]
  const draft = { ...emptyRecordDraft(TODAY, people, course.id), completedOn: '2026-10-30', hours: '8', trainerName: 'Ente' }

  it('dates the expiry from the refresher period (the month’s last day when the day does not exist)', () => {
    expect(expiryOf('2026-10-30', 24)).toBe('2028-10-30')
    expect(expiryOf('2026-01-31', 1)).toBe('2026-02-28')
    expect(expiryOf('2026-10-30', null)).toBeNull()
  })

  it('holds until the course, the day (not later than today), the trainer and the people are there', () => {
    expect(recordHeld({ ...draft, courseId: null }, null, TODAY)).toBe('held.course')
    expect(recordHeld({ ...draft, completedOn: '2026-11-03' }, course, TODAY)).toBe('held.dateFuture')
    expect(recordHeld({ ...draft, trainerName: ' ' }, course, TODAY)).toBe('held.trainer')
    expect(recordHeld({ ...draft, people: [] }, course, TODAY)).toBe('held.people')
    expect(recordHeld(draft, course, TODAY)).toBeNull()
  })

  it('asks the reason only for another valid-until than the period gives, and sends it only then', () => {
    const other = { ...draft, people: [{ ...people[0]!, validUntil: '2027-06-30' }, people[1]!] }
    expect(recordHeld(other, course, TODAY)).toBe('held.untilReason')
    const reasoned = { ...other, people: [{ ...other.people[0]!, validUntilReason: 'Attestato con scadenza propria' }, people[1]!] }
    expect(recordHeld(reasoned, course, TODAY)).toBeNull()
    expect(recordBody(reasoned, course).people).toEqual([
      { employeeId: 'p1', result: 'PASSED', languageChecked: true, validUntil: '2027-06-30', validUntilReason: 'Attestato con scadenza propria' },
      { employeeId: 'p2', result: 'PASSED', languageChecked: true },
    ])
    const same = { ...draft, people: [{ ...people[0]!, validUntil: '2028-10-30' }] }
    expect(recordHeld(same, course, TODAY)).toBeNull()
    expect(recordBody(same, course).people[0]).not.toHaveProperty('validUntil')
  })

  it('warns when someone passed without the language understood (art. 37 c.13)', () => {
    expect(languageWarning([{ result: 'PASSED', languageChecked: false }])).toBe(true)
    expect(languageWarning([{ result: 'FAILED', languageChecked: false }])).toBe(false)
  })

  it('closes a session only once every attendance is countersigned or voided and someone is', () => {
    const session = { heldOn: '2026-10-30', counts: { signed: 2, countersigned: 1, voided: 0 } }
    const signed = { countersign: { at: 'x' }, voided: null, recordId: null }
    expect(closeHeld(session, [signed, { countersign: null, voided: null, recordId: null }], TODAY)).toBe('held.notCountersigned')
    expect(closeHeld(session, [{ countersign: null, voided: { at: 'x' }, recordId: null }], TODAY)).toBe('held.noAttendance')
    expect(closeHeld({ ...session, heldOn: '2026-11-05' }, [signed], TODAY)).toBe('held.sessionLater')
    expect(closeHeld(session, [signed], TODAY)).toBeNull()
  })
})

describe('the instruction register', () => {
  it('holds an entry without a person, a task, minutes, or with the person as their own instructor', () => {
    const draft = { ...emptyInstructionDraft(TODAY, 'p1'), task: 'Pressa', minutes: '45', instructorName: 'Giulia' }
    expect(instructionHeld({ ...draft, employeeId: null }, TODAY)).toBe('held.person')
    expect(instructionHeld({ ...draft, minutes: '0' }, TODAY)).toBe('held.minutes')
    expect(instructionHeld({ ...draft, instructorEmployeeId: 'p1' }, TODAY)).toBe('held.instructorSelf')
    expect(instructionHeld(draft, TODAY)).toBeNull()
    expect(instructionBody({ ...draft, signs: 'paper' })).toMatchObject({ employeeId: 'p1', task: 'Pressa', minutes: 45, instructorName: 'Giulia', paper: true })
    expect(instructionBody(draft)).not.toHaveProperty('paper')
  })

  it('says how an entry was signed', () => {
    expect(entryState({ signed: null, voided: null })).toBe('waiting')
    expect(entryState({ signed: { at: 'x', method: 'FLOOR_PIN', verifiable: true }, voided: null })).toBe('pin')
    expect(entryState({ signed: null, voided: { at: 'x', reason: 'r', by: null } })).toBe('voided')
  })
})

describe('a DueCell and the person’s rows', () => {
  it('draws Needed, overdue past its day, valid until, done without expiry', () => {
    expect(dueValueOf({ state: 'NEEDED', overdue: false, neededBy: '2026-12-01', dueOn: null, record: null })).toEqual({ state: 'needed' })
    expect(dueValueOf({ state: 'NEEDED', overdue: true, neededBy: '2026-10-01', dueOn: null, record: null })).toEqual({ due: '2026-10-01' })
    expect(dueValueOf({ state: 'VALID', overdue: false, neededBy: null, dueOn: null, record: { id: 'r', completedOn: '2026-01-01', validUntil: '2028-01-01', languageChecked: true } })).toEqual({ due: '2028-01-01' })
    expect(dueValueOf({ state: 'VALID', overdue: false, neededBy: null, dueOn: null, record: { id: 'r', completedOn: '2026-01-01', validUntil: null, languageChecked: true } })).toEqual({ state: 'done', doneOn: '2026-01-01' })
  })

  it('lists the standing records newest first, then the Needed rows', () => {
    const rows = trainingRowsOf(DEMO_PERSON_TRAINING, 'en')
    expect(rows.map((row) => [row.result ?? 'NEEDED', row.course])).toEqual([
      ['PASSED', 'General training (example)'],
      ['PASSED', 'Supervisor (example)'],
      ['NEEDED', 'Specific training, high risk (example)'],
    ])
  })
})

describe('refusals in words', () => {
  it('names a refusal by its code, a field by its name, else the kind', () => {
    expect(trainingProblem(refusal('COURSE_REQUIRED'))).toEqual({ key: 'refusal.COURSE_REQUIRED' })
    expect(trainingProblem(refusal('LANGUAGE_NOT_UNDERSTOOD'))).toEqual({ key: 'refusal.LANGUAGE_NOT_UNDERSTOOD' })
    expect(trainingProblem(new ApiError('invalid', 400, 'invalid', 'Bad', null, [{ path: 'body/people/0/validUntil', message: 'x' }]))).toEqual({ key: 'field.people' })
    expect(trainingProblem(new ApiError('forbidden', 403, 'forbidden', 'No'))).toEqual({ key: 'problem.forbidden' })
    expect(trainingProblem(new Error('x'))).toEqual({ key: 'problem.unavailable' })
    expect(readProblemOf(new ApiError('invalid', 400, 'validation_failed', 'Bad', null, [{ path: 'company/vatNumber', message: 'x' }]))).toBe('problem.companyLegal')
    expect(readProblemOf(new ApiError('forbidden', 403, 'forbidden', 'No'))).toBe('problem.forbidden')
  })
})

const LEFT_KEY = /(?:^|[>\s"])(?:access|band|lens|privacy|keys|list|column|cell|due|type|status|result|sign|common|courses|course|review|field|standard|needs|need|classCourses|impact|entries|entry|record|held|done|problem|refusal|law|pdf|certificate|employee|safety|ppe|fitness|tile|tileHint|show)\.[a-zA-Z_]+/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/

/** Permission names said in a held reason ("needs safety.training.record") are words, not keys left on screen. */
const PERMISSIONS = /\b(?:safety\.(?:view|training\.manage|training\.record|instruction\.record|ppe\.issue|health\.view)|files\.upload|people\.(?:view|skills\.view))\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderHtml(View, model, locale).replace(PERMISSIONS, 'PERMISSION')
}

function renderHtml(View: ComponentType<{ model: unknown }>, model: unknown, locale: (typeof LOCALES)[number]): string {
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'people', 'people-skills', 'people-training', 'ds-words']) }, createElement(View, { model })))
}

describe('every design case of B-W2b-146 draws in both languages with no key or placeholder left on screen', () => {
  for (const screen of [trainingScreen, certificateScreen, dueScreen, personScreen, safetyScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale)
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the health values never reach a case where the person has no right to them', () => {
    const restricted = safetyScreen.cases.find((item) => item.id === 'production')!
    for (const locale of LOCALES) {
      const html = render(safetyScreen as unknown as DesignScreen<unknown>, restricted.model, locale)
      expect(html).not.toMatch(/Non sollevare|Idoneo con|Fit with limits/)
    }
  })
})
