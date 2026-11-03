import { createHash } from 'node:crypto'
import { ConflictError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { GradingChange } from '@nexus/factory-domain/inventory/hides/changes'
import { gradingRefusal } from '@nexus/factory-domain/inventory/hides/grading'
import { QUALITY_INCOMING_RECORD } from '@nexus/factory-domain/quality/incoming/permissions'
import { cancelReasonProblem, decisionProblems, decisionShape, isOverride, nextStepOf, type DecisionDraft, type DecisionFacts } from '@nexus/factory-domain/quality/incoming/rules'
import { isRollLot, receiptDecision, rollDecisionProblems, type ReceiptLineFact } from '@nexus/factory-domain/quality/incoming/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { asTenantSystem } from '../../production/bundles/codes'
import { assertFloorReady } from '../../production/serials/facts'
import { releaseReceiptInCommand, type ReceiptRow } from '../../purchasing/subcontracting/inspection'
import { postedBy, signerOf, type Inspector } from '../final/access'
import { readComponents, readRolls, sampleFactsOf, type ComponentRow, type RollRow, type SampleFacts } from './facts'
import { viewOf } from './views'
import { assertOpen, assertOwn, incomingFor, lockIncoming, takeOver, type IncomingRow, type LotRow, type Reader, type Subject } from './store'

/**
 * The decision of an incoming inspection (B-W2b-98; QHS-034 "Partial acceptance and split"; design floor.incoming
 * "Decision: three QuantityPads: accepted, rejected, to sort (they must add up). Summary; the inspector's PinPad with the
 * meaning in words"), and its cancellation.
 *
 *   decide   { version, accepted, rejected, toSort, overrideReason?, note?, rejectedLines? }: a signing act (the office's
 *            fresh code, the floor's PIN), asked after every other check. ONE command at the inspection's version: the
 *            rules again (factory-domain quality/incoming decisionProblems: adding up to the lot, never fewer than the
 *            sample's decisions, units outside the sample accepted only on a whole sample, every hide decided, the whole
 *            lot never accepted over a critical defect, a failed critical check or a missing mandatory check, the reason
 *            exactly when the whole lot goes against the computed result); every hide of the sample then takes the grade
 *            and shade group it was given here, as records (the text with them), and its marks become HideMark rows
 *            naming the inspection (MES-054: they stay with the hide, for the cutting table and a claim); the decision
 *            with its SHA-256, which the database checks and completes with the computed result.
 *   cancel   { version, reason }: an OPEN inspection abandoned, with why.
 *
 * The lot does not move: a person with the quality role releases or rejects it by typing its code, never its receiver
 * (Owner answer W3; modules/quality/lab). The record then says so in words, with what to do with the rejected hides (hold
 * them, return them to the tannery: purchasing's claim, sent by a person).
 *
 * B-W2b-111: every roll and component decided first (the database's rule, said in words before the PIN); a lot counted in
 * a length is bound by its rolls (factory-domain units rollDecisionProblems); goods back from a workshop are decided bundle
 * by bundle (`rejectedLines`; the quantities follow, nothing to sort) and the decision releases them in the same command
 * (purchasing/subcontracting inspection.ts: the bundles kept reported at their operation, the rejected ones' pieces moved to
 * defective, the fee posted); a cancellation lets them go on as received. On a tablet that command runs as the tenant's
 * system caller (the floor has no grant on the subcontract tables), naming the signed-in worker as before.
 */

const invalid = (problems: readonly Issue[], words: string) =>
  new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body/') ? problem.path : `body/${problem.path}` })))

/** The e-signature: SHA-256 of what was signed, by whom, when. */
const signatureOf = (what: unknown): string => createHash('sha256').update(JSON.stringify(what)).digest('hex')

const codesOf = async (db: Reader, facts: SampleFacts): Promise<Map<string, string>> => {
  const ids = facts.results.map((result) => result.hideId)
  return new Map((ids.length ? await db.hide.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } }) : []).map((hide) => [hide.id, hide.code]))
}

interface Facts {
  readonly facts: SampleFacts
  readonly decision: DecisionFacts
  readonly rolls: readonly RollRow[]
  readonly components: readonly ComponentRow[]
}

async function decisionFactsOf(db: Reader, row: IncomingRow, subject: Subject): Promise<Facts> {
  const byHide = row.uom === 'HIDE' && subject.lot !== null
  const facts = await sampleFactsOf(db, row, byHide)
  const codes = await codesOf(db, facts)
  return {
    facts,
    rolls: await readRolls(db, row.id),
    components: await readComponents(db, row.id),
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

const linesOf = (receipt: ReceiptRow): ReceiptLineFact[] =>
  receipt.lines.filter((line) => line.good + line.defective > 0).map((line) => ({ id: line.id, seq: line.seq, bundleCode: line.bundleCode, operationCode: line.operationCode, good: line.good, defective: line.defective, scrapped: line.scrapped }))

/** Every problem of the decision: B-W2b-98's rules, then the rolls', components' and a workshop's (B-W2b-111). */
function problemsOf(body: DecideBody, row: IncomingRow, subject: Subject, facts: Facts): { problems: Issue[]; rejected: ReadonlySet<string> } {
  const problems = decisionProblems(body, facts.decision)
  const rollsOpen = facts.rolls.filter((roll) => roll.decision === null).map((roll) => roll.rollRef)
  if (rollsOpen.length > 0) problems.push({ path: 'rolls', message: `Decide every roll first: ${rollsOpen.join(', ')} ${rollsOpen.length === 1 ? 'has' : 'have'} no decision.` })
  const componentsOpen = facts.components.filter((component) => component.decision === null).map((component) => String(component.seq))
  if (componentsOpen.length > 0) problems.push({ path: 'components', message: `Decide every component check first: line ${componentsOpen.join(', ')} ${componentsOpen.length === 1 ? 'has' : 'have'} no decision.` })
  if (subject.lot && isRollLot(row.uom)) problems.push(...rollDecisionProblems(body, { lotSize: row.lotSize.toString(), uom: row.uom, sampleSize: row.sampleSize, rolls: facts.rolls.map((roll) => ({ lengthM: roll.lengthM.toFixed(2), decision: (roll.decision as 'ACCEPTED' | 'REJECTED' | 'TO_SORT' | null) ?? null })) }))
  let rejected: ReadonlySet<string> = new Set()
  if (subject.receipt) {
    const split = receiptDecision(body, linesOf(subject.receipt))
    problems.push(...split.problems)
    rejected = split.rejected
  } else if (body.rejectedLines !== undefined) problems.push({ path: 'rejectedLines', message: 'Only goods back from a workshop are decided by their receipt lines.' })
  return { problems, rejected }
}

export interface DecideBody extends DecisionDraft {
  readonly version: number
  /** B-W2b-111: goods back from a workshop: the receipt lines (bundles) rejected. */
  readonly rejectedLines?: readonly string[] | undefined
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

/** The caller a workshop receipt's commands run as: a tablet acts as the tenant's system caller (no grant on the subcontract tables). */
const actingAs = (caller: CommandCaller, context: Inspector, subject: Subject): CommandCaller => (context.audience === 'floor' && subject.receipt ? asTenantSystem(caller, context) : caller)

/** POST /quality/incoming/:inspectionId/decide */
export async function decideIncoming(caller: CommandCaller, inspectionId: string, body: DecideBody, options: { readonly sign: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const { row: seen, lot, receipt, context } = await incomingFor(caller, inspectionId, QUALITY_INCOMING_RECORD)
  const subject: Subject = { lot, receipt }
  assertOwn(context, seen)
  assertOpen(seen)
  if (context.audience === 'floor') await assertFloorReady(caller, seen.siteId)
  // Answered in the command too; said first so a stale screen is not asked for a PIN.
  if (seen.version !== body.version) throw new StaleVersionError('IncomingInspection', seen.id, seen.version, body.version)
  const first = await caller.withClient((db) => decisionFactsOf(db, seen, subject))
  const asked = problemsOf(body, seen, subject, first)
  if (asked.problems.length > 0) throw invalid(asked.problems, 'The decision cannot be signed.')
  await options.sign()
  const signer = signerOf(context)
  const { result } = await command(actingAs(caller, context, subject), { name: 'quality.incoming.decide', idempotencyKey: options.idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockIncoming(tx, seen.id, body.version)
    const facts = await decisionFactsOf(tx, row, subject)
    const again = problemsOf(body, row, subject, facts)
    if (again.problems.length > 0) throw new ConflictError(`The inspection changed while you signed: ${again.problems.map((problem) => problem.message).join(' ')}`)
    const shape = decisionShape(body, facts.decision.lotSize)
    const overrideReason = isOverride(shape, facts.facts.computed) ? body.overrideReason!.trim() : null
    const quantities = { accepted: new Dec(body.accepted.trim()).toFixed(4), rejected: new Dec(body.rejected.trim()).toFixed(4), toSort: new Dec(body.toSort.trim()).toFixed(4) }
    const marked = lot ? await writeToHides(tools, context, row, lot, facts.facts) : 0
    const signature = signatureOf({
      incomingInspectionId: row.id,
      number: row.number,
      lotId: row.lotId,
      subcontractReceiptId: row.subcontractReceiptId,
      planVersionId: row.planVersionId,
      sample: {
        size: row.sampleSize,
        found: facts.facts.found,
        hides: facts.facts.results.map((entry) => ({ hideId: entry.hideId, decision: entry.decision, grade: entry.grade, shade: entry.shadeGroup, measuredArea: entry.measuredArea.toFixed(4), areaUom: entry.areaUom })),
        rolls: facts.rolls.map((roll) => ({ rollRef: roll.rollRef, points: [roll.onePoint, roll.twoPoint, roll.threePoint, roll.fourPoint], widthCm: roll.widthCm.toFixed(2), lengthM: roll.lengthM.toFixed(2), pointsPer100SqYd: roll.pointsPer100SqYd.toFixed(2), decision: roll.decision })),
        components: facts.components.map((component) => ({ seq: component.seq, kind: component.kind, marking: component.marking, protectorType: component.protectorType, certificateId: component.certificateId, checked: component.checkedQuantity, defective: component.defectiveQuantity, decision: component.decision })),
      },
      ...(receipt ? { rejectedLines: [...again.rejected].sort() } : {}),
      computed: facts.facts.computed.result,
      ...quantities,
      overrideReason,
      signer,
      at: toUtcIso(now),
    })
    const decided = await tx.incomingInspection.update({
      where: { id: row.id },
      data: {
        status: 'DECIDED',
        foundCritical: facts.facts.found.critical,
        foundMajor: facts.facts.found.major,
        foundMinor: facts.facts.found.minor,
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
    if (decided.computedResult !== facts.facts.computed.result) throw new ConflictError('The computed result differs from the rules: reload the inspection.')
    const next = nextStepOf(quantities, row.lotSize.toString())
    // B-W2b-111 hook (purchasing/subcontracting inspection.ts): goods back from a workshop released bundle by bundle.
    const released = receipt && row.subcontractReceiptId ? await releaseReceiptInCommand(tools, { id: row.id, number: row.number, subcontractReceiptId: row.subcontractReceiptId }, again.rejected) : null
    tools.audit({
      recordType: 'IncomingInspection',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: 'OPEN' },
      after: {
        status: 'DECIDED',
        computedResult: facts.facts.computed.result,
        reasons: facts.facts.computed.reasons,
        found: facts.facts.found,
        ...quantities,
        overrideReason,
        next,
        marksWritten: marked,
        ...(released ? { rejectedLines: [...again.rejected], reported: released.reports.filter((report) => report.scanId !== null).map((report) => report.receiptLineId) } : {}),
        signatureSha256: signature,
        signedBy: postedBy(context),
        ...(context.audience === 'floor' && receipt ? { floor: { deviceId: context.deviceId, workerId: context.actorId } } : {}),
      },
      ...(overrideReason ? { reason: overrideReason } : {}),
    })
    tools.emit({
      type: 'incoming_inspection.decided',
      subject: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      payload: { incomingInspectionId: row.id, number: row.number, lotId: row.lotId, subcontractReceiptId: row.subcontractReceiptId, computedResult: facts.facts.computed.result, ...quantities, uom: row.uom, overridden: overrideReason !== null, next, postedBy: postedBy(context) },
    })
    return { id: row.id }
  })
  return viewOf(caller, result.id, subject, context)
}

/** POST /quality/incoming/:inspectionId/cancel */
export async function cancelIncoming(caller: CommandCaller, inspectionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string | undefined) {
  const { row: seen, lot, receipt, context } = await incomingFor(caller, inspectionId, QUALITY_INCOMING_RECORD)
  const subject: Subject = { lot, receipt }
  assertOwn(context, seen)
  assertOpen(seen)
  const problem = cancelReasonProblem(body.reason)
  if (problem) throw invalid([problem], 'Say why the inspection is cancelled.')
  const reason = body.reason.trim()
  const { result } = await command(actingAs(caller, context, subject), { name: 'quality.incoming.cancel', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const row = await lockIncoming(tools.tx, seen.id, body.version)
    await tools.tx.incomingInspection.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: reason, ...takeOver(context, row), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    // B-W2b-111 hook: goods back from a workshop go on as received.
    if (receipt && row.subcontractReceiptId) await releaseReceiptInCommand(tools, { id: row.id, number: row.number, subcontractReceiptId: row.subcontractReceiptId }, null)
    tools.audit({ recordType: 'IncomingInspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason })
    tools.emit({ type: 'incoming_inspection.cancelled', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { incomingInspectionId: row.id, number: row.number, lotId: row.lotId, subcontractReceiptId: row.subcontractReceiptId, postedBy: postedBy(context) } })
    return { id: row.id }
  })
  return viewOf(caller, result.id, subject, context)
}
