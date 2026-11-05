import { createHash } from 'node:crypto'
import type { Issue } from '../../core/errors'
import type { Permission } from '../../core/permissions'
import type { BusinessDate } from '../../core/time'
import { addDays } from '../calendar/rules'

/**
 * The role risk sheets, the scheda mansione (B-W2b-128; QHS-236 "Role risk sheet"; design plant.risk "Role sheets", the
 * record's Role sheets tab and the pop-up "What this changes"; Owner answer H2: 6 to 10 roles typed with the safety officer
 * in one afternoon), pure. The tables are factory-db safety.prisma's RoleSheet, RoleSheetItem (risks and surveillance needs,
 * in words), PpeKitLine (the role's PPE kit) and TrainingRequirement (source ROLE_SHEET: the courses the role asks), and
 * health.prisma's HealthPlan (one per role: whether the role needs health surveillance, how often: the doctor's frequency);
 * their guards hold the same shape for every login.
 *
 * The sheet is the one place a role's needs are typed: who needs which course, which kit items and which visits is read
 * from the person's sheet (Employee.roleSheetId), never typed per person. Apply first says what it changes for the people
 * in the role ("3 people now need Specific training (high risk) · 2 people get hearing protection in their kit · 4 people
 * get a yearly visit"); a person's role change says the same for one person (courses now needed, kit items to issue, a
 * change-of-task visit). Visits are counts on a sheet; which person needs which visit is protected (see VISIT_NEED_READER).
 */

export const ROLE_SHEET_LAW = 'D.Lgs. 81/2008 art. 28'
export const KIT_LAW = 'D.Lgs. 81/2008 art. 18 c.1 d; art. 77'
export const TRAINING_LAW = 'D.Lgs. 81/2008 art. 37'
export const SURVEILLANCE_LAW = 'D.Lgs. 81/2008 art. 41'
export const CHANGE_OF_TASK_LAW = 'D.Lgs. 81/2008 art. 41 c.2 d'
/** A plan a role sheet makes needed starts with a yearly visit, the law's rule until the doctor sets another (the health page). */
export const DEFAULT_VISIT_MONTHS = 12
export const DEFAULT_VISIT_LAW = 'D.Lgs. 81/2008 art. 41 c.2 b'

export const ROLE_SHEET_ITEM_KINDS = ['RISK', 'SURVEILLANCE'] as const
export type RoleSheetItemKind = (typeof ROLE_SHEET_ITEM_KINDS)[number]
export const ROLE_SHEET_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type RoleSheetStatus = (typeof ROLE_SHEET_STATUSES)[number]

export const ROLE_SHEET_LIMITS = Object.freeze({
  code: 20,
  name: 120,
  description: 2000,
  title: 200,
  note: 1000,
  whenToWear: 200,
  items: 60,
  kit: 40,
  requirements: 40,
  quantity: 99,
  withinDays: 365,
  list: 500,
  /** The names a line of "What this changes" lists (the count says the rest). */
  names: 100,
  reason: 500,
})

/** A sheet's code: letters, digits and . _ / - (stored in capitals; the database refuses spaces). */
export const ROLE_SHEET_CODE = /^[A-Z0-9][A-Z0-9._/-]*$/
export const normalCode = (code: string): string => code.trim().toUpperCase()

export const ROLE_SHEET_REFUSALS = [
  'SITE_OTHER_COMPANY',
  'CODE_TAKEN',
  'ARCHIVED',
  'NOT_ARCHIVED',
  'PEOPLE_IN_ROLE',
  'PPE_ITEM_NOT_AVAILABLE',
  'COURSE_NOT_AVAILABLE',
  'IMPACT_CHANGED',
  'LEFT',
  'ROLE_SHEET_OTHER_SITE',
  'ROLE_SHEET_ARCHIVED',
] as const
export type RoleSheetRefusalCode = (typeof ROLE_SHEET_REFUSALS)[number]

/**
 * Who sees which PERSON needs a health visit (GDPR art. 9; W2b plan §12 and B-W2b-91; every other reader counts only): the
 * health readers, B-W2b-135's safety.health.view (HR and the occupational doctor among the templates, and the owner through
 * every()), each view of a health record recorded on the health page.
 */
export const VISIT_NEED_READER = 'safety.health.view' satisfies Permission

// ---- the content of a sheet -----------------------------------------------------------------------------------------------

export interface ItemDraft {
  readonly kind: RoleSheetItemKind
  readonly title: string
  readonly note?: string | null | undefined
}
export interface KitDraft {
  readonly ppeItemId: string
  readonly quantity: number
  readonly whenToWear: string
  readonly note?: string | null | undefined
}
export interface RequirementDraft {
  readonly courseId: string
  /** Days after taking the role; null: before starting. */
  readonly withinDays: number | null
  readonly note?: string | null | undefined
}
export interface SheetContent {
  readonly items: readonly ItemDraft[]
  readonly kit: readonly KitDraft[]
  readonly requirements: readonly RequirementDraft[]
}

/** What a role asks: its content, and its health plan (needed null: no plan yet, the doctor has not said). */
export interface RoleAsks {
  readonly content: SheetContent
  readonly needed: boolean | null
  readonly frequencyMonths: number | null
}

const clean = (words: string | null | undefined): string | null => {
  const trimmed = words?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** The content as it is stored: words trimmed, empty notes none. */
export function cleanContent(content: SheetContent): SheetContent {
  return {
    items: content.items.map((item) => ({ kind: item.kind, title: item.title.trim(), note: clean(item.note) })),
    kit: content.kit.map((line) => ({ ppeItemId: line.ppeItemId, quantity: line.quantity, whenToWear: line.whenToWear.trim(), note: clean(line.note) })),
    requirements: content.requirements.map((requirement) => ({ courseId: requirement.courseId, withinDays: requirement.withinDays, note: clean(requirement.note) })),
  }
}

/**
 * What is wrong with a sheet's content (paths without `body/`): one kit line per item and one requirement per course (the
 * module's rules: a uuid-only unique cannot be copied by the isolation tests), the numbers in range, and a role that needs
 * health surveillance names the risk that asks for it (a surveillance need): the health page shows it as the reason.
 */
export function contentProblems(content: SheetContent, needed?: boolean | undefined): Issue[] {
  const problems: Issue[] = []
  const L = ROLE_SHEET_LIMITS
  if (content.items.length > L.items) problems.push({ path: 'content/items', message: `A sheet lists at most ${L.items} risks and surveillance needs.` })
  content.items.forEach((item, index) => {
    if (item.title.trim() === '') problems.push({ path: `content/items/${index}/title`, message: 'Say the risk or the surveillance need in words.' })
    if (item.title.trim().length > L.title) problems.push({ path: `content/items/${index}/title`, message: `At most ${L.title} characters.` })
  })
  if (content.kit.length > L.kit) problems.push({ path: 'content/kit', message: `A kit holds at most ${L.kit} items.` })
  const items = new Set<string>()
  content.kit.forEach((line, index) => {
    if (items.has(line.ppeItemId)) problems.push({ path: `content/kit/${index}/ppeItemId`, message: 'This item is in the kit already: one line per item.' })
    items.add(line.ppeItemId)
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > L.quantity) problems.push({ path: `content/kit/${index}/quantity`, message: `From 1 to ${L.quantity}.` })
    if (line.whenToWear.trim() === '') problems.push({ path: `content/kit/${index}/whenToWear`, message: 'Say when to wear it ("at the clicking press", "always on the floor").' })
  })
  if (content.requirements.length > L.requirements) problems.push({ path: 'content/requirements', message: `A role asks at most ${L.requirements} courses.` })
  const courses = new Set<string>()
  content.requirements.forEach((requirement, index) => {
    if (courses.has(requirement.courseId)) problems.push({ path: `content/requirements/${index}/courseId`, message: 'The role asks this course already: one line per course.' })
    courses.add(requirement.courseId)
    if (requirement.withinDays !== null && (!Number.isInteger(requirement.withinDays) || requirement.withinDays < 0 || requirement.withinDays > L.withinDays))
      problems.push({ path: `content/requirements/${index}/withinDays`, message: `From 0 to ${L.withinDays} days, or none: before starting.` })
  })
  if (needed === true && !content.items.some((item) => item.kind === 'SURVEILLANCE'))
    problems.push({ path: 'surveillance/needed', message: 'Name the surveillance need first (the risk that asks for visits, "noise exposure"): the health page shows it as the reason.' })
  return problems
}

// ---- what changes on the sheet --------------------------------------------------------------------------------------------

export interface SheetChanges {
  /** Risks and surveillance needs added or removed (their words). */
  readonly risks: { readonly added: readonly string[]; readonly removed: readonly string[] }
  readonly surveillanceNeeds: { readonly added: readonly string[]; readonly removed: readonly string[] }
  readonly kit: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly { readonly ppeItemId: string; readonly quantity: { readonly from: number; readonly to: number } | null; readonly whenToWear: { readonly from: string; readonly to: string } | null }[]
  }
  readonly courses: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly { readonly courseId: string; readonly withinDays: { readonly from: number | null; readonly to: number | null } }[]
  }
  /** Whether the role needs health surveillance, from → to (null when the sheet does not change it). */
  readonly surveillance: { readonly from: boolean | null; readonly to: boolean } | null
  /** The parts whose rows the Apply writes. */
  readonly itemsChanged: boolean
  readonly kitChanged: boolean
  readonly requirementsChanged: boolean
}

const wordsKey = (words: string): string => words.trim().replace(/\s+/g, ' ').toLowerCase()

function wordDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const left = new Map<string, number>()
  for (const words of before) left.set(wordsKey(words), (left.get(wordsKey(words)) ?? 0) + 1)
  const added: string[] = []
  for (const words of after) {
    const count = left.get(wordsKey(words)) ?? 0
    if (count > 0) left.set(wordsKey(words), count - 1)
    else added.push(words)
  }
  const right = new Map<string, number>()
  for (const words of after) right.set(wordsKey(words), (right.get(wordsKey(words)) ?? 0) + 1)
  const removed: string[] = []
  for (const words of before) {
    const count = right.get(wordsKey(words)) ?? 0
    if (count > 0) right.set(wordsKey(words), count - 1)
    else removed.push(words)
  }
  return { added, removed }
}

/** The difference between what a role asks now and what a draft would make it ask (`needed` undefined: not changed). */
export function sheetChanges(before: RoleAsks, after: SheetContent, needed?: boolean | undefined): SheetChanges {
  const old = cleanContent(before.content)
  const next = cleanContent(after)
  const titles = (content: SheetContent, kind: RoleSheetItemKind) => content.items.filter((item) => item.kind === kind).map((item) => item.title)
  const itemsChanged = JSON.stringify(old.items) !== JSON.stringify(next.items)

  const oldKit = new Map(old.kit.map((line) => [line.ppeItemId, line]))
  const newKit = new Map(next.kit.map((line) => [line.ppeItemId, line]))
  const kitChangedLines = next.kit
    .filter((line) => oldKit.has(line.ppeItemId))
    .map((line) => {
      const was = oldKit.get(line.ppeItemId)!
      return {
        ppeItemId: line.ppeItemId,
        quantity: was.quantity !== line.quantity ? { from: was.quantity, to: line.quantity } : null,
        whenToWear: was.whenToWear !== line.whenToWear ? { from: was.whenToWear, to: line.whenToWear } : null,
      }
    })
    .filter((line) => line.quantity !== null || line.whenToWear !== null)

  const oldCourses = new Map(old.requirements.map((requirement) => [requirement.courseId, requirement]))
  const newCourses = new Map(next.requirements.map((requirement) => [requirement.courseId, requirement]))
  const courseChanges = next.requirements
    .filter((requirement) => oldCourses.has(requirement.courseId) && oldCourses.get(requirement.courseId)!.withinDays !== requirement.withinDays)
    .map((requirement) => ({ courseId: requirement.courseId, withinDays: { from: oldCourses.get(requirement.courseId)!.withinDays, to: requirement.withinDays } }))
  const requirementsChanged =
    old.requirements.length !== next.requirements.length ||
    next.requirements.some((requirement) => {
      const was = oldCourses.get(requirement.courseId)
      return !was || was.withinDays !== requirement.withinDays || (was.note ?? null) !== (requirement.note ?? null)
    })

  return {
    risks: wordDiff(titles(old, 'RISK'), titles(next, 'RISK')),
    surveillanceNeeds: wordDiff(titles(old, 'SURVEILLANCE'), titles(next, 'SURVEILLANCE')),
    kit: { added: next.kit.filter((line) => !oldKit.has(line.ppeItemId)).map((line) => line.ppeItemId), removed: old.kit.filter((line) => !newKit.has(line.ppeItemId)).map((line) => line.ppeItemId), changed: kitChangedLines },
    courses: {
      added: next.requirements.filter((requirement) => !oldCourses.has(requirement.courseId)).map((requirement) => requirement.courseId),
      removed: old.requirements.filter((requirement) => !newCourses.has(requirement.courseId)).map((requirement) => requirement.courseId),
      changed: courseChanges,
    },
    surveillance: needed !== undefined && needed !== before.needed ? { from: before.needed, to: needed } : null,
    itemsChanged,
    kitChanged: JSON.stringify(old.kit) !== JSON.stringify(next.kit),
    requirementsChanged,
  }
}

/** True when the draft changes nothing of the content or the plan. */
export const changesNothing = (changes: SheetChanges): boolean => !changes.itemsChanged && !changes.kitChanged && !changes.requirementsChanged && changes.surveillance === null

// ---- what people hold -----------------------------------------------------------------------------------------------------

export const holdingKey = (employeeId: string, thingId: string): string => `${employeeId}|${thingId}`

/**
 * Who holds which course today. `standing` are the records that stand (PASSED, not corrected away: a correction replaces the
 * record it corrects, a VOID correction removes it), newest first per person and course; the newest decides, and holds the
 * course while its "valid until" is not past (none: no refresher). B-W2b-133's due lists read the same rule.
 */
export function coursesMet(standing: readonly { readonly employeeId: string; readonly courseId: string; readonly validUntil: BusinessDate | null }[], today: BusinessDate): Set<string> {
  const seen = new Set<string>()
  const met = new Set<string>()
  for (const record of standing) {
    const key = holdingKey(record.employeeId, record.courseId)
    if (seen.has(key)) continue
    seen.add(key)
    if (record.validUntil === null || record.validUntil >= today) met.add(key)
  }
  return met
}

/** Units of each PPE item each person holds: their ISSUE rows that no VOID row voids (B-W2b-134's gaps read the same rule). */
export function kitHeld(issues: readonly { readonly id: string; readonly kind: 'ISSUE' | 'VOID'; readonly employeeId: string; readonly ppeItemId: string; readonly quantity: number; readonly voidsId: string | null }[]): Map<string, number> {
  const voided = new Set(issues.filter((issue) => issue.kind === 'VOID' && issue.voidsId).map((issue) => issue.voidsId!))
  const held = new Map<string, number>()
  for (const issue of issues) {
    if (issue.kind !== 'ISSUE' || voided.has(issue.id)) continue
    const key = holdingKey(issue.employeeId, issue.ppeItemId)
    held.set(key, (held.get(key) ?? 0) + issue.quantity)
  }
  return held
}

export interface Holdings {
  readonly met: ReadonlySet<string>
  readonly held: ReadonlyMap<string, number>
}

// ---- what this changes for the people in the role -------------------------------------------------------------------------

export const IMPACT_KINDS = ['COURSE_NEEDED', 'COURSE_NOT_NEEDED', 'COURSE_DEADLINE', 'KIT_TO_ISSUE', 'KIT_REMOVED', 'VISITS_NEEDED', 'VISITS_NOT_NEEDED'] as const
export type ImpactKind = (typeof IMPACT_KINDS)[number]

export interface PersonRef {
  readonly employeeId: string
  readonly name: string
}

/** One line of "What this changes" (the ReviewChangesModal). The screen says it in words (it/en). */
export interface ImpactLine {
  readonly kind: ImpactKind
  readonly courseId: string | null
  readonly ppeItemId: string | null
  /** The people it concerns: COURSE_NEEDED and COURSE_DEADLINE those without a valid record; KIT_TO_ISSUE those holding fewer units than the kit asks; the others everyone in the role. */
  readonly people: number
  /** COURSE_NEEDED / KIT_TO_ISSUE: people in the role who hold it already. */
  readonly already: number
  /** Who (the course and kit lines: the registers name people, at most ROLE_SHEET_LIMITS.names); null on the visit lines: counts only. */
  readonly names: readonly PersonRef[] | null
  readonly withinDays: { readonly from: number | null; readonly to: number | null } | null
  /** KIT_TO_ISSUE: the units the kit asks. */
  readonly quantity: number | null
  /** VISITS_NEEDED: every how many months (the plan's, or the law's yearly rule for a new plan). */
  readonly frequencyMonths: number | null
}

const line = (kind: ImpactKind, fields: Partial<Omit<ImpactLine, 'kind'>>): ImpactLine => ({
  kind,
  courseId: fields.courseId ?? null,
  ppeItemId: fields.ppeItemId ?? null,
  people: fields.people ?? 0,
  already: fields.already ?? 0,
  names: fields.names === undefined ? null : fields.names,
  withinDays: fields.withinDays ?? null,
  quantity: fields.quantity ?? null,
  frequencyMonths: fields.frequencyMonths ?? null,
})

const capped = (people: readonly PersonRef[]): PersonRef[] => [...people].sort((a, b) => a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId)).slice(0, ROLE_SHEET_LIMITS.names)

/**
 * What applying a draft changes for the ACTIVE people in the role: who now needs which course (and who holds it already),
 * whose deadline moves, which kit items to issue to whom, items no longer in the kit (nothing is taken back), and how many
 * people get or lose health visits (counts only).
 */
export function sheetImpact(people: readonly PersonRef[], before: RoleAsks, after: SheetContent, changes: SheetChanges, holdings: Holdings): ImpactLine[] {
  const lines: ImpactLine[] = []
  const missing = (courseId: string) => people.filter((person) => !holdings.met.has(holdingKey(person.employeeId, courseId)))
  for (const courseId of changes.courses.added) {
    const without = missing(courseId)
    const requirement = after.requirements.find((entry) => entry.courseId === courseId)!
    lines.push(line('COURSE_NEEDED', { courseId, people: without.length, already: people.length - without.length, names: capped(without), withinDays: { from: null, to: requirement.withinDays } }))
  }
  for (const change of changes.courses.changed) {
    const without = missing(change.courseId)
    lines.push(line('COURSE_DEADLINE', { courseId: change.courseId, people: without.length, already: people.length - without.length, names: capped(without), withinDays: change.withinDays }))
  }
  for (const courseId of changes.courses.removed) lines.push(line('COURSE_NOT_NEEDED', { courseId, people: people.length }))
  const raised = [
    ...changes.kit.added.map((ppeItemId) => ({ ppeItemId, quantity: after.kit.find((entry) => entry.ppeItemId === ppeItemId)!.quantity })),
    ...changes.kit.changed.filter((change) => change.quantity !== null && change.quantity.to > change.quantity.from).map((change) => ({ ppeItemId: change.ppeItemId, quantity: change.quantity!.to })),
  ]
  for (const { ppeItemId, quantity } of raised) {
    const short = people.filter((person) => (holdings.held.get(holdingKey(person.employeeId, ppeItemId)) ?? 0) < quantity)
    lines.push(line('KIT_TO_ISSUE', { ppeItemId, people: short.length, already: people.length - short.length, names: capped(short), quantity }))
  }
  for (const ppeItemId of changes.kit.removed) lines.push(line('KIT_REMOVED', { ppeItemId, people: people.length }))
  if (changes.surveillance?.to === true) lines.push(line('VISITS_NEEDED', { people: people.length, frequencyMonths: before.frequencyMonths ?? DEFAULT_VISIT_MONTHS }))
  if (changes.surveillance?.from === true && changes.surveillance.to === false) lines.push(line('VISITS_NOT_NEEDED', { people: people.length }))
  return lines
}

// ---- what a role change means for one person ------------------------------------------------------------------------------

export const ROLE_CHANGES = ['NONE', 'SET', 'CHANGE', 'CLEAR'] as const
export type RoleChange = (typeof ROLE_CHANGES)[number]
/** A role change's visit: a change-of-task visit (the new role needs surveillance: art. 41 c.2 d), the doctor has not said yet, or none. */
export const VISIT_CONSEQUENCES = ['CHANGE_OF_TASK', 'ASK_THE_DOCTOR', 'NONE'] as const
export type VisitConsequence = (typeof VISIT_CONSEQUENCES)[number]

export interface PersonImpact {
  readonly change: RoleChange
  readonly courses: {
    /** Courses the new role asks that the old one did not: due within the days from today (none: before starting), held already or not. */
    readonly needed: readonly { readonly courseId: string; readonly withinDays: number | null; readonly dueOn: BusinessDate; readonly held: boolean }[]
    readonly noLonger: readonly { readonly courseId: string }[]
  }
  readonly kit: {
    /** Items the new kit asks (new, or more units than the old kit): how many the person holds and how many to issue. */
    readonly toIssue: readonly { readonly ppeItemId: string; readonly quantity: number; readonly whenToWear: string; readonly held: number; readonly short: number }[]
    readonly noLonger: readonly { readonly ppeItemId: string }[]
  }
  readonly visit: VisitConsequence
  /** CHANGE_OF_TASK: the new role's visits every how many months. */
  readonly frequencyMonths: number | null
}

export function roleChangeOf(fromId: string | null, toId: string | null): RoleChange {
  if (fromId === toId) return 'NONE'
  if (fromId === null) return 'SET'
  if (toId === null) return 'CLEAR'
  return 'CHANGE'
}

/** What moving one person from a role (or none) to another (or none) means for them, from today. */
export function personImpact(employeeId: string, fromId: string | null, from: RoleAsks | null, toId: string | null, to: RoleAsks | null, holdings: Holdings, today: BusinessDate): PersonImpact {
  const change = roleChangeOf(fromId, toId)
  if (change === 'NONE') return { change, courses: { needed: [], noLonger: [] }, kit: { toIssue: [], noLonger: [] }, visit: 'NONE', frequencyMonths: null }
  const oldCourses = new Set((from?.content.requirements ?? []).map((requirement) => requirement.courseId))
  const newCourses = to?.content.requirements ?? []
  const oldKit = new Map((from?.content.kit ?? []).map((entry) => [entry.ppeItemId, entry.quantity]))
  const newKit = to?.content.kit ?? []
  const surveillance = to !== null && to.content.items.some((item) => item.kind === 'SURVEILLANCE')
  const visit: VisitConsequence = to?.needed === true ? 'CHANGE_OF_TASK' : to !== null && to.needed === null && surveillance ? 'ASK_THE_DOCTOR' : 'NONE'
  return {
    change,
    courses: {
      needed: newCourses
        .filter((requirement) => !oldCourses.has(requirement.courseId))
        .map((requirement) => ({ courseId: requirement.courseId, withinDays: requirement.withinDays, dueOn: addDays(today, requirement.withinDays ?? 0), held: holdings.met.has(holdingKey(employeeId, requirement.courseId)) })),
      noLonger: [...oldCourses].filter((courseId) => !newCourses.some((requirement) => requirement.courseId === courseId)).map((courseId) => ({ courseId })),
    },
    kit: {
      toIssue: newKit
        .filter((entry) => entry.quantity > (oldKit.get(entry.ppeItemId) ?? 0))
        .map((entry) => {
          const held = holdings.held.get(holdingKey(employeeId, entry.ppeItemId)) ?? 0
          return { ppeItemId: entry.ppeItemId, quantity: entry.quantity, whenToWear: entry.whenToWear, held, short: Math.max(0, entry.quantity - held) }
        }),
      noLonger: [...oldKit.keys()].filter((ppeItemId) => !newKit.some((entry) => entry.ppeItemId === ppeItemId)).map((ppeItemId) => ({ ppeItemId })),
    },
    visit,
    frequencyMonths: visit === 'CHANGE_OF_TASK' ? (to?.frequencyMonths ?? null) : null,
  }
}

/**
 * The fingerprint of an answer as the caller saw it (SHA-256 of its JSON): Apply sends it back, and a change made meanwhile
 * (a person joined the role, a course was recorded) is refused (IMPACT_CHANGED) instead of applied unseen. Made from what
 * the caller was shown only, so it never tells a reader more than the answer did.
 */
export const fingerprintOf = (shown: unknown): string => createHash('sha256').update(JSON.stringify(shown)).digest('hex')
