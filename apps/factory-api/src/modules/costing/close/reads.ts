import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { CloseCheckView, WorkOrderClosesView } from '@nexus/factory-domain/costing/close/contracts'
import { WORKORDERS_REOPEN } from '@nexus/factory-domain/costing/close/permissions'
import { beyondWords, CLOSE_REASON_WORDS, CLOSE_REASONS, CLOSE_WAITS, NOTE_NEEDED, UNDO_SECONDS } from '@nexus/factory-domain/costing/close/rules'
import { pickRate } from '@nexus/factory-domain/costing/inputs'
import { perMinuteOf } from '@nexus/factory-domain/costing/ledger/entries'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import type { ScrapReworkView } from '@nexus/factory-domain/costing/variances/contracts'
import { recordValue, scrapAndRework, type ReworkFact, type ScrapFact } from '@nexus/factory-domain/costing/variances/scrap-rework'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf } from '../../product/materials/store'
import { officeContextOf } from '../../production/work-orders/access'
import { officeWorkOrder } from '../../production/work-orders/work-orders'
import { ENTRY_COLUMNS, ratesOf, readWorkOrder, romeDay, unique, type CostedWorkOrder, type Reader } from '../actual/store'
import { ledgerViews } from '../actual/views'
import { actualSettingsOf } from '../ppv/settings'
import { closeFactsOf } from './facts'
import { CLOSE_COLUMNS, closeRecordViews, figuresView, itemsOf, splitViewOf, VARIANCE_COLUMNS, varianceLineOf } from './views'

/**
 * The close's reads (B-W2b-411; MES-012, FIN-029, FIN-030, FIN-034):
 *
 *   GET /production/work-orders/:workOrderId/close-check   workorders.view: what the close dialog shows — planned against
 *       actual, the tolerance, which figures are beyond it, the reasons, whether the close settles the cost (and what still
 *       waits to post), the variance split it would write (costing.view; amounts with the cost grain), the close that
 *       stands on a CLOSED work order
 *   GET /costing/work-orders/:workOrderId/close            costing.view: every close of the work order, newest first, with
 *       its variance lines and its VARIANCE and CLOSE entries (and their reversals)
 *   GET /costing/work-orders/:workOrderId/scrap-rework     costing.view: the cost of scrap and rework per reason
 * Per work order, never per person (the office user who closed is named inside the one record).
 */

const SCOPE = (row: { readonly companyId: string; readonly siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })

/** The work order for a costing read: costing.view over its company and site (else 404), never a DRAFT. */
async function costedWorkOrder(caller: CommandCaller, db: Reader, workOrderId: string): Promise<CostedWorkOrder> {
  const workOrder = isUuid(workOrderId) ? await readWorkOrder(db, workOrderId) : null
  if (!workOrder || workOrder.status === 'DRAFT' || !can(actorOf(contextOf(caller)), COSTING_VIEW, SCOPE(workOrder))) throw new NotFoundError('Work order not found.')
  return workOrder
}

/** GET /production/work-orders/:workOrderId/close-check */
export async function closeCheck(caller: CommandCaller, workOrderId: string): Promise<CloseCheckView> {
  const header = await officeWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const scope = SCOPE(header)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const costed = (await readWorkOrder(db, header.id))!
    const facts = await closeFactsOf(db, costed, now)
    const liveRow = header.status === 'CLOSED' ? await db.workOrderClose.findFirst({ where: { workOrderId: header.id, undoneAt: null }, select: CLOSE_COLUMNS }) : null
    const [live] = liveRow ? await closeRecordViews(db, [liveRow], { actorId: context.actorId, mayManage: can(actor, WORKORDERS_MANAGE, scope), mayReopen: can(actor, WORKORDERS_REOPEN, scope), now }) : [null]
    const completed = header.status === 'COMPLETED'
    const figures = live ? live.figures : figuresView(facts.figures, costed.currency)
    const beyond = live ? live.beyond : facts.beyond
    const tolerancePct = live ? live.tolerancePct : facts.tolerancePct
    const settleWords = facts.settles
      ? "Closing settles its cost: the variance split and the closing entry are written, and the work order's ledger takes no entry but a reversal after."
      : CLOSE_WAITS
    const words = completed
      ? `${beyondWords(beyond, tolerancePct)} ${settleWords}`
      : live
        ? `Closed at ${live.closedAt}${live.settled ? ', its cost settled' : ''}. ${live.can.undo ? `The person who closed it may undo it for ${UNDO_SECONDS} seconds after the close; ` : ''}reopening it needs workorders.reopen and a reason.`
        : `Work order ${header.number} is ${header.status}: a work order is closed once it is COMPLETED.`
    return {
      workOrder: { id: header.id, number: header.number, status: header.status, version: header.version, companyId: header.companyId, siteId: header.siteId },
      closable: completed && can(actor, WORKORDERS_MANAGE, scope),
      refusal: completed ? null : { code: 'NOT_COMPLETED' as const, message: `Work order ${header.number} is ${header.status}: a work order is closed once it is COMPLETED.` },
      figures,
      tolerancePct,
      beyond,
      reasonNeeded: completed && beyond.any,
      beyondWords: beyondWords(beyond, tolerancePct),
      reasons: CLOSE_REASONS.map((code) => ({ code, words: CLOSE_REASON_WORDS[code], noteNeeded: NOTE_NEEDED.has(code) })),
      settles: facts.settles,
      waits: facts.settles ? null : CLOSE_WAITS,
      toPost: completed ? facts.toPost : 0,
      waiting: completed ? [...facts.waiting] : [],
      split: completed && can(actor, COSTING_VIEW, scope) ? splitViewOf(facts.split, await itemsOf(db, facts.itemIds)) : null,
      undoSeconds: UNDO_SECONDS,
      live: live ?? null,
      words,
    }
  })
}

/** GET /costing/work-orders/:workOrderId/close */
export async function workOrderCloses(caller: CommandCaller, workOrderId: string): Promise<WorkOrderClosesView> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const workOrder = await costedWorkOrder(caller, db, workOrderId)
    const scope = SCOPE(workOrder)
    const rows = await db.workOrderClose.findMany({ where: { workOrderId: workOrder.id }, select: CLOSE_COLUMNS, orderBy: [{ closedAt: 'desc' }, { id: 'desc' }] })
    const variances = await db.workOrderVariance.findMany({ where: { closeId: { in: rows.map((row) => row.id) } }, select: VARIANCE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const entries = await db.workOrderCostEntry.findMany({ where: { workOrderId: workOrder.id, kind: { in: ['VARIANCE', 'CLOSE'] } }, select: ENTRY_COLUMNS, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })
    const closeOfVariance = new Map(variances.map((row) => [row.id, row.closeId]))
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const closeOf = (entry: (typeof entries)[number]): string | null => {
      const origin = entry.reversalOfId ? (byId.get(entry.reversalOfId) ?? entry) : entry
      return origin.kind === 'CLOSE' ? origin.sourceId : origin.sourceId ? (closeOfVariance.get(origin.sourceId) ?? null) : null
    }
    const views = await ledgerViews(db, entries)
    const items = await itemsOf(db, variances.map((row) => row.itemId))
    const records = await closeRecordViews(db, rows, { actorId: 'actorId' in context ? context.actorId : '', mayManage: can(actor, WORKORDERS_MANAGE, scope), mayReopen: can(actor, WORKORDERS_REOPEN, scope), now })
    const settings = await actualSettingsOf(db, workOrder.companyId)
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, companyId: workOrder.companyId, siteId: workOrder.siteId },
      currency: workOrder.currency,
      closes: records.map((record) => {
        const mine = entries.filter((entry) => closeOf(entry) === record.id)
        const closing = mine.find((entry) => entry.kind === 'CLOSE' && entry.reversalOfId === null)
        return {
          ...record,
          lines: variances.filter((row) => row.closeId === record.id).map((row) => varianceLineOf(row, items)),
          closing: asMoney('cost', closing ? closing.amount : null),
          entries: views.filter((view) => mine.some((entry) => entry.id === view.id)),
        }
      }),
      waits: settings.postingsOn ? null : CLOSE_WAITS,
      words:
        rows.length === 0
          ? 'Not closed yet.'
          : 'Every close of the work order, newest first. A close that was undone keeps its figures and split as history; its entries are reversed. UNVERIFIED with the accountant (GATE-ACCOUNTANT).',
    }
  })
}

/** GET /costing/work-orders/:workOrderId/scrap-rework */
export async function scrapReworkCost(caller: CommandCaller, workOrderId: string): Promise<ScrapReworkView> {
  return caller.withClient(async (db) => {
    const workOrder = await costedWorkOrder(caller, db, workOrderId)
    const currency = workOrder.currency
    const entries = await db.workOrderCostEntry.findMany({ where: { workOrderId: workOrder.id, kind: 'SCRAP' }, select: ENTRY_COLUMNS })
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const scans = await db.operationScan.findMany({
      where: { workOrderId: workOrder.id, kind: { in: ['REPORT', 'CORRECTION'] }, scrapQuantity: { gt: 0 }, correctedBy: { none: {} } },
      select: { id: true, scrapQuantity: true, scrapReason: true },
    })
    const reworks = await db.reworkOrder.findMany({ where: { workOrderId: workOrder.id, status: 'DONE' }, select: { id: true, reasonCode: true, quantity: true, scrapQuantity: true, reworkAtOperationId: true, doneAt: true } })
    const scanOf = new Map(scans.map((scan) => [scan.id, scan]))
    const reworkOf = new Map(reworks.map((rework) => [rework.id, rework]))
    const moves = new Map((await db.stockMove.findMany({ where: { id: { in: unique(entries.map((entry) => entry.stockMoveId)) } }, select: { id: true, reasonCode: true } })).map((move) => [move.id, move.reasonCode]))
    const scraps: ScrapFact[] = []
    for (const entry of entries) {
      const origin = entry.reversalOfId ? (byId.get(entry.reversalOfId) ?? entry) : entry
      if (origin.stockMoveId) {
        scraps.push({ source: 'STOCK', sourceId: origin.stockMoveId, reasonCode: moves.get(origin.stockMoveId) ?? null, garments: 0, value: entry.amount })
        continue
      }
      const value = recordValue(entry.quantity?.toString() ?? null, entry.unitCost?.toString() ?? null, currency)
      const reworkId = origin.sourceType === 'ReworkOrder' ? origin.sourceId : origin.idempotencyKey.startsWith('rework-scrap:') ? origin.idempotencyKey.split(':')[1]! : null
      if (reworkId) {
        const rework = reworkOf.get(reworkId)
        scraps.push({ source: 'REWORK', sourceId: reworkId, reasonCode: rework?.reasonCode ?? null, garments: rework?.scrapQuantity ?? 0, value })
      } else if (origin.operationScanId) {
        const scan = scanOf.get(origin.operationScanId)
        scraps.push({ source: 'SCAN', sourceId: origin.operationScanId, reasonCode: scan?.scrapReason ?? null, garments: scan?.scrapQuantity ?? 0, value })
      }
    }
    // Scrap not posted yet (its value waits) still counts its garments.
    for (const scan of scans) if (!scraps.some((row) => row.source === 'SCAN' && row.sourceId === scan.id)) scraps.push({ source: 'SCAN', sourceId: scan.id, reasonCode: scan.scrapReason, garments: scan.scrapQuantity, value: 0 })
    for (const rework of reworks.filter((row) => row.scrapQuantity > 0)) {
      if (!scraps.some((row) => row.source === 'REWORK' && row.sourceId === rework.id)) scraps.push({ source: 'REWORK', sourceId: rework.id, reasonCode: rework.reasonCode, garments: rework.scrapQuantity, value: 0 })
    }
    const operations = new Map(
      (await db.workOrderOperation.findMany({ where: { id: { in: unique(reworks.map((rework) => rework.reworkAtOperationId)) } }, select: { id: true, standardMinutes: true, workCentreId: true } })).map((row) => [row.id, row]),
    )
    const kinds = new Map((await db.workCentre.findMany({ where: { id: { in: unique([...operations.values()].map((row) => row.workCentreId)) } }, select: { id: true, kind: true } })).map((row) => [row.id, row.kind]))
    const rates = await ratesOf(db, workOrder.companyId)
    const reworkFacts: ReworkFact[] = reworks.map((rework) => {
      const operation = operations.get(rework.reworkAtOperationId)
      const kind = operation ? kinds.get(operation.workCentreId) : undefined
      const rate = kind ? pickRate(rates, kind, workOrder.companyId, romeDay(rework.doneAt ?? new Date())) : null
      return {
        reworkId: rework.id,
        reasonCode: rework.reasonCode,
        garments: rework.quantity,
        minutesPerGarment: operation ? decimalText(operation.standardMinutes.toString()) : '0',
        perMinute: rate && rate.currency === currency ? perMinuteOf(rate) : null,
      }
    })
    const result = scrapAndRework(scraps, reworkFacts, currency)
    const money = <T extends number | null>(value: T) => asMoney('cost', value)
    const row = <R extends Omit<(typeof result.rows)[number], 'reasonCode'>>(item: R) => ({
      ...item,
      scrapValue: money(item.scrapValue),
      stockScrapValue: money(item.stockScrapValue),
      reworkCost: money(item.reworkCost),
      total: money(item.total),
    })
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status },
      currency,
      rows: result.rows.map(row),
      totals: row(result.totals),
      words: `Scrapped garments at the value of their material at the issue; material scrapped from stock at its stock value; rework as the garments reworked × the standard minutes of the operation redone, at the cost per minute in force that day (not posted to the work order's ledger: rework time is not costed there). Per reason, never per person.`,
    }
  })
}
