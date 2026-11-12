import { ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { sendBackHeld } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import { SALES_RETURNS_DECIDE } from '@nexus/factory-domain/sales/returns/permissions'
import { DECIDING_STATUSES, type ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import { SHIPPING_DDT_ISSUE } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import type { FileView } from '../../../platform/files/contract'
import type { FilesRuntime } from '../../../platform/files/service'
import { issueSourceDdtInCommand, printSourceDdt, type SourceIssueBody } from '../../shipping/ddt/sources'
import { sourceDdtsOf } from '../../shipping/ddt/sources-store'
import { officeReturn } from '../returns/access'
import { lockReturn, touchReturn } from '../returns/rma'
import { lineKeyOf, LINE_COLUMNS, readLines, soldFactsOf } from '../returns/store'
import { outcomesOf, sendBackLineOf, type OutcomesView } from './outcomes'

/**
 * Back unchanged after inspection, with a return shipment (B-W2b-346; SAL-355; design rma.inspection "Disposition … return
 * unchanged", rma.shipments "Outbound shipment (replacement or returned unchanged)"; DPR 472/1996). Office only
 * (sales.returns.decide over the RMA; with the DDT in the body also shipping.ddt.issue over its company and site, as the
 * repair's way back). `POST /sales/returns/:returnId/send-back` {version, lineIds?, note?, ddt?} — ONE command on the RMA
 * row (W2a's lockReturn, RECEIVED or INSPECTED):
 *
 *   decide   every named line received and graded and not decided yet becomes RETURN_UNCHANGED with its goods
 *            BACK_TO_CUSTOMER and no credit (nothing enters stock; W2a's safety rule: never a protective garment returned
 *            for a defect); lines decided so before are taken as they are; the RMA → INSPECTED once every received line
 *            is decided (W2a's rule); W2a's events return.decided and return.status_changed.
 *   the DDT  with `ddt`, the return DDT that carries them (shipping's issueSourceDdtInCommand, reason RETURN by default,
 *            these lines only, under the RMA's row lock it holds already); without, the lines wait for a DDT issued here
 *            later or under Shipping. The PDF after the commit (a store failure leaves the DDT issued).
 *
 * None named: every line that may go back now. Event return.sent_back. The carrier label of a DDT without a shipment is
 * not made here (labels follow shipments: W2b-6's return labels).
 */

export type ReturnDdtBody = Omit<SourceIssueBody, 'lineIds' | 'version'>

export interface SendBackBody {
  readonly version: number
  readonly lineIds?: readonly string[] | undefined
  readonly note?: string | null | undefined
  readonly ddt?: ReturnDdtBody | undefined
}

export interface SendBackAnswer {
  readonly return: OutcomesView
  readonly decidedLineIds: string[]
  readonly ddt: { readonly id: string; readonly number: string; readonly file: FileView | null; readonly pdfProblem: string | null } | null
}

const refuse = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

export async function sendBack(files: FilesRuntime, caller: CommandCaller, returnId: string, body: SendBackBody, idempotencyKey?: string, onPdfError?: (error: unknown) => void): Promise<SendBackAnswer> {
  const { context, rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_DECIDE)
  if (body.ddt && !can(actorOf(context), SHIPPING_DDT_ISSUE, { companyId: seen.companyId, siteId: seen.siteId })) {
    throw new ForbiddenError('Issuing the return DDT needs the permission to issue DDTs (shipping.ddt.issue): ask the warehouse, or send the goods back with a DDT issued under Shipping.')
  }
  const note = (body.note ?? '').trim() || null
  if (note && note.length > 1000) refuse([{ path: 'body/note', message: 'At most 1000 characters.' }], 'The note is too long.')
  const company = body.ddt ? await companyLegalOf(caller, seen.companyId) : null
  const { result } = await command(caller, { name: 'returnsOutcomes.sendBack', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const rma = await lockReturn(tools, seen.id, body.version, DECIDING_STATUSES, 'goods are sent back')
    const lines = await readLines(tx, rma.id)
    const sold = await soldFactsOf(tx, lines)
    const { live } = await sourceDdtsOf(tx as CommandTx, { type: 'ReturnAuthorisation', id: rma.id })
    const onDdt = new Map<string, string>()
    for (const ddt of live) for (const lineId of ddt.lineIds) onDdt.set(lineId, ddt.number)
    const back = new Map(lines.map((line) => [line.id, sendBackLineOf(line, sold.get(lineKeyOf(line)), onDdt.get(line.id) ?? null)]))
    const problems: Issue[] = []
    let named: string[]
    if (body.lineIds !== undefined) {
      if (body.lineIds.length === 0) problems.push({ path: 'body/lineIds', message: 'Name at least one line, or leave the lines out for every one that may go back.' })
      named = []
      for (const [index, lineId] of body.lineIds.entries()) {
        const line = back.get(lineId)
        if (!line) problems.push({ path: `body/lineIds/${index}`, message: 'Not a line of this return.' })
        else if (named.includes(lineId)) problems.push({ path: `body/lineIds/${index}`, message: `Line ${line.seq} is named twice.` })
        else {
          const held = sendBackHeld(line)
          if (held) problems.push({ path: `body/lineIds/${index}`, message: held })
          else named.push(lineId)
        }
      }
    } else {
      named = [...back.values()].filter((line) => sendBackHeld(line) === null).map((line) => line.id)
      if (named.length === 0) problems.push({ path: 'body/lineIds', message: 'No line of this return may go back unchanged now.' })
    }
    if (problems.length > 0) refuse(problems, 'Some lines cannot go back like this.')

    const actorId = context.actorId
    const decided: string[] = []
    for (const lineId of named) {
      const line = back.get(lineId)!
      if (line.disposition !== null) continue
      await tx.returnLine.update({ where: { id: lineId }, data: { disposition: 'RETURN_UNCHANGED', goodsOutcome: 'BACK_TO_CUSTOMER', decidedAt: now, decidedById: actorId, creditAmount: 0, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'returns.decideLine', recordType: 'ReturnLine', recordId: lineId, companyId: rma.companyId, siteId: rma.siteId, before: { disposition: null }, after: { disposition: 'RETURN_UNCHANGED', goodsOutcome: 'BACK_TO_CUSTOMER', creditAmount: markMoney('price', 0), placeId: null, moveIds: [], sentBack: true } })
      decided.push(lineId)
    }
    const after = await tx.returnLine.findMany({ where: { returnId: rma.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const inspected = rma.status === 'RECEIVED' && after.filter((line) => line.receivedQuantity > 0).every((line) => line.disposition !== null)
    await touchReturn(tools, rma, inspected ? { status: 'INSPECTED', inspectedAt: now } : {})
    if (inspected) {
      tools.audit({ action: 'returns.statusChanged', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { status: rma.status }, after: { status: 'INSPECTED', inspectedAt: toUtcIso(now) } })
      tools.emit({ type: 'return.status_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, from: rma.status as ReturnStatus, to: 'INSPECTED' } })
    }
    if (decided.length > 0) tools.emit({ type: 'return.decided', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, lineIds: decided, inspected, moveIds: [] } })

    // The return DDT under the RMA's row lock this command holds (issueSourceDdtInCommand locks it again: the same row).
    let ddt: { id: string; number: string } | null = null
    if (body.ddt) {
      const issued = await issueSourceDdtInCommand(tools, company!, { type: 'ReturnAuthorisation', id: rma.id }, { ...body.ddt, reason: body.ddt.reason ?? 'RETURN', lineIds: named })
      ddt = { id: issued.ddtId, number: issued.number }
    }
    tools.audit({ action: 'returnsOutcomes.sendBack', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, after: { lineIds: named, decidedLineIds: decided, ddtId: ddt?.id ?? null, ddtNumber: ddt?.number ?? null, note } })
    tools.emit({ type: 'return.sent_back', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, lineIds: named, decidedLineIds: decided, ddtId: ddt?.id ?? null, ddtNumber: ddt?.number ?? null } })
    return { decided, ddt }
  })
  const printed = result.ddt ? await printSourceDdt(files, caller, result.ddt.id, onPdfError) : null
  return { return: await outcomesOf(caller, seen.id), decidedLineIds: result.decided, ddt: result.ddt ? { ...result.ddt, file: printed?.file ?? null, pdfProblem: printed?.pdfProblem ?? null } : null }
}
