import { ConflictError, isDomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { RegisterKind } from '@nexus/factory-domain/compliance/register/rules'
import { QUALITY_GARMENTS_REVERSE, QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { reasonProblem } from '@nexus/factory-domain/quality/final/rules'
import { REVERSAL_REASON_WORDS, reversalImpact, reversalProblems, type ReversalReason, type SerialsTo } from '@nexus/factory-domain/quality/release/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { openRegisterEntryFor } from '../../compliance/register/hook'
import { readCells, readStyle, type LabelHeader } from '../../production/serials/store'
import { lockCells } from '../../shipping/cells'
import { finalWorkOrder, mayOn, officeOf } from './access'
import { cellText } from './facts'
import { releaseView } from './releases'
import { lockRelease, lockSerials, readRelease, readReversals, releasedPerCell, shippedOfCell, type ReleaseRow } from './store'

/**
 * The reversal of released garments before they ship (B-W1-45; Reg. (EU) 2016/425 art. 8(8): corrective action; design
 * ins-reverse, dec-reversal). The office with quality.garments.reverse over the work order; ONE command(), never a second
 * person nor a code (a reversal only protects: the four-eyes rule bites on the next release):
 *
 *   the work order's release lock → the cell's shipping lock (`factory.ship-cell`, the order the triggers take them in)
 *   → the serials named, FOR UPDATE → what can be taken back now (factory-domain reversalImpact: garments no shipment
 *   holds; packed ones are unpacked first, shipped ones cannot be pulled back here) → the QualityReleaseReversal FIRST
 *   (its reason's kind and words) → its serials to MADE (rework) or VOID (scrapped) in the same transaction (the deferred
 *   trigger checks it at commit) → for a PPE style, the PPE register entry of the garments (B-W1-43's
 *   openRegisterEntryFor, source the reversal, with the shipments the cell's garments left on: "units still here are
 *   held; shipped ones go to the PPE register") → audit → event. Released garments are then releases less reversals per
 *   cell (shipping reads that); the reversed ones are on hold until a new inspection passes (Q3 (a)).
 */

export interface ReverseBody {
  readonly quantity: number
  readonly serialIds?: readonly string[] | undefined
  readonly serialsTo?: SerialsTo | null | undefined
  readonly reasonCode: ReversalReason
  readonly reason: string
}

const REGISTER_KIND: Readonly<Record<ReversalReason, RegisterKind>> = Object.freeze({
  WRONG_RESULT: 'NON_CONFORMITY',
  DEFECT_FOUND_LATER: 'NON_CONFORMITY',
  CERTIFICATE_PROBLEM: 'NON_CONFORMITY',
  CUSTOMER_COMPLAINT: 'COMPLAINT',
  RECALL: 'RECALL',
})

async function registerEntryFor(tools: CommandTools, input: { header: LabelHeader; reversalId: string; body: ReverseBody; cell: string; shipped: number; shipmentIds: readonly string[]; serials: readonly string[] }) {
  const style = await tools.tx.style.findUnique({ where: { id: input.header.styleId }, select: { ppeCategory: true } })
  if (!style || style.ppeCategory === 'NOT_PPE') return { opened: false, entryId: null, reference: null, shippedGoods: null, words: 'The style is not PPE: no PPE register entry.' }
  const left = input.shipped > 0 ? ` ${input.shipped} garment(s) of the cell left on shipments earlier: they cannot be pulled back here.` : ''
  try {
    const entry = await openRegisterEntryFor(tools, {
      companyId: input.header.companyId,
      kind: REGISTER_KIND[input.body.reasonCode],
      workOrderIds: [input.header.id],
      shipmentIds: input.shipmentIds,
      serials: input.serials,
      description: `${REVERSAL_REASON_WORDS[input.body.reasonCode]}: ${input.body.reason.trim()} — ${input.body.quantity} released garment(s) of ${input.cell}, work order ${input.header.number}, taken back.${left}`,
      risk: 'ASSESSING',
      source: { type: 'QualityReleaseReversal', id: input.reversalId },
    })
    return { ...entry, words: `PPE register entry ${entry.reference} ${entry.opened ? 'opened' : 'already open'} for the garments of work order ${input.header.number}.` }
  } catch (error) {
    if (isDomainError(error) && ['not_found', 'invalid_state', 'conflict', 'validation_failed'].includes(error.code)) {
      return { opened: false, entryId: null, reference: null, shippedGoods: null, words: `No PPE register entry was opened (${error.message}): open it by hand for work order ${input.header.number}.` }
    }
    throw error
  }
}

export async function reverseRelease(caller: CommandCaller, releaseId: string, body: ReverseBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const release = await caller.withClient((db) => readRelease(db, releaseId))
  if (!release || !(mayOn(context, QUALITY_INSPECTIONS_VIEW, release) || mayOn(context, QUALITY_GARMENTS_REVERSE, release))) throw new NotFoundError('Release not found.')
  const header = await finalWorkOrder(caller, release.workOrderId, QUALITY_GARMENTS_REVERSE)
  const problem = reasonProblem(body.reason)
  if (problem) throw new ValidationError('Say why the garments are taken back.', [{ ...problem, path: 'body/reason' }])
  const serialIds = [...(body.serialIds ?? [])]

  const { result } = await command(caller, { name: 'quality.garments.reverse', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockRelease(tx, context.tenantId, header.id)
    await lockCells(tx, context.tenantId, [release.workOrderSizeId])
    const serials = await lockSerials(tx, serialIds)
    const reversals = await readReversals(tx, { releaseId: release.id })
    const counts = (await releasedPerCell(tx, [release.workOrderSizeId])).get(release.workOrderSizeId)!
    const shipped = await shippedOfCell(tx, release.workOrderSizeId)
    const impact = reversalImpact({
      released: release.quantity,
      reversed: reversals.reduce((sum, entry) => sum + entry.quantity, 0),
      cell: { netReleased: counts.released - counts.reversed, onDraft: shipped.onDraft, packed: shipped.packed, shipped: shipped.shipped },
    })
    const tracking = (await readStyle(tx, header.styleId))?.tracking ?? 'BATCH'
    const problems = reversalProblems({ quantity: body.quantity, impact, tracking, serialIds, serialsTo: body.serialsTo ?? null })
    const quantityProblem = problems.find((entry) => entry.path === 'quantity' && Number.isInteger(body.quantity) && body.quantity >= 1)
    if (quantityProblem) throw new ConflictError(quantityProblem.message)
    if (problems.length > 0) throw new ValidationError('The reversal is not valid.', problems.map((entry) => ({ ...entry, path: `body/${entry.path}` })))
    for (const id of serialIds) {
      const serial = serials.find((entry) => entry.id === id)
      if (!serial || serial.releaseId !== release.id || serial.status !== 'RELEASED') throw new ConflictError(`${serial ? `Serial ${serial.serial}` : 'A serial named'} is not a released garment of this release.`)
      if (serial.shipmentLineId) throw new ConflictError(`Serial ${serial.serial} is packed on a shipment: remove it from the shipment first.`)
    }
    const id = newId()
    await tx.qualityReleaseReversal.create({
      data: {
        id,
        companyId: release.companyId,
        siteId: release.siteId,
        workOrderId: release.workOrderId,
        workOrderSizeId: release.workOrderSizeId,
        releaseId: release.id,
        quantity: body.quantity,
        serialIds,
        serialsTo: serialIds.length ? body.serialsTo! : null,
        reasonCode: body.reasonCode,
        reason: body.reason.trim(),
        reversedById: context.actorId,
        reversedAt: now,
        createdAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    for (const serialId of serialIds) {
      const to = body.serialsTo!
      await tx.garmentSerial.update({
        where: { id: serialId },
        data: { status: to, ...(to === 'VOID' ? { voidedAt: now, voidReason: `Release reversed: ${body.reason.trim()}` } : {}), version: { increment: 1 }, updatedAt: now },
        select: { id: true },
      })
      tools.audit({ recordType: 'GarmentSerial', recordId: serialId, companyId: release.companyId, siteId: release.siteId, before: { status: 'RELEASED' }, after: { status: to, reversalId: id }, reason: body.reason.trim() })
    }
    const cells = await readCells(tx, header.id)
    const cell = cells.find((entry) => entry.id === release.workOrderSizeId)!
    const register = await registerEntryFor(tools, {
      header,
      reversalId: id,
      body,
      cell: cellText(cell),
      shipped: shipped.shipped,
      shipmentIds: shipped.shipmentIds.gone,
      serials: serials.filter((serial) => serialIds.includes(serial.id)).map((serial) => serial.serial),
    })
    tools.audit({
      recordType: 'QualityReleaseReversal',
      recordId: id,
      companyId: release.companyId,
      siteId: release.siteId,
      after: { releaseId: release.id, quantity: body.quantity, serialIds, serialsTo: body.serialsTo ?? null, reasonCode: body.reasonCode, impact, registerEntryId: register.entryId },
      reason: body.reason.trim(),
    })
    tools.emit({
      type: 'quality.release_reversed',
      subject: id,
      companyId: release.companyId,
      siteId: release.siteId,
      payload: {
        reversalId: id,
        releaseId: release.id,
        workOrderId: release.workOrderId,
        number: header.number,
        workOrderSizeId: release.workOrderSizeId,
        quantity: body.quantity,
        reasonCode: body.reasonCode,
        serialIds,
        serialsTo: serialIds.length ? body.serialsTo! : null,
        registerEntryId: register.entryId,
      },
    })
    return { id, impact, register }
  })
  const fresh = (await caller.withClient((db) => readRelease(db, release.id))) as ReleaseRow
  return {
    reversalId: result.id,
    impact: result.impact,
    register: result.register,
    release: await caller.withClient((db) => releaseView(db, fresh, header.number)),
    words: `${body.quantity} garment(s) taken back and on hold until a new inspection passes. ${result.register.words}`,
  }
}
