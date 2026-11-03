import { createHash } from 'node:crypto'
import { ConflictError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { GradingChange } from '@nexus/factory-domain/inventory/hides/changes'
import { gradingRefusal } from '@nexus/factory-domain/inventory/hides/grading'
import { QUALITY_INCOMING_RECORD } from '@nexus/factory-domain/quality/incoming/permissions'
import { cancelReasonProblem, decisionProblems, decisionShape, isOverride, nextStepOf, type DecisionDraft, type DecisionFacts } from '@nexus/factory-domain/quality/incoming/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertFloorReady } from '../../production/serials/facts'
import { postedBy, signerOf, type Inspector } from '../final/access'
import { sampleFactsOf, type SampleFacts } from './facts'
import { incomingView } from './views'
import { assertOpen, assertOwn, incomingFor, lockIncoming, readIncoming, takeOver, type IncomingRow, type LotRow, type Reader } from './store'

/**
 * The decision of an incoming inspection (B-W2b-98; QHS-034 "Partial acceptance and split"; design floor.incoming
 * "Decision: three QuantityPads: accepted, rejected, to sort (they must add up). Summary; the inspector's PinPad with the
 * meaning in words"), and its cancellation.
 *
 *   decide   { version, accepted, rejected, toSort, overrideReason?, note? }: a signing act (the office's fresh code, the
 *            floor's PIN), asked after every other check. ONE command at the inspection's version: the rules again
 *            (factory-domain quality/incoming decisionProblems: adding up to the lot, never fewer than the sample's
 *            decisions, units outside the sample accepted only on a whole sample, every hide decided, the whole lot never
 *            accepted over a critical defect, a failed critical check or a missing mandatory check, the reason exactly
 *            when the whole lot goes against the computed result); every hide of the sample then takes the grade and
 *            shade group it was given here, as records (the text with them), and its marks become HideMark rows naming
 *            the inspection (MES-054: they stay with the hide, for the cutting table and a claim); the decision with its
 *            SHA-256, which the database checks and completes with the computed result.
 *   cancel   { version, reason }: an OPEN inspection abandoned, with why.
 *
 * The lot does not move: a person with the quality role releases or rejects it by typing its code, never its receiver
 * (Owner answer W3; modules/quality/lab). The record then says so in words, with what to do with the rejected hides (hold
 * them, return them to the tannery: purchasing's claim, sent by a person).
 */

const invalid = (problems: readonly Issue[], words: string) =>
  new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body/') ? problem.path : `body/${problem.path}` })))

/** The e-signature: SHA-256 of what was signed, by whom, when. */
const signatureOf = (what: unknown): string => createHash('sha256').update(JSON.stringify(what)).digest('hex')

const codesOf = async (db: Reader, facts: SampleFacts): Promise<Map<string, string>> => {
  const ids = facts.results.map((result) => result.hideId)
  return new Map((ids.length ? await db.hide.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } }) : []).map((hide) => [hide.id, hide.code]))
}

async function decisionFactsOf(db: Reader, row: IncomingRow): Promise<{ facts: SampleFacts; decision: DecisionFacts }> {
  const byHide = row.uom === 'HIDE'
  const facts = await sampleFactsOf(db, row, byHide)
  const codes = await codesOf(db, facts)
  return {
    facts,
    decision: {
      lotSize: row.lotSize.toString(),
      whole: byHide || row.uom === 'PCS' || row.uom === 'PAIR',
      sampleSize: row.sampleSize,
      byHide,
      tally: facts.tally,
      undecided: facts.results.filter((result) => result.decision === null).map((result) => codes.get(result.hideId) ?? result.hideId),
      computed: facts.computed,
      mandatoryMissing: facts.now.mandatoryMissing,
    },
  }
}

export interface DecideBody extends DecisionDraft {
  readonly version: number
}

/** The hides of the sample take what the inspection gave them; their marks are written to them (HideMark). */
async function writeToHides(tools: CommandTools, context: Inspector, row: IncomingRow, lot: LotRow, facts: SampleFacts): Promise<number> {
  const { tx, now } = tools
  let marked = 0
  const zoneCodes = [...new Set([...facts.marks.values()].flat().flatMap((mark) => (mark.zone ? [mark.zone] : [])))]
  const grades = new Map((zoneCodes.length ? await tx.leatherGrade.findMany({ where: { code: { in: zoneCodes } }, select: { id: true, code: true } }) : []).map((grade) => [grade.code, grade.id]))
  for (const result of facts.results) {
    const hide = (await tx.hide.findUnique({ where: { id: result.hideId }, select: { id: true, code: true, state: true, itemId: true, grade: true, gradeId: true, shade: true, shadeGroupId: true } }))!
    // The grade and the shade group as records, each with its text (the …_leather_stock_w2b_guards Hide_grade_shade_check).
    const changed: GradingChange[] = []
    const data: { gradeId?: string | null; grade?: string | null; shadeGroupId?: string | null; shade?: string | null } = {}
    if (gradingRefusal(hide) === null) {
      if (result.gradeRecordId && (result.gradeRecordId !== hide.gradeId || result.grade !== hide.grade)) {
        Object.assign(data, { gradeId: result.gradeRecordId, grade: result.grade })
        changed.push('GRADE')
      }
      if (result.shadeRecordId && (result.shadeRecordId !== hide.shadeGroupId || result.shadeGroup !== hide.shade)) {
        Object.assign(data, { shadeGroupId: result.shadeRecordId, shade: result.shadeGroup })
        changed.push('SHADE')
      }
    }
    if (changed.length > 0) {
      await tx.hide.update({ where: { id: hide.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({
        action: 'inventory.gradeHide',
        recordType: 'Hide',
        recordId: hide.id,
        companyId: lot.companyId,
        siteId: lot.siteId,
        before: { grade: hide.grade, gradeId: hide.gradeId, shade: hide.shade, shadeGroupId: hide.shadeGroupId },
        after: { grade: data.grade ?? hide.grade, gradeId: data.gradeId ?? hide.gradeId, shade: data.shade ?? hide.shade, shadeGroupId: data.shadeGroupId ?? hide.shadeGroupId },
        reason: `Incoming inspection ${row.number}.`,
      })
      tools.emit({
        type: 'inventory.hide_graded',
        subject: hide.id,
        companyId: lot.companyId,
        siteId: lot.siteId,
        payload: { hideId: hide.id, lotId: lot.id, itemId: hide.itemId, changed, gradeId: data.gradeId ?? hide.gradeId, gradeCode: (data.gradeId ?? hide.gradeId) ? (data.grade ?? hide.grade) : null, shadeGroupId: data.shadeGroupId ?? hide.shadeGroupId, shadeLabel: (data.shadeGroupId ?? hide.shadeGroupId) ? (data.shade ?? hide.shade) : null },
      })
    }
    for (const mark of facts.marks.get(result.id) ?? []) {
      const defect = mark.kind === 'DEFECT' && mark.code ? facts.defects.get(mark.code) : undefined
      await tx.hideMark.create({
        data: {
          id: newId(),
          siteId: row.siteId,
          lotId: lot.id,
          hideId: hide.id,
          kind: mark.kind,
          x: new Dec(String(mark.x)).toFixed(5),
          y: new Dec(String(mark.y)).toFixed(5),
          outline: mark.kind === 'ZONE' ? (mark.outline ?? []).map((point) => ({ x: point.x, y: point.y })) : [],
          defectCodeId: defect?.id ?? null,
          zoneGradeId: mark.zone ? (grades.get(mark.zone) ?? null) : null,
          incomingInspectionId: row.id,
          note: mark.note ?? null,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
        },
        select: { id: true },
      })
      marked++
    }
  }
  return marked
}

/** POST /quality/incoming/:inspectionId/decide */
export async function decideIncoming(caller: CommandCaller, inspectionId: string, body: DecideBody, options: { readonly sign: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const { row: seen, lot, context } = await incomingFor(caller, inspectionId, QUALITY_INCOMING_RECORD)
  assertOwn(context, seen)
  assertOpen(seen)
  if (context.audience === 'floor') await assertFloorReady(caller, seen.siteId)
  // Answered in the command too; said first so a stale screen is not asked for a PIN.
  if (seen.version !== body.version) throw new StaleVersionError('IncomingInspection', seen.id, seen.version, body.version)
  const first = await caller.withClient((db) => decisionFactsOf(db, seen))
  const problems = decisionProblems(body, first.decision)
  if (problems.length > 0) throw invalid(problems, 'The decision cannot be signed.')
  await options.sign()
  const { result } = await command(caller, { name: 'quality.incoming.decide', idempotencyKey: options.idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockIncoming(tx, seen.id, body.version)
    const { facts, decision } = await decisionFactsOf(tx, row)
    const again = decisionProblems(body, decision)
    if (again.length > 0) throw new ConflictError(`The inspection changed while you signed: ${again.map((problem) => problem.message).join(' ')}`)
    const shape = decisionShape(body, decision.lotSize)
    const overrideReason = isOverride(shape, facts.computed) ? body.overrideReason!.trim() : null
    const quantities = { accepted: new Dec(body.accepted.trim()).toFixed(4), rejected: new Dec(body.rejected.trim()).toFixed(4), toSort: new Dec(body.toSort.trim()).toFixed(4) }
    const marked = await writeToHides(tools, context, row, lot, facts)
    const signer = signerOf(context)
    const signature = signatureOf({
      incomingInspectionId: row.id,
      number: row.number,
      lotId: lot.id,
      planVersionId: row.planVersionId,
      sample: { size: row.sampleSize, found: facts.found, hides: facts.results.map((entry) => ({ hideId: entry.hideId, decision: entry.decision, grade: entry.grade, shade: entry.shadeGroup, measuredArea: entry.measuredArea.toFixed(4), areaUom: entry.areaUom })) },
      computed: facts.computed.result,
      ...quantities,
      overrideReason,
      signer,
      at: toUtcIso(now),
    })
    const decided = await tx.incomingInspection.update({
      where: { id: row.id },
      data: {
        status: 'DECIDED',
        foundCritical: facts.found.critical,
        foundMajor: facts.found.major,
        foundMinor: facts.found.minor,
        acceptedQuantity: quantities.accepted,
        rejectedQuantity: quantities.rejected,
        toSortQuantity: quantities.toSort,
        overrideReason,
        decidedAt: now,
        signatureSha256: signature,
        ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
        ...takeOver(context, row),
        version: { increment: 1 },
        updatedAt: now,
      },
      select: { computedResult: true },
    })
    if (decided.computedResult !== facts.computed.result) throw new ConflictError('The computed result differs from the rules: reload the inspection.')
    const next = nextStepOf(quantities, row.lotSize.toString())
    tools.audit({
      recordType: 'IncomingInspection',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: 'OPEN' },
      after: { status: 'DECIDED', computedResult: facts.computed.result, reasons: facts.computed.reasons, found: facts.found, ...quantities, overrideReason, next, marksWritten: marked, signatureSha256: signature, signedBy: postedBy(context) },
      ...(overrideReason ? { reason: overrideReason } : {}),
    })
    tools.emit({
      type: 'incoming_inspection.decided',
      subject: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      payload: { incomingInspectionId: row.id, number: row.number, lotId: lot.id, computedResult: facts.computed.result, ...quantities, uom: row.uom, overridden: overrideReason !== null, next, postedBy: postedBy(context) },
    })
    return { id: row.id }
  })
  return caller.withClient(async (db) => incomingView(db, (await readIncoming(db, result.id))!, lot, context))
}

/** POST /quality/incoming/:inspectionId/cancel */
export async function cancelIncoming(caller: CommandCaller, inspectionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string | undefined) {
  const { row: seen, lot, context } = await incomingFor(caller, inspectionId, QUALITY_INCOMING_RECORD)
  assertOwn(context, seen)
  assertOpen(seen)
  const problem = cancelReasonProblem(body.reason)
  if (problem) throw invalid([problem], 'Say why the inspection is cancelled.')
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'quality.incoming.cancel', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const row = await lockIncoming(tools.tx, seen.id, body.version)
    await tools.tx.incomingInspection.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: reason, ...takeOver(context, row), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'IncomingInspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason })
    tools.emit({ type: 'incoming_inspection.cancelled', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { incomingInspectionId: row.id, number: row.number, lotId: lot.id, postedBy: postedBy(context) } })
    return { id: row.id }
  })
  return caller.withClient(async (db) => incomingView(db, (await readIncoming(db, result.id))!, lot, context))
}
