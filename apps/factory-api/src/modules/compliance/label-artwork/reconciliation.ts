import { allocateSpoil, inForceAt, reconcile, reconciliationWords, spoilProblems, type Reconciliation, type SpoilKind } from '@nexus/factory-domain/compliance/label-artwork/rules'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_SERIALS } from '@nexus/factory-domain/production/serials/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { deviceStationOf, scanWorkOrderLock } from '../../production/scans/store'
import { asTenantSystem, assertFloorReady, labelFacts, labelWorkOrder, mayLabel, workerOf, type LabelFacts, type Worker } from '../../production/serials/facts'
import { readLabelSpoils, recordLabelSpoil, type LabelSpoilEntry } from '../../production/serials/label-log'
import { lockLabelCells, readHeader, type LabelHeader } from '../../production/serials/store'
import { floorRecordSubjectFor } from '../../production/settings/subject'
import { gateRequirements } from '../requirements/store'
import type { ReconciliationView } from './contract'
import { guarded, readArtwork, type Reader } from './store'

/**
 * The label reconciliation of a work order (B-W2b-259; MES-140 controlled issue of certified labels; design floor.labels
 * sec:print "W2b reconciliation: printed vs used vs spoiled, 'Log spoiled'", page.h "Log spoiled labels (W2b)"). Per size
 * and in total: printed (W1's label log: every print and reprint) = used (the garments that carry a label: labelled, never
 * more than are finished) + spoiled + returned (B-W2b-218's append-only GarmentLabelSpoil). A difference holds the work
 * order's final release where the company asks it (B-W2b-254's gate, check `label.reconciliation`: gate-plug.ts).
 *
 * Log spoiled labels: the floor device of the work order's site or the office (production.serials), a size, SPOILED (why,
 * in words) or RETURNED, how many: one command (Idempotency-Key; required on the floor) under W1's work-order and cell locks,
 * rows on the size's prints newest first (the database keeps each print's spoiled + returned at most its quantity), an audit
 * row per row and on the work order, `label_reconciliation.logged`. Who: the office user; on the floor the worker where the
 * site names workers (W1's rule), nobody at a station site. Never queued: the screen holds it offline with the reason.
 */

const at = (value: Date) => toUtcIso(value)

/** Who a row names: the office user; on the floor the worker where the site names workers (409 in words otherwise), else nobody. */
async function namedBy(tools: CommandTools, siteId: string): Promise<string | null> {
  const context = tools.context as Worker
  if (context.audience === 'office') return context.actorId
  const subject = await floorRecordSubjectFor(tools.tx, { siteId, workerId: context.actorId, stationId: await deviceStationOf(tools.tx, context.deviceId) })
  return subject.workerId ? context.actorId : null
}

/** The figures of a work order from what the label step knows and the rows logged. */
export function reconciliationOf(facts: LabelFacts, spoils: readonly LabelSpoilEntry[]): Reconciliation {
  return reconcile(
    facts.cells.map((cell) => ({ cellId: cell.cellId, colourwayCode: cell.colourwayCode, size: cell.size, finished: cell.finished, labelled: cell.labelled })),
    facts.log.map((entry) => ({ id: entry.id, cellId: entry.cellId, kind: entry.kind, quantity: entry.quantity, at: entry.at })),
    spoils.map((spoil) => ({ printId: spoil.printId, kind: spoil.kind, quantity: spoil.quantity })),
  )
}

/** Does an ACTIVE, switched-on requirement with the reconciliation check block the final release? (read as the system). */
async function holdsRelease(db: Reader): Promise<boolean> {
  return (await gateRequirements(db)).some((row) => row.status === 'ACTIVE' && row.switchedOn && row.checkKey === 'label.reconciliation' && row.blocks.includes('FINAL_RELEASE'))
}

async function viewOf(db: Reader, header: LabelHeader, office: boolean, holds: boolean): Promise<ReconciliationView> {
  const facts = await labelFacts(db, header)
  const spoils = await readLabelSpoils(db, header.id)
  const result = reconciliationOf(facts, spoils)
  const cellOfPrint = new Map(facts.log.map((entry) => [entry.id, entry.cellId]))
  let artwork: ReconciliationView['artwork'] = null
  if (office && header.labelTemplateId && facts.log.length > 0) {
    const followed = inForceAt(await readArtwork(db, header.labelTemplateId), facts.log[0]!.at)
    artwork = followed ? { id: followed.id, versionNo: followed.versionNo, approvedAt: followed.approvedAt ? at(followed.approvedAt) : null } : null
  }
  return {
    workOrder: { id: header.id, number: header.number, batchNumber: header.batchNumber, status: header.status },
    tracking: facts.style.tracking,
    cells: result.cells.map((row) => ({ workOrderSizeId: row.cellId, colourwayCode: row.colourwayCode, size: row.size, printed: row.printed, used: row.used, spoiled: row.spoiled, returned: row.returned, difference: row.difference, balanced: row.balanced, words: reconciliationWords(row) })),
    total: result.total,
    balanced: result.balanced,
    entries: [...spoils].reverse().map((spoil) => ({ id: spoil.id, workOrderSizeId: cellOfPrint.get(spoil.printId) ?? '', kind: spoil.kind, quantity: spoil.quantity, reason: spoil.reason, at: at(spoil.at) })),
    artwork,
    holdsRelease: holds,
  }
}

/** The requirement read: the office with its own client, the floor as the tenant's system (the floor role reads no requirements). */
const readHolds = (caller: CommandCaller, worker: Worker): Promise<boolean> => (worker.audience === 'office' ? caller : asTenantSystem(caller)).withClient((db) => holdsRelease(db))

/** GET /production/serials/work-orders/:workOrderId/reconciliation */
export async function readReconciliation(caller: CommandCaller, workOrderId: string): Promise<ReconciliationView> {
  const context = workerOf(caller)
  const header = await labelWorkOrder(caller, workOrderId, PRODUCTION_SERIALS)
  const holds = await readHolds(caller, context)
  return caller.withClient((db) => viewOf(db, header, context.audience === 'office', holds))
}

export interface SpoiledBody {
  readonly workOrderSizeId: string
  readonly kind: SpoilKind
  readonly quantity: number
  readonly reason?: string | null | undefined
}

/** POST /production/serials/work-orders/:workOrderId/spoiled */
export async function logSpoiledLabels(caller: CommandCaller, workOrderId: string, body: SpoiledBody, idempotencyKey?: string): Promise<{ reconciliation: ReconciliationView; replayed: boolean }> {
  const context = workerOf(caller)
  const header = await labelWorkOrder(caller, workOrderId, PRODUCTION_SERIALS)
  if (context.audience === 'floor') await assertFloorReady(caller, header.siteId)
  const reason = body.reason?.trim() || null
  const problems = spoilProblems({ cellId: body.workOrderSizeId, kind: body.kind, quantity: body.quantity, reason })
  if (problems.length > 0) throw new ValidationError('The spoiled labels are not valid.', problems)
  const holds = await readHolds(caller, context)

  return guarded(async () => {
    const outcome = await command(caller, { name: 'production.logSpoiledLabels', idempotencyKey, input: { workOrderId, ...body, reason } }, async (tools) => {
      const { tx } = tools
      await scanWorkOrderLock(tx, context.tenantId, workOrderId)
      const current = await readHeader(tx, workOrderId)
      if (!current || !mayLabel(context, PRODUCTION_SERIALS, current)) throw new NotFoundError('Work order not found.')
      await lockLabelCells(tx, context.tenantId, current.siteId, [body.workOrderSizeId])
      const facts = await labelFacts(tx, current)
      const cell = facts.cells.find((row) => row.cellId === body.workOrderSizeId)
      if (!cell) throw new ValidationError('Not a size of this work order.', [{ path: 'body/workOrderSizeId', message: 'Pick a size of this work order.' }])
      const spoils = await readLabelSpoils(tx, current.id)
      const prints = facts.log.map((entry) => ({ id: entry.id, cellId: entry.cellId, kind: entry.kind, quantity: entry.quantity, at: entry.at }))
      const what = `${cell.colourwayCode} ${cell.size}`
      const plan = allocateSpoil(prints, spoils, cell.cellId, body.quantity)
      if (plan.rows === null) {
        const printed = prints.filter((print) => print.cellId === cell.cellId).reduce((total, print) => total + print.quantity, 0)
        throw new ConflictError(
          printed === 0
            ? `No label of ${what} was printed: nothing to log as spoiled or returned.`
            : plan.room === 0
              ? `${what}: all ${printed} labels printed are logged as spoiled or returned already; no more can be logged.`
              : `${what}: ${printed} labels were printed and only ${plan.room} are not logged as spoiled or returned yet; ${body.quantity} cannot be logged.`,
        )
      }
      const createdById = await namedBy(tools, current.siteId)
      const scope = { companyId: current.companyId, siteId: current.siteId }
      const ids: string[] = []
      for (const row of plan.rows) {
        const id = newId()
        ids.push(id)
        await recordLabelSpoil(tools, { id, ...scope, workOrderId: current.id, printId: row.printId, kind: body.kind, quantity: row.quantity, reason, createdById })
      }
      const view = await viewOf(tx, current, context.audience === 'office', holds)
      const after = view.cells.find((row) => row.workOrderSizeId === cell.cellId)!
      tools.audit({ recordType: 'WorkOrder', recordId: current.id, ...scope, after: { garmentLabelsLogged: { kind: body.kind, workOrderSizeId: cell.cellId, quantity: body.quantity, rows: ids, difference: after.difference } }, ...(reason ? { reason } : {}) })
      tools.emit({
        type: 'label_reconciliation.logged',
        subject: current.id,
        ...scope,
        payload: { workOrderId: current.id, number: current.number, workOrderSizeId: cell.cellId, kind: body.kind, quantity: body.quantity, difference: after.difference, postedBy: context.audience === 'floor' ? 'FLOOR' : 'OFFICE' },
      })
      return view
    })
    return { reconciliation: outcome.result, replayed: outcome.replayed }
  })
}
