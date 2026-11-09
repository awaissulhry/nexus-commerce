import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { settingLine } from '@nexus/factory-domain/product/routing-depth/rules'
import { MINUTES_ROUND, routingMinutes } from '@nexus/factory-domain/product/routing/minutes'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { BomLineFacts, MeasurementFacts, PieceFacts, ProtectorFacts, SpecSnapshot, StepFacts } from '@nexus/factory-domain/product/versions/compare'
import type { CommandTx } from '../../../core/command'

/**
 * Everything a style revision says, read for the compare (B-W2b-220; factory-domain product/versions/compare): the
 * revision's own columns, its BOM (lines, sizes, colour grid, alternates and every W2b-4 column), its routing (steps with
 * their W2b-4 depth, size times and machine settings; never a workshop's fee), its pattern pieces, its measurement spec and
 * protector placement — and the codes they name, read once for both revisions. Every read names its columns and selects no
 * relation; queries run one after another (a transaction client runs one at a time anyway). Office reads only.
 */

export type Db = FactoryClient | CommandTx

export const REVISION_COLUMNS = {
  id: true,
  styleId: true,
  revision: true,
  status: true,
  changeNote: true,
  plannedHideYieldPct: true,
  labelTemplateId: true,
  outputQuantity: true,
  outputUom: true,
  releasedAt: true,
  releasedById: true,
  effectiveFrom: true,
  effectiveTo: true,
  releasedColourwayIds: true,
  releasedSizes: true,
  createdAt: true,
  createdById: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.StyleRevisionSelect
export type RevisionRow = Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_COLUMNS }>

const LINE_COLUMNS = {
  id: true,
  seq: true,
  itemId: true,
  placement: true,
  qty: true,
  uom: true,
  wastagePct: true,
  sizeDependent: true,
  colourDependent: true,
  itemColourId: true,
  colourwayId: true,
  supplierId: true,
  section: true,
  parentLineId: true,
  subAssemblyRevisionId: true,
  customerSuppliedByPartyId: true,
  issueToSubcontract: true,
  sourceKey: true,
  optionValueId: true,
  routingSeq: true,
  mtmScalePointId: true,
  mtmScaleFactor: true,
  note: true,
} as const satisfies Prisma.BomLineSelect
type LineRow = Prisma.BomLineGetPayload<{ select: typeof LINE_COLUMNS }>

const STEP_COLUMNS = {
  id: true,
  seq: true,
  operationId: true,
  code: true,
  name: true,
  workCentreKind: true,
  standardMinutes: true,
  basicMinutes: true,
  personalPct: true,
  fatiguePct: true,
  delayPct: true,
  timeVersionId: true,
  setupMinutes: true,
  waitMinutes: true,
  moveMinutes: true,
  appliesToSizes: true,
  appliesToColourwayIds: true,
  appliesToOptionValueIds: true,
  inspectionPlanId: true,
  scanRequired: true,
  parallelGroup: true,
  instructions: true,
  // The workshop and its transit days; never pricePerPiece (the cost grain: the cost section prices it).
  supplierId: true,
  transitDays: true,
} as const satisfies Prisma.RoutingOperationSelect
type StepRow = Prisma.RoutingOperationGetPayload<{ select: typeof STEP_COLUMNS }>

const text = (value: { toString(): string }): string => decimalText(value.toString())
const textOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : text(value))
const ids = (values: readonly (string | null | undefined)[]): string[] => [...new Set(values.filter((value): value is string => typeof value === 'string' && isUuid(value)))]

/** One revision's rows, before the codes they name are read. */
interface RawSpec {
  readonly revision: RevisionRow
  readonly lines: readonly LineRow[]
  readonly sizes: readonly { bomLineId: string; size: string; qty: Prisma.Decimal }[]
  readonly cells: readonly { bomLineId: string; colourwayId: string; itemColourId: string }[]
  readonly alternates: readonly { bomLineId: string; priority: number; itemId: string; itemColourId: string | null; qty: Prisma.Decimal | null; allowedWhen: string; certificateCheck: boolean }[]
  readonly steps: readonly StepRow[]
  readonly sizeTimes: readonly { routingOperationId: string; size: string; extraMinutes: Prisma.Decimal }[]
  readonly settings: readonly {
    routingOperationId: string | null
    seq: number
    machineClassId: string | null
    stitchType: string | null
    needle: string | null
    thread: string | null
    stitchesPerCm: Prisma.Decimal | null
    tension: string | null
    foot: string | null
    notes: string | null
  }[]
  readonly pieces: readonly { id: string; seq: number; name: string; quantity: number; bomLineId: string | null; minGradeId: string | null; grain: string; sizes: string[]; note: string | null }[]
  readonly spec: { id: string; status: string; baseSize: string; gradeRuleId: string | null } | null
  readonly values: readonly { pointOfMeasureId: string; size: string; seq: number; nominal: Prisma.Decimal; toleranceMinus: Prisma.Decimal; tolerancePlus: Prisma.Decimal }[]
  readonly protectors: readonly { id: string; seq: number; pocket: string; protectorItemId: string; standard: string; level: string; sizes: string[]; positionNote: string | null }[]
}

/** A revision of this style, or null (another style's, or none). */
export async function revisionOfStyle(db: Db, styleId: string, revisionId: string): Promise<RevisionRow | null> {
  if (!isUuid(revisionId)) return null
  const row = await db.styleRevision.findUnique({ where: { id: revisionId }, select: REVISION_COLUMNS })
  return row && row.styleId === styleId ? row : null
}

/** The measurement spec a revision is compared by: its APPROVED one, else its newest that is not archived. */
async function specOf(db: Db, revisionId: string) {
  const specs = await db.measurementSpec.findMany({ where: { revisionId, status: { not: 'ARCHIVED' } }, select: { id: true, status: true, baseSize: true, gradeRuleId: true, createdAt: true }, orderBy: { createdAt: 'desc' } })
  return specs.find((spec) => spec.status === 'APPROVED') ?? specs[0] ?? null
}

async function readRaw(db: Db, revision: RevisionRow): Promise<RawSpec> {
  const revisionId = revision.id
  const lines = await db.bomLine.findMany({ where: { revisionId }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
  const sizes = await db.bomLineSize.findMany({ where: { revisionId }, select: { bomLineId: true, size: true, qty: true } })
  const cells = await db.bomLineColour.findMany({ where: { revisionId }, select: { bomLineId: true, colourwayId: true, itemColourId: true }, orderBy: { createdAt: 'asc' } })
  const alternates = await db.bomLineAlternate.findMany({
    where: { revisionId },
    select: { bomLineId: true, priority: true, itemId: true, itemColourId: true, qty: true, allowedWhen: true, certificateCheck: true },
    orderBy: { priority: 'asc' },
  })
  const steps = await db.routingOperation.findMany({ where: { revisionId }, select: STEP_COLUMNS, orderBy: { seq: 'asc' } })
  const sizeTimes = await db.routingOperationSizeTime.findMany({ where: { revisionId }, select: { routingOperationId: true, size: true, extraMinutes: true } })
  const settings = await db.operationMachineSetting.findMany({
    where: { revisionId },
    select: { routingOperationId: true, seq: true, machineClassId: true, stitchType: true, needle: true, thread: true, stitchesPerCm: true, tension: true, foot: true, notes: true },
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
  })
  const pieces = await db.patternPiece.findMany({
    where: { revisionId },
    select: { id: true, seq: true, name: true, quantity: true, bomLineId: true, minGradeId: true, grain: true, sizes: true, note: true },
    orderBy: { seq: 'asc' },
  })
  const spec = await specOf(db, revisionId)
  const values = spec
    ? await db.measurementSpecValue.findMany({
        where: { specId: spec.id },
        select: { pointOfMeasureId: true, size: true, seq: true, nominal: true, toleranceMinus: true, tolerancePlus: true },
        orderBy: [{ seq: 'asc' }, { size: 'asc' }],
      })
    : []
  const protectors = await db.protectorPlacement.findMany({
    where: { revisionId },
    select: { id: true, seq: true, pocket: true, protectorItemId: true, standard: true, level: true, sizes: true, positionNote: true },
    orderBy: { seq: 'asc' },
  })
  return { revision, lines, sizes, cells, alternates, steps, sizeTimes, settings, pieces, spec, values, protectors }
}

/** The codes and names the rows of several revisions name, read once. */
async function readNames(db: Db, raws: readonly RawSpec[]) {
  const lines = raws.flatMap((raw) => raw.lines)
  const steps = raws.flatMap((raw) => raw.steps)
  const itemIds = ids([...lines.map((line) => line.itemId), ...raws.flatMap((raw) => raw.alternates.map((row) => row.itemId)), ...raws.flatMap((raw) => raw.protectors.map((row) => row.protectorItemId))])
  const items = itemIds.length ? await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true } }) : []
  const colourIds = ids([...lines.map((line) => line.itemColourId), ...raws.flatMap((raw) => raw.cells.map((cell) => cell.itemColourId)), ...raws.flatMap((raw) => raw.alternates.map((row) => row.itemColourId))])
  const colours = colourIds.length ? await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true } }) : []
  const colourwayIds = ids([
    ...lines.map((line) => line.colourwayId),
    ...raws.flatMap((raw) => raw.cells.map((cell) => cell.colourwayId)),
    ...steps.flatMap((step) => step.appliesToColourwayIds),
    ...raws.flatMap((raw) => raw.revision.releasedColourwayIds),
  ])
  const colourways = colourwayIds.length ? await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true } }) : []
  const partyIds = ids([...lines.map((line) => line.supplierId), ...lines.map((line) => line.customerSuppliedByPartyId), ...steps.map((step) => step.supplierId)])
  const parties = partyIds.length ? await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true } }) : []
  const subRevisionIds = ids(lines.map((line) => line.subAssemblyRevisionId))
  const subRevisions = subRevisionIds.length ? await db.styleRevision.findMany({ where: { id: { in: subRevisionIds } }, select: { id: true, styleId: true, revision: true } }) : []
  const subStyleIds = ids(subRevisions.map((row) => row.styleId))
  const subStyles = subStyleIds.length ? await db.style.findMany({ where: { id: { in: subStyleIds } }, select: { id: true, code: true } }) : []
  const valueIds = ids([...lines.map((line) => line.optionValueId), ...steps.flatMap((step) => step.appliesToOptionValueIds)])
  const values = valueIds.length ? await db.optionValue.findMany({ where: { id: { in: valueIds } }, select: { id: true, code: true, groupId: true } }) : []
  const groupIds = ids(values.map((value) => value.groupId))
  const groups = groupIds.length ? await db.optionGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, code: true } }) : []
  const planIds = ids(steps.map((step) => step.inspectionPlanId))
  const plans = planIds.length ? await db.inspectionPlan.findMany({ where: { id: { in: planIds } }, select: { id: true, code: true } }) : []
  const versionIds = ids(steps.map((step) => step.timeVersionId))
  const versions = versionIds.length ? await db.operationTimeVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, number: true } }) : []
  const classIds = ids(raws.flatMap((raw) => raw.settings.map((row) => row.machineClassId)))
  const classes = classIds.length ? await db.machineClass.findMany({ where: { id: { in: classIds } }, select: { id: true, labelIt: true, labelEn: true } }) : []
  const labelIds = ids(raws.map((raw) => raw.revision.labelTemplateId))
  const labels = labelIds.length ? await db.labelTemplate.findMany({ where: { id: { in: labelIds } }, select: { id: true, code: true, revision: true } }) : []
  const gradeIds = ids(raws.flatMap((raw) => raw.pieces.map((piece) => piece.minGradeId)))
  const grades = gradeIds.length ? await db.leatherGrade.findMany({ where: { id: { in: gradeIds } }, select: { id: true, code: true } }) : []
  const pointIds = ids(raws.flatMap((raw) => raw.values.map((value) => value.pointOfMeasureId)))
  const points = pointIds.length ? await db.pointOfMeasure.findMany({ where: { id: { in: pointIds } }, select: { id: true, code: true, name: true, uom: true } }) : []
  const mtmIds = ids(lines.map((line) => line.mtmScalePointId))
  const mtmPoints = mtmIds.length ? await db.measurementPoint.findMany({ where: { id: { in: mtmIds } }, select: { id: true, code: true } }) : []
  const ruleIds = ids(raws.map((raw) => raw.spec?.gradeRuleId))
  const rules = ruleIds.length ? await db.gradeRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, code: true } }) : []

  const by = <Row extends { id: string }>(rows: readonly Row[]) => new Map(rows.map((row) => [row.id, row]))
  const groupBy = by(groups)
  const styleBy = by(subStyles)
  return {
    item: by(items),
    colour: by(colours),
    colourway: by(colourways),
    party: by(parties),
    subAssembly: new Map(subRevisions.map((row) => [row.id, `${styleBy.get(row.styleId)?.code ?? '?'} rev ${row.revision}`])),
    option: new Map(values.map((value) => [value.id, `${groupBy.get(value.groupId)?.code ?? '?'}: ${value.code}`])),
    plan: by(plans),
    timeVersion: by(versions),
    machineClass: by(classes),
    label: by(labels),
    grade: by(grades),
    point: by(points),
    mtm: by(mtmPoints),
    rule: by(rules),
  }
}
type Names = Awaited<ReturnType<typeof readNames>>

function snapshotOf(raw: RawSpec, names: Names): SpecSnapshot {
  const { revision } = raw
  const itemText = (id: string) => {
    const item = names.item.get(id)
    return item ? `${item.code} ${item.name}` : id
  }
  const colourwayCode = (id: string | null) => (id === null ? null : (names.colourway.get(id)?.code ?? id))
  const colourCode = (id: string | null) => (id === null ? null : (names.colour.get(id)?.code ?? id))
  const partyCode = (id: string | null) => (id === null ? null : (names.party.get(id)?.code ?? id))
  const seqOfLine = new Map(raw.lines.map((line) => [line.id, line.seq]))
  const itemOfLine = new Map(raw.lines.map((line) => [line.id, line.itemId]))

  const bom = raw.lines.map(
    (line): BomLineFacts => ({
      id: line.id,
      seq: line.seq,
      itemId: line.itemId,
      item: itemText(line.itemId),
      placement: line.placement,
      colourwayId: line.colourwayId,
      colourway: colourwayCode(line.colourwayId),
      qty: text(line.qty),
      uom: line.uom,
      wastagePct: text(line.wastagePct),
      sizeDependent: line.sizeDependent,
      sizes: Object.fromEntries(raw.sizes.filter((row) => row.bomLineId === line.id).map((row) => [row.size, text(row.qty)])),
      colourDependent: line.colourDependent,
      colours: raw.cells.filter((cell) => cell.bomLineId === line.id).map((cell) => ({ colourway: colourwayCode(cell.colourwayId)!, itemColour: colourCode(cell.itemColourId)! })),
      itemColour: colourCode(line.itemColourId),
      supplier: partyCode(line.supplierId),
      section: line.section,
      parentSeq: line.parentLineId === null ? null : (seqOfLine.get(line.parentLineId) ?? null),
      subAssembly: line.subAssemblyRevisionId === null ? null : (names.subAssembly.get(line.subAssemblyRevisionId) ?? null),
      customerSupplied: partyCode(line.customerSuppliedByPartyId),
      issueToSubcontract: line.issueToSubcontract,
      sourceKey: line.sourceKey,
      option: line.optionValueId === null ? null : (names.option.get(line.optionValueId) ?? null),
      routingSeq: line.routingSeq,
      mtm: line.mtmScalePointId === null ? null : `${names.mtm.get(line.mtmScalePointId)?.code ?? '?'}${line.mtmScaleFactor === null ? '' : ` × ${text(line.mtmScaleFactor)}`}`,
      alternates: raw.alternates
        .filter((row) => row.bomLineId === line.id)
        .map((row) => ({ priority: row.priority, item: names.item.get(row.itemId)?.code ?? row.itemId, itemColour: colourCode(row.itemColourId), qty: textOrNull(row.qty), allowedWhen: row.allowedWhen, certificateCheck: row.certificateCheck })),
      note: line.note,
    }),
  )

  const routing = raw.steps.map(
    (step): StepFacts => ({
      id: step.id,
      seq: step.seq,
      operationId: step.operationId,
      code: step.code,
      name: step.name,
      workCentreKind: step.workCentreKind,
      standardMinutes: text(step.standardMinutes),
      basicMinutes: textOrNull(step.basicMinutes),
      personalPct: textOrNull(step.personalPct),
      fatiguePct: textOrNull(step.fatiguePct),
      delayPct: textOrNull(step.delayPct),
      timeVersion: step.timeVersionId === null ? null : (names.timeVersion.get(step.timeVersionId)?.number ?? null),
      setupMinutes: textOrNull(step.setupMinutes),
      waitMinutes: textOrNull(step.waitMinutes),
      moveMinutes: textOrNull(step.moveMinutes),
      scanRequired: step.scanRequired,
      parallelGroup: step.parallelGroup,
      instructions: step.instructions,
      sizes: [...step.appliesToSizes],
      colourways: step.appliesToColourwayIds.map((id) => colourwayCode(id)!),
      options: step.appliesToOptionValueIds.map((id) => names.option.get(id) ?? id),
      checkpoint: step.inspectionPlanId === null ? null : (names.plan.get(step.inspectionPlanId)?.code ?? null),
      sizeTimes: Object.fromEntries(raw.sizeTimes.filter((row) => row.routingOperationId === step.id).map((row) => [row.size, text(row.extraMinutes)])),
      settings: raw.settings
        .filter((row) => row.routingOperationId === step.id)
        .map(
          (row) =>
            settingLine(
              { seq: row.seq, machineClassId: row.machineClassId, stitchType: row.stitchType, needle: row.needle, thread: row.thread, stitchesPerCm: textOrNull(row.stitchesPerCm), tension: row.tension, foot: row.foot, notes: row.notes },
              row.machineClassId ? (names.machineClass.get(row.machineClassId) ?? null) : null,
            ).en || `#${row.seq}`,
        ),
      workshop: partyCode(step.supplierId),
      transitDays: step.transitDays,
    }),
  )

  const pieces = raw.pieces.map(
    (piece): PieceFacts => ({
      id: piece.id,
      seq: piece.seq,
      name: piece.name,
      quantity: piece.quantity,
      line: piece.bomLineId === null ? null : `${seqOfLine.get(piece.bomLineId) ?? '?'} · ${names.item.get(itemOfLine.get(piece.bomLineId) ?? '')?.code ?? '?'}`,
      minGrade: piece.minGradeId === null ? null : (names.grade.get(piece.minGradeId)?.code ?? null),
      grain: piece.grain,
      sizes: [...piece.sizes],
      note: piece.note,
    }),
  )

  let measurements: MeasurementFacts | null = null
  if (raw.spec) {
    const byPoint = new Map<string, { seq: number; values: Record<string, { nominal: string; minus: string; plus: string }> }>()
    for (const value of raw.values) {
      const entry = byPoint.get(value.pointOfMeasureId) ?? { seq: value.seq, values: {} }
      entry.seq = Math.min(entry.seq, value.seq)
      entry.values[value.size] = { nominal: text(value.nominal), minus: text(value.toleranceMinus), plus: text(value.tolerancePlus) }
      byPoint.set(value.pointOfMeasureId, entry)
    }
    measurements = {
      status: raw.spec.status,
      baseSize: raw.spec.baseSize,
      gradeRule: raw.spec.gradeRuleId === null ? null : (names.rule.get(raw.spec.gradeRuleId)?.code ?? null),
      points: [...byPoint].map(([pointId, entry]) => {
        const point = names.point.get(pointId)
        return { pointId, point: point ? `${point.code} ${point.name}` : pointId, uom: point?.uom ?? '', seq: entry.seq, values: entry.values }
      }),
    }
  }

  const protectors = raw.protectors.map(
    (row): ProtectorFacts => ({
      id: row.id,
      seq: row.seq,
      pocket: row.pocket,
      item: names.item.get(row.protectorItemId)?.code ?? row.protectorItemId,
      standard: row.standard,
      level: row.level,
      sizes: [...row.sizes],
      positionNote: row.positionNote,
    }),
  )

  const label = revision.labelTemplateId === null ? null : names.label.get(revision.labelTemplateId)
  return {
    revision: {
      id: revision.id,
      revision: revision.revision,
      status: revision.status,
      labelTemplate: revision.labelTemplateId === null ? null : label ? `${label.code} r${label.revision}` : revision.labelTemplateId,
      plannedHideYieldPct: textOrNull(revision.plannedHideYieldPct),
      outputQuantity: revision.outputQuantity,
      outputUom: revision.outputUom,
      releasedColourways: revision.releasedColourwayIds.map((id) => colourwayCode(id)!),
      releasedSizes: [...revision.releasedSizes],
      minutesPerGarment: routingMinutes(
        raw.steps.map((step) => ({ standardMinutes: text(step.standardMinutes), workCentreKind: step.workCentreKind, scanRequired: step.scanRequired })),
        [],
        MINUTES_ROUND,
      ).perGarment,
    },
    bom,
    routing,
    measurements,
    protectors,
    pieces,
  }
}

/** The snapshots of these revisions (one read of the codes for all of them), in the order given. */
export async function readSnapshots(db: Db, revisions: readonly RevisionRow[]): Promise<SpecSnapshot[]> {
  const raws: RawSpec[] = []
  for (const revision of revisions) raws.push(await readRaw(db, revision))
  const names = await readNames(db, raws)
  return raws.map((raw) => snapshotOf(raw, names))
}

/** A revision as a compare's head ("Rev 2", "RELEASED 2026-11-20"). */
export function headOf(row: RevisionRow) {
  const day = row.releasedAt ? businessDate(row.releasedAt) : null
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    label: `Rev ${row.revision}`,
    note: day ? `${row.status} ${day}` : row.status,
    changeNote: row.changeNote,
    releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
    effectiveFrom: row.effectiveFrom ? row.effectiveFrom.toISOString().slice(0, 10) : null,
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString().slice(0, 10) : null,
  }
}
