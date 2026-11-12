import { ForbiddenError, type Issue } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_REPAIRS_MANAGE } from '@nexus/factory-domain/sales/repairs/permissions'
import type { RepairKind } from '@nexus/factory-domain/sales/repairs/rules'
import { fitProblems } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import { SALES_RETURNS_MANAGE } from '@nexus/factory-domain/sales/returns/permissions'
import { SALES_SERVICE_MANAGE } from '@nexus/factory-domain/sales/service/permissions'
import { actionLinkNote, SERVICE_CASE_RECORD, type ReturnPurpose } from '@nexus/factory-domain/sales/service/rules'
import { command, type CommandCaller } from '../../../core/command'
import { createRepairInCommand } from '../repairs/create'
import { remakeAskedInCommand } from '../returns-outcomes/remake'
import { createReturnInCommand, type NewLineBody } from '../returns/rma'
import { held, mayOn, officeCase } from './access'
import { linkInCommand } from './links'
import { blank, refuse } from './open'
import { garmentOf, lockCase, touchCase } from './store'
import { caseRecordOf, type CaseView } from './view'

/**
 * What a case opens (B-W2b-345; plan "its actions open a repair, a return, a remake or a credit, each linked"; design
 * service.grid row verbs "Make RMA, Make repair"). ONE command each: the case's row locked at the version the screen read,
 * the record made by its own module's code (W2a's repair and RMA, B-W2b-346's remake asked) with every check it makes, the
 * ServiceCaseLink in the same command (service_case.linked, via REPAIR | RETURN | REMAKE | CREDIT), the case's version moved
 * on. The case's customer, contact and garment go with it; the case does not move by itself (its moves are the person's,
 * and each may tell the customer).
 *
 *   repair   POST /sales/service/cases/:caseId/repair (also sales.repairs.manage): W2a's repair (AWAITING_GOODS, or
 *            RECEIVED when the garment came with the customer) for the case's customer and garment, its problem the case's
 *            unless typed (a repair's words hold 2000 characters), the work wanted, the repairing site (default: the
 *            company's only plant).
 *   return   POST /sales/service/cases/:caseId/return {purpose} (also sales.returns.manage): W2a's RMA, AUTHORISED, for the
 *            goods back (RETURN), a remake of the garment (REMAKE: B-W2b-346's remake asked in the same command, with what is
 *            wrong with the fit) or a credit (CREDIT: the RMA's own "Credit without return" — B-W2b-341, a yes may be asked —
 *            or the credit once the goods arrive). Its lines as typed, or the case's garment: one piece of the order line
 *            and size its serial left on, with the reason given.
 */

export interface RepairBody {
  readonly version: number
  readonly siteId?: string | undefined
  readonly kind?: RepairKind | undefined
  readonly problem?: string | undefined
  readonly workWanted?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly received?: { readonly at?: string | undefined; readonly inboundDdtNumber?: string | null | undefined; readonly inboundDdtDate?: BusinessDate | null | undefined } | null | undefined
}

/** POST /sales/service/cases/:caseId/repair */
export async function openRepair(caller: CommandCaller, caseId: string, body: RepairBody, idempotencyKey?: string): Promise<{ case: CaseView; repair: { id: string; number: string }; warnings: Issue[] }> {
  const { context, row: seen } = await officeCase(caller, caseId, SALES_SERVICE_MANAGE)
  if (seen.partyId && !mayOn(context, SALES_REPAIRS_MANAGE, seen)) throw new ForbiddenError('Opening a repair also needs the right to make repairs (sales.repairs.manage).')
  const { result } = await command(caller, { name: 'serviceCases.openRepair', idempotencyKey, input: { caseId, ...body } }, async (tools) => {
    const row = await lockCase(tools, seen.id, body.version)
    if (!row.partyId) throw held('NO_CUSTOMER', row.number)
    const made = await createRepairInCommand(tools, context, {
      companyId: row.companyId,
      partyId: row.partyId,
      ...(body.siteId ? { siteId: body.siteId } : {}),
      kind: body.kind ?? 'REPAIR',
      serial: row.garmentSerial ?? row.serial,
      styleId: row.styleId,
      colourwayId: row.colourwayId,
      size: row.size,
      problem: blank(body.problem) ?? row.problem,
      workWanted: blank(body.workWanted),
      ownerId: body.ownerId ?? undefined,
      received: body.received ?? null,
    })
    await linkInCommand(tools, row, { recordType: 'RepairOrder', recordId: made.repairId, note: actionLinkNote('REPAIR', made.number), via: 'REPAIR' })
    const after = await touchCase(tools, row)
    tools.audit({ action: 'serviceCases.openRepair', recordType: SERVICE_CASE_RECORD, recordId: row.id, companyId: row.companyId, before: { version: row.version }, after: { version: after.version, repairId: made.repairId, repairNumber: made.number } })
    return { repair: { id: made.repairId, number: made.number }, warnings: made.warnings }
  })
  return { case: await caseRecordOf(caller, seen.id), repair: result.repair, warnings: result.warnings }
}

export interface ReturnBody {
  readonly version: number
  readonly purpose: ReturnPurpose
  /** The lines that come back as W2a's RMA takes them; left out: the case's garment, one piece, with `reasonCode`. */
  readonly lines?: readonly NewLineBody[] | undefined
  /** A RETURN reason code (the reasons list) for the case's garment line. */
  readonly reasonCode?: string | undefined
  /** REMAKE: what is wrong with the fit, in words (B-W2b-346's remake). */
  readonly fit?: string | undefined
  readonly siteId?: string | undefined
  readonly customerRef?: string | null | undefined
  readonly goodsDueBy?: BusinessDate | null | undefined
  readonly internalNote?: string | null | undefined
}

const NEXT: Readonly<Record<ReturnPurpose, string>> = Object.freeze({
  RETURN: 'The goods come back on the return: the dock receives them, then the office decides each line.',
  REMAKE: 'The remake is asked on the return: the garment is made again once the line is decided Remake.',
  CREDIT: "Credit it on the return: without the goods (Credit without return; a yes may be asked) or once they arrive and the line is decided Credit.",
})

/** POST /sales/service/cases/:caseId/return */
export async function openReturn(caller: CommandCaller, caseId: string, body: ReturnBody, idempotencyKey?: string): Promise<{ case: CaseView; return: { id: string; number: string }; next: string; warnings: Issue[] }> {
  const { context, row: seen } = await officeCase(caller, caseId, SALES_SERVICE_MANAGE)
  if (seen.partyId && !mayOn(context, SALES_RETURNS_MANAGE, seen)) throw new ForbiddenError('Opening a return also needs the right to make returns (sales.returns.manage).')
  const shape: Issue[] = body.purpose === 'REMAKE' ? fitProblems(body.fit, 'body/fit') : body.fit !== undefined ? [{ path: 'body/fit', message: 'The fit goes with a remake only.' }] : []
  if (!body.lines && !body.reasonCode) shape.push({ path: 'body/reasonCode', message: "Say why the garment comes back (a return reason), or name the lines." })
  if (shape.length > 0) refuse(shape, 'The return cannot be opened like this.')
  const { result } = await command(caller, { name: 'serviceCases.openReturn', idempotencyKey, input: { caseId, ...body } }, async (tools) => {
    const { tx } = tools
    const row = await lockCase(tools, seen.id, body.version)
    if (!row.partyId) throw held('NO_CUSTOMER', row.number)
    let lines = body.lines
    if (!lines) {
      // The case's garment: one piece of the order line and size its serial left on.
      const garment = await garmentOf(tx, row.garmentSerial)
      if (!garment?.shipment) refuse([{ path: 'body/lines', message: row.garmentSerial ? `Serial ${row.garmentSerial} did not leave on a shipment we know: name the lines that come back.` : 'The case names no garment of ours: name the lines that come back.' }], 'Name the lines that come back.')
      lines = [{ salesOrderLineId: garment!.shipment!.salesOrderLineId, size: garment!.shipment!.size, quantity: 1, reasonCode: body.reasonCode!, reasonNote: null, serial: row.garmentSerial, batchNumber: row.garmentBatch }]
    }
    const made = await createReturnInCommand(tools, context, {
      companyId: row.companyId,
      partyId: row.partyId,
      ...(body.siteId ? { siteId: body.siteId } : {}),
      contactId: row.contactId,
      customerRef: body.customerRef ?? null,
      ...(body.goodsDueBy !== undefined ? { goodsDueBy: body.goodsDueBy } : {}),
      internalNote: body.internalNote ?? null,
      lines,
    })
    if (body.purpose === 'REMAKE') remakeAskedInCommand(tools, { id: made.returnId, number: made.number, companyId: row.companyId, siteId: made.siteId }, made.lineIds, 'OFFICE', body.fit!)
    await linkInCommand(tools, row, { recordType: 'ReturnAuthorisation', recordId: made.returnId, note: actionLinkNote(body.purpose, made.number), via: body.purpose })
    const after = await touchCase(tools, row)
    tools.audit({ action: 'serviceCases.openReturn', recordType: SERVICE_CASE_RECORD, recordId: row.id, companyId: row.companyId, before: { version: row.version }, after: { version: after.version, purpose: body.purpose, returnId: made.returnId, returnNumber: made.number } })
    return { return: { id: made.returnId, number: made.number }, warnings: made.warnings }
  })
  return { case: await caseRecordOf(caller, seen.id), return: result.return, next: NEXT[body.purpose], warnings: result.warnings }
}
