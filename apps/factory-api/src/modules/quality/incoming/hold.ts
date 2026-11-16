import { ConflictError, DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { holdChunks, INCOMING_HOLD_REASONS, incomingHoldNote, notAcceptedOf } from '@nexus/factory-domain/quality/incoming/held'
import { unholdableWords } from '@nexus/factory-domain/quality/holds/rules'
import { command, type CommandCaller } from '../../../core/command'
import { asTenantSystem } from '../../production/bundles/codes'
import { postedBy, type Inspector } from '../final/access'
import { placeHoldInCommand } from '../holds/holds'
import { readIncoming, type IncomingRow, type Reader } from './store'

/**
 * B-W2b-GF5 (G367, G369): the hides an incoming inspection did not accept are held at once, and stay held until quality
 * decides them (B-W2b-114's hold board; the lab's lot release waits for them: modules/quality/lab, factory-domain
 * quality/lab releaseChecklist's INCOMING check).
 *
 *   notAcceptedHidesOf   the hides a DECIDED inspection of a hide lot did not accept (factory-domain quality/incoming held.ts
 *                        notAcceptedOf: the sample's rejected and to-sort hides, and every hide outside the sample when units
 *                        outside it were not accepted) that are still in the lot (not used up, scrapped, returned or moved out by the ledger), which of them is neither on
 *                        hold nor was decided by quality since (a hold placed after the decision and released or closed), and
 *                        the ACTIVE holds that hold them. Read in the caller's own scope (the office's or the bench's: both
 *                        read hides, stock moves and holds of the site).
 *   holdNotAcceptedHides the hold itself, right after the decision's command: ONE command as the tenant's system caller (the
 *                        floor places no hold, and an automatic hold is the system's: placedById empty, the bench's worker
 *                        named), one hold per 100 hides with the first active HOLD reason of QUALITY_CHECK, SUPPLIER_CHECK,
 *                        OTHER and the words of what it holds, its source the inspection. Its Idempotency-Key is the
 *                        inspection's: a resent decision never holds twice. A rule that refuses the hold (no active reason, a
 *                        hide no longer holdable) leaves the decision as it is: the record offers the office's hold for what
 *                        is not held, and the lot's release waits for it.
 */

export interface NotAcceptedHides {
  /** Not accepted and still in the lot (code order). */
  readonly hides: readonly { readonly id: string; readonly code: string; readonly state: string }[]
  /** Of them, neither on hold nor decided by quality since the decision. */
  readonly unheld: readonly { readonly id: string; readonly code: string; readonly state: string }[]
  /** The ACTIVE holds that hold some of them (number order). */
  readonly holds: readonly { readonly id: string; readonly number: string | null }[]
}

const NONE: NotAcceptedHides = Object.freeze({ hides: [], unheld: [], holds: [] })

type InspectionFacts = Pick<IncomingRow, 'id' | 'lotId' | 'uom' | 'status' | 'rejectedQuantity' | 'toSortQuantity' | 'decidedAt'>

/** Hides that have left the lot: used up, scrapped or returned, or moved out by the ledger (a split's old row: its moves net to nothing). */
const GONE_STATES: readonly string[] = ['CONSUMED', 'SCRAPPED', 'RETURNED']
async function movedOut(db: Reader, hideIds: readonly string[]): Promise<Set<string>> {
  if (hideIds.length === 0) return new Set()
  const rows = await db.$queryRaw<{ hideId: string }[]>`
    SELECT p."hideId"::text AS "hideId"
      FROM (SELECT "hideId", "baseQuantity" AS q FROM "StockMove" WHERE "hideId" = ANY(${[...hideIds]}::uuid[]) AND "toLocationId" IS NOT NULL
            UNION ALL
            SELECT "hideId", -"baseQuantity" FROM "StockMove" WHERE "hideId" = ANY(${[...hideIds]}::uuid[]) AND "fromLocationId" IS NOT NULL) p
     GROUP BY p."hideId"
    HAVING sum(p.q) <= 0`
  return new Set(rows.map((row) => row.hideId))
}

export async function notAcceptedHidesOf(db: Reader, inspection: InspectionFacts): Promise<NotAcceptedHides> {
  if (inspection.status !== 'DECIDED' || !inspection.lotId || inspection.uom !== 'HIDE' || !inspection.decidedAt) return NONE
  const results = await db.incomingHideResult.findMany({ where: { incomingInspectionId: inspection.id }, select: { hideId: true, decision: true } })
  const lotHides = await db.hide.findMany({ where: { lotId: inspection.lotId }, select: { id: true, code: true, state: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const plan = notAcceptedOf({ results, lotHideIds: lotHides.map((hide) => hide.id), rejected: inspection.rejectedQuantity?.toString() ?? '0', toSort: inspection.toSortQuantity?.toString() ?? '0' })
  const wanted = new Set([...plan.sampled, ...plan.outside])
  if (wanted.size === 0) return NONE
  const gone = await movedOut(db, [...wanted])
  const hides = lotHides.filter((hide) => wanted.has(hide.id) && !gone.has(hide.id) && !GONE_STATES.includes(hide.state))
  if (hides.length === 0) return NONE
  // On hold now, or held after the decision and since released or closed by quality (it decided them).
  const holds = await db.qualityHold.findMany({
    where: { subjectType: 'Hide', subjectIds: { hasSome: hides.map((hide) => hide.id) }, OR: [{ status: 'ACTIVE' }, { placedAt: { gte: inspection.decidedAt } }] },
    select: { id: true, number: true, status: true, subjectIds: true },
    orderBy: [{ number: 'asc' }, { id: 'asc' }],
  })
  const settled = new Set(holds.flatMap((hold) => hold.subjectIds))
  return { hides, unheld: hides.filter((hide) => !settled.has(hide.id)), holds: holds.filter((hold) => hold.status === 'ACTIVE').map((hold) => ({ id: hold.id, number: hold.number })) }
}

/** The automatic hold's key: one per inspection. */
export const incomingHoldKeyOf = (inspectionId: string): string => `incoming-hold.${inspectionId}`

export async function holdNotAcceptedHides(caller: CommandCaller, context: Inspector, inspectionId: string): Promise<readonly { readonly id: string; readonly number: string | null }[]> {
  // Nothing to hold (every hide accepted, or held already): no command at all (every command writes an audit row).
  const seen = await caller.withClient((db) => readIncoming(db, inspectionId))
  if (!seen || (await caller.withClient((db) => notAcceptedHidesOf(db, seen))).unheld.length === 0) return []
  try {
    const { result } = await command(asTenantSystem(caller, context), { name: 'quality.incoming.holdNotAccepted', idempotencyKey: incomingHoldKeyOf(inspectionId), input: { inspectionId } }, async (tools) => {
      const { tx } = tools
      await tx.$queryRaw`SELECT "id" FROM "IncomingInspection" WHERE "id" = ${inspectionId}::uuid FOR UPDATE`
      const row = await readIncoming(tx, inspectionId)
      if (!row) throw new NotFoundError('Incoming inspection not found.')
      const holdable = (await notAcceptedHidesOf(tx, row)).unheld.filter((hide) => unholdableWords('Hide', { label: hide.code, state: hide.state }) === null)
      // Refusals in words, rolled back and caught below: the decision stands and the record offers the office's hold.
      if (holdable.length === 0) throw new ConflictError('Every hide the inspection did not accept is on hold already, or cannot be held now.')
      const reasons = await tx.reasonCode.findMany({ where: { list: 'HOLD', code: { in: [...INCOMING_HOLD_REASONS] }, active: true }, select: { code: true } })
      const reasonCode = INCOMING_HOLD_REASONS.find((code) => reasons.some((reason) => reason.code === code))
      if (!reasonCode) throw new ConflictError(`No hold reason ${INCOMING_HOLD_REASONS.join(', ')} is active: the office holds the hides with a reason of its own.`)
      const placed: { id: string; number: string | null }[] = []
      for (const chunk of holdChunks(holdable)) {
        const { hold } = await placeHoldInCommand(tools, {
          subjectType: 'Hide',
          subjectIds: chunk.map((hide) => hide.id),
          reasonCode,
          reasonNote: incomingHoldNote(row.number, chunk.map((hide) => hide.code)),
          sourceType: 'IncomingInspection',
          sourceId: row.id,
          placedByWorkerId: context.audience === 'floor' ? context.actorId : null,
        })
        placed.push({ id: hold.id, number: hold.number })
      }
      tools.audit({
        action: 'quality.incoming.holdNotAccepted',
        recordType: 'IncomingInspection',
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        after: { holds: placed.map((hold) => hold.id), hides: holdable.map((hide) => hide.id), reasonCode, decidedBy: postedBy(context), ...(context.audience === 'floor' ? { floor: { deviceId: context.deviceId, workerId: context.actorId } } : {}) },
      })
      return { placed }
    })
    return result.placed
  } catch (error) {
    // A rule refused the hold: the decision stands; the record offers the office's hold for what is not held.
    if (error instanceof DomainError) return []
    throw error
  }
}
