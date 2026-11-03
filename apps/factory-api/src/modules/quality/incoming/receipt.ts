import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { reasonProblem } from '@nexus/factory-domain/quality/aql/profiles'
import { QUALITY_INCOMING_RECORD, QUALITY_INCOMING_VIEW } from '@nexus/factory-domain/quality/incoming/permissions'
import { INCOMING_LIMITS, sampleWords } from '@nexus/factory-domain/quality/incoming/rules'
import { heldWords, receiptLotOf } from '@nexus/factory-domain/quality/incoming/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asTenantSystem } from '../../production/bundles/codes'
import { assertFloorReady } from '../../production/serials/facts'
import type { ReceiptRow } from '../../purchasing/subcontracting/inspection'
import { inspectorOf, mayOn, postedBy, signerOf, type Inspector } from '../final/access'
import { pickFor } from '../triggers/pick'
import { workshopSubject, type WorkshopSubject } from '../triggers/facts'
import { lockIncomingSubject } from '../triggers/open'
import { invalid, numberOf, samplingOf, type Chosen, type SampledOf } from './open'
import { receiptAs, type Reader } from './store'
import { viewOf } from './views'

/**
 * Goods back from a workshop at incoming inspection (B-W2b-111; QHS-036 "Inspection of goods back from a subcontractor";
 * design floor.kits "Finish receipt: goods go to inspection before stock and before the workshop is paid"). A rule opens
 * it with the receipt (purchasing/subcontracting inspection.ts, B-W2b-101's rules); a person may open one too:
 *
 *   GET  /quality/incoming/receipts/:receiptId  the receipt (order, work order, its lines), its OPEN inspection when there
 *                                               is one, else what opening would give (the plan, the sample in words) or
 *                                               why nothing can open, in words.
 *   POST /quality/incoming { subcontractReceiptId, planId?, profileId?, reason?, note? }  → 201 the record. ONE command
 *                                               under the receipt's lock (the rules' key: a person and a rule never open
 *                                               two); a second OPEN one refused in words; the plan named, else the one the
 *                                               rules pick (pickFor: an active rule's, else the most specific INCOMING plan
 *                                               whose chips fit the work order's style, customers, the workshop, its
 *                                               operations); the lot = the pieces back good and defective; the sample by
 *                                               the plan (fixed, or ISO 2859-1 from the profile of the style or customer).
 *
 * Opened by a person after the receipt, its bundles were reported at their operation when they came back: the decision
 * then moves the rejected bundles' pieces to defective (no fee, not matched) but takes no report back (said in words).
 * A tablet reads the receipt as the tenant's system caller and its opening runs as that caller (the floor has no grant on
 * the subcontract tables): the inspector it names is the signed-in worker all the same.
 */

/** The receipt as the caller may reach it: the office over the order's company and site; a tablet at its own site. */
async function receiptFor(caller: CommandCaller, receiptId: string, permission: typeof QUALITY_INCOMING_VIEW | typeof QUALITY_INCOMING_RECORD): Promise<{ receipt: ReceiptRow; context: Inspector }> {
  const context = inspectorOf(caller)
  const receipt = isUuid(receiptId) ? await receiptAs(caller, context, receiptId) : null
  const scope = receipt ? { companyId: receipt.order.companyId, siteId: receipt.siteId } : null
  if (!receipt || !scope || !(mayOn(context, QUALITY_INCOMING_VIEW, scope) || mayOn(context, permission, scope))) throw new NotFoundError("Workshop's receipt not found.")
  if (!mayOn(context, permission, scope)) throw new ForbiddenError(`This needs ${permission} over the receipt's company and site.`)
  return { receipt, context }
}

/** The tablet acts as the tenant's system caller on the subcontract tables; the office as itself. */
const actingAs = (caller: CommandCaller, context: Inspector): CommandCaller => (context.audience === 'floor' ? asTenantSystem(caller, context) : caller)

const sampledOf = (subject: WorkshopSubject): SampledOf => ({ label: subject.label, companyId: subject.companyId, styleId: subject.styleId, customerIds: subject.customerIds })

async function chosenFor(db: Reader, subject: WorkshopSubject, planId: string | null | undefined): Promise<Chosen | { readonly refusal: string; readonly path: string | null }> {
  if (planId) {
    const plan = isUuid(planId) ? await db.inspectionPlan.findFirst({ where: { id: planId, companyId: subject.companyId, stage: 'INCOMING' }, select: { id: true, code: true, name: true } }) : null
    if (!plan) return { refusal: "Not an incoming inspection plan of the receipt's company.", path: 'body/planId' }
    const version = await db.inspectionPlanVersion.findFirst({ where: { planId: plan.id, status: 'APPROVED' }, select: { id: true, number: true, samplingMethod: true, fixedSampleSize: true } })
    if (!version) return { refusal: `Plan ${plan.code} has no approved version: a second person approves a version before an inspection runs on it.`, path: 'body/planId' }
    return { plan, version, because: [] }
  }
  const pick = await pickFor(db as Parameters<typeof pickFor>[0], subject.companyId, 'INCOMING', subject.facts)
  if (!pick || !pick.plan.approved) return { refusal: `No approved incoming plan applies to ${subject.label}: name the plan to inspect it on.`, path: null }
  const version = (await db.inspectionPlanVersion.findUnique({ where: { id: pick.plan.approved.id }, select: { id: true, number: true, samplingMethod: true, fixedSampleSize: true } }))!
  return { plan: { id: pick.plan.id, code: pick.plan.code, name: pick.plan.name }, version, because: pick.because }
}

const headOf = (receipt: ReceiptRow, context: Inspector) => ({
  id: receipt.id,
  seq: receipt.seq,
  receivedAt: toUtcIso(receipt.receivedAt),
  order: { id: receipt.order.id, number: receipt.order.number, status: receipt.order.status },
  workOrder: receipt.workOrder,
  workshop: context.audience === 'office' ? receipt.workshop : null,
  pieces: receiptLotOf(receipt.lines),
})

/** GET /quality/incoming/receipts/:receiptId — the scan of a workshop's receipt. */
export async function scanReceipt(caller: CommandCaller, receiptId: string) {
  const { receipt, context } = await receiptFor(caller, receiptId, QUALITY_INCOMING_VIEW)
  const found = await caller.withClient(async (db) => ({
    open: await db.incomingInspection.findFirst({ where: { subcontractReceiptId: receipt.id, status: 'OPEN' }, select: { id: true }, orderBy: { id: 'asc' } }),
    decided: await db.incomingInspection.count({ where: { subcontractReceiptId: receipt.id, status: 'DECIDED' } }),
  }))
  const head = headOf(receipt, context)
  if (found.open) return { receipt: head, decided: found.decided, open: await viewOf(caller, found.open.id, { lot: null, receipt }, context), opening: null }
  const opening = await actingAs(caller, context).withClient(async (client) => {
    const db = client as unknown as Reader
    const subject = await workshopSubject(db as Parameters<typeof workshopSubject>[0], receipt.id)
    if (!subject) return { plan: null, lotSize: null, uom: null, sampleSize: null, words: null, refusal: 'Only material came back on this receipt: there are no pieces to inspect.' }
    const chosen = await chosenFor(db, subject, null)
    if ('refusal' in chosen) return { plan: null, lotSize: subject.lotSize, uom: subject.uom, sampleSize: null, words: null, refusal: chosen.refusal }
    const plan = { planId: chosen.plan.id, code: chosen.plan.code, name: chosen.plan.name, versionId: chosen.version.id, number: chosen.version.number }
    const sampling = await samplingOf(db, sampledOf(subject), chosen, { lotSize: new Dec(subject.lotSize), uom: 'PCS', countable: true }, null).catch((error: unknown) => ({ refusal: error instanceof Error ? error.message : String(error) }))
    if ('refusal' in sampling) return { plan, lotSize: subject.lotSize, uom: subject.uom, sampleSize: null, words: null, refusal: sampling.refusal }
    return { plan, lotSize: subject.lotSize, uom: subject.uom, sampleSize: sampling.sampleSize, words: sampleWords(sampling.sampleSize, subject.lotSize, 'PCS', null), refusal: found.decided > 0 ? `This receipt was inspected already (${found.decided} decided): open another only for a reason.` : null }
  })
  return { receipt: head, decided: found.decided, open: null, opening }
}

/** POST /quality/incoming for goods back from a workshop. */
export async function openReceipt(caller: CommandCaller, body: { readonly subcontractReceiptId: string; readonly planId?: string | null | undefined; readonly profileId?: string | null | undefined; readonly reason?: string | null | undefined; readonly note?: string | null | undefined }, idempotencyKey: string | undefined) {
  const { receipt, context } = await receiptFor(caller, body.subcontractReceiptId, QUALITY_INCOMING_RECORD)
  if (context.audience === 'floor') await assertFloorReady(caller, receipt.siteId)
  const note = body.note?.trim() || null
  if (note && note.length > INCOMING_LIMITS.note) throw invalid([{ path: 'note', message: `At most ${INCOMING_LIMITS.note} characters.` }], 'The inspection is not valid.')
  if (body.planId && !isUuid(body.planId)) throw invalid([{ path: 'planId', message: "Not an incoming inspection plan of the receipt's company." }], 'The plan is not found.')
  const signer = signerOf(context)
  const { result } = await command(actingAs(caller, context), { name: 'quality.incoming.open', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    // One opener of a receipt at a time (a person or a rule): the OPEN count read under the lock is the truth.
    await lockIncomingSubject(tx, receipt.id)
    const open = await tx.incomingInspection.findFirst({ where: { subcontractReceiptId: receipt.id, status: 'OPEN' }, select: { number: true }, orderBy: { id: 'asc' } })
    if (open) throw new ConflictError(`The goods of this receipt have an open incoming inspection already, ${open.number}: finish or cancel it first.`)
    const subject = await workshopSubject(tx, receipt.id)
    if (!subject) throw new InvalidStateError('Only material came back on this receipt: there are no pieces to inspect.')
    const chosen = await chosenFor(tx, subject, body.planId)
    if ('refusal' in chosen) {
      if (chosen.path) throw invalid([{ path: chosen.path, message: chosen.refusal }], chosen.refusal)
      throw new InvalidStateError(chosen.refusal)
    }
    const sampling = await samplingOf(tx, sampledOf(subject), chosen, { lotSize: new Dec(subject.lotSize), uom: 'PCS', countable: true }, body.profileId)
    if ('refusal' in sampling) throw new InvalidStateError(sampling.refusal)
    const problems: Issue[] = []
    if (sampling.named) {
      const issue = reasonProblem(body.reason)
      if (issue) problems.push({ ...issue, message: `${sampling.profileCode} is not the profile that applies: say why. ${issue.message}` })
    } else if (body.reason?.trim()) problems.push({ path: 'reason', message: 'This is the sample the plan gives: no reason is needed.' })
    if (problems.length > 0) throw invalid(problems, 'The inspection cannot open.')
    const id = newId()
    const number = await numberOf(tools, subject.companyId, id)
    const reported = receipt.lines.some((line) => line.scanId !== null)
    const lead = reported ? 'Opened after the receipt: its bundles were reported at their operation when they came back.' : null
    await tx.incomingInspection.create({
      data: {
        id,
        companyId: subject.companyId,
        siteId: subject.siteId,
        number,
        subcontractReceiptId: receipt.id,
        workOrderId: receipt.workOrderId,
        planVersionId: chosen.version.id,
        aqlProfileId: sampling.aqlProfileId,
        codeLetter: sampling.codeLetter,
        lotSize: new Dec(subject.lotSize).toFixed(4),
        uom: 'PCS',
        sampleSize: sampling.sampleSize,
        inspectionLevel: sampling.inspectionLevel,
        aqlMajor: sampling.aqlMajor,
        aqlMinor: sampling.aqlMinor,
        acceptMajor: sampling.acceptMajor,
        acceptMinor: sampling.acceptMinor,
        inspectorWorkerId: signer.workerId,
        inspectorUserId: signer.userId,
        note: [sampling.note, lead, note].filter(Boolean).join(' ') || null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({
      recordType: 'IncomingInspection',
      recordId: id,
      companyId: subject.companyId,
      siteId: subject.siteId,
      after: {
        number,
        subcontractReceiptId: receipt.id,
        subcontractOrder: receipt.order.number,
        receiptSeq: receipt.seq,
        plan: `${chosen.plan.code} v${chosen.version.number}`,
        planVersionId: chosen.version.id,
        because: chosen.because,
        lotSize: subject.lotSize,
        uom: 'PCS',
        sampleSize: sampling.sampleSize,
        aqlProfileId: sampling.aqlProfileId,
        codeLetter: sampling.codeLetter,
        sampling: sampling.words,
        status: 'OPEN',
        inspector: postedBy(context),
        ...(context.audience === 'floor' ? { floor: { deviceId: context.deviceId, workerId: context.actorId } } : {}),
      },
      ...(sampling.named ? { reason: body.reason!.trim() } : {}),
    })
    tools.emit({
      type: 'incoming_inspection.opened',
      subject: id,
      companyId: subject.companyId,
      siteId: subject.siteId,
      payload: { incomingInspectionId: id, number, lotId: null, subcontractReceiptId: receipt.id, itemId: null, planVersionId: chosen.version.id, lotSize: new Dec(subject.lotSize).toFixed(4), uom: 'PCS', sampleSize: sampling.sampleSize, postedBy: postedBy(context) },
    })
    return { id, words: heldWords(receiptLotOf(receipt.lines), number) }
  })
  return viewOf(caller, result.id, { lot: null, receipt }, context)
}
