import { createHash } from 'node:crypto'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_INSPECTIONS_RECORD } from '@nexus/factory-domain/quality/final/permissions'
import { HOLD_LIMITS, placedByKind, unholdableWords } from '@nexus/factory-domain/quality/holds/rules'
import { command, type CommandCaller } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { reasonWords } from '../../../platform/reasons/service'
import { asTenantSystem as systemFor } from '../../production/bundles/codes'
import { asTenantSystem, assertFloorReady } from '../../production/serials/facts'
import { activeHoldsOf } from '../holds/checks'
import { placeHoldInCommand } from '../holds/holds'
import { raiseNcrInCommand } from '../ncr/ncr'
import { finalWorkOrder, inspectorOf } from './access'
import type { Reader } from './store'

/**
 * Hold lot at the inspection bench (B-W2a-75; design floor.final sec "release" "Hold lot (secondary): a reason, and an NCR
 * from W2a", pop final.hold "A reason tile; 'Packing is blocked until quality decides.'"; QHS-074 on the floor). The
 * bench's inspector (quality.inspections.record at the device's site) holds the work order's garments with a reason of
 * the HOLD list: ONE command places the quality hold on the work order (holds.ts placeHoldInCommand: the work order goes
 * ON_HOLD unless it is COMPLETED; releasing, packing and shipping are refused while it stands) with the worker as its
 * placer, and raises the NCR that decides it (ncr.ts raiseNcrInCommand from the hold: found at FINAL by the inspection,
 * MAJOR until quality says otherwise, the hold as its first containment action, done). Quality releases the hold or
 * closes it with the NCR in the office; the worker who placed it never releases it (holds' NOT_PLACER).
 *
 * The floor's role may neither put a work order ON_HOLD nor raise an NCR, so after the floor's own checks (the work order
 * at the device's site, the permission, the site's floor ready, an inspection of that work order) the command runs as
 * the tenant's system caller, naming the worker (placedByWorkerId; the NCR's finder) and the device (audit). Its
 * Idempotency-Key is derived from the floor request's: a resend answers the stored hold, never a second one. Online
 * only (the NCR takes the office's number at once).
 */

export interface BenchHoldBody {
  readonly reasonCode: string
  readonly reasonNote?: string | null | undefined
  /** The open inspection at the bench, when there is one (the hold's source; its link on the NCR). */
  readonly inspectionId?: string | null | undefined
  /** Garments held (the NCR's quantity affected): the lot at the bench. */
  readonly quantity: number
}

/** The follow-up's key, one per floor request key (keys are at most 128 characters: a digest of it). */
export const benchHoldKeyOf = (floorKey: string): string => `bench-hold.${createHash('sha256').update(floorKey).digest('hex').slice(0, 48)}`

/** The ACTIVE holds of a work order as the bench shows them: why, since when, by whom (kind only), the NCR deciding it. */
export async function benchHolds(db: Reader, workOrderId: string) {
  const holds = await activeHoldsOf(db, 'WorkOrder', [workOrderId])
  if (holds.length === 0) return []
  const rows = await db.qualityHold.findMany({ where: { id: { in: holds.map((hold) => hold.id) } }, select: { id: true, reasonCode: true, reasonNote: true, placedAt: true, placedById: true, placedByWorkerId: true, ncrId: true } })
  const words = await reasonWords(db, 'HOLD')
  const ncrIds = rows.flatMap((row) => (row.ncrId ? [row.ncrId] : []))
  const ncrs = ncrIds.length > 0 ? await db.nonconformance.findMany({ where: { id: { in: ncrIds } }, select: { id: true, number: true } }) : []
  return holds.map((hold) => {
    const row = rows.find((entry) => entry.id === hold.id)!
    const reason = words.get(row.reasonCode)
    return {
      id: row.id,
      reasonCode: row.reasonCode,
      reasonIt: reason?.labelIt ?? row.reasonCode,
      reasonEn: reason?.labelEn ?? row.reasonCode,
      reasonNote: row.reasonNote,
      placedAt: toUtcIso(row.placedAt),
      placedBy: placedByKind(row),
      ncrNumber: ncrs.find((ncr) => ncr.id === row.ncrId)?.number ?? null,
    }
  })
}

/** POST /quality/final/work-orders/:workOrderId/hold (floor). */
export async function holdAtBench(caller: CommandCaller, workOrderId: string, body: BenchHoldBody, idempotencyKey?: string) {
  const context = inspectorOf(caller)
  if (context.audience !== 'floor') throw new ForbiddenError('Hold lot is the bench’s: the office places holds on Quality › Holds.')
  const floor: FloorContext = context
  if (!idempotencyKey) throw new ValidationError('An Idempotency-Key is required for floor writes.', [{ path: 'headers/idempotency-key', message: 'Required.' }])
  const header = await finalWorkOrder(caller, workOrderId, QUALITY_INSPECTIONS_RECORD)
  await assertFloorReady(caller, header.siteId)
  const reasonNote = body.reasonNote?.trim() || null
  if ((reasonNote ?? '').length > HOLD_LIMITS.reasonNote) throw new ValidationError(`At most ${HOLD_LIMITS.reasonNote} characters.`, [{ path: 'body/reasonNote', message: `At most ${HOLD_LIMITS.reasonNote} characters.` }])
  if (body.inspectionId) {
    const inspection = isUuid(body.inspectionId) ? await caller.withClient((db) => db.inspection.findUnique({ where: { id: body.inspectionId! }, select: { workOrderId: true } })) : null
    if (!inspection || inspection.workOrderId !== header.id) throw new NotFoundError('Inspection not found.')
  }
  const unholdable = unholdableWords('WorkOrder', { label: header.number, state: header.status })
  if (unholdable) throw new ConflictError(unholdable)

  const { result, replayed } = await command(
    systemFor(caller, floor),
    { name: 'quality.benchHold', idempotencyKey: benchHoldKeyOf(idempotencyKey), input: { workOrderId: header.id, ...body, reasonNote, deviceId: floor.deviceId, workerId: floor.actorId } },
    async (tools) => {
      const placed = await placeHoldInCommand(tools, {
        subjectType: 'WorkOrder',
        subjectIds: [header.id],
        reasonCode: body.reasonCode,
        reasonNote,
        sourceType: body.inspectionId ? 'Inspection' : null,
        sourceId: body.inspectionId ?? null,
        placedByWorkerId: floor.actorId,
      })
      const reason = (await reasonWords(tools.tx, 'HOLD')).get(body.reasonCode)
      const ncrId = await raiseNcrInCommand(
        tools,
        {
          from: { recordType: 'QualityHold', recordId: placed.hold.id },
          title: `Held at the final inspection: ${reason?.labelEn ?? body.reasonCode}`.slice(0, 200),
          source: 'INSPECTION',
          foundAt: 'FINAL',
          severity: 'MAJOR',
          quantityAffected: String(body.quantity),
          uom: 'PCS',
          workOrderId: header.id,
        },
        // The floor's own checks ran above; the system raises it for the bench.
        { actorId: null, may: () => true },
      )
      const ncr = await tools.tx.nonconformance.findUnique({ where: { id: ncrId }, select: { id: true, number: true } })
      tools.audit({ action: 'quality.benchHold', recordType: 'QualityHold', recordId: placed.hold.id, companyId: header.companyId, siteId: header.siteId, after: { workOrderId: header.id, ncrId, deviceId: floor.deviceId, workerId: floor.actorId, inspectionId: body.inspectionId ?? null } })
      return { holdId: placed.hold.id, workOrderHeld: placed.workOrdersHeld.length > 0, ncr: { id: ncrId, number: ncr!.number } }
    },
  )
  const holds = await asTenantSystem(caller).withClient((db) => benchHolds(db, header.id))
  const hold = holds.find((entry) => entry.id === result.holdId) ?? null
  return {
    hold: hold ?? { id: result.holdId, reasonCode: body.reasonCode, reasonIt: body.reasonCode, reasonEn: body.reasonCode, reasonNote, placedAt: toUtcIso(new Date()), placedBy: 'WORKER' as const, ncrNumber: result.ncr.number },
    workOrderHeld: result.workOrderHeld,
    ncr: result.ncr,
    replayed,
  }
}
