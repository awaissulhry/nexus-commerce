import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { LengthUom } from '@nexus/factory-domain/inventory/rolls/rolls'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { PRODUCTION_CUTORDERS_MANAGE } from '@nexus/factory-domain/production/cutorders/permissions'
import { CONSUMPTION_UOM, differenceWords, estimateOf, recordedOf } from '@nexus/factory-domain/production/lays/consumption'
import { bySize, CUT_VARIANCE_REASONS, fabricCut, leatherCut, lineFigures, reasonProblems, reconcileRefusal, reconcileWords, VARIANCE_WORDS, type ReasonDraft } from '@nexus/factory-domain/production/lays/reconcile'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { invalid, may, notFound, officeOf } from '../cutorders/access'
import { readCutOrder, readLayRolls, readLays, readLines, type CutOrderRow, type Reader } from '../cutorders/store'
import { cutCountsOf } from '../cutting/views'
import { refuse } from './access'
import { emitReconciled } from './emit'
import { CONSUMPTION_COLUMNS, issuedForLays, layLengthOf, markerOf, metres, rollUom } from './store'
import { plyLength } from '@nexus/factory-domain/production/lays/rules'

/**
 * Cut against ordered (B-W2b-116; MES-045; design production.cutting pop "Reconcile cut": "planned vs cut per size, material issued
 * vs used vs returned, end bits, variance reason", the Yield tab's "W2b reconciliation of issued vs used vs returned"):
 *
 *   GET  /production/cut-orders/:cutOrderId/reconciliation   office, production.cutting.view: each line ordered, cut and recut, the
 *                                                            sums per size, the material per lay (estimate, the lay report, used,
 *                                                            issued to the work orders, end loss, ends returned), the variance
 *                                                            reasons, what still stops it
 *   POST /production/cut-orders/:cutOrderId/reconcile        office, production.cutorders.manage, at the cut order's version: one
 *                                                            CutReconciliation per line not yet reconciled (append-only; a reason
 *                                                            exactly where cut differs from ordered), the cut order RECONCILED
 *
 * A fabric cut order is reconciled once it is CUT and each CUT lay's fabric used is confirmed (that issued its fabric to the work
 * orders: the cost ledger posts it). Rules: factory-domain production/lays/reconcile. Counts and lengths only: no money.
 */

const m4 = (value: Decimal): string => value.toFixed(4)

/** The material of a fabric cut order per CUT lay: estimate, the lay report, used (confirmed), issued, end loss, ends returned (metres). */
async function materialOf(db: Reader, order: CutOrderRow, marker: { readonly length: string; readonly uom: LengthUom }, cutLays: Awaited<ReturnType<typeof readLays>>) {
  const [rolls, consumptions, issued] = await Promise.all([
    readLayRolls(db, cutLays.map((lay) => lay.id)),
    db.cutConsumption.findMany({ where: { cutOrderId: order.id }, select: CONSUMPTION_COLUMNS }),
    issuedForLays(db, cutLays.map((lay) => lay.id), order.item.baseUom),
  ])
  const sum = { estimated: ZERO, recorded: ZERO, used: ZERO, issued: ZERO, endLoss: ZERO, endsReturned: ZERO }
  const perLay = cutLays.map((lay) => {
    const own = rolls.filter((row) => row.layId === lay.id)
    const consumption = consumptions.find((row) => row.layId === lay.id) ?? null
    const ply = plyLength(marker, layLengthOf(lay), CONSUMPTION_UOM)
    const estimated = consumption ? new Dec(consumption.estimated.toString()) : estimateOf(marker, lay.plyCountLeft ?? 0)
    const recorded = consumption ? new Dec(consumption.recorded.toString()) : recordedOf(own.map((row) => ({ plies: row.plies, endLoss: new Dec(row.endLoss.toString()), uom: rollUom(row.roll) })), ply)
    const used = consumption?.confirmed ? new Dec(consumption.confirmed.toString()) : null
    const endLoss = own.reduce((total, row) => total.plus(metres(new Dec(row.endLoss.toString()), rollUom(row.roll))), ZERO)
    const endsReturned = own.reduce((total, row) => total.plus(metres(new Dec(row.endReturned.toString()), rollUom(row.roll))), ZERO)
    const out = issued.get(lay.id) ?? ZERO
    sum.estimated = sum.estimated.plus(estimated)
    sum.recorded = sum.recorded.plus(recorded)
    sum.used = sum.used.plus(used ?? recorded)
    sum.issued = sum.issued.plus(out)
    sum.endLoss = sum.endLoss.plus(endLoss)
    sum.endsReturned = sum.endsReturned.plus(endsReturned)
    return { layId: lay.id, seq: lay.seq, plies: lay.plyCountLeft ?? 0, estimated: m4(estimated), recorded: m4(recorded), used: used ? m4(used) : null, issued: m4(out), endLoss: m4(endLoss), endsReturned: m4(endsReturned), confirmed: used !== null }
  })
  return {
    uom: CONSUMPTION_UOM as LengthUom,
    lays: perLay,
    sum: { estimated: m4(sum.estimated), recorded: m4(sum.recorded), used: m4(sum.used), issued: m4(sum.issued), endLoss: m4(sum.endLoss), endsReturned: m4(sum.endsReturned) },
    words: { it: differenceWords(sum.used, sum.estimated, 'it'), en: differenceWords(sum.used, sum.estimated, 'en') },
  }
}

/** The reconciliation of a cut order as it stands, read with `db` (the caller's client, or a command's transaction). */
async function reconciliationOf(db: Reader, order: CutOrderRow) {
  const [lines, lays, done] = await Promise.all([
    readLines(db, [order.id]),
    readLays(db, [order.id]),
    db.cutReconciliation.findMany({ where: { cutOrderId: order.id }, select: { cutOrderLineId: true, orderedQuantity: true, cutQuantity: true, recutQuantity: true, varianceReasonCode: true, note: true, reconciledAt: true } }),
  ])
  const cutLays = lays.filter((lay) => lay.status === 'CUT')
  const counted = cutLays.reduce((sum, lay) => sum + (lay.plyCountLeft ?? 0), 0)
  const cells = lines.map((line) => line.workOrderSizeId)
  // Recuts: RECUT tickets of the line's cell done since the cut order was released (B-W2b-117's replacement panels).
  const recuts = cells.length && order.releasedAt
    ? await db.cutTicket.groupBy({ by: ['workOrderSizeId'], where: { kind: 'RECUT', status: 'DONE', workOrderSizeId: { in: cells }, doneAt: { gte: order.releasedAt } }, _sum: { quantity: true } })
    : []
  const recutOf = new Map(recuts.map((row) => [row.workOrderSizeId!, row._sum.quantity ?? 0]))
  // Leather: the cut log per cell, less what earlier reconciled leather cut orders of the material took of the cell.
  const leatherCuts = new Map<string, number>()
  if (order.kind === 'LEATHER') {
    const before = await db.cutReconciliation.findMany({
      where: { cutOrderId: { not: order.id }, line: { is: { workOrderSizeId: { in: cells } } }, cutOrder: { is: { kind: 'LEATHER', itemId: order.itemId } } },
      select: { cutQuantity: true, line: { select: { workOrderSizeId: true } } },
    })
    const takenBefore = new Map<string, number>()
    for (const row of before) takenBefore.set(row.line.workOrderSizeId, (takenBefore.get(row.line.workOrderSizeId) ?? 0) + row.cutQuantity)
    for (const workOrder of new Map(lines.map((line) => [line.workOrderId, line.workOrderSize.workOrder.style.id]))) {
      const counts = await cutCountsOf(db, workOrder[0], workOrder[1])
      for (const line of lines.filter((entry) => entry.workOrderId === workOrder[0])) leatherCuts.set(line.id, leatherCut(counts.get(line.workOrderSizeId) ?? 0, takenBefore.get(line.workOrderSizeId) ?? 0))
    }
  }
  const lineViews = lines.map((line) => {
    const stored = done.find((row) => row.cutOrderLineId === line.id) ?? null
    const cut = stored ? stored.cutQuantity : order.kind === 'FABRIC' ? fabricCut(line.ratio ?? 0, counted) : (leatherCuts.get(line.id) ?? 0)
    const figures = stored ? lineFigures(stored.orderedQuantity, stored.cutQuantity, stored.recutQuantity) : lineFigures(line.quantity, cut, recutOf.get(line.workOrderSizeId) ?? 0)
    return {
      id: line.id,
      seq: line.seq,
      workOrder: { id: line.workOrderId, number: line.workOrderSize.workOrder.number },
      style: line.workOrderSize.workOrder.style,
      colourway: line.workOrderSize.colourway,
      size: line.workOrderSize.size,
      ratio: line.ratio,
      ...figures,
      reconciled: stored ? { varianceReasonCode: stored.varianceReasonCode, note: stored.note, reconciledAt: toUtcIso(stored.reconciledAt) } : null,
    }
  })

  const marker = markerOf(order)
  const material = order.kind === 'FABRIC' && marker ? await materialOf(db, order, marker, cutLays) : null

  const ordered = lineViews.reduce((total, line) => total + line.ordered, 0)
  const cut = lineViews.reduce((total, line) => total + line.cut, 0)
  const unconfirmed = material ? material.lays.filter((lay) => !lay.confirmed).map((lay) => lay.seq) : []
  return {
    cutOrder: { id: order.id, number: order.number, kind: order.kind, status: order.status, version: order.version, reconciledAt: order.reconciledAt ? toUtcIso(order.reconciledAt) : null },
    lines: lineViews,
    sizes: bySize(lineViews.map((line) => ({ size: line.size, figures: line }))),
    material,
    reasons: CUT_VARIANCE_REASONS.map((code) => ({ code, words: VARIANCE_WORDS[code] })),
    refusal: reconcileRefusal(order, unconfirmed),
    garments: { ordered, cut },
    words: { it: reconcileWords({ ordered, cut }, 'it'), en: reconcileWords({ ordered, cut }, 'en') },
  }
}

/** The cut order the office sees (production.cutting.view at its site; 404 otherwise). */
async function seenOrder(caller: CommandCaller, cutOrderId: string) {
  const context = officeOf(caller)
  const order = await caller.withClient((db) => readCutOrder(db, cutOrderId))
  if (!order || !may(context, PRODUCTION_CUTTING_VIEW, order)) return notFound('Cut order')
  return { context, order: order! }
}

/** GET /production/cut-orders/:cutOrderId/reconciliation. */
export async function readReconciliation(caller: CommandCaller, cutOrderId: string) {
  const { context, order } = await seenOrder(caller, cutOrderId)
  return caller.withClient(async (db) => {
    const view = await reconciliationOf(db, order)
    return { ...view, can: { reconcile: may(context, PRODUCTION_CUTORDERS_MANAGE, order) && view.refusal === null } }
  })
}

export interface ReconcileBody {
  readonly version: number
  readonly lines?: readonly ReasonDraft[] | undefined
}

/** POST /production/cut-orders/:cutOrderId/reconcile: each line still open reconciled, the cut order RECONCILED. */
export async function reconcileCutOrder(caller: CommandCaller, cutOrderId: string, body: ReconcileBody, idempotencyKey?: string) {
  const { context, order } = await seenOrder(caller, cutOrderId)
  if (!may(context, PRODUCTION_CUTORDERS_MANAGE, order)) throw new ForbiddenError('A cut order is reconciled with production.cutorders.manage at its site.')
  const { result } = await command(caller, { name: 'production.reconcileCutOrder', idempotencyKey, input: { cutOrderId, ...body }, record: { type: 'CutOrder', id: cutOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = (await readCutOrder(tx, cutOrderId))!
    const view = await reconciliationOf(tx, current)
    if (view.refusal) refuse(view.refusal)
    const open = view.lines.filter((line) => line.reconciled === null)
    const problems = reasonProblems(open.map((line) => ({ id: line.id, seq: line.seq, figures: line })), body.lines ?? [])
    if (problems.length > 0) invalid(problems, 'The variance reasons are not complete.')
    const given = new Map((body.lines ?? []).map((entry) => [entry.lineId, entry]))
    for (const line of open) {
      const reason = given.get(line.id)
      await tx.cutReconciliation.create({
        data: {
          id: newId(),
          siteId: current.siteId,
          cutOrderId,
          cutOrderLineId: line.id,
          key: `reconciliation:${line.id}`,
          orderedQuantity: line.ordered,
          cutQuantity: line.cut,
          recutQuantity: line.recut,
          varianceReasonCode: line.needsReason ? reason!.reasonCode!.trim() : null,
          note: reason?.note?.trim() || null,
          reconciledAt: now,
          createdAt: now,
          createdById: context.actorId,
        },
        select: { id: true },
      })
    }
    await tx.cutOrder.update({ where: { id: cutOrderId }, data: { status: 'RECONCILED', reconciledAt: now, reconciledById: context.actorId, updatedAt: now }, select: { id: true } })
    const after = (await readCutOrder(tx, cutOrderId))!
    const workOrderIds = [...new Set(view.lines.map((line) => line.workOrder.id))].sort()
    const counts = { lines: open.length, variances: open.filter((line) => line.needsReason).length, garmentsOrdered: open.reduce((sum, line) => sum + line.ordered, 0), garmentsCut: open.reduce((sum, line) => sum + line.cut, 0) }
    tools.audit({
      action: 'production.reconcileCutOrder',
      recordType: 'CutOrder',
      recordId: cutOrderId,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { status: current.status },
      after: { status: 'RECONCILED', number: current.number, lines: open.map((line) => ({ seq: line.seq, ordered: line.ordered, cut: line.cut, recut: line.recut, reason: line.needsReason ? given.get(line.id)!.reasonCode!.trim() : null })), material: view.material?.sum ?? null },
    })
    emitReconciled(tools, after, workOrderIds, counts)
    return { ...(await reconciliationOf(tx, after)), can: { reconcile: false } }
  })
  return result
}
