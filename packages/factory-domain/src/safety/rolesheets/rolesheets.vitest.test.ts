import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { SAFETY_ROLESHEETS_MANAGE } from './permissions'
import {
  changesNothing,
  contentProblems,
  coursesMet,
  DEFAULT_VISIT_MONTHS,
  fingerprintOf,
  holdingKey,
  kitHeld,
  normalCode,
  personImpact,
  ROLE_SHEET_CODE,
  sheetChanges,
  sheetImpact,
  VISIT_NEED_READER,
  type RoleAsks,
  type SheetContent,
} from './rules'

/** Role sheets (B-W2b-128; QHS-236): what a draft changes and what it means for the people in the role. Made-up ids. */

const C = { general: 'c-general', high: 'c-high', medium: 'c-medium' }
const I = { gloves: 'i-gloves', ears: 'i-ears', shoes: 'i-shoes' }
const P = { anna: { employeeId: 'p-anna', name: 'Made-up Anna' }, bruno: { employeeId: 'p-bruno', name: 'Made-up Bruno' }, carla: { employeeId: 'p-carla', name: 'Made-up Carla' } }
const today = '2026-11-03'

const cutter: SheetContent = {
  items: [
    { kind: 'RISK', title: 'Noise at the clicking press' },
    { kind: 'SURVEILLANCE', title: 'Noise exposure' },
  ],
  kit: [
    { ppeItemId: I.gloves, quantity: 2, whenToWear: 'At the cutting table' },
    { ppeItemId: I.shoes, quantity: 1, whenToWear: 'Always on the floor' },
  ],
  requirements: [{ courseId: C.general, withinDays: null }],
}
const asks = (content: SheetContent, needed: boolean | null = null, frequencyMonths: number | null = null): RoleAsks => ({ content, needed, frequencyMonths })

describe('the content of a sheet', () => {
  it('takes one kit line per item and one line per course, numbers in range, and a surveillance need before visits', () => {
    expect(contentProblems(cutter)).toEqual([])
    const doubled: SheetContent = { ...cutter, kit: [...cutter.kit, { ppeItemId: I.gloves, quantity: 1, whenToWear: 'Again' }], requirements: [...cutter.requirements, { courseId: C.general, withinDays: 400 }] }
    expect(contentProblems(doubled).map((problem) => problem.path)).toEqual(['content/kit/2/ppeItemId', 'content/requirements/1/courseId', 'content/requirements/1/withinDays'])
    const quiet: SheetContent = { ...cutter, items: [{ kind: 'RISK', title: 'Manual handling' }] }
    expect(contentProblems(quiet, true).map((problem) => problem.path)).toEqual(['surveillance/needed'])
    expect(contentProblems(quiet, false)).toEqual([])
  })

  it('stores a code in capitals, without spaces', () => {
    expect(normalCode(' cut-a ')).toBe('CUT-A')
    expect(ROLE_SHEET_CODE.test('CUT A')).toBe(false)
    expect(ROLE_SHEET_CODE.test('SEW/B.2')).toBe(true)
  })
})

describe('what a draft changes on the sheet', () => {
  it('names the risks, needs, kit items and courses that come, go or change, and whether the plan changes', () => {
    const next: SheetContent = {
      items: [
        { kind: 'RISK', title: 'noise at the clicking press ' },
        { kind: 'RISK', title: 'Glues and solvents' },
      ],
      kit: [
        { ppeItemId: I.gloves, quantity: 3, whenToWear: 'At the cutting table' },
        { ppeItemId: I.ears, quantity: 1, whenToWear: 'At the clicking press' },
      ],
      requirements: [
        { courseId: C.general, withinDays: 30 },
        { courseId: C.high, withinDays: 60 },
      ],
    }
    const changes = sheetChanges(asks(cutter), next, true)
    expect(changes.risks).toEqual({ added: ['Glues and solvents'], removed: [] })
    expect(changes.surveillanceNeeds).toEqual({ added: [], removed: ['Noise exposure'] })
    expect(changes.kit).toEqual({ added: [I.ears], removed: [I.shoes], changed: [{ ppeItemId: I.gloves, quantity: { from: 2, to: 3 }, whenToWear: null }] })
    expect(changes.courses).toEqual({ added: [C.high], removed: [], changed: [{ courseId: C.general, withinDays: { from: null, to: 30 } }] })
    expect(changes.surveillance).toEqual({ from: null, to: true })
    expect([changes.itemsChanged, changes.kitChanged, changesNothing(changes)]).toEqual([true, true, false])
    // The same content, the plan left alone: nothing to write.
    expect(changesNothing(sheetChanges(asks(cutter, true, 12), { ...cutter, items: cutter.items.map((item) => ({ ...item, title: ` ${item.title} ` })) }))).toBe(true)
    expect(changesNothing(sheetChanges(asks(cutter, true, 12), cutter, true))).toBe(true)
  })
})

describe('what people hold', () => {
  it('holds a course by the newest standing record while it is valid, and PPE units not voided', () => {
    const met = coursesMet(
      [
        { employeeId: P.anna.employeeId, courseId: C.high, validUntil: '2026-11-02' },
        { employeeId: P.anna.employeeId, courseId: C.high, validUntil: '2030-01-01' },
        { employeeId: P.bruno.employeeId, courseId: C.high, validUntil: null },
        { employeeId: P.carla.employeeId, courseId: C.high, validUntil: today },
      ],
      today,
    )
    expect([...met].sort()).toEqual([holdingKey(P.bruno.employeeId, C.high), holdingKey(P.carla.employeeId, C.high)])
    const held = kitHeld([
      { id: 'x1', kind: 'ISSUE', employeeId: P.anna.employeeId, ppeItemId: I.gloves, quantity: 2, voidsId: null },
      { id: 'x2', kind: 'ISSUE', employeeId: P.anna.employeeId, ppeItemId: I.gloves, quantity: 1, voidsId: null },
      { id: 'x3', kind: 'VOID', employeeId: P.anna.employeeId, ppeItemId: I.gloves, quantity: 1, voidsId: 'x2' },
    ])
    expect(held.get(holdingKey(P.anna.employeeId, I.gloves))).toBe(2)
  })
})

describe('what this changes for the people in the role (the design: "3 people now need … · 2 people get … · 4 people get a yearly visit")', () => {
  const people = [P.anna, P.bruno, P.carla]
  const next: SheetContent = { ...cutter, kit: [...cutter.kit, { ppeItemId: I.ears, quantity: 1, whenToWear: 'At the clicking press' }], requirements: [...cutter.requirements, { courseId: C.high, withinDays: 60 }] }

  it('names who now needs which course and which item to issue; visits are counts only', () => {
    const changes = sheetChanges(asks(cutter), next, true)
    const holdings = { met: new Set([holdingKey(P.bruno.employeeId, C.high)]), held: new Map([[holdingKey(P.carla.employeeId, I.ears), 1]]) }
    const lines = sheetImpact(people, asks(cutter), next, changes, holdings)
    expect(lines.map((line) => [line.kind, line.people, line.already])).toEqual([
      ['COURSE_NEEDED', 2, 1],
      ['KIT_TO_ISSUE', 2, 1],
      ['VISITS_NEEDED', 3, 0],
    ])
    expect(lines[0]!.names).toEqual([P.anna, P.carla])
    expect(lines[0]!.withinDays).toEqual({ from: null, to: 60 })
    expect(lines[1]).toMatchObject({ ppeItemId: I.ears, quantity: 1, names: [P.anna, P.bruno] })
    expect(lines[2]).toMatchObject({ names: null, frequencyMonths: DEFAULT_VISIT_MONTHS })
  })

  it('says what goes too: a course no longer asked, an item no longer in the kit, visits no longer needed', () => {
    const lighter: SheetContent = { ...cutter, kit: [cutter.kit[0]!], requirements: [] }
    const lines = sheetImpact(people, asks(cutter, true, 24), lighter, sheetChanges(asks(cutter, true, 24), lighter, false), { met: new Set(), held: new Map() })
    expect(lines.map((line) => [line.kind, line.people, line.names])).toEqual([
      ['COURSE_NOT_NEEDED', 3, null],
      ['KIT_REMOVED', 3, null],
      ['VISITS_NOT_NEEDED', 3, null],
    ])
  })

  it('a fingerprint changes when what is shown changes', () => {
    const changes = sheetChanges(asks(cutter), next)
    const a = sheetImpact(people, asks(cutter), next, changes, { met: new Set(), held: new Map() })
    const b = sheetImpact(people, asks(cutter), next, changes, { met: new Set([holdingKey(P.anna.employeeId, C.high)]), held: new Map() })
    expect(fingerprintOf(a)).toBe(fingerprintOf(sheetImpact(people, asks(cutter), next, changes, { met: new Set(), held: new Map() })))
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b))
  })
})

describe('a role change for one person (the design: courses now needed, kit items to issue, a change-of-task visit)', () => {
  const machinist: SheetContent = { items: [{ kind: 'RISK', title: 'Repetitive movements' }], kit: [{ ppeItemId: I.shoes, quantity: 1, whenToWear: 'Always on the floor' }], requirements: [{ courseId: C.general, withinDays: null }, { courseId: C.medium, withinDays: 30 }] }

  it('lists only what is new for the person, due from today, held or not, and the visit', () => {
    const holdings = { met: new Set([holdingKey(P.anna.employeeId, C.general)]), held: new Map([[holdingKey(P.anna.employeeId, I.gloves), 1]]) }
    const next = { ...cutter, requirements: [...cutter.requirements, { courseId: C.high, withinDays: 60 }] }
    const impact = personImpact(P.anna.employeeId, 'sew', asks(machinist), 'cut', asks(next, true, 12), holdings, today)
    expect(impact.change).toBe('CHANGE')
    expect(impact.courses.needed).toEqual([{ courseId: C.high, withinDays: 60, dueOn: '2027-01-02', held: false }])
    expect(impact.courses.noLonger).toEqual([{ courseId: C.medium }])
    expect(impact.kit.toIssue).toEqual([{ ppeItemId: I.gloves, quantity: 2, whenToWear: 'At the cutting table', held: 1, short: 1 }])
    expect(impact.kit.noLonger).toEqual([])
    expect([impact.visit, impact.frequencyMonths]).toEqual(['CHANGE_OF_TASK', 12])
    // A role whose plan the doctor has not set: ask the doctor; a role without surveillance: none; the same role: nothing.
    expect(personImpact(P.anna.employeeId, 'sew', asks(machinist), 'cut', asks(cutter), holdings, today).visit).toBe('ASK_THE_DOCTOR')
    expect(personImpact(P.anna.employeeId, 'cut', asks(cutter), 'sew', asks(machinist, false), holdings, today).visit).toBe('NONE')
    expect(personImpact(P.anna.employeeId, 'cut', asks(cutter), 'cut', asks(cutter), holdings, today)).toMatchObject({ change: 'NONE', courses: { needed: [] }, visit: 'NONE' })
    expect(personImpact(P.anna.employeeId, null, null, 'cut', asks(cutter, true, 12), holdings, today).courses.needed).toEqual([{ courseId: C.general, withinDays: null, dueOn: today, held: true }])
  })
})

describe('the catalogues', () => {
  it('declares the permission, gives it to the safety officer, and declares the events', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(SAFETY_ROLESHEETS_MANAGE)).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared(VISIT_NEED_READER)).toBe(true)
    const holders = ROLE_TEMPLATES.filter((template) => template.permissions.includes(SAFETY_ROLESHEETS_MANAGE)).map((template) => template.key)
    expect(holders.sort()).toEqual(['owner', 'safety_officer'])
    // The person-level visit is for the health readers only (B-W2b-135: HR and the occupational doctor, and the owner).
    expect(ROLE_TEMPLATES.filter((template) => template.permissions.includes(VISIT_NEED_READER)).map((template) => template.key).sort()).toEqual(['company_doctor', 'hr', 'owner'])
    expect(EVENT_DEFINITIONS.filter((event) => event.context === 'safety-rolesheets').map((event) => event.type)).toEqual(['role_sheet.changed', 'employee.role_changed'])
  })
})
