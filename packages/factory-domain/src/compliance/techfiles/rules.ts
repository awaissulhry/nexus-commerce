import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'

/**
 * Technical files (B-W2b-251; PRD-296, PRD-299, PRD-301, PRD-302, QHS-048, QHS-110; design compliance.techfiles): the pure
 * rules apps/factory-api's modules/compliance/techfiles applies before it writes, said in words. The database (B-W2b-218's
 * …_techfiles_labels_w2b_guards) holds the same rules for every login; these come first so a person reads why, at the field.
 *
 *   Annex III      the thirteen points (a) to (m) of PPE Reg. (EU) 2016/425 Annex III, each with its law reference; a point's
 *                  state from its items; when a file may be completed (every point with an item, every item reviewed or not
 *                  applicable, the certificate for a category II or III style); which records may be evidence of which
 *                  point (linked, never copied).
 *   risk           a hazard row's words (PRD-301) and what signing needs.
 *   tests          production-control tests (QHS-048): when the next one is due by its frequency, the plan per kind, what
 *                  recording a result needs.
 *   batches        conformity to type per batch (PRD-302, Annex VIII module C2): what a batch's evidence lacks.
 *   kept 10 years  QHS-110 (art. 8(3)): a day ten years on, the way PostgreSQL counts it, and where a record's keeping stands.
 *   packs          what an evidence pack may be asked for (PRD-299) and the manifest its fingerprint is taken of.
 */

// ---- Annex III ------------------------------------------------------------------------------------------------------------

export const ANNEX_III_POINTS = [
  'A_DESCRIPTION',
  'B_RISK_ASSESSMENT',
  'C_REQUIREMENTS',
  'D_DRAWINGS',
  'E_EXPLANATIONS',
  'F_STANDARDS',
  'G_OTHER_SPECIFICATIONS',
  'H_CALCULATIONS',
  'I_TEST_REPORTS',
  'J_PRODUCTION_CONTROL',
  'K_USER_INFORMATION',
  'L_SINGLE_UNIT',
  'M_SERIES_FITTED',
] as const
export type AnnexIIIPoint = (typeof ANNEX_III_POINTS)[number]

export const ANNEX_III_LAW = 'Reg. (EU) 2016/425 Annex III'

/** Each point's letter, its law reference (the design's LawRef) and what it asks, in English and Italian. */
export const POINT_INFO: Readonly<Record<AnnexIIIPoint, { readonly letter: string; readonly law: string; readonly en: string; readonly it: string }>> = Object.freeze({
  A_DESCRIPTION: { letter: 'a', law: `${ANNEX_III_LAW} (a)`, en: 'Description of the PPE and its intended use', it: "Descrizione del DPI e dell'uso previsto" },
  B_RISK_ASSESSMENT: { letter: 'b', law: `${ANNEX_III_LAW} (b)`, en: 'Assessment of the risks the PPE protects against', it: 'Valutazione dei rischi da cui il DPI protegge' },
  C_REQUIREMENTS: { letter: 'c', law: `${ANNEX_III_LAW} (c)`, en: 'Essential health and safety requirements that apply', it: 'Requisiti essenziali di salute e sicurezza applicabili' },
  D_DRAWINGS: { letter: 'd', law: `${ANNEX_III_LAW} (d)`, en: 'Design and manufacturing drawings and schemes', it: 'Disegni e schemi di progettazione e fabbricazione' },
  E_EXPLANATIONS: { letter: 'e', law: `${ANNEX_III_LAW} (e)`, en: 'Descriptions and explanations of the drawings and of how the PPE works', it: 'Descrizioni e spiegazioni dei disegni e del funzionamento del DPI' },
  F_STANDARDS: { letter: 'f', law: `${ANNEX_III_LAW} (f)`, en: 'Harmonised standards applied', it: 'Norme armonizzate applicate' },
  G_OTHER_SPECIFICATIONS: { letter: 'g', law: `${ANNEX_III_LAW} (g)`, en: 'Other technical specifications applied', it: 'Altre specifiche tecniche applicate' },
  H_CALCULATIONS: { letter: 'h', law: `${ANNEX_III_LAW} (h)`, en: 'Results of design calculations, inspections and examinations', it: 'Risultati dei calcoli di progettazione, controlli ed esami' },
  I_TEST_REPORTS: { letter: 'i', law: `${ANNEX_III_LAW} (i)`, en: 'Test reports (conformity and protection class)', it: 'Rapporti di prova (conformità e classe di protezione)' },
  J_PRODUCTION_CONTROL: { letter: 'j', law: `${ANNEX_III_LAW} (j)`, en: 'Means used in production to keep the PPE conforming', it: 'Mezzi usati in produzione per mantenere la conformità' },
  K_USER_INFORMATION: { letter: 'k', law: `${ANNEX_III_LAW} (k)`, en: "Copy of the manufacturer's instructions and information", it: 'Copia delle istruzioni e informazioni del fabbricante' },
  L_SINGLE_UNIT: { letter: 'l', law: `${ANNEX_III_LAW} (l)`, en: 'Single unit made to fit one user: how it is made from the approved model', it: 'Esemplare unico su misura: come è fatto dal modello approvato' },
  M_SERIES_FITTED: { letter: 'm', law: `${ANNEX_III_LAW} (m)`, en: 'Series fitted to each user: how each item keeps to the approved type', it: 'Serie adattata a ogni utilizzatore: come ogni articolo resta conforme al tipo' },
})

export const TECHNICAL_FILE_STATUSES = ['OPEN', 'COMPLETE', 'ARCHIVED'] as const
export type TechnicalFileStatus = (typeof TECHNICAL_FILE_STATUSES)[number]
export const ITEM_STATES = ['MISSING', 'LINKED', 'REVIEWED', 'NOT_APPLICABLE'] as const
export type ItemState = (typeof ITEM_STATES)[number]
/** A point's state: NONE has no item yet. */
export const POINT_STATES = ['NONE', 'MISSING', 'LINKED', 'REVIEWED', 'NOT_APPLICABLE'] as const
export type PointState = (typeof POINT_STATES)[number]

export const PPE_CATEGORIES = ['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III'] as const
export type PpeCategory = (typeof PPE_CATEGORIES)[number]
/** A category II or III style's file is complete only with its EU type-examination certificate (Annex V). */
export const needsCertificate = (category: string): boolean => category === 'CATEGORY_II' || category === 'CATEGORY_III'

export const NOTE_MAX = 2000
export const REASON_MIN = 3
export const REASON_MAX = 500
/** At most this many items per point (a point's evidence is a list, never a folder of copies). */
export const ITEMS_PER_POINT_MAX = 50

/**
 * The records that may be a point's evidence (the model name the item keeps), with the points they usually prove: the
 * evidence picker offers them there first. Any of them may be linked to any point; another model is refused.
 */
export const EVIDENCE_RECORD_TYPES: Readonly<Record<string, readonly AnnexIIIPoint[]>> = Object.freeze({
  Style: ['A_DESCRIPTION'],
  StyleRevision: ['A_DESCRIPTION', 'D_DRAWINGS', 'E_EXPLANATIONS', 'J_PRODUCTION_CONTROL'],
  StyleRevisionFile: ['D_DRAWINGS', 'E_EXPLANATIONS'],
  MeasurementSpec: ['D_DRAWINGS', 'G_OTHER_SPECIFICATIONS'],
  Certificate: ['C_REQUIREMENTS', 'F_STANDARDS', 'I_TEST_REPORTS'],
  RegulationOrStandard: ['C_REQUIREMENTS', 'F_STANDARDS', 'G_OTHER_SPECIFICATIONS'],
  ComplianceDocument: ['C_REQUIREMENTS', 'K_USER_INFORMATION'],
  ProductRiskAssessment: ['B_RISK_ASSESSMENT'],
  ProductionControlTest: ['H_CALCULATIONS', 'I_TEST_REPORTS', 'J_PRODUCTION_CONTROL'],
  LabResult: ['H_CALCULATIONS', 'I_TEST_REPORTS'],
  Inspection: ['H_CALCULATIONS', 'J_PRODUCTION_CONTROL'],
  InspectionPlanVersion: ['J_PRODUCTION_CONTROL'],
  WorkInstructionVersion: ['E_EXPLANATIONS', 'J_PRODUCTION_CONTROL'],
  LabelTemplate: ['K_USER_INFORMATION'],
  MeasurementTemplate: ['L_SINGLE_UNIT', 'M_SERIES_FITTED'],
})
export const isEvidenceRecordType = (value: string): boolean => Object.hasOwn(EVIDENCE_RECORD_TYPES, value)

/**
 * The records whose files may be linked as evidence (StoredFile.recordType): the evidence records above, a file uploaded to
 * the technical file itself (a drawing, a calculation), a lot's lab reports and the notified body's answer to a type change.
 * Nothing else: a file of an invoice, an order or a pay record never becomes evidence (costs, prices and wages stay out).
 */
export const EVIDENCE_FILE_RECORD_TYPES: readonly string[] = Object.freeze([...Object.keys(EVIDENCE_RECORD_TYPES), 'TechnicalFile', 'Lot', 'TypeChangeReview'])
export const isEvidenceFileRecordType = (value: string): boolean => EVIDENCE_FILE_RECORD_TYPES.includes(value)

export interface ItemFacts {
  readonly point: AnnexIIIPoint
  readonly state: ItemState
}

export interface PointSummary {
  readonly point: AnnexIIIPoint
  readonly letter: string
  readonly state: PointState
  readonly items: number
}

/** A point's state from its items: none → NONE; any MISSING → MISSING; any LINKED → LINKED; all not applicable → NOT_APPLICABLE; else REVIEWED. */
export function pointState(items: readonly ItemFacts[]): PointState {
  if (items.length === 0) return 'NONE'
  if (items.some((item) => item.state === 'MISSING')) return 'MISSING'
  if (items.some((item) => item.state === 'LINKED')) return 'LINKED'
  if (items.every((item) => item.state === 'NOT_APPLICABLE')) return 'NOT_APPLICABLE'
  return 'REVIEWED'
}

const isDone = (state: PointState): boolean => state === 'REVIEWED' || state === 'NOT_APPLICABLE'

/** The checklist's progress (the grid's "9 of 13" bar: done out of outOf): each point's state, how many are done, the first open one, the items still missing. */
export function annexSummary(items: readonly ItemFacts[]): { readonly points: readonly PointSummary[]; readonly done: number; readonly outOf: number; readonly open: AnnexIIIPoint | null; readonly missingItems: number } {
  const points = ANNEX_III_POINTS.map((point) => {
    const own = items.filter((item) => item.point === point)
    return { point, letter: POINT_INFO[point].letter, state: pointState(own), items: own.length }
  })
  return {
    points,
    done: points.filter((entry) => isDone(entry.state)).length,
    outOf: ANNEX_III_POINTS.length,
    open: points.find((entry) => !isDone(entry.state))?.point ?? null,
    missingItems: items.filter((item) => item.state === 'MISSING').length + points.filter((entry) => entry.state === 'NONE').length,
  }
}

const pointWords = (point: AnnexIIIPoint): string => `(${POINT_INFO[point].letter}) ${POINT_INFO[point].en.toLowerCase()}`

/** Why the file cannot be completed now (empty: it can), as the database will check it. */
export function completeProblems(input: { readonly status: string; readonly items: readonly ItemFacts[]; readonly ppeCategory: string; readonly certificateId: string | null }): Issue[] {
  if (input.status !== 'OPEN') return [{ path: 'status', message: input.status === 'COMPLETE' ? 'The technical file is complete already.' : `The technical file is ${input.status}: it is completed only while OPEN.` }]
  const problems: Issue[] = []
  for (const entry of annexSummary(input.items).points) {
    if (entry.state === 'NONE') problems.push({ path: `points/${entry.point}`, message: `Point ${pointWords(entry.point)} has no evidence yet: link it and review it, or mark it not applicable.` })
    else if (entry.state === 'MISSING') problems.push({ path: `points/${entry.point}`, message: `Point ${pointWords(entry.point)} has an item still missing its evidence.` })
    else if (entry.state === 'LINKED') problems.push({ path: `points/${entry.point}`, message: `Point ${pointWords(entry.point)} has evidence not reviewed yet.` })
  }
  if (needsCertificate(input.ppeCategory) && input.certificateId === null) {
    problems.push({ path: 'certificateId', message: 'A category II or III style needs the EU type-examination certificate this file supports.' })
  }
  return problems
}

/** An item's evidence: exactly one record (an evidence model and its id) or one file, or none at all. */
export function evidenceProblems(input: { readonly recordType?: string | null | undefined; readonly recordId?: string | null | undefined; readonly fileId?: string | null | undefined }, at = 'body'): Issue[] {
  const record = input.recordType != null || input.recordId != null
  if (record && (input.recordType == null || input.recordId == null)) return [{ path: `${at}/recordId`, message: 'Name the evidence record by its type and id together.' }]
  if (record && input.fileId != null) return [{ path: `${at}/fileId`, message: 'An item links one record or one file, not both: add another item for the other.' }]
  if (input.recordType != null && !isEvidenceRecordType(input.recordType)) {
    return [{ path: `${at}/recordType`, message: `A ${input.recordType} is not evidence of a technical file: link one of ${Object.keys(EVIDENCE_RECORD_TYPES).join(', ')}, or a file.` }]
  }
  return []
}

// ---- the product risk assessment --------------------------------------------------------------------------------------------

export const HAZARDS = ['ABRASION', 'IMPACT', 'TEAR', 'SEAM_BURST', 'CUT', 'CHEMICAL', 'THERMAL', 'VISIBILITY', 'ERGONOMIC', 'OTHER'] as const
export type Hazard = (typeof HAZARDS)[number]
export const RESIDUAL_RISKS = ['NEGLIGIBLE', 'LOW', 'MEDIUM', 'HIGH'] as const
export type ResidualRisk = (typeof RESIDUAL_RISKS)[number]
export const ASSESSMENT_STATUSES = ['DRAFT', 'SIGNED', 'SUPERSEDED'] as const
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number]
/** A zone code of the garment zone map ("shoulder", "back-upper", "knee-left"). */
export const ZONE_CODE = /^[a-z][a-z0-9_-]{0,39}$/
export const RISK_ROWS_MAX = 200

export interface RiskRowInput {
  readonly hazard?: string | undefined
  readonly hazardNote?: string | null | undefined
  readonly garmentZone?: string | null | undefined
  readonly intendedUse?: string | undefined
  readonly foreseeableMisuse?: string | null | undefined
  readonly control?: string | undefined
  readonly standardClause?: string | null | undefined
  readonly residualRisk?: string | undefined
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): boolean => value == null || value.trim() === ''
const tooLong = (value: string | null | undefined, max: number): boolean => value != null && value.length > max

/** A hazard row's problems (the whole row as it will be written). */
export function riskRowProblems(row: RiskRowInput, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (!row.hazard || !(HAZARDS as readonly string[]).includes(row.hazard)) problems.push({ path: `${at}/hazard`, message: `Choose the hazard: ${HAZARDS.join(', ')}.` })
  if (row.hazard === 'OTHER' && (blank(row.hazardNote) || row.hazardNote!.trim().length < 3)) problems.push({ path: `${at}/hazardNote`, message: 'Name the other hazard in words (3 to 300 characters).' })
  if (tooLong(row.hazardNote, 300)) problems.push({ path: `${at}/hazardNote`, message: 'The hazard in words is up to 300 characters.' })
  if (row.garmentZone != null && !ZONE_CODE.test(row.garmentZone)) problems.push({ path: `${at}/garmentZone`, message: 'Name the zone by its code on the garment zone map ("shoulder", "knee-left"), or none for the whole garment.' })
  if (blank(row.intendedUse) || tooLong(row.intendedUse, 2000)) problems.push({ path: `${at}/intendedUse`, message: 'Say the intended use (1 to 2000 characters).' })
  if (blank(row.control) || tooLong(row.control, 2000)) problems.push({ path: `${at}/control`, message: 'Say how the hazard is controlled (1 to 2000 characters): the design, the material, the protector, the warning.' })
  if (tooLong(row.foreseeableMisuse, 2000)) problems.push({ path: `${at}/foreseeableMisuse`, message: 'The foreseeable misuse is up to 2000 characters.' })
  if (tooLong(row.standardClause, 100)) problems.push({ path: `${at}/standardClause`, message: 'The standard clause is up to 100 characters ("EN 17092-4:2020 6.3").' })
  if (!row.residualRisk || !(RESIDUAL_RISKS as readonly string[]).includes(row.residualRisk)) problems.push({ path: `${at}/residualRisk`, message: `Choose the residual risk: ${RESIDUAL_RISKS.join(', ')}.` })
  if (tooLong(row.note, 2000)) problems.push({ path: `${at}/note`, message: 'The note is up to 2000 characters.' })
  return problems
}

/** What signing a draft needs: at least one hazard, the signer's typed name and function. */
export function signProblems(input: { readonly status: string; readonly rows: number; readonly name: string; readonly function: string }): Issue[] {
  const problems: Issue[] = []
  if (input.status !== 'DRAFT') problems.push({ path: 'status', message: `This revision is ${input.status}: only a draft is signed (a change is the next revision).` })
  if (input.rows < 1) problems.push({ path: 'rows', message: 'Write at least one hazard before signing.' })
  if (blank(input.name) || input.name.length > 200) problems.push({ path: 'body/name', message: 'Type your name as you sign (1 to 200 characters).' })
  if (blank(input.function) || input.function.length > 200) problems.push({ path: 'body/function', message: 'Type your function (1 to 200 characters): the quality manager, the technical director.' })
  return problems
}

// ---- days and keeping (QHS-110) -------------------------------------------------------------------------------------------

export const RETAIN_YEARS = 10

const parts = (day: BusinessDate): [number, number, number] => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return [year, month, date]
}
const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()
const written = (year: number, month: number, date: number): BusinessDate => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`

/** The day `months` months on, kept to the month's last day (31 Jan + 1 month = 28 or 29 Feb), as PostgreSQL's interval does. */
export function addMonths(day: BusinessDate, months: number): BusinessDate {
  const [year, month, date] = parts(day)
  const index = year * 12 + (month - 1) + months
  const nextYear = Math.floor(index / 12)
  const nextMonth = (index % 12) + 1
  return written(nextYear, nextMonth, Math.min(date, daysIn(nextYear, nextMonth)))
}

/** The day `days` days on (or back, when negative). */
export function addDays(day: BusinessDate, days: number): BusinessDate {
  const [year, month, date] = parts(day)
  const at = new Date(Date.UTC(year, month - 1, date + days))
  return written(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate())
}

/** Kept until: ten years after the day of the fact (29 Feb → 28 Feb), the database's factory_techfiles_ten_years. */
export const retainUntilOf = (day: BusinessDate): BusinessDate => addMonths(day, RETAIN_YEARS * 12)

export const RETENTION_STATES = ['NOT_SET', 'KEPT', 'ENDS_WITHIN_YEAR', 'MAY_GO'] as const
export type RetentionState = (typeof RETENTION_STATES)[number]

/** Where a record's keeping stands today: not set (still open), kept, ending within a year, or past (the owner may purge it). */
export function retentionState(retainUntil: BusinessDate | null, today: BusinessDate): RetentionState {
  if (retainUntil === null) return 'NOT_SET'
  if (retainUntil < today) return 'MAY_GO'
  return retainUntil <= addMonths(today, 12) ? 'ENDS_WITHIN_YEAR' : 'KEPT'
}

// ---- production-control tests (QHS-048) ------------------------------------------------------------------------------------

export const TEST_KINDS = ['SEAM_STRENGTH', 'POCKET_RETENTION', 'LABEL_DURABILITY', 'ABRASION', 'TEAR_STRENGTH', 'IMPACT', 'DIMENSIONS', 'COLOUR_FASTNESS', 'OTHER'] as const
export type TestKind = (typeof TEST_KINDS)[number]
export const FREQUENCIES = ['EVERY_BATCH', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'ON_CHANGE', 'ONCE'] as const
export type Frequency = (typeof FREQUENCIES)[number]
export const TEST_RESULTS = ['PASS', 'FAIL'] as const
export type TestResult = (typeof TEST_RESULTS)[number]
/** How many days ahead a test counts as due soon (the tile's and the plan's). */
export const DUE_SOON_DAYS = 30

const MONTHS: Partial<Record<Frequency, number>> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 }

/** The next due day after a test on `day`, by its frequency; null when it has no next day (every batch, on a change, once). */
export function nextDueOn(day: BusinessDate, frequency: Frequency): BusinessDate | null {
  const months = MONTHS[frequency]
  return months === undefined ? null : addMonths(day, months)
}

export interface TestFacts {
  readonly id: string
  readonly test: TestKind
  readonly testName: string | null
  readonly frequency: Frequency
  readonly dueOn: BusinessDate
  readonly result: TestResult | null
  readonly testedOn: BusinessDate | null
  readonly workOrderId: string | null
  readonly batchNumber: string | null
}

export const PLAN_STATES = ['OVERDUE', 'DUE_SOON', 'PLANNED', 'EVERY_BATCH', 'ON_CHANGE', 'DONE'] as const
export type PlanState = (typeof PLAN_STATES)[number]

export interface PlanEntry {
  readonly test: TestKind
  readonly testName: string | null
  readonly frequency: Frequency
  readonly lastTestedOn: BusinessDate | null
  readonly lastResult: TestResult | null
  /** The first due test of the kind (planned), else the day after the last one by the frequency. */
  readonly nextDueOn: BusinessDate | null
  readonly dueTestId: string | null
  readonly state: PlanState
  readonly tests: number
}

const planKey = (test: Pick<TestFacts, 'test' | 'testName' | 'frequency'>): string => `${test.test}|${(test.testName ?? '').trim().toLowerCase()}|${test.frequency}`

/** The plan of periodic tests (design "what, how often, next due"): one entry per kind, name and frequency. */
export function testPlan(tests: readonly TestFacts[], today: BusinessDate): PlanEntry[] {
  const groups = new Map<string, TestFacts[]>()
  for (const test of tests) groups.set(planKey(test), [...(groups.get(planKey(test)) ?? []), test])
  const entries: PlanEntry[] = []
  for (const group of groups.values()) {
    const first = group[0]!
    const recorded = group.filter((test) => test.result !== null && test.testedOn !== null).sort((a, b) => (a.testedOn! < b.testedOn! ? 1 : a.testedOn! > b.testedOn! ? -1 : a.id < b.id ? 1 : -1))
    const due = group.filter((test) => test.result === null).sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.id < b.id ? -1 : 1))
    const last = recorded[0] ?? null
    const next = due[0]?.dueOn ?? (last ? nextDueOn(last.testedOn!, first.frequency) : null)
    let state: PlanState
    if (next !== null) state = next < today ? 'OVERDUE' : next <= addDays(today, DUE_SOON_DAYS) ? 'DUE_SOON' : 'PLANNED'
    else state = first.frequency === 'EVERY_BATCH' ? 'EVERY_BATCH' : first.frequency === 'ON_CHANGE' ? 'ON_CHANGE' : 'DONE'
    entries.push({ test: first.test, testName: first.testName, frequency: first.frequency, lastTestedOn: last?.testedOn ?? null, lastResult: last?.result ?? null, nextDueOn: next, dueTestId: due[0]?.id ?? null, state, tests: group.length })
  }
  const order = (state: PlanState): number => PLAN_STATES.indexOf(state)
  return entries.sort((a, b) => order(a.state) - order(b.state) || (a.nextDueOn ?? '9999').localeCompare(b.nextDueOn ?? '9999') || a.test.localeCompare(b.test))
}

export interface TestPlanInput {
  readonly test?: string | undefined
  readonly testName?: string | null | undefined
  readonly frequency?: string | undefined
  readonly dueOn?: string | undefined
  readonly standardClause?: string | null | undefined
  readonly sample?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly workOrderId?: string | null | undefined
  readonly note?: string | null | undefined
}

/** A planned test's problems (the database's words, said first). */
export function testPlanProblems(input: TestPlanInput, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (!input.test || !(TEST_KINDS as readonly string[]).includes(input.test)) problems.push({ path: `${at}/test`, message: `Choose the test: ${TEST_KINDS.join(', ')}.` })
  if (input.test === 'OTHER' && blank(input.testName)) problems.push({ path: `${at}/testName`, message: 'Name the other test (1 to 200 characters).' })
  if (tooLong(input.testName, 200)) problems.push({ path: `${at}/testName`, message: 'The test name is up to 200 characters.' })
  if (!input.frequency || !(FREQUENCIES as readonly string[]).includes(input.frequency)) problems.push({ path: `${at}/frequency`, message: `Choose how often it is due: ${FREQUENCIES.join(', ')}.` })
  if (!input.dueOn || !isBusinessDate(input.dueOn)) problems.push({ path: `${at}/dueOn`, message: 'Give the day it is due (YYYY-MM-DD).' })
  if (input.workOrderId != null && input.batchNumber != null) problems.push({ path: `${at}/batchNumber`, message: 'Name a work order (its batch) or a batch number typed, not both.' })
  if (input.batchNumber != null && (blank(input.batchNumber) || input.batchNumber.length > 60)) problems.push({ path: `${at}/batchNumber`, message: 'The batch number is 1 to 60 characters.' })
  if (tooLong(input.standardClause, 100)) problems.push({ path: `${at}/standardClause`, message: 'The standard clause is up to 100 characters.' })
  if (tooLong(input.sample, 500)) problems.push({ path: `${at}/sample`, message: 'The sample is up to 500 characters.' })
  if (tooLong(input.note, 2000)) problems.push({ path: `${at}/note`, message: 'The note is up to 2000 characters.' })
  return problems
}

export interface TestRecordInput {
  readonly result?: string | undefined
  readonly testedOn?: string | undefined
  readonly testedBy?: string | undefined
  readonly reportNumber?: string | null | undefined
  readonly resultNote?: string | null | undefined
}

/** Recording a result: PASS or FAIL, a day that has come, who tested it, a FAIL says what failed. */
export function testRecordProblems(input: TestRecordInput, today: BusinessDate, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (!input.result || !(TEST_RESULTS as readonly string[]).includes(input.result)) problems.push({ path: `${at}/result`, message: 'Choose the result: PASS or FAIL.' })
  if (!input.testedOn || !isBusinessDate(input.testedOn)) problems.push({ path: `${at}/testedOn`, message: 'Give the day it was tested (YYYY-MM-DD).' })
  else if (input.testedOn > today) problems.push({ path: `${at}/testedOn`, message: `The test day has to have come (today is ${today}).` })
  if (blank(input.testedBy) || input.testedBy!.length > 200) problems.push({ path: `${at}/testedBy`, message: 'Say who tested it: the lab or the person (1 to 200 characters).' })
  if (input.reportNumber != null && (blank(input.reportNumber) || input.reportNumber.length > 100)) problems.push({ path: `${at}/reportNumber`, message: 'The report number is 1 to 100 characters.' })
  if (input.result === 'FAIL' && (blank(input.resultNote) || input.resultNote!.trim().length < 3)) problems.push({ path: `${at}/resultNote`, message: 'A failed test says what failed (3 or more characters).' })
  if (tooLong(input.resultNote, 2000)) problems.push({ path: `${at}/resultNote`, message: 'The result note is up to 2000 characters.' })
  return problems
}

// ---- conformity to type per batch (PRD-302) -------------------------------------------------------------------------------

export const BATCH_STATES = ['COMPLETE', 'MISSING', 'FAILED', 'IN_PROGRESS'] as const
export type BatchState = (typeof BATCH_STATES)[number]
export const MISSING_CODES = ['FINAL_INSPECTION', 'RELEASE', 'TEST'] as const
export type MissingCode = (typeof MISSING_CODES)[number]

export interface BatchFacts {
  /** The work order is done (completed, closed) or has released garments. */
  readonly done: boolean
  /** The newest final inspection's status (OPEN, PASSED, FAILED; CANCELLED ones left out), or null. */
  readonly finalStatus: string | null
  readonly passedInspections: number
  readonly releases: number
  /** The style's every-batch tests (kind and name). */
  readonly required: readonly { readonly test: TestKind; readonly testName: string | null }[]
  /** This batch's recorded tests, newest first. */
  readonly recorded: readonly { readonly test: TestKind; readonly testName: string | null; readonly result: TestResult }[]
}

export interface BatchEvidence {
  readonly state: BatchState
  readonly missing: readonly { readonly code: MissingCode; readonly test: TestKind | null; readonly testName: string | null; readonly words: string }[]
  readonly failed: readonly string[]
}

const sameTest = (a: { test: string; testName: string | null }, b: { test: string; testName: string | null }): boolean =>
  a.test === b.test && (a.testName ?? '').trim().toLowerCase() === (b.testName ?? '').trim().toLowerCase()
const testWords = (test: { test: string; testName: string | null }): string => (test.testName ? `${test.test.replace(/_/g, ' ').toLowerCase()} (${test.testName})` : test.test.replace(/_/g, ' ').toLowerCase())

/**
 * A batch's evidence that production still matches the certified type: a final inspection passed, garments released, and
 * every test the style plans for every batch recorded for it. A failed test (its newest result) or a final inspection that
 * failed with none passed after it makes the batch FAILED; what is missing makes it MISSING once the work is done, IN_PROGRESS
 * before.
 */
export function batchEvidence(facts: BatchFacts): BatchEvidence {
  const missing: BatchEvidence['missing'][number][] = []
  const failed: string[] = []
  if (facts.passedInspections === 0) missing.push({ code: 'FINAL_INSPECTION', test: null, testName: null, words: 'No final inspection passed.' })
  if (facts.releases === 0) missing.push({ code: 'RELEASE', test: null, testName: null, words: 'No garments released.' })
  if (facts.finalStatus === 'FAILED' && facts.passedInspections === 0) failed.push('The final inspection failed.')
  const seen: { test: string; testName: string | null }[] = []
  for (const test of facts.recorded) {
    if (seen.some((other) => sameTest(other, test))) continue
    seen.push(test)
    if (test.result === 'FAIL') failed.push(`The ${testWords(test)} test failed.`)
  }
  for (const required of facts.required) {
    if (!facts.recorded.some((test) => sameTest(test, required))) missing.push({ code: 'TEST', test: required.test, testName: required.testName, words: `No ${testWords(required)} test recorded for this batch.` })
  }
  const state: BatchState = failed.length > 0 ? 'FAILED' : missing.length === 0 ? 'COMPLETE' : facts.done ? 'MISSING' : 'IN_PROGRESS'
  return { state, missing, failed }
}

// ---- evidence packs (PRD-299) -------------------------------------------------------------------------------------------

/** A technical file's pack is for an authority or a customer (a shipment's pack is the shipping documents' step). */
export const PACK_PURPOSES = ['AUTHORITY', 'CUSTOMER'] as const
export type PackPurpose = (typeof PACK_PURPOSES)[number]
export const PACK_STATUSES = ['BUILDING', 'BUILT', 'FAILED'] as const
export type PackStatus = (typeof PACK_STATUSES)[number]
/** The contents checklist (design tf-pack: all on by default). */
export const PACK_CONTENTS = ['TECHFILE_INDEX', 'RISK_ASSESSMENT', 'DOC', 'USER_INFORMATION', 'CERTIFICATES', 'TEST_REPORTS', 'PRODUCTION_CONTROL', 'INSPECTIONS', 'LABELS', 'CR6'] as const
export type PackContent = (typeof PACK_CONTENTS)[number]
export const PACK_SCOPES = ['STYLE', 'BATCHES', 'SERIALS', 'SHIPMENT'] as const
export type PackScopeKind = (typeof PACK_SCOPES)[number]
/** The design's line, printed on every pack: what a pack never holds. */
export const NEVER_IN_A_PACK = 'Costs, prices and wages are never included.'
export const PACK_LIMITS = Object.freeze({
  /** Batches a pack covers at most (a style's scope takes the newest released ones). */
  batches: 50,
  batchNumbers: 100,
  /** Documents (files) one pack lists at most. */
  documents: 500,
  /** The ZIP's size at most (the file store's largest document). */
  zipBytes: 25 * 1024 * 1024,
})
/** A link's end at most (DOCUMENT_VIEW: 365 days). */
export const PACK_LINK_DAYS_MAX = 365

export interface PackScope {
  readonly kind: PackScopeKind
  readonly batchNumbers?: readonly string[] | undefined
  readonly serialFrom?: string | undefined
  readonly serialTo?: string | undefined
  readonly shipmentId?: string | undefined
}

export interface PackRequest {
  readonly purpose: string
  readonly language: string
  readonly recipient: string
  readonly scope: PackScope
  readonly include: readonly string[]
  readonly note?: string | null | undefined
}

/** An evidence pack request's problems. */
export function packRequestProblems(input: PackRequest, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (!(PACK_PURPOSES as readonly string[]).includes(input.purpose)) problems.push({ path: `${at}/purpose`, message: 'A technical file builds a pack for an AUTHORITY or a CUSTOMER.' })
  if (!/^[a-z]{2,3}$/.test(input.language)) problems.push({ path: `${at}/language`, message: 'Give the language the recipient understands (ISO 639: "de", "it").' })
  if (blank(input.recipient) || input.recipient.length > 300) problems.push({ path: `${at}/recipient`, message: 'Name who it is for (1 to 300 characters): the market surveillance authority, the customer.' })
  if (input.include.length === 0) problems.push({ path: `${at}/include`, message: 'Choose at least one kind of document.' })
  for (const [index, kind] of input.include.entries()) {
    if (!(PACK_CONTENTS as readonly string[]).includes(kind)) problems.push({ path: `${at}/include/${index}`, message: `Choose among ${PACK_CONTENTS.join(', ')}.` })
    else if (input.include.indexOf(kind) !== index) problems.push({ path: `${at}/include/${index}`, message: `${kind} is chosen twice.` })
  }
  const scope = input.scope
  if (scope.kind === 'BATCHES') {
    const numbers = scope.batchNumbers ?? []
    if (numbers.length === 0 || numbers.length > PACK_LIMITS.batchNumbers) problems.push({ path: `${at}/scope/batchNumbers`, message: `Name 1 to ${PACK_LIMITS.batchNumbers} batch numbers.` })
    for (const [index, number] of numbers.entries()) if (blank(number) || number.length > 60) problems.push({ path: `${at}/scope/batchNumbers/${index}`, message: 'A batch number is 1 to 60 characters.' })
  }
  if (scope.kind === 'SERIALS') {
    if (blank(scope.serialFrom) || blank(scope.serialTo)) problems.push({ path: `${at}/scope/serialFrom`, message: 'Give the first and the last serial of the range.' })
    else if (scope.serialFrom!.trim().toUpperCase() > scope.serialTo!.trim().toUpperCase()) problems.push({ path: `${at}/scope/serialTo`, message: 'The last serial comes after the first.' })
  }
  if (scope.kind === 'SHIPMENT' && !scope.shipmentId) problems.push({ path: `${at}/scope/shipmentId`, message: 'Choose the shipment.' })
  if (tooLong(input.note, 2000)) problems.push({ path: `${at}/note`, message: 'The note is up to 2000 characters.' })
  return problems
}

export interface ManifestEntry {
  readonly title: string
  readonly sha256: string
}

/** The text the pack's fingerprint is the SHA-256 of: its number, then one line per document ("<sha256>  <title>"), in order. */
export function manifestText(number: string, entries: readonly ManifestEntry[]): string {
  return [`Nexus Factory evidence pack ${number}`, ...entries.map((entry) => `${entry.sha256}  ${entry.title}`)].join('\n') + '\n'
}

/** A file name within the pack's ZIP: no folders, no characters a file system refuses, at most 120 characters. */
export function zipSafeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim()
  return (cleaned === '' || cleaned === '.' || cleaned === '..' ? 'document' : cleaned).slice(0, 120)
}
