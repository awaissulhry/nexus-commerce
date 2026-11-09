import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { DefectClass } from '@nexus/factory-domain/quality/defects/rules'
import {
  identitySummary,
  mtmPoints,
  scansOf,
  stopRuleOf,
  type IdentityMode,
  type IdentitySummary,
  type MeasurementRow,
  type MtmPoint,
  type PlanCandidate,
  type PlanCheck,
  type ResultOutcome,
  type ResultRow,
} from '@nexus/factory-domain/quality/final/plan'
import type { CheckType, Chip, ChipKind } from '@nexus/factory-domain/quality/plans/rules'
import type { CommandCaller } from '../../../core/command'
import { asTenantSystem } from '../../production/serials/facts'
import { readCells, readStyle, type LabelHeader } from '../../production/serials/store'
import type { InspectionRow, Reader } from './store'

/**
 * The reads of a final inspection on a plan (B-W2b-97): the plan version frozen on it and its checks, the results and
 * measurements recorded, the photos of the results, the stop rule, the serial or batch check's facts and the rider's
 * measurement profile of a made-to-measure unit. Every read names its columns and selects no relation. A floor device
 * reads the plan, its records and the work order's serials as itself (row-level security: its own site); the photos of
 * the results (the office's too), the style and a rider's profile and template it reads through the tenant's system view
 * (`factsReader`): the floor role sees only its site's floor files and no party data, and the bench must count every photo.
 */

export const VERSION_COLUMNS = { id: true, companyId: true, planId: true, number: true, status: true, samplingMethod: true, aqlProfileId: true, fixedSampleSize: true, stopAtReject: true } as const satisfies Prisma.InspectionPlanVersionSelect
export type VersionRow = Prisma.InspectionPlanVersionGetPayload<{ select: typeof VERSION_COLUMNS }>

const CHECK_COLUMNS = { id: true, planVersionId: true, sortOrder: true, code: true, labelIt: true, labelEn: true, labelI18n: true, type: true, checkClass: true, mandatory: true, photoRequired: true, nominal: true, tolerance: true, uom: true, choices: true } as const satisfies Prisma.InspectionPlanCheckSelect
type CheckDbRow = Prisma.InspectionPlanCheckGetPayload<{ select: typeof CHECK_COLUMNS }>

export const RESULT_COLUMNS = { id: true, planCheckId: true, sampleIndex: true, outcome: true, value: true, note: true, recordedById: true, recordedByWorkerId: true, deviceId: true, recordedAt: true, version: true } as const satisfies Prisma.InspectionCheckResultSelect
export type ResultDbRow = Prisma.InspectionCheckResultGetPayload<{ select: typeof RESULT_COLUMNS }>

export const MEASUREMENT_COLUMNS = { id: true, planCheckId: true, pointCode: true, size: true, sampleIndex: true, nominal: true, tolerance: true, measured: true, uom: true, pass: true, recordedById: true, recordedByWorkerId: true, deviceId: true, recordedAt: true, version: true } as const satisfies Prisma.InspectionMeasurementSelect
export type MeasurementDbRow = Prisma.InspectionMeasurementGetPayload<{ select: typeof MEASUREMENT_COLUMNS }>

/** The record type of a result's photos (StoredFile). */
export const RESULT_RECORD = 'InspectionCheckResult'

/** The plan a record runs on: the frozen version, its plan and its checks in order (with their words in other languages). */
export interface Binding {
  readonly version: VersionRow
  readonly plan: { readonly id: string; readonly code: string; readonly name: string }
  readonly checks: readonly PlanCheck[]
  /** The checks' words in the floor's other languages, by check id. */
  readonly words: ReadonlyMap<string, Readonly<Record<string, string>>>
}

const decimal = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed(3))
const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

export const checkOf = (row: CheckDbRow): PlanCheck => ({
  id: row.id,
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  type: row.type as CheckType,
  checkClass: (row.checkClass as DefectClass | null) ?? null,
  mandatory: row.mandatory,
  photoRequired: row.photoRequired,
  nominal: decimal(row.nominal),
  tolerance: decimal(row.tolerance),
  uom: (row.uom as Uom | null) ?? null,
  choices: [...row.choices],
})

export async function readBinding(db: Reader, planVersionId: string): Promise<Binding> {
  const version = await db.inspectionPlanVersion.findUnique({ where: { id: planVersionId }, select: VERSION_COLUMNS })
  if (!version) throw new NotFoundError('The plan version of this inspection was not found.')
  const plan = await db.inspectionPlan.findUnique({ where: { id: version.planId }, select: { id: true, code: true, name: true } })
  if (!plan) throw new NotFoundError('The plan of this inspection was not found.')
  const rows = await db.inspectionPlanCheck.findMany({ where: { planVersionId }, select: CHECK_COLUMNS, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
  return { version, plan, checks: rows.map(checkOf), words: new Map(rows.map((row) => [row.id, wordsOf(row.labelI18n)])) }
}

/** The binding of an inspection on a plan; one without a plan is W1's (409 in words: its routes are the checklist's). */
export async function bindingOf(db: Reader, row: Pick<InspectionRow, 'planVersionId'>): Promise<Binding> {
  if (!row.planVersionId) throw new InvalidStateError("This inspection was opened without a plan: it runs W1's fixed checklist (PATCH …/:inspectionId), not a plan's checks.")
  return readBinding(db, row.planVersionId)
}

export const resultsOf = (db: Reader, inspectionId: string): Promise<ResultDbRow[]> =>
  db.inspectionCheckResult.findMany({ where: { inspectionId }, select: RESULT_COLUMNS, orderBy: [{ planCheckId: 'asc' }, { sampleIndex: 'asc' }] })

export const measurementsOf = (db: Reader, inspectionId: string): Promise<MeasurementDbRow[]> =>
  db.inspectionMeasurement.findMany({ where: { inspectionId }, select: MEASUREMENT_COLUMNS, orderBy: [{ pointCode: 'asc' }, { size: 'asc' }, { sampleIndex: 'asc' }] })

/** The photos of results (not deleted; available or waiting for the upload to finish), by result id. */
export async function photosOf(db: Reader, resultIds: readonly string[]): Promise<Map<string, { id: string; status: string; createdAt: Date }[]>> {
  if (resultIds.length === 0) return new Map()
  const files = await db.storedFile.findMany({ where: { recordType: RESULT_RECORD, recordId: { in: [...resultIds] }, kind: 'PHOTO', status: { notIn: ['DELETED', 'PENDING_UPLOAD'] } }, select: { id: true, recordId: true, status: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, { id: string; status: string; createdAt: Date }[]>()
  for (const file of files) out.set(file.recordId, [...(out.get(file.recordId) ?? []), { id: file.id, status: file.status, createdAt: file.createdAt }])
  return out
}

export const resultRow = (row: ResultDbRow, photos: number): ResultRow => ({ id: row.id, planCheckId: row.planCheckId, sampleIndex: row.sampleIndex, outcome: row.outcome as ResultOutcome, value: row.value, note: row.note, photos })

export const measurementRow = (row: MeasurementDbRow): MeasurementRow => ({
  id: row.id,
  planCheckId: row.planCheckId,
  pointCode: row.pointCode,
  size: row.size,
  sampleIndex: row.sampleIndex,
  nominal: row.nominal.toFixed(3),
  tolerance: row.tolerance.toFixed(3),
  measured: row.measured.toFixed(3),
  uom: row.uom as Uom,
  pass: row.pass,
})

/** A reader for what the floor role may not read (photos of every audience, the style, a rider's profile): the tenant's system view. */
export const factsReader = (caller: CommandCaller): CommandCaller => (caller.factoryContext?.audience === 'floor' ? asTenantSystem(caller) : caller)

/** Stop at the reject number or finish the sample: the plan version's, else the company's row, the tenant's, else finish. */
export async function stopRule(db: Reader, tenantId: string, companyId: string, planStop: boolean | null) {
  const rows = await db.qualitySettings.findMany({ where: { id: { in: [companyId, tenantId] } }, select: { id: true, stopAtRejectNumber: true } })
  return stopRuleOf({ plan: planStop, company: rows.find((row) => row.id === companyId)?.stopAtRejectNumber ?? null, tenant: rows.find((row) => row.id === tenantId)?.stopAtRejectNumber ?? null })
}

/** The serial or batch check of an inspection: its mode (the style's tracking), the work order's serials waiting for a release, its batch. */
export async function identityFacts(db: Reader, header: Pick<LabelHeader, 'id' | 'styleId' | 'batchNumber'>, row: Pick<InspectionRow, 'lotSize' | 'checklist'>): Promise<{ mode: IdentityMode; summary: IdentitySummary; scans: ReturnType<typeof scansOf>; expected: { id: string; serial: string }[] }> {
  const style = await readStyle(db, header.styleId)
  const mode: IdentityMode = style?.tracking === 'SERIAL' ? 'SERIAL' : 'BATCH'
  const expected = mode === 'SERIAL' ? await db.garmentSerial.findMany({ where: { workOrderId: header.id, status: 'MADE' }, select: { id: true, serial: true }, orderBy: [{ serial: 'asc' }] }) : []
  const scans = scansOf(row.checklist)
  return { mode, scans, expected, summary: identitySummary({ mode, expected: expected.map((serial) => serial.serial), batchNumber: header.batchNumber, lotSize: row.lotSize, scans }) }
}

/** The made-to-measure unit of a work order (QHS-053): its base size and the rider's profile points; null for a size-grid work order. */
export interface MtmFacts {
  readonly size: string
  readonly points: readonly MtmPoint[]
  readonly profile: { readonly id: string; readonly garmentType: string; readonly revision: number }
  /** The template asks points the profile has no value for. */
  readonly pointsWithout: readonly string[]
}

/**
 * The rider's measurement profile revision of the work order's made-to-measure cell (the order line's), read against the
 * style's measurement template (PRD-200). Never the rider's name (personal data: the bench needs only the values). Read
 * through `factsReader` (the floor reads no party data).
 */
export async function mtmFacts(db: Reader, header: Pick<LabelHeader, 'id' | 'styleId'>): Promise<MtmFacts | null> {
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: header.id, measurementProfileId: { not: null } }, select: { size: true, measurementProfileId: true }, take: 2 })
  const cell = cells[0]
  if (!cell || !cell.measurementProfileId) return null
  const profile = await db.measurementProfile.findUnique({ where: { id: cell.measurementProfileId }, select: { id: true, garmentType: true, revision: true, measurements: true } })
  if (!profile) return null
  const style = await db.style.findUnique({ where: { id: header.styleId }, select: { measurementTemplateId: true } })
  const template = style?.measurementTemplateId
    ? await db.measurementTemplate.findUnique({ where: { id: style.measurementTemplateId }, select: { id: true } })
    : await db.measurementTemplate.findFirst({ where: { code: profile.garmentType }, select: { id: true } })
  const points = template ? await db.measurementPoint.findMany({ where: { templateId: template.id, status: 'ACTIVE' }, select: { code: true, name: true, uom: true }, orderBy: [{ seq: 'asc' }] }) : []
  const valued = mtmPoints(points.map((point) => ({ code: point.code, name: point.name, uom: point.uom as Uom })), profile.measurements)
  return { size: cell.size, points: valued, profile: { id: profile.id, garmentType: profile.garmentType, revision: profile.revision }, pointsWithout: points.filter((point) => !valued.some((entry) => entry.code === point.code)).map((point) => point.name) }
}

// ---- which plan applies ----------------------------------------------------------------------------------------------------

const chipsOf = (value: Prisma.JsonValue): Chip[] =>
  Array.isArray(value) ? value.flatMap((chip) => (chip && typeof chip === 'object' && !Array.isArray(chip) && typeof chip.kind === 'string' && typeof chip.value === 'string' ? [{ kind: chip.kind as ChipKind, value: chip.value }] : [])) : []

/** The company's FINAL plans with the version in force (at most one APPROVED per plan). */
export async function finalPlans(db: Reader, companyId: string): Promise<PlanCandidate[]> {
  const plans = await db.inspectionPlan.findMany({ where: { companyId, stage: 'FINAL' }, select: { id: true, code: true, name: true, appliesTo: true }, orderBy: [{ code: 'asc' }] })
  if (plans.length === 0) return []
  const approved = await db.inspectionPlanVersion.findMany({ where: { planId: { in: plans.map((plan) => plan.id) }, status: 'APPROVED' }, select: { id: true, planId: true, number: true } })
  return plans.map((plan) => {
    const version = approved.find((row) => row.planId === plan.id)
    return { id: plan.id, code: plan.code, name: plan.name, appliesTo: chipsOf(plan.appliesTo), approved: version ? { id: version.id, number: version.number } : null }
  })
}

/** What a work order's final inspection knows to match a plan's chips: its style, the style's category, its customers. */
export async function workOrderFacts(db: Reader, header: Pick<LabelHeader, 'id' | 'styleId'>): Promise<{ facts: Partial<Record<ChipKind, string[]>>; productType: string | null; customerIds: string[] }> {
  const style = await db.style.findUnique({ where: { id: header.styleId }, select: { productType: true } })
  const customerIds = [...new Set((await readCells(db, header.id)).map((cell) => cell.partyId))]
  return { facts: { STYLE: [header.styleId], CATEGORY: style ? [style.productType] : [], CUSTOMER: customerIds }, productType: style?.productType ?? null, customerIds }
}

/** The FINAL plan a body names, of the work order's company, with its version in force. */
export async function namedPlan(db: Reader, companyId: string, planId: string): Promise<{ plan: PlanCandidate; version: VersionRow }> {
  const at = 'body/planId'
  const plan = isUuid(planId) ? await db.inspectionPlan.findUnique({ where: { id: planId }, select: { id: true, companyId: true, code: true, name: true, stage: true, appliesTo: true } }) : null
  if (!plan || plan.companyId !== companyId) throw new ValidationError("Not an inspection plan of the work order's company.", [{ path: at, message: "Not an inspection plan of the work order's company." }])
  if (plan.stage !== 'FINAL') throw new ValidationError(`${plan.code} is a plan of another stage: a final inspection runs a FINAL plan.`, [{ path: at, message: `${plan.code} is a plan of another stage: a final inspection runs a FINAL plan.` }])
  const version = await db.inspectionPlanVersion.findFirst({ where: { planId: plan.id, status: 'APPROVED' }, select: VERSION_COLUMNS })
  if (!version) throw new InvalidStateError(`${plan.code} has no approved version: a second person approves a version before an inspection runs on it (QHS-016).`)
  return { plan: { id: plan.id, code: plan.code, name: plan.name, appliesTo: chipsOf(plan.appliesTo), approved: { id: version.id, number: version.number } }, version }
}

/** Words for the chips that made a plan apply: "category Jacket, customer Example Moto". */
export async function becauseWords(db: Reader, chips: readonly Chip[]): Promise<string> {
  if (chips.length === 0) return 'it applies to every final inspection'
  const parties = chips.filter((chip) => chip.kind === 'CUSTOMER' && isUuid(chip.value)).map((chip) => chip.value)
  const styles = chips.filter((chip) => chip.kind === 'STYLE' && isUuid(chip.value)).map((chip) => chip.value)
  const partyNames = new Map((parties.length ? await db.party.findMany({ where: { id: { in: parties } }, select: { id: true, legalName: true, tradeName: true } }) : []).map((row) => [row.id, row.tradeName ?? row.legalName]))
  const styleNames = new Map((styles.length ? await db.style.findMany({ where: { id: { in: styles } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
  return chips
    .map((chip) => {
      if (chip.kind === 'CUSTOMER') return `customer ${partyNames.get(chip.value) ?? chip.value}`
      if (chip.kind === 'STYLE') return `style ${styleNames.get(chip.value) ?? chip.value}`
      if (chip.kind === 'CATEGORY') return `category ${chip.value.charAt(0)}${chip.value.slice(1).toLowerCase()}`
      return `${chip.kind.toLowerCase()} ${chip.value}`
    })
    .join(', ')
}
