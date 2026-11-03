import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { areaIn, type AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { INVENTORY_HIDES_MANAGE } from '@nexus/factory-domain/inventory/hides/permissions'
import { areaCheck, correctionNote, measureDraftProblems, measureRefusal, stockCorrection } from '@nexus/factory-domain/inventory/hides/measure'
import { INVENTORY_ADJUST } from '@nexus/factory-domain/inventory/permissions'
import { UNITS } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { workerGateFor } from '../../people/privacy/worker-gate'
import { lockHideCuts } from '../issue/store'
import { postMoves } from '../ledger/post-moves'
import { fixed, mainPlace } from '../stock/read-kit'
import type { MeasureView } from './contract'
import { areaUom, hideFor, hideHeadOf, HIDE_SELECT, mayAtHide, stockOfHide, toleranceOfLot, type HideData, type Tolerance } from './facts'

/**
 * Re-measure and area check (B-W2b-94; SCM-249, QHS-025; design warehouse.hides record "Measurements & grade": "Area is
 * read-only with the words 'Measured at receipt and never changed: a correction is an adjustment move' + 'Correct the
 * area…'"). Office: inventory.stock.view to read, inventory.hides.manage to measure, and inventory.adjust as well to correct
 * the hide's stock with the measure.
 *
 *   GET  /inventory/hides/:hideId/measures   every measure of the hide, newest first, each against the tannery's area (the
 *                                            one typed, else the area it was received with) with the tolerance; who
 *                                            measured inside this record only (a floor worker only where the site's
 *                                            PERFORMANCE gate is open: B-W2b-F3's rule).
 *   POST /inventory/hides/:hideId/measures   a new measure of a WHOLE hide (FULL), one command() with an Idempotency-Key:
 *                                            the HideMeasure row (append-only) and, when asked (`correctStock`), the
 *                                            ADJUSTMENT move that makes the hide's stock say the measured area at the one
 *                                            place that holds it (postMoves: valued, period locks, never below zero). The
 *                                            hide's area never changes (W1's rule). Under the hide's cut lock, so no cut
 *                                            lands between the check and the move.
 *
 * `insertMeasureInCommand` is the one writer of HideMeasure: the incoming inspection (B-W2b-98) calls it inside its own
 * command with the floor worker and the inspection.
 */

const MEASURE_SELECT = {
  id: true,
  hideId: true,
  declaredArea: true,
  measuredArea: true,
  areaUom: true,
  incomingInspectionId: true,
  measuredById: true,
  measuredByWorkerId: true,
  measuredAt: true,
  note: true,
  createdAt: true,
} as const satisfies Prisma.HideMeasureSelect
export type MeasureRow = Prisma.HideMeasureGetPayload<{ select: typeof MEASURE_SELECT }>

/** Newest first: by when it was measured, then by when it was written (UUIDv7 ids sort in time). */
export const MEASURE_ORDER: Prisma.HideMeasureOrderByWithRelationInput[] = [{ measuredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]

type Names = { readonly users: ReadonlyMap<string, string>; readonly workers: ReadonlyMap<string, string>; readonly gateOpen: boolean }

/** The tannery's area of a measure: typed, else the area the hide was received with, in the measure's unit. */
export function declaredOf(row: Pick<MeasureRow, 'declaredArea' | 'areaUom'>, hide: Pick<HideData, 'area' | 'areaUom'>): { declared: string; from: 'TANNERY' | 'RECEIPT' } {
  if (row.declaredArea !== null) return { declared: fixed(new Dec(row.declaredArea.toString())), from: 'TANNERY' }
  return { declared: fixed(areaIn(hide.area.toString(), areaUom(hide.areaUom), areaUom(row.areaUom))), from: 'RECEIPT' }
}

export function measureViewOf(row: MeasureRow, hide: Pick<HideData, 'area' | 'areaUom'>, names: Names, latest: boolean, tolerance: Tolerance): MeasureView {
  const { declared, from } = declaredOf(row, hide)
  const check = areaCheck(declared, row.measuredArea.toString(), tolerance.percent)
  const worker = row.measuredByWorkerId
  return {
    id: row.id,
    measuredAt: toUtcIso(row.measuredAt),
    declaredArea: row.declaredArea === null ? null : fixed(new Dec(row.declaredArea.toString())),
    declared,
    declaredFrom: from,
    measuredArea: fixed(new Dec(row.measuredArea.toString())),
    areaUom: areaUom(row.areaUom),
    difference: fixed(check.difference),
    differencePercent: check.differencePercent,
    outcome: check.outcome,
    incomingInspectionId: row.incomingInspectionId,
    by: worker
      ? { audience: 'FLOOR', id: names.gateOpen ? worker : null, name: names.gateOpen ? (names.workers.get(worker) ?? null) : null, hidden: !names.gateOpen }
      : { audience: 'OFFICE', id: row.measuredById, name: row.measuredById ? (names.users.get(row.measuredById) ?? null) : null, hidden: false },
    note: row.note,
    latest,
  }
}

/** The names of who measured: office users by their display name, floor workers only where the gate is open. */
export async function namesOf(db: Pick<CommandTx, 'user' | 'worker' | 'peopleLegalGate'>, siteId: string, rows: readonly MeasureRow[]): Promise<Names> {
  const userIds = [...new Set(rows.flatMap((row) => (row.measuredById ? [row.measuredById] : [])))]
  const gate = await workerGateFor(db, siteId)
  const workerIds = gate.lookup(rows.map((row) => row.measuredByWorkerId))
  const users = new Map((userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row.displayName]))
  const workers = new Map((workerIds.length > 0 ? await db.worker.findMany({ where: { id: { in: [...new Set(workerIds)] } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row.displayName]))
  return { users, workers, gateOpen: gate.open }
}

/** The measures of these hides, newest first per hide. */
export async function measuresOf(db: Pick<CommandTx, 'hideMeasure'>, hideIds: readonly string[]): Promise<Map<string, MeasureRow[]>> {
  const result = new Map<string, MeasureRow[]>()
  if (hideIds.length === 0) return result
  for (const row of await db.hideMeasure.findMany({ where: { hideId: { in: [...new Set(hideIds)] } }, select: MEASURE_SELECT, orderBy: MEASURE_ORDER })) {
    result.set(row.hideId, [...(result.get(row.hideId) ?? []), row])
  }
  return result
}

/** GET /inventory/hides/:hideId/measures. */
export async function readMeasures(caller: CommandCaller, hideId: string) {
  const { hide, context } = await hideFor(caller, hideId)
  return caller.withClient(async (client) => {
    const rows = (await measuresOf(client, [hide.id])).get(hide.id) ?? []
    const names = await namesOf(client, hide.siteId, rows)
    const stock = await stockOfHide(client, hide.id)
    const tolerance = await toleranceOfLot(client, hide.lotId)
    const measures = rows.map((row, index) => measureViewOf(row, hide, names, index === 0, tolerance))
    return {
      hide: hideHeadOf(hide, stock.onHand),
      tolerancePercent: tolerance.percent,
      toleranceFrom: tolerance.from,
      measures,
      latest: measures[0] ?? null,
      measureRefusal: measureRefusal(hide),
      canMeasure: mayAtHide(context, INVENTORY_HIDES_MANAGE, hide),
      canCorrectStock: mayAtHide(context, INVENTORY_HIDES_MANAGE, hide) && mayAtHide(context, INVENTORY_ADJUST, hide),
    }
  })
}

export interface MeasureInsert {
  readonly measuredArea: string
  readonly areaUom: AreaUom
  readonly declaredArea: string | null
  readonly measuredAt: Date
  readonly note: string | null
  readonly incomingInspectionId?: string | null
  /** An office user, or a floor worker with the device: exactly one. */
  readonly by: { readonly userId: string } | { readonly workerId: string; readonly deviceId: string | null }
}

/** The one writer of HideMeasure (append-only): a row of the hide's site and lot, audited on the hide. */
export async function insertMeasureInCommand(tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>, hide: Pick<HideData, 'id' | 'code' | 'siteId' | 'lotId' | 'lot'>, measure: MeasureInsert): Promise<MeasureRow> {
  const id = newId()
  const by = 'userId' in measure.by ? { measuredById: measure.by.userId, createdById: measure.by.userId } : { measuredByWorkerId: measure.by.workerId, deviceId: measure.by.deviceId, createdById: measure.by.workerId }
  const row = await tools.tx.hideMeasure.create({
    data: {
      id,
      siteId: hide.siteId,
      lotId: hide.lotId,
      hideId: hide.id,
      declaredArea: measure.declaredArea,
      measuredArea: measure.measuredArea,
      areaUom: measure.areaUom,
      incomingInspectionId: measure.incomingInspectionId ?? null,
      measuredAt: measure.measuredAt,
      note: measure.note,
      createdAt: tools.now,
      ...by,
    },
    select: MEASURE_SELECT,
  })
  tools.audit({
    action: 'inventory.hideMeasured',
    recordType: 'Hide',
    recordId: hide.id,
    companyId: hide.lot.companyId,
    siteId: hide.siteId,
    after: { measureId: id, code: hide.code, declaredArea: measure.declaredArea, measuredArea: measure.measuredArea, areaUom: measure.areaUom, incomingInspectionId: measure.incomingInspectionId ?? null },
  })
  return row
}

export interface RecordMeasureBody {
  readonly measuredArea: string
  readonly areaUom?: AreaUom | undefined
  readonly declaredArea?: string | null | undefined
  readonly measuredAt?: string | undefined
  readonly note?: string | null | undefined
  readonly correctStock?: { readonly note?: string | null | undefined; readonly reasonCode?: string | undefined } | undefined
}

const refuse = (problems: Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** POST /inventory/hides/:hideId/measures. */
export async function recordMeasure(caller: CommandCaller, hideId: string, body: RecordMeasureBody, idempotencyKey?: string) {
  const { hide, context } = await hideFor(caller, hideId, INVENTORY_HIDES_MANAGE)
  if (body.correctStock && !mayAtHide(context, INVENTORY_ADJUST, hide)) throw new ValidationError('Correcting the stock is an adjustment: it needs inventory.adjust at the hide\'s site.', [{ path: 'body/correctStock', message: 'Needs inventory.adjust.' }])
  const uom = body.areaUom ?? areaUom(hide.areaUom)
  const measuredAt = body.measuredAt ? parseInstant(body.measuredAt)! : undefined
  const problems = measureDraftProblems({ measuredArea: body.measuredArea, declaredArea: body.declaredArea, areaUom: uom, measuredAt, note: body.note }, new Date())
  if (problems.length > 0) refuse(problems, 'The measure is not valid.')
  const refusal = measureRefusal(hide)
  if (refusal) throw new InvalidStateError(refusal)

  const { result } = await command(caller, { name: 'inventory.measureHide', idempotencyKey, input: { hideId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockHideCuts(tx, context.tenantId, hide.siteId, hide.id)
    const current = await tx.hide.findUniqueOrThrow({ where: { id: hide.id }, select: HIDE_SELECT })
    const stillRefused = measureRefusal(current)
    if (stillRefused) throw new InvalidStateError(stillRefused)
    const row = await insertMeasureInCommand(tools, current, {
      measuredArea: new Dec(body.measuredArea).toFixed(4),
      areaUom: uom,
      declaredArea: body.declaredArea ? new Dec(body.declaredArea).toFixed(4) : null,
      measuredAt: measuredAt ?? now,
      note: body.note?.trim() || null,
      by: { userId: context.actorId },
    })
    const names = await namesOf(tx, current.siteId, [row])
    const measure = measureViewOf(row, current, names, true, await toleranceOfLot(tx, current.lotId))

    let move: { id: string; direction: 'IN' | 'OUT'; quantity: string; uom: typeof current.lot.item.baseUom } | null = null
    if (body.correctStock) {
      const base = areaUom(current.lot.item.baseUom)
      const measuredBase = areaIn(row.measuredArea.toString(), uom, base)
      const stock = await stockOfHide(tx, current.id)
      const correction = stockCorrection(stock.onHand, measuredBase)
      if (correction) {
        const place = mainPlace(stock)
        if (!place || stock.at.size !== 1) {
          throw new ConflictError(`Hide ${current.code} is not in one place of the site's stock (it may be at a work order): its stock is corrected where it lies, so bring it back first.`)
        }
        const reasonCode = body.correctStock.reasonCode?.trim()
        if (reasonCode) {
          const code = await tx.reasonCode.findFirst({ where: { list: 'ADJUSTMENT', code: reasonCode }, select: { active: true } })
          if (!code?.active) throw new ValidationError('Not an active adjustment reason of this company.', [{ path: 'body/correctStock/reasonCode', message: 'Pick an active adjustment reason.' }])
        }
        const symbol = UNITS[base].symbol
        const [posted] = await postMoves(
          tools,
          [
            {
              siteId: current.siteId,
              reason: 'ADJUSTMENT',
              itemId: current.itemId,
              lotId: current.lotId,
              hideId: current.id,
              quantity: correction.quantity.toFixed(4),
              uom: base,
              ...(correction.direction === 'IN' ? { toLocationId: place } : { fromLocationId: place }),
              note: correctionNote(current.code, measuredBase.toFixed(2), stock.onHand.toFixed(2), symbol, body.correctStock.note),
              ...(reasonCode ? { reasonCode } : {}),
              reference: `HideMeasure ${row.id}`,
            },
          ],
          { key: idempotencyKey ? `inventory.measureHide:${idempotencyKey}` : null, issuePath: () => 'body/correctStock' },
        )
        move = { id: posted!.id, direction: correction.direction, quantity: posted!.baseQuantity, uom: current.lot.item.baseUom }
      }
    }
    tools.emit({
      type: 'inventory.hide_measured',
      subject: current.id,
      companyId: current.lot.companyId,
      siteId: current.siteId,
      payload: { hideId: current.id, lotId: current.lotId, itemId: current.itemId, measureId: row.id, outcome: measure.outcome, moveId: move?.id ?? null },
    })
    return { measure, move }
  })
  return result
}
