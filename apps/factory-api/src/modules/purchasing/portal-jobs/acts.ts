import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import {
  acceptPlanOf,
  acceptProblems,
  dateDecisionProblem,
  declineProblems,
  declineText,
  jobActsOf,
  kitCheckPlan,
  progressPlan,
  returnPlan,
  returnQuantitiesOf,
  type AcceptInput,
  type DateDecision,
  type DeclineInput,
  type JobActs,
  type KitCheckInput,
  type ProgressInput,
  type ReturnInput,
  type Words,
} from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import type { CommandTools } from '../../../core/command'
import { dayOf, dayValue } from '../store'
import { sizesOf } from '../subcontracting/store'
import { jobFactsOf, readJobRows, type JobContext, type JobOrderRow, type JobRows } from './read'
import { doneJobTasksInCommand } from './tasks'

/**
 * The workshop's acts on a job (B-W2b-176), each written INSIDE one command that names the SubcontractOrder with the version
 * the page showed (command()'s record guard: an act and the office's kit send, receipt, recall or cancel never both commit; the
 * second gets 409 and, read again, the job refuses it in words). Whoever acts:
 *
 *   PORTAL  a person of the workshop in its portal session (factory_partner_runtime: the …_portal_supply_w2b_guards triggers
 *           let it write only its answer, the kit check, its reports and notices); the name stored is the one it typed, else
 *           its own;
 *   LINK    the holder of the job's JOB_ACCEPT link (accept, move the date, decline), the evidence in the same command;
 *   OFFICE  an office person for a workshop without e-mail (Owner answer C3), with the name the workshop gave by phone, else
 *           the office person's own; reports and notices keep the office person (createdById).
 *
 * Each checks the job as it stands in the command's own scope (factory-domain purchasing/portal-jobs/jobs.ts), writes,
 * audits (`via`, who, the whole act) and emits its subcontract_order.* event; the requests it answers are done.
 */

export type Via = 'PORTAL' | 'LINK' | 'OFFICE'

export interface Who {
  readonly via: Via
  /** The portal person, or the office person; null for a link. */
  readonly personId: string | null
  /** The name stored when the act gives none (the portal person's, the office person's); null: none (a link). */
  readonly name: string | null
}

const refuse = (problems: readonly Issue[], what: string) => new ValidationError(problems.length === 1 ? problems[0]!.message : what, problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))

function held(acts: JobActs, act: keyof JobActs): void {
  const reason: Words | null = acts[act]
  if (reason) throw new InvalidStateError(reason.en)
}

/** The job's rows again, in the command's own scope (the version guard ran first: nothing moved since the page). */
export async function rowsInCommand(tools: Pick<CommandTools, 'tx'>, orderId: string): Promise<JobRows> {
  const order = await tools.tx.subcontractOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      companyId: true,
      siteId: true,
      number: true,
      partyId: true,
      workOrderId: true,
      status: true,
      orderDate: true,
      expectedBackDate: true,
      note: true,
      issuedAt: true,
      closedAt: true,
      cancelledAt: true,
      acceptedAt: true,
      acceptedByName: true,
      proposedDate: true,
      proposedDateReason: true,
      declinedAt: true,
      declinedByName: true,
      declineReason: true,
      proposedDateDecision: true,
      proposedDateDecidedAt: true,
      version: true,
      updatedAt: true,
    },
  })
  if (!order) throw new InvalidStateError('This job is no longer available.')
  return readJobRows(tools.tx, order)
}

const base = (order: Pick<JobOrderRow, 'id' | 'number' | 'partyId'>, status: string) => ({ subcontractOrderId: order.id, number: order.number, status: status as JobOrderRow['status'], partyId: order.partyId })
const doneBy = (who: Who): string | null => (who.via === 'PORTAL' ? who.personId : null)
const officeId = (who: Who): string | null => (who.via === 'OFFICE' ? who.personId : null)

// ---- the answer -----------------------------------------------------------------------------------------------------------

export async function acceptInCommand(tools: CommandTools, rows: JobRows, context: JobContext, input: AcceptInput, who: Who) {
  const { order } = rows
  held(jobActsOf(jobFactsOf(rows, context.operations)), 'accept')
  const problems = acceptProblems({ orderDate: dayOf(order.orderDate)!, expectedBackDate: dayOf(order.expectedBackDate) }, input, businessDate(tools.now))
  if (problems.length > 0) throw refuse(problems, 'The answer is not valid as it stands.')
  const plan = acceptPlanOf(input)
  const name = plan.name ?? who.name
  await tools.tx.subcontractOrder.update({
    where: { id: order.id },
    data: { acceptedAt: tools.now, acceptedByName: name, proposedDate: plan.proposedDate ? dayValue(plan.proposedDate) : null, proposedDateReason: plan.reason },
    select: { id: true },
  })
  tools.audit({
    action: 'purchasing.subcontract.jobAccept',
    recordType: 'SubcontractOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    before: { acceptedAt: null },
    after: { via: who.via, byPartner: who.via !== 'OFFICE', personId: who.personId, byName: name, proposedDate: plan.proposedDate, reason: plan.reason },
  })
  tools.emit({ type: 'subcontract_order.job_answered', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { ...base(order, order.status), answer: 'ACCEPTED', proposedDate: plan.proposedDate, via: who.via } })
  return plan
}

export async function declineInCommand(tools: CommandTools, rows: JobRows, context: JobContext, input: DeclineInput, who: Who) {
  const { order } = rows
  held(jobActsOf(jobFactsOf(rows, context.operations)), 'decline')
  const problems = declineProblems(input)
  if (problems.length > 0) throw refuse(problems, 'The answer is not valid as it stands.')
  const reason = declineText(input)
  const name = input.name?.trim() || who.name
  await tools.tx.subcontractOrder.update({ where: { id: order.id }, data: { declinedAt: tools.now, declinedByName: name, declineReason: reason }, select: { id: true } })
  tools.audit({
    action: 'purchasing.subcontract.jobDecline',
    recordType: 'SubcontractOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    reason,
    before: { declinedAt: null },
    after: { via: who.via, byPartner: who.via !== 'OFFICE', personId: who.personId, byName: name, reasonCode: input.reason },
  })
  tools.emit({ type: 'subcontract_order.job_answered', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { ...base(order, order.status), answer: 'DECLINED', proposedDate: null, via: who.via } })
  return { reason }
}

/** The office answers the date the workshop proposed: ACCEPTED moves the expected-back date to it (in the same write). */
export async function decideDateInCommand(tools: CommandTools, rows: JobRows, decision: DateDecision, actorId: string) {
  const { order } = rows
  const proposedDate = dayOf(order.proposedDate) as BusinessDate | null
  const problem = dateDecisionProblem({ status: order.status, proposedDate, decided: order.proposedDateDecision !== null })
  if (problem) throw new InvalidStateError(problem)
  const expectedBackDate = decision === 'ACCEPTED' ? proposedDate : dayOf(order.expectedBackDate)
  await tools.tx.subcontractOrder.update({
    where: { id: order.id },
    data: { proposedDateDecision: decision, proposedDateDecidedAt: tools.now, proposedDateDecidedById: actorId, ...(decision === 'ACCEPTED' ? { expectedBackDate: dayValue(proposedDate!) } : {}) },
    select: { id: true },
  })
  tools.audit({
    action: 'purchasing.subcontract.jobDate',
    recordType: 'SubcontractOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    before: { expectedBackDate: dayOf(order.expectedBackDate), proposedDate },
    after: { decision, expectedBackDate },
  })
  tools.emit({ type: 'subcontract_order.date_decided', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { ...base(order, order.status), decision, expectedBackDate } })
  return { decision, expectedBackDate }
}

// ---- the kit ----------------------------------------------------------------------------------------------------------------

export async function checkKitInCommand(tools: CommandTools, rows: JobRows, context: JobContext, input: KitCheckInput, who: Who) {
  const { order } = rows
  held(jobActsOf(jobFactsOf(rows, context.operations)), 'kit')
  const plan = kitCheckPlan(
    rows.kit.map((line) => ({ id: line.id, seq: line.seq, status: line.status, quantity: line.quantity.toFixed(4), checked: line.receivedByWorkshopAt !== null })),
    input,
  )
  if (plan.problems.length > 0) throw refuse(plan.problems, 'The kit check is not valid as it stands.')
  for (const line of plan.lines) {
    const { count } = await tools.tx.subcontractKitLine.updateMany({
      where: { id: line.kitLineId, subcontractOrderId: order.id, status: 'SENT', receivedByWorkshopAt: null },
      data: { receivedByWorkshopAt: tools.now, receivedByWorkshopQuantity: line.quantity, receivedByWorkshopNote: line.note, version: { increment: 1 } },
    })
    if (count !== 1) throw new InvalidStateError(`Kit line ${line.seq} was confirmed already.`)
  }
  tools.audit({
    action: 'purchasing.subcontract.kitReceived',
    recordType: 'SubcontractOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    after: { via: who.via, byPartner: who.via !== 'OFFICE', personId: who.personId, byName: who.name, all: input.all === true, lines: plan.lines.map((line) => ({ ...line })) },
  })
  tools.emit({
    type: 'subcontract_order.kit_checked',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { ...base(order, order.status), kitLineIds: plan.lines.map((line) => line.kitLineId), short: plan.lines.filter((line) => line.short).length, via: who.via },
  })
  // The request is done once nothing it asked waits for a check.
  const waiting = await tools.tx.subcontractKitLine.count({ where: { subcontractOrderId: order.id, status: 'SENT', receivedByWorkshopAt: null } })
  if (waiting === 0) await doneJobTasksInCommand(tools, order.id, 'CONFIRM_KIT', doneBy(who))
  return plan
}

// ---- progress ---------------------------------------------------------------------------------------------------------------

export async function reportInCommand(tools: CommandTools, rows: JobRows, context: JobContext, input: ProgressInput, who: Who) {
  const { order } = rows
  held(jobActsOf(jobFactsOf(rows, context.operations)), 'progress')
  const plan = progressPlan(
    {
      orderDate: dayOf(order.orderDate)!,
      operations: context.operations.map((operation) => ({ id: operation.id, seq: operation.seq, pieces: operation.pieces, sizes: sizesOf(operation.sizes) })),
      bundles: context.bundles,
      reported: rows.reports.map((report) => ({ subcontractOperationId: report.subcontractOperationId, workOrderSizeId: report.workOrderSizeId, bundleId: report.bundleId, finishedQuantity: report.finishedQuantity })),
    },
    input,
  )
  if (plan.problems.length > 0) throw refuse(plan.problems, 'The report is not valid as it stands.')
  const name = plan.name ?? who.name ?? 'Workshop'
  const ids = plan.rows.map(() => newId())
  await tools.tx.subcontractProgressReport.createMany({
    data: plan.rows.map((row, index) => ({
      id: ids[index]!,
      siteId: order.siteId,
      workOrderId: order.workOrderId,
      partyId: order.partyId,
      subcontractOrderId: order.id,
      subcontractOperationId: row.subcontractOperationId,
      bundleId: row.bundleId,
      workOrderSizeId: row.workOrderSizeId,
      finishedQuantity: row.finishedQuantity,
      finishBy: plan.finishBy ? dayValue(plan.finishBy) : null,
      reportedAt: tools.now,
      reportedByName: name,
      note: plan.note,
      createdAt: tools.now,
      ...(officeId(who) ? { createdById: officeId(who) } : {}),
    })),
  })
  tools.audit({
    action: 'purchasing.subcontract.progress',
    recordType: 'SubcontractOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    after: { via: who.via, byPartner: who.via !== 'OFFICE', personId: who.personId, byName: name, reportIds: ids, rows: plan.rows.map((row) => ({ ...row })), finishBy: plan.finishBy, note: plan.note },
  })
  tools.emit({ type: 'subcontract_order.progress_reported', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { ...base(order, order.status), reportIds: ids, finished: plan.finished, finishBy: plan.finishBy, via: who.via } })
  await doneJobTasksInCommand(tools, order.id, 'REPORT_PROGRESS', doneBy(who))
  return { ...plan, ids }
}

// ---- send back --------------------------------------------------------------------------------------------------------------

export async function announceInCommand(tools: CommandTools, rows: JobRows, context: JobContext, input: ReturnInput, who: Who) {
  const { order } = rows
  held(jobActsOf(jobFactsOf(rows, context.operations)), 'sendBack')
  const facts = jobFactsOf(rows, context.operations)
  const plan = returnPlan(
    {
      operations: context.operations.map((operation, index) => ({ id: operation.id, seq: operation.seq, sizes: sizesOf(operation.sizes), ...facts.operations[index]! })),
      bundles: context.bundles,
      announced: rows.notices
        .filter((notice) => notice.status === 'ANNOUNCED')
        .flatMap((notice) => returnQuantitiesOf(notice.quantities))
        .map((row) => ({ subcontractOperationId: row.subcontractOperationId, bundleId: row.bundleId, finished: row.finished, scrapped: row.scrapped })),
      kitLines: rows.kit.map((line) => ({ id: line.id, seq: line.seq, status: line.status, quantity: line.quantity.toFixed(4), checked: line.receivedByWorkshopAt !== null })),
    },
    input,
    businessDate(tools.now),
  )
  if (plan.problems.length > 0) throw refuse(plan.problems, 'The send-back is not valid as it stands.')
  const id = newId()
  const seq = rows.notices.reduce((max, notice) => Math.max(max, notice.seq), 0) + 1
  const name = plan.name ?? who.name ?? 'Workshop'
  await tools.tx.subcontractReturnNotice.createMany({
    data: [
      {
        id,
        siteId: order.siteId,
        workOrderId: order.workOrderId,
        partyId: order.partyId,
        subcontractOrderId: order.id,
        seq,
        quantities: plan.quantities.map((row) => ({ ...row })),
        materialBack: plan.materialBack.map((row) => ({ ...row })),
        parcels: plan.parcels,
        expectedDate: dayValue(plan.expectedDate),
        weCollect: plan.weCollect,
        workshopDdtNumber: plan.ddt?.number ?? null,
        workshopDdtDate: plan.ddt?.date ? dayValue(plan.ddt.date) : null,
        announcedByName: name,
        note: plan.note,
        createdAt: tools.now,
        updatedAt: tools.now,
        ...(officeId(who) ? { createdById: officeId(who) } : {}),
      },
    ],
  })
  tools.audit({
    action: 'purchasing.subcontract.returnAnnounced',
    recordType: 'SubcontractOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    after: { via: who.via, byPartner: who.via !== 'OFFICE', personId: who.personId, byName: name, returnNoticeId: id, seq, pieces: plan.pieces, expectedDate: plan.expectedDate, parcels: plan.parcels, weCollect: plan.weCollect, ddt: plan.ddt, quantities: plan.quantities.map((row) => ({ ...row })), materialBack: plan.materialBack.map((row) => ({ ...row })) },
  })
  tools.emit({ type: 'subcontract_order.return_announced', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { ...base(order, order.status), returnNoticeId: id, seq, pieces: plan.pieces, expectedDate: plan.expectedDate, via: who.via } })
  await doneJobTasksInCommand(tools, order.id, 'REPORT_PROGRESS', doneBy(who))
  return { ...plan, id, seq }
}

/** The office cancels an ANNOUNCED notice with its reason (the goods will not come as announced). */
export async function cancelNoticeInCommand(tools: CommandTools, order: Pick<JobOrderRow, 'id' | 'number' | 'partyId' | 'companyId' | 'siteId' | 'status'>, noticeId: string, reason: string) {
  const notice = await tools.tx.subcontractReturnNotice.findUnique({ where: { id: noticeId }, select: { id: true, subcontractOrderId: true, seq: true, status: true } })
  if (!notice || notice.subcontractOrderId !== order.id) throw new ValidationError('Not a send-back of this order.', [{ path: 'params/returnNoticeId', message: 'Not a send-back of this order.' }])
  if (notice.status !== 'ANNOUNCED') throw new InvalidStateError(`Send-back ${notice.seq} is ${notice.status.toLowerCase()}; only an announced one is cancelled.`)
  const words = reason.trim()
  if (words === '' || words.length > 2000) throw new ValidationError('Say why, in at most 2000 characters.', [{ path: 'body/reason', message: 'Say why, in at most 2000 characters.' }])
  await tools.tx.subcontractReturnNotice.update({ where: { id: notice.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: words, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'purchasing.subcontract.returnCancelled', recordType: 'SubcontractOrder', recordId: order.id, companyId: order.companyId, siteId: order.siteId, reason: words, before: { returnNoticeId: notice.id, status: 'ANNOUNCED' }, after: { status: 'CANCELLED' } })
  tools.emit({ type: 'subcontract_order.return_cancelled', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { ...base(order, order.status), returnNoticeId: notice.id, seq: notice.seq } })
  return { returnNoticeId: notice.id, status: 'CANCELLED' as const }
}

/**
 * The receive back's hook (../subcontracting/receive.ts, inside its command, after the receipt is recorded): the notice it was
 * written from becomes RECEIVED with that receipt and its time (the database holds RECEIVED exactly with both). A notice of
 * another order, or one not ANNOUNCED any more, refuses the whole receipt in words (the command rolls back).
 */
export async function receiveNoticeInCommand(tools: CommandTools, order: { readonly id: string; readonly companyId: string; readonly siteId: string }, noticeId: string | null | undefined, receiptId: string): Promise<void> {
  if (!noticeId) return
  const orderId = order.id
  const notice = await tools.tx.subcontractReturnNotice.findUnique({ where: { id: noticeId }, select: { id: true, subcontractOrderId: true, seq: true, status: true } })
  if (!notice || notice.subcontractOrderId !== orderId) throw new ValidationError('Not a send-back of this order.', [{ path: 'body/returnNoticeId', message: 'Not a send-back of this order.' }])
  if (notice.status !== 'ANNOUNCED') throw new InvalidStateError(`Send-back ${notice.seq} is ${notice.status.toLowerCase()} already.`)
  await tools.tx.subcontractReturnNotice.update({ where: { id: notice.id }, data: { status: 'RECEIVED', receiptId, receivedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'purchasing.subcontract.returnReceived', recordType: 'SubcontractOrder', recordId: orderId, companyId: order.companyId, siteId: order.siteId, after: { returnNoticeId: notice.id, seq: notice.seq, receiptId, at: toUtcIso(tools.now) } })
}

/** Kit lines the workshop confirmed it received have left: they never come back "unsent" (../subcontracting/kit.ts). */
export async function assertNotReceivedInCommand(tools: Pick<CommandTools, 'tx'>, line: { readonly id: string; readonly seq: number }): Promise<void> {
  const row = await tools.tx.subcontractKitLine.findUnique({ where: { id: line.id }, select: { receivedByWorkshopAt: true } })
  if (row?.receivedByWorkshopAt) throw new InvalidStateError(`The workshop confirmed it received kit line ${line.seq}: it left. Agree a return of the material instead.`)
}
