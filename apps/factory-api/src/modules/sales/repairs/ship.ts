import { ForbiddenError, InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DdtReason } from '@nexus/factory-domain/documents/model'
import { SALES_REPAIRS_SHIP } from '@nexus/factory-domain/sales/repairs/permissions'
import { noteNeeded, shipProblems, unrepairedWarning, type RepairStage } from '@nexus/factory-domain/sales/repairs/rules'
import type { SourceDdtRequest } from '@nexus/factory-domain/shipping/ddt/sources'
import { SHIPPING_DDT_ISSUE } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import type { FileView } from '../../../platform/files/contract'
import type { FilesRuntime } from '../../../platform/files/service'
import { issueSourceDdtInCommand, printSourceDdt } from '../../shipping/ddt/sources'
import { officeRepair } from './access'
import { blank, recordOf, refuse } from './create'
import { lockRepair, moveStageInCommand } from './stages'
import { liveDdtOf, safetyFactsOf, workOrderOf, type RepairView } from './store'

/**
 * The way back (B-W2a-57; LOG-116 "Repair round trip"; design repair.return "Outbound DDT (repair reason) · Shipped date";
 * DPR 472/1996). ONE command on the repair's row: the garment goes back from repaired (a protective garment only with a
 * passed safety check made after the repair) or unrepaired from received or estimated (with why, its repair work order
 * cancelled); it travels with ONE live DDT whose source is the repair (B-W2a-17): issued here, BEFORE the move to
 * SHIPPED (issueSourceDdtInCommand: reason REPAIR by default, or RETURN_FROM_WORK, or OTHER in words; the customer's
 * DDT the garment came with is its reference), or issued earlier under Shipping and live. Then SHIPPED with its time and
 * stage event. The PDF after the commit (a store failure leaves the DDT issued: POST /shipping/ddts/:ddtId/pdf prints
 * it again). Issuing the DDT here needs shipping.ddt.issue as well. The carrier label for a DDT without a shipment is
 * not made here (a gap: labels follow shipments).
 */

export type RepairDdtBody = Omit<SourceDdtRequest, 'lineIds'> & { readonly internalNote?: string | null | undefined }

export interface ShipBody {
  readonly version: number
  readonly note?: string | null | undefined
  readonly ddt?: RepairDdtBody | undefined
}

export interface ShipAnswer {
  readonly repair: RepairView
  readonly ddt: { readonly id: string; readonly number: string; readonly reason: DdtReason; readonly issuedNow: boolean; readonly file: FileView | null; readonly pdfProblem: string | null }
  readonly warnings: Issue[]
}

/** POST /sales/repairs/:repairId/ship (sales.repairs.ship; + shipping.ddt.issue when the body brings the DDT). */
export async function shipRepair(files: FilesRuntime, caller: CommandCaller, repairId: string, body: ShipBody, idempotencyKey?: string, onPdfError?: (error: unknown) => void): Promise<ShipAnswer> {
  const { context, repair: seen } = await officeRepair(caller, repairId, SALES_REPAIRS_SHIP)
  if (body.ddt && !can(actorOf(context), SHIPPING_DDT_ISSUE, { companyId: seen.companyId, siteId: seen.siteId })) {
    throw new ForbiddenError('Issuing the DDT needs the permission to issue DDTs (shipping.ddt.issue): ask the warehouse, or send the garment back with a DDT issued under Shipping.')
  }
  const company = body.ddt ? await companyLegalOf(caller, seen.companyId) : null
  const { result } = await command(caller, { name: 'repairs.ship', idempotencyKey, input: { repairId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const repair = await lockRepair(tools, seen.id, body.version)
    const stage = repair.stage as RepairStage
    const workOrder = await workOrderOf(tx, repair)
    const live = await liveDdtOf(tx, repair.id)
    const { state, fields } = shipProblems({ number: repair.number, stage, workOrder: workOrder.live, liveDdt: live, ddtAsked: body.ddt !== undefined, ...safetyFactsOf(repair) })
    if (state.length > 0) throw new InvalidStateError(state.join(' '))
    const note = blank(body.note)
    const needed = noteNeeded(stage, 'SHIPPED')
    if (!note && needed) fields.push({ path: 'body/note', message: needed })
    if (fields.length > 0) refuse(fields, 'The garment cannot go back like this.')
    // The DDT first, while the repair is still in the stage its garment leaves from (after the move it would count as a
    // replacement of a cancelled one).
    let ddt: { id: string; number: string; issuedNow: boolean }
    if (body.ddt) {
      const issued = await issueSourceDdtInCommand(tools, company!, { type: 'RepairOrder', id: repair.id }, body.ddt)
      ddt = { id: issued.ddtId, number: issued.number, issuedNow: true }
    } else {
      ddt = { id: live!.id, number: live!.number, issuedNow: false }
    }
    const reason = (await tx.ddt.findUniqueOrThrow({ where: { id: ddt.id }, select: { reason: true } })).reason as DdtReason
    await moveStageInCommand(tools, repair, 'SHIPPED', { data: { shippedAt: now }, note, ddtId: ddt.id, audit: { shippedAt: toUtcIso(now), ddt: ddt.number, ddtIssuedNow: ddt.issuedNow, unrepaired: repair.repairedAt === null } })
    const warning = unrepairedWarning({ stage, required: repair.safetyCheckRequired })
    return { ddt: { ...ddt, reason }, warnings: warning ? [{ path: 'safety', message: warning }] : [] }
  })
  const printed = result.ddt.issuedNow ? await printSourceDdt(files, caller, result.ddt.id, onPdfError) : { file: null, pdfProblem: null }
  return { repair: await recordOf(caller, seen.id), ddt: { ...result.ddt, ...printed }, warnings: result.warnings }
}
