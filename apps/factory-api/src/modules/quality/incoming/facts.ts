import type { Prisma } from '@nexus/factory-db'
import type { AqlDefectClass } from '@nexus/factory-domain/quality/aql/sampling'
import { isHideDefect } from '@nexus/factory-domain/quality/defects/grades'
import {
  checksNow,
  computedOf,
  foundOf,
  tallyOf,
  type CheckFacts,
  type ChecksNow,
  type Computed,
  type Found,
  type MarkDraft,
  type Tally,
  type UnitDecision,
} from '@nexus/factory-domain/quality/incoming/rules'
import { readResults, type IncomingRow, type Reader, type ResultRow } from './store'

/**
 * The facts of an incoming inspection as the rules read them (B-W2b-98), shared by the record's view and the commands:
 * the frozen plan version's checks and their answers, the marks of every hide with the class of each defect (the library's
 * default class; a defect the library gives none counts MAJOR until quality says otherwise), the found counts (a hide once,
 * under its worst class), the sample's tally and the result the rules give now, as the database will compute it.
 */

export const CHECK_COLUMNS = {
  id: true,
  code: true,
  labelIt: true,
  labelEn: true,
  type: true,
  checkClass: true,
  mandatory: true,
  photoRequired: true,
  nominal: true,
  tolerance: true,
  uom: true,
  choices: true,
  sortOrder: true,
} as const satisfies Prisma.InspectionPlanCheckSelect
export type CheckRow = Prisma.InspectionPlanCheckGetPayload<{ select: typeof CHECK_COLUMNS }>

export const checkFactsOf = (row: CheckRow): CheckFacts => ({
  id: row.id,
  code: row.code,
  label: row.labelEn,
  type: row.type,
  checkClass: (row.checkClass as AqlDefectClass | null) ?? null,
  mandatory: row.mandatory,
  nominal: row.nominal === null ? null : row.nominal.toFixed(3),
  tolerance: row.tolerance === null ? null : row.tolerance.toFixed(3),
  choices: [...row.choices],
})

export const readChecks = (db: Pick<Reader, 'inspectionPlanCheck'>, planVersionId: string): Promise<CheckRow[]> =>
  db.inspectionPlanCheck.findMany({ where: { planVersionId }, select: CHECK_COLUMNS, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })

export const ANSWER_COLUMNS = { id: true, planCheckId: true, sampleIndex: true, outcome: true, value: true, note: true, version: true } as const satisfies Prisma.InspectionCheckResultSelect
export type AnswerRow = Prisma.InspectionCheckResultGetPayload<{ select: typeof ANSWER_COLUMNS }>

export const readAnswers = (db: Pick<Reader, 'inspectionCheckResult'>, inspectionId: string): Promise<AnswerRow[]> =>
  db.inspectionCheckResult.findMany({ where: { incomingInspectionId: inspectionId }, select: ANSWER_COLUMNS, orderBy: [{ planCheckId: 'asc' }, { sampleIndex: 'asc' }] })

/** A stored mark list (the result's JSON), as the rules take it. */
export function marksOf(value: Prisma.JsonValue): MarkDraft[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const mark = entry as Record<string, unknown>
    if (typeof mark.x !== 'number' || typeof mark.y !== 'number') return []
    const code = typeof mark.code === 'string' ? mark.code : null
    const kind = mark.kind === 'ZONE' || (mark.kind === undefined && !code) ? 'ZONE' : 'DEFECT'
    const outline = Array.isArray(mark.outline) ? (mark.outline as unknown[]).flatMap((point) => (point && typeof point === 'object' && typeof (point as { x?: unknown }).x === 'number' && typeof (point as { y?: unknown }).y === 'number' ? [{ x: (point as { x: number }).x, y: (point as { y: number }).y }] : [])) : []
    return [{ kind, x: mark.x, y: mark.y, code, zone: typeof mark.zone === 'string' ? mark.zone : null, outline, note: typeof mark.note === 'string' ? mark.note : null }]
  })
}

export const DEFECT_COLUMNS = { id: true, code: true, labelIt: true, labelEn: true, severity: true, stages: true, parentId: true, active: true, sortOrder: true } as const satisfies Prisma.DefectCodeSelect
export type DefectRow = Prisma.DefectCodeGetPayload<{ select: typeof DEFECT_COLUMNS }>

/** The class a mark of this defect counts in: the library's default class, MAJOR when it gives none. */
export const classOfDefect = (defect: Pick<DefectRow, 'severity'> | undefined): AqlDefectClass => (defect?.severity as AqlDefectClass | null | undefined) ?? 'MAJOR'

/** Every defect of the library by code (retired ones too: a mark keeps the code it has). */
export async function defectsByCode(db: Pick<Reader, 'defectCode'>, codes: readonly string[]): Promise<Map<string, DefectRow>> {
  const wanted = [...new Set(codes.filter(Boolean))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.defectCode.findMany({ where: { code: { in: wanted } }, select: DEFECT_COLUMNS })).map((row) => [row.code, row]))
}

/** The hide defects of the library the bench picks from: active defects of the LEATHER category at incoming or cutting. */
export async function hideDefectsOf(db: Pick<Reader, 'defectCode'>): Promise<DefectRow[]> {
  const rows = await db.defectCode.findMany({ where: { active: true }, select: DEFECT_COLUMNS, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
  const categories = new Map(rows.filter((row) => row.parentId === null).map((row) => [row.id, row.code]))
  return rows.filter((row) => row.parentId !== null && categories.has(row.parentId) && isHideDefect(row, categories.get(row.parentId)!))
}

export interface SampleFacts {
  readonly results: readonly ResultRow[]
  readonly marks: ReadonlyMap<string, MarkDraft[]>
  readonly defects: ReadonlyMap<string, DefectRow>
  /** Per hide result, the classes of its defect marks. */
  readonly classes: ReadonlyMap<string, AqlDefectClass[]>
  readonly found: Found
  readonly tally: Tally
  readonly checkRows: readonly CheckRow[]
  readonly checks: readonly CheckFacts[]
  readonly answers: readonly AnswerRow[]
  readonly now: ChecksNow
  readonly computed: Computed
}

/** The facts of the inspection's sample, read on one client (one statement after the other). */
export async function sampleFactsOf(db: Reader, row: Pick<IncomingRow, 'id' | 'planVersionId' | 'sampleSize' | 'acceptMajor' | 'acceptMinor' | 'foundCritical' | 'foundMajor' | 'foundMinor'>, byHide: boolean): Promise<SampleFacts> {
  const results = await readResults(db, row.id)
  const marks = new Map(results.map((result) => [result.id, marksOf(result.marks)]))
  const defects = await defectsByCode(db, [...marks.values()].flat().flatMap((mark) => (mark.kind === 'DEFECT' && mark.code ? [mark.code] : [])))
  const classes = new Map(results.map((result) => [result.id, marks.get(result.id)!.flatMap((mark) => (mark.kind === 'DEFECT' && mark.code ? [classOfDefect(defects.get(mark.code))] : []))]))
  // A lot inspected hide by hide counts from its marks; another lot keeps the counters it has (B-W2b-111's units).
  const found = byHide ? foundOf([...classes.values()].map((list) => ({ classes: list }))) : { critical: row.foundCritical, major: row.foundMajor, minor: row.foundMinor }
  const tally = tallyOf(results.map((result) => result.decision as UnitDecision | null))
  const checkRows = await readChecks(db, row.planVersionId)
  const checks = checkRows.map(checkFactsOf)
  const answers = await readAnswers(db, row.id)
  // As the database's factory_inspection_results_problem: a measurement answers a check too, and out of tolerance fails it.
  const measurements = await db.inspectionMeasurement.findMany({ where: { incomingInspectionId: row.id, planCheckId: { not: null } }, select: { planCheckId: true, pass: true } })
  const now = checksNow(checks, [...answers.map((answer) => ({ planCheckId: answer.planCheckId, failed: answer.outcome === 'FAIL' })), ...measurements.map((m) => ({ planCheckId: m.planCheckId!, failed: !m.pass }))])
  const computed = computedOf({ found, sampleSize: row.sampleSize, acceptMajor: row.acceptMajor, acceptMinor: row.acceptMinor, failedCritical: now.failedCritical })
  return { results, marks, defects, classes, found, tally, checkRows, checks, answers, now, computed }
}

// ---- B-W2b-111: rolls (4-point) and components ---------------------------------------------------------------------------

export const ROLL_COLUMNS = {
  id: true,
  rollRef: true,
  recordType: true,
  recordId: true,
  onePoint: true,
  twoPoint: true,
  threePoint: true,
  fourPoint: true,
  widthCm: true,
  lengthM: true,
  pointsPer100SqYd: true,
  decision: true,
  note: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.IncomingRollResultSelect
export type RollRow = Prisma.IncomingRollResultGetPayload<{ select: typeof ROLL_COLUMNS }>

export const readRolls = (db: Pick<Reader, 'incomingRollResult'>, inspectionId: string): Promise<RollRow[]> =>
  db.incomingRollResult.findMany({ where: { incomingInspectionId: inspectionId }, select: ROLL_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

export const COMPONENT_COLUMNS = {
  id: true,
  seq: true,
  kind: true,
  marking: true,
  protectorType: true,
  size: true,
  certificateId: true,
  checkedQuantity: true,
  defectiveQuantity: true,
  decision: true,
  note: true,
  version: true,
} as const satisfies Prisma.IncomingComponentResultSelect
export type ComponentRow = Prisma.IncomingComponentResultGetPayload<{ select: typeof COMPONENT_COLUMNS }>

export const readComponents = (db: Pick<Reader, 'incomingComponentResult'>, inspectionId: string): Promise<ComponentRow[]> =>
  db.incomingComponentResult.findMany({ where: { incomingInspectionId: inspectionId }, select: COMPONENT_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
