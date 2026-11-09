import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { MeasurementSpecView, PomRow } from '@nexus/factory-domain/product/measures/contracts'
import {
  measureText,
  missingCells,
  pointOrder,
  specEditRefusal,
  toleranceWords,
  type PomFields,
  type PomKind,
  type PomStatus,
  type PomUom,
  type PomUse,
  type PomZone,
  type SpecPoint,
  type SpecStatus,
  type SpecValue,
  type ValueSource,
  type Words,
} from '@nexus/factory-domain/product/measures/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { findRevision, lockStyleRow, revisionViewOf, STYLE_COLUMNS, type BomStyleRow, type LockedStyle, type RevisionRow } from '../bom/store'
import { requireEditRule } from '../lifecycle/edit-rule'
import { contextOf, mayWrite } from '../materials/store'

/**
 * The points of measure and the measurement spec's rows (factory-db `PointOfMeasure`, `MeasurementSpec`,
 * `MeasurementSpecValue`, B-W2b-210) and what they name (`Style`, `StyleRevision`, `Size`, `GradeRule`): the columns every
 * read names (no relation selects: inside a transaction Prisma would send them at once on its one connection), how they
 * become the views, who may, and the locks the spec's writes take.
 *
 * Who may: the library (points of measure, grade rules) is the Sizes & measurements page's, as the size scales:
 * product.styles.view | manage over the point's company (a tenant-wide point only by a role over every company). The
 * spec is a part of the style's revision, as its BOM and pattern pieces: product.bom.view | manage over the style's
 * company; approving and reopening it is product.bom.release (the person who releases the revision says what it is
 * measured against).
 *
 * Lock order of a spec write (the BOM's, B-W1-13): the style row (FOR UPDATE), the edit rule of the style's state
 * (B-W2b-221, kind DRAFT), the revision checked a DRAFT (409 in words before the database's own refusal), then the spec
 * row FOR UPDATE and its version compared (409 on a stale one), then the values. The …_product_guards part rule takes the
 * revision FOR SHARE meanwhile.
 */

export { contextOf }

export const POM_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  description: true,
  howTo: true,
  howToI18n: true,
  pictureFileId: true,
  kind: true,
  bodyZone: true,
  uom: true,
  defaultTolerance: true,
  bodyPointId: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PointOfMeasureSelect
export type PomRowData = Prisma.PointOfMeasureGetPayload<{ select: typeof POM_COLUMNS }>

export const SPEC_COLUMNS = {
  id: true,
  styleId: true,
  revisionId: true,
  baseSize: true,
  status: true,
  gradeRuleId: true,
  approvedAt: true,
  approvedById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MeasurementSpecSelect
export type SpecRowData = Prisma.MeasurementSpecGetPayload<{ select: typeof SPEC_COLUMNS }>

export const VALUE_COLUMNS = { id: true, pointOfMeasureId: true, size: true, seq: true, nominal: true, toleranceMinus: true, tolerancePlus: true, source: true } as const satisfies Prisma.MeasurementSpecValueSelect

type Client = FactoryClient | CommandTx

const wordsOf = (value: Prisma.JsonValue | null): Words | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : null
const decimal = (value: { toString(): string } | null): string | null => (value === null ? null : measureText(value.toString()))

/** A row as the domain's point fields. */
export function pomFieldsOf(row: PomRowData): PomFields {
  return {
    code: row.code,
    name: row.name,
    nameI18n: wordsOf(row.nameI18n),
    description: row.description,
    howTo: row.howTo,
    howToI18n: wordsOf(row.howToI18n),
    kind: row.kind as PomKind,
    bodyZone: row.bodyZone as PomZone,
    uom: row.uom as PomUom,
    defaultTolerance: decimal(row.defaultTolerance),
    bodyPointId: row.bodyPointId,
  }
}

// ---- who may ------------------------------------------------------------------------------------------------------------

export const POM_SCOPE = { company: { field: 'companyId', nullable: true } } as const

export function assertMayWrite(context: RequestContext, permission: Permission, companyId: string | null, what: string): void {
  if (!mayWrite(actorOf(context), permission, companyId)) throw new ForbiddenError(companyId === null ? `A ${what} for every company is changed only by a role over every company.` : undefined)
}

/** The point as the caller may see it; another company's (outside the caller's grants) or another tenant's is not found. */
export async function readPomFor(caller: CommandCaller, pomId: string): Promise<PomRowData> {
  const context = contextOf(caller)
  const row = isUuid(pomId) ? await caller.withClient((client) => client.pointOfMeasure.findUnique({ where: { id: pomId }, select: POM_COLUMNS })) : null
  if (!row || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: row.companyId })) throw new NotFoundError('Point of measure not found.')
  return row
}

/** What names each point: template points, spec values (and their specs), grade steps (and their rules), garment points. */
export async function pomUses(client: Client, ids: readonly string[]): Promise<Map<string, PomUse & { specs: number; gradeRules: number }>> {
  const out = new Map(ids.map((id) => [id, { templatePoints: 0, specValues: 0, gradeSteps: 0, garmentPoints: 0, specs: 0, gradeRules: 0 }]))
  if (ids.length === 0) return out
  const where = { pointOfMeasureId: { in: [...ids] } }
  for (const row of await client.measurementPoint.groupBy({ by: ['pointOfMeasureId'], where, _count: { _all: true } })) if (row.pointOfMeasureId) out.get(row.pointOfMeasureId)!.templatePoints = row._count._all
  for (const row of await client.measurementSpecValue.groupBy({ by: ['pointOfMeasureId'], where, _count: { _all: true } })) out.get(row.pointOfMeasureId)!.specValues = row._count._all
  for (const row of await client.measurementSpecValue.groupBy({ by: ['pointOfMeasureId', 'specId'], where })) out.get(row.pointOfMeasureId)!.specs += 1
  for (const row of await client.gradeRuleStep.groupBy({ by: ['pointOfMeasureId'], where, _count: { _all: true } })) out.get(row.pointOfMeasureId)!.gradeSteps = row._count._all
  for (const row of await client.gradeRuleStep.groupBy({ by: ['pointOfMeasureId', 'ruleId'], where })) out.get(row.pointOfMeasureId)!.gradeRules += 1
  for (const row of await client.pointOfMeasure.groupBy({ by: ['bodyPointId'], where: { bodyPointId: { in: [...ids] } }, _count: { _all: true } })) if (row.bodyPointId) out.get(row.bodyPointId)!.garmentPoints = row._count._all
  return out
}

/** The list row of a point (its body point named, not just its id). */
export function pomRowOf(row: PomRowData, bodyPoints: ReadonlyMap<string, { id: string; code: string; name: string }>): PomRow {
  const fields = pomFieldsOf(row)
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    nameI18n: fields.nameI18n,
    description: row.description,
    howTo: row.howTo,
    howToI18n: fields.howToI18n,
    kind: fields.kind,
    bodyZone: fields.bodyZone,
    uom: fields.uom,
    defaultTolerance: fields.defaultTolerance,
    bodyPoint: row.bodyPointId ? (bodyPoints.get(row.bodyPointId) ?? null) : null,
    hasPicture: row.pictureFileId !== null,
    status: row.status as PomStatus,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The body points the rows name (by id). */
export async function bodyPointsOf(client: Client, rows: readonly Pick<PomRowData, 'bodyPointId'>[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const ids = [...new Set(rows.flatMap((row) => (row.bodyPointId ? [row.bodyPointId] : [])))]
  if (ids.length === 0) return new Map()
  const found = await client.pointOfMeasure.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } })
  return new Map(found.map((row) => [row.id, row]))
}

// ---- the spec: reads ----------------------------------------------------------------------------------------------------

export interface ValueRecord extends SpecValue {}

export async function readValues(client: Client, specId: string): Promise<ValueRecord[]> {
  const rows = await client.measurementSpecValue.findMany({ where: { specId }, select: VALUE_COLUMNS, orderBy: [{ seq: 'asc' }, { size: 'asc' }] })
  return rows.map((row) => ({
    id: row.id,
    pointOfMeasureId: row.pointOfMeasureId,
    size: row.size,
    seq: row.seq,
    nominal: measureText(row.nominal.toString()),
    toleranceMinus: measureText(row.toleranceMinus.toString()),
    tolerancePlus: measureText(row.tolerancePlus.toString()),
    source: row.source as ValueSource,
  }))
}

/** The revision's live spec (DRAFT or APPROVED), or null. */
export const readLiveSpec = (client: Client, revisionId: string): Promise<SpecRowData | null> =>
  client.measurementSpec.findFirst({ where: { revisionId, status: { not: 'ARCHIVED' } }, select: SPEC_COLUMNS })

/** The points the values name, and any other asked (by id), as the spec's rules and view read them. */
export async function readSpecPoints(client: Client, ids: readonly string[]): Promise<Map<string, PomRowData>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await client.pointOfMeasure.findMany({ where: { id: { in: unique } }, select: POM_COLUMNS })
  return new Map(rows.map((row) => [row.id, row]))
}

export const specPointOf = (row: PomRowData): SpecPoint => ({ id: row.id, code: row.code, kind: row.kind as PomKind, status: row.status as PomStatus, defaultTolerance: decimal(row.defaultTolerance) })

export interface LoadedSpec {
  readonly style: BomStyleRow
  readonly revision: RevisionRow
  readonly spec: SpecRowData | null
  readonly values: readonly ValueRecord[]
  readonly points: ReadonlyMap<string, PomRowData>
  readonly sizes: readonly { code: string; label: string | null; fitCode: string | null }[]
  readonly rule: { id: string; code: string; name: string; format: string; status: string } | null
  readonly archived: readonly SpecRowData[]
}

export async function loadSpec(client: Client, style: BomStyleRow, revision: RevisionRow): Promise<LoadedSpec> {
  const spec = await readLiveSpec(client, revision.id)
  const values = spec ? await readValues(client, spec.id) : []
  const points = await readSpecPoints(
    client,
    values.map((value) => value.pointOfMeasureId),
  )
  const scaleSizes = await client.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, label: true, fitCode: true } })
  const byCode = new Map(scaleSizes.map((size) => [size.code, size]))
  const rule = spec?.gradeRuleId ? await client.gradeRule.findUnique({ where: { id: spec.gradeRuleId }, select: { id: true, code: true, name: true, format: true, status: true } }) : null
  const archived = await client.measurementSpec.findMany({ where: { revisionId: revision.id, status: 'ARCHIVED' }, select: SPEC_COLUMNS, orderBy: { createdAt: 'desc' } })
  return {
    style,
    revision,
    spec,
    values,
    points,
    sizes: style.sizes.map((code) => ({ code, label: byCode.get(code)?.label ?? null, fitCode: byCode.get(code)?.fitCode ?? null })),
    rule: rule ? { ...rule, format: String(rule.format), status: String(rule.status) } : null,
    archived,
  }
}

/** The measurement spec of one revision (the style's "Measurement spec" section). */
export function specViewOf(loaded: LoadedSpec): MeasurementSpecView {
  const { style, revision, spec, values, points } = loaded
  const range = style.sizes
  const refusal = spec === null ? specEditRefusal(revision, null, style.status) : specEditRefusal(revision, { status: spec.status as SpecStatus }, style.status)
  const order = pointOrder(values)
  const codeOf = (id: string) => points.get(id)?.code ?? id
  const missing = missingCells(
    values.filter((value) => range.includes(value.size)),
    range,
  )
  const view: MeasurementSpecView['points'] = order.map((pointId) => {
    const row = points.get(pointId)
    const ofPoint = values.filter((value) => value.pointOfMeasureId === pointId)
    const uom = (row?.uom ?? 'CM') as PomUom
    return {
      pointOfMeasureId: pointId,
      code: row?.code ?? '',
      name: row?.name ?? '',
      nameI18n: row ? wordsOf(row.nameI18n) : null,
      kind: (row?.kind ?? 'GARMENT') as PomKind,
      bodyZone: (row?.bodyZone ?? 'OTHER') as PomZone,
      uom,
      howTo: row?.howTo ?? null,
      hasPicture: row?.pictureFileId != null,
      status: (row?.status ?? 'ACTIVE') as PomStatus,
      seq: ofPoint.reduce((low, value) => Math.min(low, value.seq), Number.MAX_SAFE_INTEGER),
      cells: range.map((size) => {
        const value = ofPoint.find((entry) => entry.size === size)
        return {
          size,
          value: value
            ? { id: value.id, nominal: value.nominal, toleranceMinus: value.toleranceMinus, tolerancePlus: value.tolerancePlus, source: value.source, words: toleranceWords(value.nominal, value.toleranceMinus, value.tolerancePlus, uom) }
            : null,
        }
      }),
    }
  })
  const outside = values.filter((value) => !range.includes(value.size)).length
  const words =
    spec === null
      ? 'No measurement spec yet: start one, then add points of measure from the library.'
      : [
          `${order.length} point(s) × ${range.length} size(s), base size ${spec.baseSize}`,
          missing.length > 0 ? `${missing.reduce((sum, gap) => sum + gap.sizes.length, 0)} value(s) missing` : 'nothing missing',
          outside > 0 ? `${outside} value(s) of sizes no longer in the range` : null,
          spec.status === 'APPROVED' ? 'approved' : spec.status === 'DRAFT' ? 'draft' : 'archived',
        ]
          .filter((part): part is string => part !== null)
          .join(' · ')
  return {
    revision: revisionViewOf(revision),
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status, baseSize: style.baseSize, sizeScaleId: style.sizeScaleId },
    sizes: loaded.sizes.map((size) => ({ ...size })),
    spec: spec
      ? {
          id: spec.id,
          status: spec.status as SpecStatus,
          baseSize: spec.baseSize,
          gradeRule: loaded.rule,
          approvedAt: spec.approvedAt ? toUtcIso(spec.approvedAt) : null,
          approvedById: spec.approvedById,
          version: spec.version,
          createdAt: toUtcIso(spec.createdAt),
          updatedAt: toUtcIso(spec.updatedAt),
        }
      : null,
    points: view,
    missing: missing.map((gap) => ({ pointOfMeasureId: gap.pointOfMeasureId, code: codeOf(gap.pointOfMeasureId), sizes: gap.sizes })),
    archived: loaded.archived.map((row) => ({ id: row.id, baseSize: row.baseSize, createdAt: toUtcIso(row.createdAt), approvedAt: row.approvedAt ? toUtcIso(row.approvedAt) : null })),
    editable: spec !== null && refusal === null,
    refusal: spec === null ? specEditRefusal(revision, null, style.status) : refusal,
    words,
  }
}

/** The spec as the command left it (its answer). */
export async function specViewInTx(tx: CommandTx, styleId: string, revisionId: string): Promise<MeasurementSpecView> {
  const style = await tx.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS })
  if (!style) throw new NotFoundError('Style not found.')
  return specViewOf(await loadSpec(tx, style, await findRevision(tx, styleId, revisionId)))
}

// ---- the spec: locks ----------------------------------------------------------------------------------------------------

export interface LockedSpec {
  readonly style: LockedStyle
  readonly revision: RevisionRow
  readonly spec: SpecRowData
}

/**
 * The first step of a write to a revision's spec: the style row locked, the edit rule asked (DRAFT), the revision a DRAFT
 * of this style, the live spec found and locked FOR UPDATE at the version the caller read. `allow` names the spec states
 * the write takes (cells and points: DRAFT; reopen: APPROVED; archive: both).
 */
export async function lockSpec(tools: CommandTools, styleId: string, revisionId: string, expectedVersion: number, allow: readonly SpecStatus[] = ['DRAFT']): Promise<LockedSpec> {
  const { tx } = tools
  const style = await lockStyleRow(tx, styleId)
  const revision = await findRevision(tx, styleId, revisionId)
  const revisionRefusal = specEditRefusal(revision, null, style.status)
  if (revisionRefusal) throw new InvalidStateError(revisionRefusal)
  await requireEditRule(tx, styleId, 'DRAFT')
  const live = await readLiveSpec(tx, revisionId)
  if (!live) throw new NotFoundError(`Revision ${revision.revision} has no measurement spec: start one first.`)
  const [locked] = await tx.$queryRaw<{ version: number; status: string }[]>`SELECT "version", "status"::text AS "status" FROM "MeasurementSpec" WHERE "id" = ${live.id}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Measurement spec not found.')
  if (locked.version !== expectedVersion) throw new StaleVersionError('MeasurementSpec', live.id, locked.version, expectedVersion)
  if (!allow.includes(locked.status as SpecStatus)) {
    const refusal = specEditRefusal(revision, { status: locked.status as SpecStatus }, style.status)
    throw new InvalidStateError(refusal ?? `The measurement spec is ${locked.status.toLowerCase()}.`)
  }
  return { style, revision, spec: { ...live, version: locked.version, status: locked.status as SpecRowData['status'] } }
}

/** The spec's version moved by this write (and its other fields, when given): ONE update, so an approval is one move. */
export async function bumpSpec(tools: CommandTools, locked: LockedSpec, data: Prisma.MeasurementSpecUncheckedUpdateManyInput = {}): Promise<number> {
  const { count } = await tools.tx.measurementSpec.updateMany({ where: { id: locked.spec.id, version: locked.spec.version }, data: { ...data, version: locked.spec.version + 1, updatedAt: tools.now } })
  if (count !== 1) throw new ApiError('internal_error', 'The measurement spec moved under its lock.')
  return locked.spec.version + 1
}

export const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
export const invalid = (issues: readonly Issue[], what = 'measurement spec'): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : `The ${what} is not valid.`, issues)
export const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
