import { ConflictError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { lengthIn, isLengthUom } from '@nexus/factory-domain/inventory/rolls/rolls'
import { componentDraftProblems, counterProblems, inspectedProblem, isRollLot, rollDraftProblems, ROLL_UNIT_LIMITS, COMPONENT_LIMITS, type ComponentDraft, type CountersDraft, type RollDraft } from '@nexus/factory-domain/quality/incoming/units'
import type { UnitDecision } from '@nexus/factory-domain/quality/incoming/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { postedBy } from '../final/access'
import { certificatesIn } from './certificates'
import { COMPONENT_COLUMNS, ROLL_COLUMNS } from './facts'
import { invalid, recorded, writable } from './record'
import { lockIncoming, lotOf, takeOver } from './store'
import { viewOf } from './views'
import { asTenantSystem } from '../../production/bundles/codes'

/**
 * Rolls, components and the defect counter of an incoming inspection (B-W2b-111; QHS-032, QHS-033; design floor.incoming
 * "Fabric rolls (4-point)", "Armour, zips, hardware"; B-W2b-98's gap 4: the counter of a lot not counted by hide). Office
 * and the site's inspection tablet, its inspector only (anyone with quality.incoming.record takes an inspection nobody
 * took). Each write is ONE command at the inspection's version (its row FOR UPDATE), with its audit row and event.
 *
 *   PUT    …/:inspectionId/rolls                    a roll in (or changed), keyed by its reference: its tag (rollId:
 *                                                   a FabricRoll of the lot, B-W2b-107; its width and length taken from
 *                                                   the tag when not sent) or the supplier's roll number; the 4 counters,
 *                                                   width (cm) and length (m); accept, reject or sort. A lot counted in a
 *                                                   length only (m, cm, mm): its sample is a number of rolls, a new roll
 *                                                   refused once it is full. The database writes the points per 100 sq yd.
 *   DELETE …/:inspectionId/rolls/:rollResultId      a roll out of the inspection.
 *   PUT    …/:inspectionId/components/:seq          a line of the component checklist (seq from 1, the bench's line):
 *                                                   kind, what is read (marking, a protector's type A or B and size), the
 *                                                   certificate it was checked against (the PPE register's), pieces looked
 *                                                   at and those not right, accept or reject. Any lot or workshop receipt.
 *   DELETE …/:inspectionId/components/:seq          a line out.
 *   PUT    …/:inspectionId/counters                 { found: { critical, major, minor } } units of the sample with a
 *                                                   defect per class (the AQL counter), for an inspection not counted hide
 *                                                   by hide (a hide lot counts from its marks).
 */

type Version = { readonly version: number }

const done = async (tx: CommandTx, id: string) => (await tx.incomingHideResult.count({ where: { incomingInspectionId: id } })) + (await tx.incomingRollResult.count({ where: { incomingInspectionId: id } }))

export interface RollBody extends RollDraft, Version {
  /** The roll's tag of the lot (B-W2b-107); its tag is then the reference. */
  readonly rollId?: string | null | undefined
}

/** PUT /quality/incoming/:inspectionId/rolls */
export async function putRoll(caller: CommandCaller, inspectionId: string, body: RollBody, idempotencyKey: string | undefined) {
  const found = await writable(caller, inspectionId)
  const { row: seen, context } = found
  const lot = lotOf(seen, found, 'fabric rolls')
  if (!isRollLot(seen.uom)) throw new ConflictError(`Incoming inspection ${seen.number} counts ${seen.uom}: fabric rolls are inspected on a lot counted in a length (m, cm, mm).`)
  const shape = rollDraftProblems(body)
  if (!body.rollId && !body.rollRef?.trim()) shape.push({ path: 'rollRef', message: "Name the roll: scan its tag or type the supplier's roll number." })
  if (body.rollId && !isUuid(body.rollId)) shape.push({ path: 'rollId', message: 'Not a roll of this lot.' })
  if (shape.length > 0) throw invalid(shape, 'The roll is not valid.')
  const { result } = await command(caller, { name: 'quality.incoming.recordRoll', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockIncoming(tx, seen.id, body.version)
    const tag = body.rollId ? await tx.fabricRoll.findUnique({ where: { id: body.rollId }, select: { id: true, code: true, lotId: true, length: true, uom: true, widthCm: true, state: true } }) : null
    if (body.rollId && (!tag || tag.lotId !== lot.id)) throw new NotFoundError(`Roll not found in lot ${lot.code}.`)
    const rollRef = tag ? tag.code : body.rollRef!.trim()
    const existing = await tx.incomingRollResult.findFirst({ where: { incomingInspectionId: row.id, rollRef }, select: ROLL_COLUMNS })
    const count = await tx.incomingRollResult.count({ where: { incomingInspectionId: row.id } })
    if (!existing && count >= row.sampleSize) throw new ConflictError(`The sample is ${row.sampleSize} ${row.sampleSize === 1 ? 'roll' : 'rolls'}: all are recorded. Take one out first.`)
    if (!existing && count >= ROLL_UNIT_LIMITS.rolls) throw new ConflictError(`At most ${ROLL_UNIT_LIMITS.rolls} rolls on one inspection.`)
    // Width and length: as sent, else as recorded, else the tag's (its length received, in metres).
    const tagLength = tag && isLengthUom(tag.uom) ? lengthIn(tag.length.toString(), tag.uom, 'M').toFixed(2) : null
    const widthCm = body.widthCm?.trim() || existing?.widthCm.toFixed(2) || tag?.widthCm?.toFixed(2) || null
    const lengthM = body.lengthM?.trim() || existing?.lengthM.toFixed(2) || tagLength
    const problems: Issue[] = []
    if (!widthCm) problems.push({ path: 'widthCm', message: 'Measure the width (cm): the points are per 100 square yards.' })
    if (!lengthM) problems.push({ path: 'lengthM', message: 'Measure the length (m): the points are per 100 square yards.' })
    if (problems.length > 0) throw invalid(problems, 'The roll is not valid.')
    const counts = {
      onePoint: body.onePoint ?? existing?.onePoint ?? 0,
      twoPoint: body.twoPoint ?? existing?.twoPoint ?? 0,
      threePoint: body.threePoint ?? existing?.threePoint ?? 0,
      fourPoint: body.fourPoint ?? existing?.fourPoint ?? 0,
    }
    const data = {
      rollRef,
      recordType: tag ? 'FabricRoll' : (existing?.recordType ?? null),
      recordId: tag ? tag.id : (existing?.recordId ?? null),
      ...counts,
      widthCm: new Dec(widthCm!).toFixed(2),
      lengthM: new Dec(lengthM!).toFixed(2),
      decision: body.decision === undefined ? ((existing?.decision as UnitDecision | null) ?? null) : body.decision,
      note: body.note === undefined ? (existing?.note ?? null) : body.note?.trim() || null,
    }
    const saved = existing
      ? await tx.incomingRollResult.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true, pointsPer100SqYd: true } })
      : await tx.incomingRollResult.create({ data: { id: newId(), siteId: row.siteId, incomingInspectionId: row.id, ...data, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true, pointsPer100SqYd: true } })
    await tx.incomingInspection.update({ where: { id: row.id }, data: { ...takeOver(context, row), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({
      recordType: 'IncomingInspection',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: existing ? { roll: rollRef, ...{ onePoint: existing.onePoint, twoPoint: existing.twoPoint, threePoint: existing.threePoint, fourPoint: existing.fourPoint }, widthCm: existing.widthCm.toFixed(2), lengthM: existing.lengthM.toFixed(2), pointsPer100SqYd: existing.pointsPer100SqYd.toFixed(2), decision: existing.decision } : { roll: rollRef, inSample: false },
      after: { roll: rollRef, rollId: data.recordId, ...counts, widthCm: data.widthCm, lengthM: data.lengthM, pointsPer100SqYd: saved.pointsPer100SqYd.toFixed(2), decision: data.decision, by: postedBy(context) },
    })
    recorded(tools, row, 'ROLL', null, await done(tx, row.id))
    return { id: row.id }
  })
  return viewOf(caller, result.id, found, context)
}

/** DELETE /quality/incoming/:inspectionId/rolls/:rollResultId?version= */
export async function removeRoll(caller: CommandCaller, inspectionId: string, rollResultId: string, version: number, idempotencyKey: string | undefined) {
  const found = await writable(caller, inspectionId)
  const { row: seen, context } = found
  lotOf(seen, found, 'fabric rolls')
  const { result } = await command(caller, { name: 'quality.incoming.removeRoll', idempotencyKey, input: { inspectionId, rollResultId, version } }, async (tools) => {
    const row = await lockIncoming(tools.tx, seen.id, version)
    const existing = isUuid(rollResultId) ? await tools.tx.incomingRollResult.findFirst({ where: { id: rollResultId, incomingInspectionId: row.id }, select: ROLL_COLUMNS }) : null
    if (!existing) throw new NotFoundError('This roll is not on the inspection.')
    await tools.tx.incomingRollResult.delete({ where: { id: existing.id }, select: { id: true } })
    await tools.tx.incomingInspection.update({ where: { id: row.id }, data: { ...takeOver(context, row), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'IncomingInspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { roll: existing.rollRef, inSample: true, decision: existing.decision, pointsPer100SqYd: existing.pointsPer100SqYd.toFixed(2) }, after: { roll: existing.rollRef, inSample: false } })
    recorded(tools, row, 'ROLL_REMOVED', null, await done(tools.tx, row.id))
    return { id: row.id }
  })
  return viewOf(caller, result.id, found, context)
}

export interface ComponentBody extends Omit<ComponentDraft, 'kind'>, Version {
  readonly kind: ComponentDraft['kind']
}

/** PUT /quality/incoming/:inspectionId/components/:seq */
export async function putComponent(caller: CommandCaller, inspectionId: string, seq: number, body: ComponentBody, idempotencyKey: string | undefined) {
  const found = await writable(caller, inspectionId)
  const { row: seen, context } = found
  const shape = componentDraftProblems(body)
  if (!(Number.isInteger(seq) && seq >= 1 && seq <= COMPONENT_LIMITS.rows)) shape.push({ path: 'seq', message: `A line of the checklist: from 1 to ${COMPONENT_LIMITS.rows}.` })
  if (body.certificateId && !isUuid(body.certificateId)) shape.push({ path: 'certificateId', message: 'Not a certificate of the PPE register.' })
  if (shape.length > 0) throw invalid(shape.map((issue) => (issue.path === 'seq' ? { ...issue, path: 'params/seq' } : issue)), 'The component check is not valid.')
  // The register's certificate (a tablet reads none: as the tenant's system caller, its site checked above).
  if (body.certificateId) {
    const reader = context.audience === 'floor' ? asTenantSystem(caller, context) : caller
    const certificate = (await reader.withClient((db) => certificatesIn(db, [body.certificateId!]))).get(body.certificateId)
    if (!certificate) throw invalid([{ path: 'certificateId', message: 'Not a certificate of the PPE register.' }], 'The component check is not valid.')
  }
  const { result } = await command(caller, { name: 'quality.incoming.recordComponent', idempotencyKey, input: { inspectionId, seq, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockIncoming(tx, seen.id, body.version)
    const existing = await tx.incomingComponentResult.findFirst({ where: { incomingInspectionId: row.id, seq }, select: COMPONENT_COLUMNS })
    if (!existing && (await tx.incomingComponentResult.count({ where: { incomingInspectionId: row.id } })) >= COMPONENT_LIMITS.rows) throw new ConflictError(`At most ${COMPONENT_LIMITS.rows} component checks on one inspection.`)
    const data = {
      kind: body.kind,
      marking: body.marking?.trim() || null,
      protectorType: body.kind === 'PROTECTOR' ? body.protectorType?.trim() || null : null,
      size: body.size?.trim() || null,
      certificateId: body.certificateId ?? null,
      checkedQuantity: body.checkedQuantity,
      defectiveQuantity: body.defectiveQuantity ?? 0,
      decision: body.decision ?? null,
      note: body.note?.trim() || null,
    }
    if (existing) await tx.incomingComponentResult.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    else await tx.incomingComponentResult.create({ data: { id: newId(), siteId: row.siteId, incomingInspectionId: row.id, seq, ...data, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    await tx.incomingInspection.update({ where: { id: row.id }, data: { ...takeOver(context, row), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({
      recordType: 'IncomingInspection',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: existing ? { component: seq, kind: existing.kind, marking: existing.marking, protectorType: existing.protectorType, size: existing.size, certificateId: existing.certificateId, checkedQuantity: existing.checkedQuantity, defectiveQuantity: existing.defectiveQuantity, decision: existing.decision } : { component: seq, inChecklist: false },
      after: { component: seq, ...data, by: postedBy(context) },
    })
    recorded(tools, row, 'COMPONENT', null, await done(tx, row.id))
    return { id: row.id }
  })
  return viewOf(caller, result.id, found, context)
}

/** DELETE /quality/incoming/:inspectionId/components/:seq?version= */
export async function removeComponent(caller: CommandCaller, inspectionId: string, seq: number, version: number, idempotencyKey: string | undefined) {
  const found = await writable(caller, inspectionId)
  const { row: seen, context } = found
  const { result } = await command(caller, { name: 'quality.incoming.removeComponent', idempotencyKey, input: { inspectionId, seq, version } }, async (tools) => {
    const row = await lockIncoming(tools.tx, seen.id, version)
    const existing = await tools.tx.incomingComponentResult.findFirst({ where: { incomingInspectionId: row.id, seq }, select: COMPONENT_COLUMNS })
    if (!existing) throw new NotFoundError('This line is not on the component checklist.')
    await tools.tx.incomingComponentResult.delete({ where: { id: existing.id }, select: { id: true } })
    await tools.tx.incomingInspection.update({ where: { id: row.id }, data: { ...takeOver(context, row), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'IncomingInspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { component: seq, kind: existing.kind, decision: existing.decision }, after: { component: seq, inChecklist: false } })
    recorded(tools, row, 'COMPONENT_REMOVED', null, await done(tools.tx, row.id))
    return { id: row.id }
  })
  return viewOf(caller, result.id, found, context)
}

/**
 * PUT /quality/incoming/:inspectionId/counters. B-W2b-213: with `inspected`, the units of the sample inspected so far
 * (IncomingInspection.inspectedCount: "38 of 50" and a verdict before the decision; the database keeps it 0..sample and
 * freezes the AQL profile once a unit is counted).
 */
export async function putCounters(caller: CommandCaller, inspectionId: string, body: Version & { readonly found: CountersDraft; readonly inspected?: number | undefined }, idempotencyKey: string | undefined) {
  const found = await writable(caller, inspectionId)
  const { row: seen, context } = found
  if (seen.uom === 'HIDE' && found.lot) throw new ConflictError(`Incoming inspection ${seen.number} is inspected hide by hide: its counts follow from the marks on each hide.`)
  const inspected = inspectedProblem(body.inspected, seen.sampleSize)
  const problems = [...counterProblems(body.found, seen.sampleSize), ...(inspected ? [inspected] : [])]
  if (problems.length > 0) throw invalid(problems, 'The counts are not valid.')
  const { result } = await command(caller, { name: 'quality.incoming.recordCounters', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const row = await lockIncoming(tools.tx, seen.id, body.version)
    const before = { critical: row.foundCritical, major: row.foundMajor, minor: row.foundMinor }
    await tools.tx.incomingInspection.update({
      where: { id: row.id },
      data: { foundCritical: body.found.critical, foundMajor: body.found.major, foundMinor: body.found.minor, ...(body.inspected !== undefined ? { inspectedCount: body.inspected } : {}), ...takeOver(context, row), version: { increment: 1 }, updatedAt: tools.now },
      select: { id: true },
    })
    tools.audit({ recordType: 'IncomingInspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { found: before, inspected: row.inspectedCount }, after: { found: body.found, ...(body.inspected !== undefined ? { inspected: body.inspected } : {}), by: postedBy(context) } })
    recorded(tools, row, 'COUNTERS', null, await done(tools.tx, row.id))
    return { id: row.id }
  })
  return viewOf(caller, result.id, found, context)
}
