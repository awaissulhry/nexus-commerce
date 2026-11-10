import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_BOM_MANAGE, PRODUCT_BOM_RELEASE, PRODUCT_BOM_VIEW } from '@nexus/factory-domain/product/bom/permissions'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { AddSpecPointsBody, MeasurementSpecView, SpecCellsBody, SpecMoveBody, SpecPointsBody, StartSpecBody, UpdateSpecBody } from '@nexus/factory-domain/product/measures/contracts'
import { SPEC_CHANGES } from '@nexus/factory-domain/product-measures/events'
import {
  approvalProblems,
  cellChanged,
  measureText,
  nextPlace,
  orderProblems,
  planCells,
  pointOrder,
  SPEC_LIMITS,
  specEditRefusal,
  type CellInput,
  type PlannedCell,
} from '@nexus/factory-domain/product/measures/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { findRevision, lockStyleRow, readRevisionFor, STYLE_COLUMNS } from '../bom/store'
import { requireEditRule } from '../lifecycle/edit-rule'
import {
  assertMayWrite,
  bumpSpec,
  contextOf,
  invalid,
  isUniqueViolation,
  loadSpec,
  lockSpec,
  prefixed,
  readLiveSpec,
  readSpecPoints,
  readValues,
  specPointOf,
  specViewInTx,
  specViewOf,
  type LockedSpec,
  type ValueRecord,
} from './store'

/**
 * A style revision's measurement spec (B-W2b-224; PRD-063, PRD-052, PRD-069; design products.styles › Sizes &
 * measurements › "Measurement spec": points of measure × sizes, graded from the base size, typed values marked; revision
 * bound): started on a draft revision, its points added from the library with their base size value, cells typed or
 * pasted (a typed cell on another size than the base is a manual override), points removed and reordered, graded by a
 * rule (../grading/apply.ts), approved, reopened and archived. Every write: one command(), the spec's version (409 when
 * stale), the edit rule of the style's state (B-W2b-221, DRAFT), an audit row, `style.measurement_spec_changed`. Who may:
 * product.bom.manage over the style's company (approve and reopen: product.bom.release).
 */

const NOUN = 'measurement spec'
type SpecChange = (typeof SPEC_CHANGES)[number]

function recordChange(tools: CommandTools, locked: Pick<LockedSpec, 'style' | 'revision'> & { readonly spec: { readonly id: string } }, change: SpecChange, after: Record<string, unknown>, reason?: string): void {
  const { style, revision, spec } = locked
  tools.audit({ recordType: 'MeasurementSpec', recordId: spec.id, companyId: style.companyId, after: { styleId: style.id, revisionId: revision.id, revision: revision.revision, change, ...after }, ...(reason ? { reason } : {}) })
  tools.emit({
    type: 'style.measurement_spec_changed',
    subject: style.id,
    companyId: style.companyId,
    payload: { styleId: style.id, code: style.code, revisionId: revision.id, revision: revision.revision, specId: spec.id, change },
  })
}

const clashed = (error: unknown): never => {
  if (isUniqueViolation(error)) throw new ConflictError('Another change wrote the same cell or started a spec of this revision at the same time: load the spec again.')
  throw error
}

/** The style and revision as the caller may see them, and the write permission checked against the style's company. */
async function writer(caller: CommandCaller, styleId: string, revisionId: string, permission: Permission = PRODUCT_BOM_MANAGE) {
  const seen = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(contextOf(caller), permission, seen.style.companyId, 'measurement spec of a style')
  return seen
}

/** GET …/measurement-spec: the revision's live spec as the grid shows it. */
export async function getSpec(caller: CommandCaller, styleId: string, revisionId: string): Promise<MeasurementSpecView> {
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  return caller.withClient(async (client) => specViewOf(await loadSpec(client, style, revision)))
}

/** The grade rule a spec names: ACTIVE, of the style's size scale, one the caller may see. */
async function ruleProblems(tx: CommandTx, caller: CommandCaller, ruleId: string, scaleId: string): Promise<Issue[]> {
  const rule = isUuid(ruleId) ? await tx.gradeRule.findUnique({ where: { id: ruleId }, select: { code: true, sizeScaleId: true, status: true, companyId: true } }) : null
  if (!rule || !can(actorOf(contextOf(caller)), PRODUCT_STYLES_VIEW, { companyId: rule.companyId })) return [{ path: 'body/gradeRuleId', message: 'No such grade rule.' }]
  if (rule.sizeScaleId !== scaleId) return [{ path: 'body/gradeRuleId', message: `Grade rule ${rule.code} is of another size scale than the style's.` }]
  if (rule.status !== 'ACTIVE') return [{ path: 'body/gradeRuleId', message: `Grade rule ${rule.code} is archived.` }]
  return []
}

/** product.measures.startSpec: a DRAFT spec of a draft revision (blank, or the cells of another spec). One live spec per revision. */
export async function startSpec(caller: CommandCaller, styleId: string, revisionId: string, body: StartSpecBody, idempotencyKey?: string): Promise<MeasurementSpecView> {
  await writer(caller, styleId, revisionId)
  const context = contextOf(caller)

  const { result } = await command(caller, { name: 'product.measures.startSpec', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockStyleRow(tx, styleId)
    const revision = await findRevision(tx, styleId, revisionId)
    const refusal = specEditRefusal(revision, null, locked.status)
    if (refusal) throw new InvalidStateError(refusal)
    await requireEditRule(tx, styleId, 'DRAFT')
    const live = await readLiveSpec(tx, revisionId)
    if (live) throw new ConflictError(`Revision ${revision.revision} has a measurement spec already (${live.status.toLowerCase()}): archive it before starting another.`)
    const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
    const baseSize = (body.baseSize ?? style.baseSize ?? style.sizes[0] ?? '').toUpperCase()
    const problems: Issue[] = []
    if (!style.sizes.includes(baseSize)) problems.push({ path: 'body/baseSize', message: `The base size is one of the style's sizes: ${style.sizes.join(', ')}.` })
    const gradeRuleId = body.gradeRuleId ?? null
    if (gradeRuleId) problems.push(...(await ruleProblems(tx, caller, gradeRuleId, style.sizeScaleId)))
    let copied: ValueRecord[] = []
    if (body.copyFromSpecId) {
      const source = isUuid(body.copyFromSpecId) ? await tx.measurementSpec.findUnique({ where: { id: body.copyFromSpecId }, select: { id: true, styleId: true } }) : null
      const sourceStyle = source ? await tx.style.findUnique({ where: { id: source.styleId }, select: { companyId: true } }) : null
      if (!source || !sourceStyle || !can(actorOf(context), PRODUCT_BOM_VIEW, { companyId: sourceStyle.companyId })) problems.push({ path: 'body/copyFromSpecId', message: 'No such measurement spec.' })
      else copied = (await readValues(tx, source.id)).filter((value) => style.sizes.includes(value.size))
    }
    if (problems.length > 0) throw invalid(problems, NOUN)
    const id = newId()
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    await tx.measurementSpec.create({ data: { id, styleId, revisionId, baseSize, status: 'DRAFT', gradeRuleId, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
    if (copied.length > 0) {
      // A copy keeps each point's place, renumbered from 1 in the source's order.
      const place = new Map(pointOrder(copied).map((pointId, index) => [pointId, index + 1]))
      await tx.measurementSpecValue.createMany({
        data: copied.map((value) => ({
          id: newId(),
          revisionId,
          specId: id,
          pointOfMeasureId: value.pointOfMeasureId,
          size: value.size,
          seq: place.get(value.pointOfMeasureId)!,
          nominal: value.nominal,
          toleranceMinus: value.toleranceMinus,
          tolerancePlus: value.tolerancePlus,
          source: value.source,
          createdAt: now,
          updatedAt: now,
          createdById,
        })),
      })
    }
    recordChange(tools, { style: locked, revision, spec: { id } }, 'STARTED', { baseSize, gradeRuleId, copiedFrom: body.copyFromSpecId ?? null, cells: copied.length })
    return specViewInTx(tx, styleId, revisionId)
  }).catch(clashed)
  return result
}

/** product.measures.updateSpec: a draft spec's base size or grade rule (the cells stay as they are). */
export async function updateSpec(caller: CommandCaller, styleId: string, revisionId: string, body: UpdateSpecBody, idempotencyKey?: string): Promise<MeasurementSpecView> {
  await writer(caller, styleId, revisionId)
  const { result } = await command(caller, { name: 'product.measures.updateSpec', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx } = tools
    const locked = await lockSpec(tools, styleId, revisionId, body.version)
    const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
    const problems: Issue[] = []
    const baseSize = body.baseSize?.toUpperCase()
    if (baseSize !== undefined && !style.sizes.includes(baseSize)) problems.push({ path: 'body/baseSize', message: `The base size is one of the style's sizes: ${style.sizes.join(', ')}.` })
    if (body.gradeRuleId) problems.push(...(await ruleProblems(tx, caller, body.gradeRuleId, style.sizeScaleId)))
    if (problems.length > 0) throw invalid(problems, NOUN)
    const data = { ...(baseSize !== undefined ? { baseSize } : {}), ...(body.gradeRuleId !== undefined ? { gradeRuleId: body.gradeRuleId } : {}) }
    if (Object.keys(data).length === 0) throw invalid([{ path: 'body', message: 'Nothing changes: name the base size or the grade rule.' }], NOUN)
    await bumpSpec(tools, locked, data)
    recordChange(tools, locked, 'UPDATED', { before: { baseSize: locked.spec.baseSize, gradeRuleId: locked.spec.gradeRuleId }, ...data })
    return specViewInTx(tx, styleId, revisionId)
  })
  return result
}

/** Writes planned cells: an existing one updated where it changes, a new one at its point's place (a new point after the last). */
export async function writeCells(tools: CommandTools, locked: LockedSpec, values: readonly ValueRecord[], write: readonly PlannedCell[], source: 'TYPED' | 'GRADED' = 'TYPED'): Promise<number> {
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const place = new Map(values.map((value) => [value.pointOfMeasureId, value.seq]))
  let next = nextPlace(values)
  let written = 0
  const fresh: PlannedCell[] = []
  for (const cell of write) {
    const asWritten = { ...cell, source }
    if (!cellChanged(asWritten, cell.before)) continue
    written += 1
    if (cell.before) {
      await tx.measurementSpecValue.update({
        where: { id: cell.before.id },
        data: { nominal: cell.nominal, toleranceMinus: cell.toleranceMinus, tolerancePlus: cell.tolerancePlus, source, version: { increment: 1 }, updatedAt: now },
        select: { id: true },
      })
    } else fresh.push(cell)
  }
  for (const cell of fresh) if (!place.has(cell.pointOfMeasureId)) place.set(cell.pointOfMeasureId, next++)
  if (fresh.length > 0) {
    await tx.measurementSpecValue.createMany({
      data: fresh.map((cell) => ({
        id: newId(),
        revisionId: locked.revision.id,
        specId: locked.spec.id,
        pointOfMeasureId: cell.pointOfMeasureId,
        size: cell.size,
        seq: place.get(cell.pointOfMeasureId)!,
        nominal: cell.nominal,
        toleranceMinus: cell.toleranceMinus,
        tolerancePlus: cell.tolerancePlus,
        source,
        createdAt: now,
        updatedAt: now,
        createdById,
      })),
    })
  }
  return written
}

/** A cell as an audit row keeps it: "CHEST_W 54: 58 → 59 (−1/+1)". */
const cellWords = (codeOf: (id: string) => string, cell: { pointOfMeasureId: string; size: string; nominal: string | null; toleranceMinus?: string; tolerancePlus?: string }, before: { nominal: string } | null) =>
  `${codeOf(cell.pointOfMeasureId)} ${cell.size}: ${before ? measureText(before.nominal) : '—'} → ${cell.nominal === null ? '—' : `${cell.nominal}${cell.toleranceMinus !== undefined ? ` (−${cell.toleranceMinus}/+${cell.tolerancePlus})` : ''}`}`

async function typedCells(
  tools: CommandTools,
  styleId: string,
  revisionId: string,
  version: number,
  asked: readonly CellInput[] | ((baseSize: string) => readonly CellInput[]),
  change: 'CELLS' | 'POINTS',
  guard?: (values: readonly ValueRecord[], codeOf: (id: string) => string) => Issue[],
): Promise<MeasurementSpecView> {
  const { tx } = tools
  const locked = await lockSpec(tools, styleId, revisionId, version)
  const cells = typeof asked === 'function' ? asked(locked.spec.baseSize) : asked
  const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
  const values = await readValues(tx, locked.spec.id)
  const rows = await readSpecPoints(tx, [...values.map((value) => value.pointOfMeasureId), ...cells.map((cell) => cell.pointOfMeasureId)])
  const codeOf = (id: string) => rows.get(id)?.code ?? id
  const early = guard?.(values, codeOf) ?? []
  if (early.length > 0) throw invalid(early, NOUN)
  if (new Set([...values.map((value) => value.pointOfMeasureId), ...cells.map((cell) => cell.pointOfMeasureId)]).size > SPEC_LIMITS.points) {
    throw invalid([{ path: 'body', message: `A spec has at most ${SPEC_LIMITS.points} points of measure.` }], NOUN)
  }
  const plan = planCells(cells, { values, points: new Map([...rows].map(([id, row]) => [id, specPointOf(row)])), sizes: style.sizes, baseSize: locked.spec.baseSize })
  if (plan.problems.length > 0) throw invalid(prefixed(plan.problems), NOUN)
  const written = await writeCells(tools, locked, values, plan.write)
  if (plan.remove.length > 0) {
    const { count } = await tx.measurementSpecValue.deleteMany({ where: { id: { in: plan.remove.map((value) => value.id) } } })
    if (count !== plan.remove.length) throw new ConflictError('The measurement spec changed while it was written: load it again.')
  }
  await bumpSpec(tools, locked)
  recordChange(tools, locked, change, {
    written,
    removed: plan.remove.length,
    cells: [...plan.write.filter((cell) => cellChanged({ ...cell, source: 'TYPED' }, cell.before)).map((cell) => cellWords(codeOf, cell, cell.before)), ...plan.remove.map((value) => cellWords(codeOf, { ...value, nominal: null }, value))].slice(0, 200),
  })
  return specViewInTx(tx, styleId, revisionId)
}

/** product.measures.writeCells: cells typed or pasted (TYPED; null takes a cell out). */
export async function writeSpecCells(caller: CommandCaller, styleId: string, revisionId: string, body: SpecCellsBody, idempotencyKey?: string): Promise<MeasurementSpecView> {
  await writer(caller, styleId, revisionId)
  const { result } = await command(caller, { name: 'product.measures.writeCells', idempotencyKey, input: { styleId, revisionId, ...body } }, (tools) => typedCells(tools, styleId, revisionId, body.version, body.cells, 'CELLS')).catch(clashed)
  return result
}

/** product.measures.addPoints: points of the library added at the end, each with its base size value. */
export async function addSpecPoints(caller: CommandCaller, styleId: string, revisionId: string, body: AddSpecPointsBody, idempotencyKey?: string): Promise<MeasurementSpecView> {
  await writer(caller, styleId, revisionId)
  const ids = body.points.map((point) => point.pointOfMeasureId)
  if (new Set(ids).size !== ids.length) throw invalid([{ path: 'body/points', message: 'Each point once.' }], NOUN)
  const { result } = await command(caller, { name: 'product.measures.addPoints', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const cells = (baseSize: string): CellInput[] => body.points.map((point) => ({ pointOfMeasureId: point.pointOfMeasureId, size: baseSize, nominal: point.nominal, toleranceMinus: point.toleranceMinus, tolerancePlus: point.tolerancePlus }))
    return typedCells(tools, styleId, revisionId, body.version, cells, 'POINTS', (values, codeOf) =>
      body.points.flatMap((point, index) => (values.some((value) => value.pointOfMeasureId === point.pointOfMeasureId) ? [{ path: `body/points/${index}/pointOfMeasureId`, message: `${codeOf(point.pointOfMeasureId)} is in the spec already: type its cells instead.` }] : [])),
    )
  }).catch(clashed)
  return result
}

/** product.measures.removePoints: points out of the spec (every size of each). */
export async function removeSpecPoints(caller: CommandCaller, styleId: string, revisionId: string, body: SpecPointsBody, idempotencyKey?: string): Promise<MeasurementSpecView> {
  await writer(caller, styleId, revisionId)
  if (new Set(body.pointOfMeasureIds).size !== body.pointOfMeasureIds.length) throw invalid([{ path: 'body/pointOfMeasureIds', message: 'Each point once.' }], NOUN)
  const { result } = await command(caller, { name: 'product.measures.removePoints', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx } = tools
    const locked = await lockSpec(tools, styleId, revisionId, body.version)
    const values = await readValues(tx, locked.spec.id)
    const unknown = body.pointOfMeasureIds.filter((id) => !values.some((value) => value.pointOfMeasureId === id))
    if (unknown.length > 0) throw new NotFoundError(`${unknown.length} point(s) are not in this spec.`)
    const gone = values.filter((value) => body.pointOfMeasureIds.includes(value.pointOfMeasureId))
    const { count } = await tx.measurementSpecValue.deleteMany({ where: { specId: locked.spec.id, pointOfMeasureId: { in: [...body.pointOfMeasureIds] } } })
    if (count !== gone.length) throw new ConflictError('The measurement spec changed while it was written: load it again.')
    await bumpSpec(tools, locked)
    const codes = await readSpecPoints(tx, body.pointOfMeasureIds)
    recordChange(tools, locked, 'POINTS', { removedPoints: body.pointOfMeasureIds.map((id) => codes.get(id)?.code ?? id), cells: gone.length })
    return specViewInTx(tx, styleId, revisionId)
  })
  return result
}

/** product.measures.reorderPoints: every point of the spec in its new order (places 1, 2, 3 …, the same on every size). */
export async function reorderSpecPoints(caller: CommandCaller, styleId: string, revisionId: string, body: SpecPointsBody, idempotencyKey?: string): Promise<MeasurementSpecView> {
  await writer(caller, styleId, revisionId)
  const { result } = await command(caller, { name: 'product.measures.reorderPoints', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockSpec(tools, styleId, revisionId, body.version)
    const values = await readValues(tx, locked.spec.id)
    const current = pointOrder(values)
    const problems = orderProblems(current, body.pointOfMeasureIds)
    if (problems.length > 0) throw invalid(prefixed(problems), 'order')
    let moved = 0
    for (const [index, pointId] of body.pointOfMeasureIds.entries()) {
      if (current[index] === pointId && values.filter((value) => value.pointOfMeasureId === pointId).every((value) => value.seq === index + 1)) continue
      const { count } = await tx.measurementSpecValue.updateMany({ where: { specId: locked.spec.id, pointOfMeasureId: pointId }, data: { seq: index + 1, version: { increment: 1 }, updatedAt: now } })
      moved += count > 0 ? 1 : 0
    }
    await bumpSpec(tools, locked)
    recordChange(tools, locked, 'POINTS', { reordered: body.pointOfMeasureIds, moved })
    return specViewInTx(tx, styleId, revisionId)
  })
  return result
}

/**
 * product.measures.approveSpec: what samples, the release and the final inspection measure against. Every point has a
 * value for every size of the range (said in words first); ONE update moves it with who and when (the database checks
 * the same).
 */
export async function approveSpec(caller: CommandCaller, styleId: string, revisionId: string, body: SpecMoveBody, idempotencyKey?: string): Promise<MeasurementSpecView> {
  await writer(caller, styleId, revisionId, PRODUCT_BOM_RELEASE)
  const { result } = await command(caller, { name: 'product.measures.approveSpec', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx, now, context } = tools
    const locked = await lockSpec(tools, styleId, revisionId, body.version)
    const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
    const values = await readValues(tx, locked.spec.id)
    const codes = await readSpecPoints(
      tx,
      values.map((value) => value.pointOfMeasureId),
    )
    const problems = approvalProblems(values, { sizes: style.sizes, baseSize: locked.spec.baseSize, codeOf: (id) => codes.get(id)?.code ?? id })
    if (problems.length > 0) throw new ValidationError(`The measurement spec is not complete: ${problems.map((problem) => problem.message).join(' ')}`, problems)
    if (context.audience !== 'office') throw new InvalidStateError('A measurement spec is approved by a person in the office.')
    await bumpSpec(tools, locked, { status: 'APPROVED', approvedAt: now, approvedById: context.actorId })
    recordChange(tools, locked, 'APPROVED', { status: 'APPROVED', points: codes.size, cells: values.length })
    return specViewInTx(tx, styleId, revisionId)
  })
  return result
}

/** product.measures.reopenSpec: an approved spec back to DRAFT (its approval cleared), while the revision is a draft. */
export async function reopenSpec(caller: CommandCaller, styleId: string, revisionId: string, body: SpecMoveBody, idempotencyKey?: string): Promise<MeasurementSpecView> {
  await writer(caller, styleId, revisionId, PRODUCT_BOM_RELEASE)
  const { result } = await command(caller, { name: 'product.measures.reopenSpec', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const locked = await lockSpec(tools, styleId, revisionId, body.version, ['APPROVED'])
    await bumpSpec(tools, locked, { status: 'DRAFT', approvedAt: null, approvedById: null })
    recordChange(tools, locked, 'REOPENED', { status: 'DRAFT', approvedAt: locked.spec.approvedAt, approvedById: locked.spec.approvedById }, body.reason)
    return specViewInTx(tools.tx, styleId, revisionId)
  })
  return result
}

/** product.measures.archiveSpec: the live spec kept as ARCHIVED (never changes again), so another can be started. */
export async function archiveSpec(caller: CommandCaller, styleId: string, revisionId: string, body: SpecMoveBody, idempotencyKey?: string): Promise<MeasurementSpecView> {
  await writer(caller, styleId, revisionId)
  const { result } = await command(caller, { name: 'product.measures.archiveSpec', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const locked = await lockSpec(tools, styleId, revisionId, body.version, ['DRAFT', 'APPROVED'])
    await bumpSpec(tools, locked, { status: 'ARCHIVED' })
    recordChange(tools, locked, 'ARCHIVED', { status: 'ARCHIVED', from: locked.spec.status }, body.reason)
    return specViewInTx(tools.tx, styleId, revisionId)
  })
  return result
}
