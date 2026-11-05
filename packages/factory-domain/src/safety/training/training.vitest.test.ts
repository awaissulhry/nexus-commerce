import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { holdingKey, sheetChanges, sheetImpact } from '../rolesheets/rules'
import { SAFETY_TRAINING_MANAGE } from './permissions'
import {
  classAsks,
  classRequirementProblems,
  COURSE_CODE,
  COURSE_TYPE_LAW,
  COURSE_TYPES,
  courseChanges,
  courseProblems,
  countNeeds,
  dueOf,
  needsOf,
  refresherImpact,
  STANDARD_COURSES,
  type CourseFields,
} from './rules'

/** The course catalogue and who needs which course (B-W2b-133; QHS-241, QHS-242). Made-up ids and people. */

const today = '2026-11-04'
const C = { general: 'c-general', high: 'c-high', forklift: 'c-forklift' }
const P = { anna: 'p-anna', bruno: 'p-bruno', carla: 'p-carla', dario: 'p-dario' }
const course: CourseFields = { name: 'Made-up course', nameI18n: null, hours: '8', refresherMonths: 60, refresherHours: '6', inPersonRequired: false, provider: null, legalBasis: 'D.Lgs. 81/2008 art. 37', sortOrder: 1 }

describe('the standard list (design people.skills "Start from the standard list")', () => {
  it('names every type of the law once, with the law each rests on, and never a number of hours or months', () => {
    expect(STANDARD_COURSES.map((entry) => entry.type)).toEqual(COURSE_TYPES.filter((type) => type !== 'OTHER'))
    for (const entry of STANDARD_COURSES) {
      expect(COURSE_CODE.test(entry.code)).toBe(true)
      expect(entry.legalBasis).toBe(COURSE_TYPE_LAW[entry.type])
      expect(entry.nameI18n.it.trim()).not.toBe('')
      expect(entry.nameI18n.en).toBe(entry.name)
      // The plan gives none of the agreement's numbers: the person types them (no hours, no refresher in the list).
      expect(Object.keys(entry).sort()).toEqual(['code', 'legalBasis', 'name', 'nameI18n', 'type'])
      expect(entry.legalBasis).not.toMatch(/\b\d+\s*(?:h|ore|hours|mesi|months|anni|years)\b/i)
    }
  })
})

describe('a course (QHS-241: duration and refresher as settings)', () => {
  it('checks only the database bounds: hours above 0 and at most 200, a refresher of 1 to 120 months, its hours only with it, the law', () => {
    expect(courseProblems(course)).toEqual([])
    expect(courseProblems({ ...course, hours: '0' }).map((problem) => problem.path)).toEqual(['hours'])
    expect(courseProblems({ ...course, hours: '200.5' }).map((problem) => problem.path)).toEqual(['hours'])
    expect(courseProblems({ ...course, hours: '4.125' }).map((problem) => problem.path)).toEqual(['hours'])
    expect(courseProblems({ ...course, refresherMonths: 121 }).map((problem) => problem.path)).toEqual(['refresherMonths'])
    expect(courseProblems({ ...course, refresherMonths: null }).map((problem) => problem.path)).toEqual(['refresherHours'])
    expect(courseProblems({ ...course, refresherMonths: null, refresherHours: null })).toEqual([])
    expect(courseProblems({ ...course, legalBasis: '  ', name: '' }, 'courses/2/').map((problem) => problem.path)).toEqual(['courses/2/name', 'courses/2/legalBasis'])
  })

  it('says what a draft changes: "12.50" hours are 12.5, an empty provider is none, the refresher from → to', () => {
    expect(courseChanges(course, { ...course, hours: '8.00', provider: '  ' })).toEqual([])
    expect(courseChanges(course, { ...course, hours: '12.50', refresherMonths: 24, inPersonRequired: true })).toEqual([
      { field: 'hours', from: '8', to: '12.5' },
      { field: 'refresherMonths', from: 60, to: 24 },
      { field: 'inPersonRequired', from: false, to: true },
    ])
    // No refresher period takes its hours away.
    expect(courseChanges(course, { ...course, refresherMonths: null, refresherHours: '6' })).toEqual([
      { field: 'refresherMonths', from: 60, to: null },
      { field: 'refresherHours', from: '6', to: null },
    ])
  })

  it('a new refresher period moves no date on record: it says whose date would differ, and leaves dates set otherwise alone', () => {
    const holdings = [
      { employeeId: P.anna, name: 'Made-up Anna', completedOn: '2024-01-31', validUntil: '2029-01-31' },
      { employeeId: P.bruno, name: 'Made-up Bruno', completedOn: '2025-03-10', validUntil: '2030-03-10' },
      // A date with a reason (one year): no period touches it.
      { employeeId: P.carla, name: 'Made-up Carla', completedOn: '2026-01-15', validUntil: '2027-01-15' },
    ]
    const shorter = refresherImpact(holdings, 60, 24)
    expect(shorter).toMatchObject({ from: 60, to: 24, holders: 3, followPeriod: 2, wouldMove: 2, ownDate: 1 })
    expect(shorter.people).toEqual([
      { employeeId: P.anna, name: 'Made-up Anna', completedOn: '2024-01-31', validUntil: '2029-01-31', withNewPeriod: '2026-01-31' },
      { employeeId: P.bruno, name: 'Made-up Bruno', completedOn: '2025-03-10', validUntil: '2030-03-10', withNewPeriod: '2027-03-10' },
    ])
    // No refresher any more: their records would have no expiry.
    expect(refresherImpact(holdings, 60, null).people.map((person) => person.withNewPeriod)).toEqual([null, null])
    // A period added where there was none: records without expiry follow "none".
    expect(refresherImpact([{ employeeId: P.dario, name: 'Made-up Dario', completedOn: '2025-06-30', validUntil: null }], null, 36)).toMatchObject({ followPeriod: 1, wouldMove: 1, people: [{ withNewPeriod: '2028-06-30' }] })
  })
})

describe('who needs what (QHS-242: from role sheets and machine types, never typed per person)', () => {
  const inputs = {
    people: [
      { employeeId: P.anna, roleSheetId: 'role-cut', roleSince: '2026-10-01' },
      { employeeId: P.bruno, roleSheetId: 'role-cut', roleSince: '2026-09-01' },
      { employeeId: P.carla, roleSheetId: null, roleSince: null },
      { employeeId: P.dario, roleSheetId: null, roleSince: null },
    ],
    roleRequirements: new Map([
      [
        'role-cut',
        [
          { courseId: C.general, withinDays: null },
          { courseId: C.high, withinDays: 60 },
        ],
      ],
    ]),
    authorisations: [
      { employeeId: P.anna, machineClassId: 'class-press', authorisedOn: '2026-10-20' },
      { employeeId: P.carla, machineClassId: 'class-press', authorisedOn: '2026-11-10' },
      { employeeId: P.carla, machineClassId: 'class-press', authorisedOn: '2026-12-01' },
      { employeeId: 'p-unknown', machineClassId: 'class-press', authorisedOn: '2026-01-01' },
      { employeeId: P.dario, machineClassId: 'class-forklift', authorisedOn: '2026-06-01' },
    ],
    classRequirements: new Map([
      ['class-press', [{ courseId: C.high, withinDays: null }]],
      ['class-forklift', [{ courseId: C.forklift, withinDays: 30 }]],
    ]),
    met: new Set([holdingKey(P.bruno, C.general), holdingKey(P.dario, C.forklift)]),
    today,
  }

  it('due = the day they took the role or the authorisation starts + its days (none: before starting); the earliest source decides', () => {
    expect(dueOf('2026-10-01', null)).toBe('2026-10-01')
    expect(dueOf('2026-10-01', 60)).toBe('2026-11-30')
    const needs = needsOf(inputs)
    const of = (employeeId: string) => needs.filter((need) => need.employeeId === employeeId).map((need) => [need.courseId, need.dueOn, need.state, need.sources.map((source) => `${source.kind}:${source.state}`)])
    // Anna: general before starting (overdue since she took the role); specific-high from the role in 60 days AND from the press before
    // starting → the press's day decides, overdue; from the role alone it is still due.
    expect(of(P.anna)).toEqual([
      [C.general, '2026-10-01', 'OVERDUE', ['ROLE_SHEET:OVERDUE']],
      [C.high, '2026-10-20', 'OVERDUE', ['MACHINE_CLASS:OVERDUE', 'ROLE_SHEET:DUE']],
    ])
    // Bruno holds the general course; specific-high due 60 days after he took the role.
    expect(of(P.bruno)).toEqual([
      [C.general, '2026-09-01', 'MET', ['ROLE_SHEET:MET']],
      [C.high, '2026-10-31', 'OVERDUE', ['ROLE_SHEET:OVERDUE']],
    ])
    // Carla has no role: the press authorisation that starts later asks the course before it (the earliest one counts).
    expect(of(P.carla)).toEqual([[C.high, '2026-11-10', 'DUE', ['MACHINE_CLASS:DUE']]])
    // Dario holds the forklift course; a person no list names is ignored.
    expect(of(P.dario)).toEqual([[C.forklift, '2026-07-01', 'MET', ['MACHINE_CLASS:MET']]])
    expect(needs.some((need) => need.employeeId === 'p-unknown')).toBe(false)
    expect(countNeeds(needs)).toEqual({ people: 6, met: 2, due: 1, overdue: 3 })
  })

  it('a person with neither a role sheet nor an authorisation needs nothing', () => {
    expect(needsOf({ ...inputs, people: [{ employeeId: 'p-nobody', roleSheetId: null, roleSince: null }], authorisations: [] })).toEqual([])
  })
})

describe('the courses a type of machine asks', () => {
  it('one line per course, the days in range', () => {
    expect(classRequirementProblems([{ courseId: C.high, withinDays: null }])).toEqual([])
    expect(
      classRequirementProblems([
        { courseId: C.high, withinDays: 400 },
        { courseId: C.high, withinDays: 10 },
      ]).map((problem) => problem.path),
    ).toEqual(['requirements/0/withinDays', 'requirements/1/courseId'])
  })

  it('says what a change means for the people authorised on it, with the role sheets’ own diff and impact', () => {
    const before = classAsks([{ courseId: C.general, withinDays: null }])
    const after = classAsks([
      { courseId: C.general, withinDays: 10, note: '  ' },
      { courseId: C.high, withinDays: null, note: 'Before working at the press.' },
    ])
    const changes = sheetChanges(before, after.content)
    expect(changes.courses).toEqual({ added: [C.high], removed: [], changed: [{ courseId: C.general, withinDays: { from: null, to: 10 } }] })
    expect([changes.itemsChanged, changes.kitChanged, changes.surveillance]).toEqual([false, false, null])
    const people = [
      { employeeId: P.anna, name: 'Made-up Anna' },
      { employeeId: P.bruno, name: 'Made-up Bruno' },
    ]
    const lines = sheetImpact(people, before, after.content, changes, { met: new Set([holdingKey(P.bruno, C.high)]), held: new Map() })
    expect(lines.map((line) => [line.kind, line.courseId, line.people, line.already, line.names?.map((person) => person.name)])).toEqual([
      ['COURSE_NEEDED', C.high, 1, 1, ['Made-up Anna']],
      ['COURSE_DEADLINE', C.general, 2, 0, ['Made-up Anna', 'Made-up Bruno']],
    ])
  })
})

describe('the catalogues', () => {
  it('declares the write permission, gives it to the safety officer (read_only never), and declares the events', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(SAFETY_TRAINING_MANAGE)).toBe(true)
    expect(FACTORY_PERMISSIONS.get(SAFETY_TRAINING_MANAGE)?.risk).toBe('write')
    expect(ROLE_TEMPLATES.filter((template) => template.permissions.includes(SAFETY_TRAINING_MANAGE)).map((template) => template.key).sort()).toEqual(['owner', 'safety_officer'])
    const events = EVENT_DEFINITIONS.filter((event) => event.context === 'safety-training')
    expect(events.map((event) => event.type)).toEqual(['safety_course.changed', 'training_requirement.changed'])
    for (const event of events) expect(event.live).toMatchObject({ permission: 'safety.view' })
  })
})
