import { cleanList, entryProblems, type RegisterKind, type RegisterRisk, type RegisterSource } from '@nexus/factory-domain/compliance/register/rules'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { uniqueIds } from '@nexus/factory-domain/threads/rules'
import type { CommandTools } from '../../../core/command'
import { ApiError } from '../../../core/errors'
import { opened } from './register'
import { insertEntry, nextReference, readEntryBySource } from './store'
import { traceOf } from './trace'

/**
 * The register's hook for other steps (B-W1-45: "units still here are held; shipped ones go to the PPE register"): opens
 * an OPEN entry INSIDE the caller's own command, in the same transaction as the caller's change, with its reference,
 * audit row (action compliance.register.openFrom) and the event compliance.register_entry_opened. No permission is
 * checked here: the calling step checked its own (as platform/threads' ensureThread). Office and system callers only.
 *
 * The work orders' style is the entry's (they must share one); their batch numbers join the entry's. One entry per
 * source record (the partial unique index on the source): a second call for the same source answers the entry it opened
 * (`opened: false`) and writes nothing. Called from nowhere yet.
 */

export interface RegisterOpening {
  readonly companyId: string
  /** Default NON_CONFORMITY (garments found non-conforming after they left). */
  readonly kind?: RegisterKind
  /** The work orders whose garments it concerns (their style and batch numbers). */
  readonly workOrderIds?: readonly string[]
  /** The shipments the garments left on (B-W1-45: the shipped ones), their garments of the style. */
  readonly shipmentIds?: readonly string[]
  /** The garments' serials, for a serial-tracked style. */
  readonly serials?: readonly string[]
  readonly batchNumbers?: readonly string[]
  /** Default: the work orders' style. */
  readonly styleId?: string
  /** What happened, in words (the reversal's reason, and what left). */
  readonly description: string
  /** Default ASSESSING. */
  readonly risk?: RegisterRisk
  /** Default the command's time. */
  readonly reportedAt?: Date
  readonly source: RegisterSource
  /** Who reported it, when a party did. */
  readonly partyId?: string | null
}

export interface OpenedEntry {
  readonly entryId: string
  readonly reference: string
  /** False when the source had opened its entry already. */
  readonly opened: boolean
  /** Garments it concerns have left for customers (the distributors must be informed). */
  readonly shippedGoods: boolean
}

export async function openRegisterEntryFor(tools: CommandTools, opening: RegisterOpening): Promise<OpenedEntry> {
  const { tx, context, now } = tools
  if (context.audience !== 'office' && context.audience !== 'system') {
    throw new ApiError('internal_error', `The PPE register is kept by office and system commands, not the ${context.audience} audience.`)
  }
  const existing = await readEntryBySource(tx, opening.source.type, opening.source.id)
  if (existing) {
    const trace = await traceOf(tx, existing.companyId, existing)
    return { entryId: existing.id, reference: existing.reference, opened: false, shippedGoods: trace.shippedGoods }
  }
  const workOrderIds = uniqueIds(opening.workOrderIds)
  const workOrders = workOrderIds.length ? await tx.workOrder.findMany({ where: { id: { in: workOrderIds }, companyId: opening.companyId }, select: { id: true, styleId: true, batchNumber: true } }) : []
  if (workOrders.length !== workOrderIds.length) throw new ApiError('internal_error', 'openRegisterEntryFor(): a work order is not of the company.')
  const styles = new Set(workOrders.map((row) => row.styleId))
  if (opening.styleId) styles.add(opening.styleId)
  if (styles.size !== 1) throw new ApiError('internal_error', 'openRegisterEntryFor(): one entry concerns one style; name it or work orders of one style.')
  const styleId = [...styles][0]!
  const entry = {
    kind: opening.kind ?? 'NON_CONFORMITY',
    reportedAt: opening.reportedAt ?? now,
    description: opening.description.trim(),
    investigation: null,
    actionTaken: null,
    styleId,
    styleRevisionId: null,
    batchNumbers: cleanList([...(opening.batchNumbers ?? []), ...workOrders.map((row) => row.batchNumber).filter((batch): batch is string => batch !== null)]),
    serials: cleanList(opening.serials),
    lotIds: [],
    workOrderIds,
    shipmentIds: uniqueIds(opening.shipmentIds),
  }
  const problems = entryProblems(entry, now)
  if (problems.length > 0) throw new ValidationError('The register entry is not valid.', problems)
  const id = newId()
  const reference = await nextReference(tools, opening.companyId, entry.reportedAt, id)
  const record = await insertEntry(
    tools,
    {
      id,
      companyId: opening.companyId,
      reference,
      ...entry,
      partyId: opening.partyId ?? null,
      risk: opening.risk ?? 'ASSESSING',
      sourceType: opening.source.type,
      sourceId: opening.source.id,
      createdById: context.audience === 'office' ? context.actorId : null,
    },
    { action: 'compliance.register.openFrom' },
  )
  const trace = await traceOf(tx, record.companyId, record)
  opened(tools, record, trace.shippedGoods)
  return { entryId: record.id, reference, opened: true, shippedGoods: trace.shippedGoods }
}
