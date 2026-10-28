import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { AddLineBody, BomView, SetColoursBody, SetSizesBody, UpdateLineBody, UpdateRevisionBody } from '@nexus/factory-domain/product/bom/contracts'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import { hideYieldProblem, MAX_BOM_LINES, nextSeq, planLine, type LineChange } from '@nexus/factory-domain/product/bom/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import {
  assertMayWrite,
  auditedLine,
  bomStyleOf,
  bomViewInTx,
  contextOf,
  deleteLine,
  invalid,
  isUniqueViolation,
  lockDraft,
  materialFor,
  prefixed,
  readColourways,
  readLines,
  readRevisionFor,
  supplierProblems,
  writeLine,
  type LineRecord,
  type LockedDraft,
} from './store'

/**
 * A draft revision's BOM lines (features PRD-043, PRD-076, PRD-079, PRD-082, PRD-100): added, changed (fields, the
 * quantity per size, the colour grid) and removed, and the revision's own planned hide yield and change note. Every
 * write sends the revision's version: it locks the style row, checks the revision is a draft (409 otherwise, before the
 * database's own refusal), compares and sets the revision's version, then writes the parts; it records an audit row on
 * the line and one on the revision, and `style.bom_changed`.
 */

function recordChange(tools: CommandTools, draft: LockedDraft, lineIds: readonly string[], change: Record<string, unknown>): void {
  const { style } = draft
  tools.audit({ recordType: 'StyleRevision', recordId: draft.revisionId, companyId: style.companyId, after: { bom: change, version: draft.version } })
  tools.emit({
    type: 'style.bom_changed',
    subject: style.id,
    companyId: style.companyId,
    payload: { styleId: style.id, code: style.code, revisionId: draft.revisionId, revision: draft.revision, lineIds: [...lineIds] },
  })
}

/** Plans a new line or a change against the material it will have and the style as it is, inside the command. */
async function plan(tools: CommandTools, draft: LockedDraft, current: LineRecord | null, change: LineChange, lines: readonly LineRecord[]) {
  const { tx } = tools
  const itemId = change.itemId ?? current?.itemId
  if (itemId === undefined) throw invalid([{ path: 'body/itemId', message: 'Choose the material.' }])
  const material = await materialFor(tx, itemId, draft.style.companyId)
  const row = await tx.style.findUniqueOrThrow({ where: { id: draft.style.id }, select: { sizes: true, baseSize: true } })
  const style = bomStyleOf(row, await readColourways(tx, draft.style.id))
  const planned = planLine(current, change, material, style, nextSeq(lines))
  if (!planned.ok) throw invalid(prefixed(planned.issues))
  const line = planned.line
  if (change.supplierId !== undefined && change.supplierId !== current?.supplierId) {
    const problems = await supplierProblems(tx, line.supplierId, draft.style.companyId)
    if (problems.length > 0) throw invalid(problems)
  }
  const clash = lines.find((other) => other.seq === line.seq && other.id !== current?.id)
  if (clash) throw new ConflictError(`Place ${line.seq} is taken by another line of this BOM: choose another.`)
  return line
}

/** product.bom.addLine: a line at the end of the draft's BOM (or at the place sent). */
export async function addLine(caller: CommandCaller, styleId: string, revisionId: string, body: AddLineBody, idempotencyKey?: string): Promise<BomView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  const { version, ...change } = body

  const { result } = await command(caller, { name: 'product.bom.addLine', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const lines = await readLines(tools.tx, revisionId)
    if (lines.length >= MAX_BOM_LINES) throw new ValidationError('The BOM is full.', [{ path: 'body', message: `A BOM has at most ${MAX_BOM_LINES} lines.` }])
    const line = await plan(tools, draft, null, change, lines)
    const id = newId()
    await writeLine(tools, { styleId, revisionId, lineId: id }, line, null)
    const after = auditedLine(line)
    tools.audit({ recordType: 'BomLine', recordId: id, companyId: draft.style.companyId, after: { revisionId, ...after } })
    recordChange(tools, draft, [id], { added: id, seq: line.seq, itemId: line.itemId })
    return bomViewInTx(tools.tx, styleId, revisionId)
  }).catch(seqTaken)
  return result
}

const seqTaken = (error: unknown): never => {
  if (isUniqueViolation(error)) throw new ConflictError('This place in the BOM is taken by another line: choose another.')
  throw error
}

/** The line of this revision, read inside the command. */
function lineOf(lines: readonly LineRecord[], lineId: string): LineRecord {
  const line = isUuid(lineId) ? lines.find((entry) => entry.id === lineId) : undefined
  if (!line) throw new NotFoundError('BOM line not found.')
  return line
}

/** One change to one line: its fields, its sizes or its grid. */
async function changeLine(
  caller: CommandCaller,
  name: 'product.bom.updateLine' | 'product.bom.setSizes' | 'product.bom.setColours',
  target: { styleId: string; revisionId: string; lineId: string },
  version: number,
  change: LineChange,
  input: unknown,
  idempotencyKey: string | undefined,
): Promise<BomView> {
  const context = contextOf(caller)
  const { styleId, revisionId, lineId } = target
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await command(caller, { name, idempotencyKey, input }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const lines = await readLines(tools.tx, revisionId)
    const current = lineOf(lines, lineId)
    const line = await plan(tools, draft, current, change, lines)
    await writeLine(tools, { styleId, revisionId, lineId }, line, current)
    tools.audit({ recordType: 'BomLine', recordId: lineId, companyId: draft.style.companyId, before: auditedLine(current), after: auditedLine(line) })
    recordChange(tools, draft, [lineId], { changed: lineId })
    return bomViewInTx(tools.tx, styleId, revisionId)
  }).catch(seqTaken)
  return result
}

/** product.bom.updateLine: the fields sent (material, placement, unit, quantity, wastage, dependence, colour, supplier …). */
export function updateLine(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: UpdateLineBody, idempotencyKey?: string): Promise<BomView> {
  const { version, ...change } = body
  return changeLine(caller, 'product.bom.updateLine', { styleId, revisionId, lineId }, version, change, { styleId, revisionId, lineId, ...body }, idempotencyKey)
}

/** product.bom.setSizes: a size-dependent line's quantities (PRD-079), merged: 0 where a size does not use it, null clears. */
export function setSizes(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: SetSizesBody, idempotencyKey?: string): Promise<BomView> {
  return changeLine(caller, 'product.bom.setSizes', { styleId, revisionId, lineId }, body.version, { sizes: body.sizes }, { styleId, revisionId, lineId, ...body }, idempotencyKey)
}

/** product.bom.setColours: a colour-dependent line's grid (PRD-043), merged: a colour sets a colourway's cell, null clears it. */
export function setColours(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: SetColoursBody, idempotencyKey?: string): Promise<BomView> {
  return changeLine(caller, 'product.bom.setColours', { styleId, revisionId, lineId }, body.version, { colours: body.colours }, { styleId, revisionId, lineId, ...body }, idempotencyKey)
}

/** product.bom.removeLine: the line out of the draft, with its size quantities and grid cells. */
export async function removeLine(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, version: number, idempotencyKey?: string): Promise<BomView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.bom.removeLine', idempotencyKey, input: { styleId, revisionId, lineId, version } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const current = lineOf(await readLines(tools.tx, revisionId), lineId)
    await deleteLine(tools, current)
    tools.audit({ recordType: 'BomLine', recordId: lineId, companyId: draft.style.companyId, before: { revisionId, ...auditedLine(current) }, after: { removed: true } })
    recordChange(tools, draft, [lineId], { removed: lineId, seq: current.seq, itemId: current.itemId })
    return bomViewInTx(tools.tx, styleId, revisionId)
  })
  return result
}

/** product.bom.updateRevision: a draft's change note and planned hide yield (PRD-082). */
export async function updateRevision(caller: CommandCaller, styleId: string, revisionId: string, body: UpdateRevisionBody, idempotencyKey?: string): Promise<BomView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  const yieldPct = body.plannedHideYieldPct === undefined || body.plannedHideYieldPct === null ? body.plannedHideYieldPct : decimalText(body.plannedHideYieldPct)
  const problem = hideYieldProblem(yieldPct ?? null)
  if (problem) throw invalid([{ path: 'body/plannedHideYieldPct', message: problem }], 'revision')

  const { result } = await command(caller, { name: 'product.bom.updateRevision', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx } = tools
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const before = await tx.styleRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { changeNote: true, plannedHideYieldPct: true } })
    const data = {
      ...(body.changeNote === undefined ? {} : { changeNote: body.changeNote }),
      ...(yieldPct === undefined ? {} : { plannedHideYieldPct: yieldPct }),
    }
    await tx.styleRevision.update({ where: { id: revisionId }, data, select: { id: true } })
    const was = { changeNote: before.changeNote, plannedHideYieldPct: before.plannedHideYieldPct === null ? null : decimalText(before.plannedHideYieldPct.toString()) }
    const keys = Object.keys(data) as (keyof typeof was)[]
    tools.audit({
      recordType: 'StyleRevision',
      recordId: revisionId,
      companyId: draft.style.companyId,
      before: Object.fromEntries(keys.map((key) => [key, was[key]])),
      after: { ...data, version: draft.version },
    })
    tools.emit({
      type: 'style.bom_changed',
      subject: styleId,
      companyId: draft.style.companyId,
      payload: { styleId, code: draft.style.code, revisionId, revision: draft.revision, lineIds: [] },
    })
    return bomViewInTx(tx, styleId, revisionId)
  })
  return result
}
