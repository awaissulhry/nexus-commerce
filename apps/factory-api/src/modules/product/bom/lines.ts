import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { AddLineBody, BomView, SetColoursBody, SetSizesBody, UpdateLineBody, UpdateRevisionBody } from '@nexus/factory-domain/product/bom/contracts'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import { MAIN_REFUSAL_WORDS, mainRefusalOf, removeRefusalOf, type MainRefusal } from '@nexus/factory-domain/product/bom/main'
import { hideYieldProblem, MAX_BOM_LINES, nextSeq, planLine, routingSeqProblem, type LineChange } from '@nexus/factory-domain/product/bom/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { readSteps } from '../routing/read'
import { assertMayEditDraft } from '../drafts/may-edit' // owb-pd1 1.4: the designer edits a DRAFT's lines
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
 * the line and one on the revision, and `style.bom_changed`. B-W2b-88: a line may name the step of the revision's routing
 * that uses it (`routingSeq`; the routing and the BOM are one versioned record, so the style row's lock holds both).
 * owb-pd3 step 3.3 (design plan § 5zc): the main material — `isMain` on add or change moves the one mark of the revision to the line
 * (the index BomLine_one_main holds one); the main line is never taken out nor unmarked (MAIN_REQUIRED); a line added or changed to a
 * material another line uses at the same placement for the same colourways is refused (SAME_MATERIAL). Refusals 409 `refusal/<CODE>`.
 */

const mainRefused = (code: MainRefusal): DomainError => new DomainError('conflict', MAIN_REFUSAL_WORDS[code], [{ path: `refusal/${code}`, message: MAIN_REFUSAL_WORDS[code] }])

/** The revision's main-material mark moved to `lineId` (the old one cleared first: one per revision). */
async function markMain(tools: CommandTools, revisionId: string, lineId: string): Promise<void> {
  const { tx, now } = tools
  await tx.bomLine.updateMany({ where: { revisionId, isMain: true, NOT: { id: lineId } }, data: { isMain: false, version: { increment: 1 }, updatedAt: now } })
  await tx.bomLine.update({ where: { id: lineId }, data: { isMain: true, updatedAt: now }, select: { id: true } })
}

/** Refuses a change the main-material rules refuse (the duplicate rule only when the line's material, placement or colourway moves). */
function assertMainRules(lines: readonly LineRecord[], current: LineRecord | null, line: { readonly itemId: string; readonly placement: string | null; readonly colourwayId: string | null }, wantsMain: boolean | undefined): void {
  const refusal = mainRefusalOf(lines, { lineId: current?.id ?? null, itemId: line.itemId, placement: line.placement, colourwayId: line.colourwayId, wantsMain })
  if (refusal === 'SAME_MATERIAL' && current && current.itemId === line.itemId && (current.placement ?? '') === (line.placement ?? '') && current.colourwayId === line.colourwayId) return
  if (refusal) throw mainRefused(refusal)
}

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
  const routingSeq = line.routingSeq ?? null
  if (routingSeq !== null && routingSeq !== (current?.routingSeq ?? null)) {
    const problem = routingSeqProblem(routingSeq, await readSteps(tx, draft.revisionId))
    if (problem) throw invalid([{ path: 'body/routingSeq', message: problem }])
  }
  return line
}

/** product.bom.addLine: a line at the end of the draft's BOM (or at the place sent). */
export async function addLine(caller: CommandCaller, styleId: string, revisionId: string, body: AddLineBody, idempotencyKey?: string): Promise<BomView> {
  const context = contextOf(caller)
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  assertMayEditDraft(context, style.companyId, revision.status, PRODUCT_BOM_MANAGE) // owb-pd1 1.4: or the designer on a DRAFT
  const { version, isMain, ...change } = body

  const { result } = await command(caller, { name: 'product.bom.addLine', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const lines = await readLines(tools.tx, revisionId)
    if (lines.length >= MAX_BOM_LINES) throw new ValidationError('The BOM is full.', [{ path: 'body', message: `A BOM has at most ${MAX_BOM_LINES} lines.` }])
    const line = await plan(tools, draft, null, change, lines)
    assertMainRules(lines, null, line, isMain) // owb-pd3
    const id = newId()
    await writeLine(tools, { styleId, revisionId, lineId: id }, line, null)
    if (isMain === true) await markMain(tools, revisionId, id)
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
  /** owb-pd3: the main-material mark asked (updateLine only). */
  wantsMain?: boolean,
): Promise<BomView> {
  const context = contextOf(caller)
  const { styleId, revisionId, lineId } = target
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  assertMayEditDraft(context, style.companyId, revision.status, PRODUCT_BOM_MANAGE) // owb-pd1 1.4: or the designer on a DRAFT

  const { result } = await command(caller, { name, idempotencyKey, input }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const lines = await readLines(tools.tx, revisionId)
    const current = lineOf(lines, lineId)
    const line = await plan(tools, draft, current, change, lines)
    assertMainRules(lines, current, line, wantsMain) // owb-pd3
    await writeLine(tools, { styleId, revisionId, lineId }, line, current)
    if (wantsMain === true && current.isMain !== true) await markMain(tools, revisionId, lineId)
    tools.audit({ recordType: 'BomLine', recordId: lineId, companyId: draft.style.companyId, before: { ...auditedLine(current), isMain: current.isMain === true }, after: { ...auditedLine(line), isMain: wantsMain ?? current.isMain === true } })
    recordChange(tools, draft, [lineId], { changed: lineId })
    return bomViewInTx(tools.tx, styleId, revisionId)
  }).catch(seqTaken)
  return result
}

/** product.bom.updateLine: the fields sent (material, placement, unit, quantity, wastage, dependence, colour, supplier …). */
export function updateLine(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: UpdateLineBody, idempotencyKey?: string): Promise<BomView> {
  const { version, isMain, ...change } = body
  return changeLine(caller, 'product.bom.updateLine', { styleId, revisionId, lineId }, version, change, { styleId, revisionId, lineId, ...body }, idempotencyKey, isMain)
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
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  assertMayEditDraft(context, style.companyId, revision.status, PRODUCT_BOM_MANAGE) // owb-pd1 1.4: or the designer on a DRAFT

  const { result } = await command(caller, { name: 'product.bom.removeLine', idempotencyKey, input: { styleId, revisionId, lineId, version } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const current = lineOf(await readLines(tools.tx, revisionId), lineId)
    const refusal = removeRefusalOf(current) // owb-pd3: the main material stays
    if (refusal) throw mainRefused(refusal)
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
