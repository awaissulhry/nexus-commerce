import { toUtcIso } from '@nexus/factory-domain/core/time'
import { printProblems, type ExtraProblem, type WorkOrderChecks } from '@nexus/factory-domain/production/print-start/checks'
import { printStartState } from '@nexus/factory-domain/production/print-start/prints'
import { beforeRelease } from '@nexus/factory-domain/production/work-orders/bulk'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { planCredit } from '../../sales/credit/check'
import { checklistOf, readBasics, readReleaseFacts } from '../work-orders/facts'
import { readWorkOrder } from '../work-orders/store'
import { todayNow } from '../work-orders/work-orders'
import { basketsAtPrintBySite, basketsOfCell, designFilesOf, draftGroupsOf, goodsLinesOf, printOrder, printsOf, workOrdersOf } from './store'
// owb-ss2b: the saved places of the scan code.
import { placedCount } from '@nexus/factory-domain/production/print-start/placement'
import { placeKey, placementsOf } from '../prints/placements'

/**
 * GET /production/orders/:orderId/print-start (production.print.start; owb- order workflow, S3 ss2 step 2.2; settles L1, L6; the
 * Shape of build/briefs/owb-ss2.md). What "Print and start the work" would do now, read without a command: the work orders (the
 * ones there are, and one per group of lines still to make — `workOrderId` null), today's release checks of every DRAFT work order
 * and the customer's credit, each problem classed (law, money, structure, hold refuse; a material shortage or a credit warning
 * warn), the baskets it would make where the site makes them at print, the design pages. A work order still to make is checked
 * when the print makes it (the command lists its problems in the same words).
 */
export async function printStartPreview(caller: CommandCaller, orderId: string) {
  const { order, context } = await printOrder(caller, orderId)
  return caller.withClient(async (client) => {
    const db = client as unknown as CommandTx
    const prints = await printsOf(db, order.id)
    const first = prints.find((row) => row.kind === 'FIRST') ?? null
    const lines = await goodsLinesOf(db, order.id)
    const lineOf = new Map(lines.map((line) => [line.id, line]))
    const workOrders = await workOrdersOf(db, lines.map((line) => line.id))
    const groups = await draftGroupsOf(db, order, lines)

    // Today's release checks of every DRAFT work order (no override: a shortage shows as a warning).
    const checks: WorkOrderChecks[] = []
    for (const workOrder of workOrders) {
      const header = (await readWorkOrder(db, workOrder.id))!
      if (!beforeRelease(header)) continue
      const facts = await readReleaseFacts(db, await readBasics(db, header), todayNow())
      checks.push({ workOrderNumber: workOrder.number, checklist: checklistOf(facts, null) })
    }
    // The customer's credit at the release step (a HOLD refuses, a WARN warns), as the release's own credit gate reads it.
    const extras: ExtraProblem[] = []
    const credit = await planCredit(db, { step: 'RELEASE', partyId: order.partyId, companyId: order.companyId, now: serverClock.now(), askers: [context.actorId] })
    if (credit?.result === 'HOLD') extras.push({ code: 'CREDIT_HOLD', workOrderNumber: null, words: credit.words })
    else if (credit?.result === 'WARN') extras.push({ code: 'CREDIT_WARN', workOrderNumber: null, words: credit.words })
    const answer = printProblems(checks, extras)

    // The baskets, where the making site makes them at print (a work order still to make: its group's site).
    const switches = await basketsAtPrintBySite(db, [...workOrders.map((workOrder) => workOrder.siteId), ...groups.flatMap((group) => (group.siteId ? [group.siteId] : []))])
    const basketsByLine = new Map<string, number>()
    for (const workOrder of workOrders) {
      // Only the DRAFTs this print releases get baskets (one released before keeps what it has).
      if (!switches.get(workOrder.siteId) || workOrder.status !== 'DRAFT') continue
      for (const cell of workOrder.cells) if (cell.salesOrderLineId) basketsByLine.set(cell.salesOrderLineId, (basketsByLine.get(cell.salesOrderLineId) ?? 0) + basketsOfCell(workOrder, cell.quantity))
    }
    for (const group of groups) {
      if (!group.siteId || !switches.get(group.siteId)) continue
      for (const line of group.lines) basketsByLine.set(line.salesOrderLineId, (basketsByLine.get(line.salesOrderLineId) ?? 0) + line.sizes.reduce((sum, size) => sum + size.quantity, 0))
    }
    const files = await designFilesOf(db, lines)
    // owb-ss2b: page 1 of each line's design file is placed when a place is saved for it.
    const places = await placementsOf(db, order.id)
    const pages = lines.map((line) => {
      const file = files.get(line.id)
      return { salesOrderLineId: line.id, label: lineOf.get(line.id)!.label, fileId: file?.fileId ?? null, pageCount: null, placed: file ? places.has(placeKey(line.id, file.fileId, 1)) : false }
    })
    const basketLines = lines.filter((line) => (basketsByLine.get(line.id) ?? 0) > 0).map((line) => ({ salesOrderLineId: line.id, label: line.label, baskets: basketsByLine.get(line.id)! }))
    return {
      orderId: order.id,
      version: order.version,
      state: printStartState(order, first?.createdAt ?? null),
      printedAt: first ? toUtcIso(first.createdAt) : null,
      basketsAtPrint: [...switches.values()].some(Boolean),
      workOrders: [
        ...workOrders.map((workOrder) => ({ workOrderId: workOrder.id, number: workOrder.number, styleCode: workOrder.styleCode, pieces: workOrder.cells.reduce((sum, cell) => sum + cell.quantity, 0), status: workOrder.status })),
        ...groups.map((group) => ({ workOrderId: null, number: null, styleCode: group.styleCode, pieces: group.pieces, status: null })),
      ],
      problems: answer.problems.map((problem) => ({ ...problem })),
      refused: answer.refused,
      needsMaterialReason: answer.needsMaterialReason,
      baskets: { count: basketLines.reduce((sum, line) => sum + line.baskets, 0), lines: basketLines },
      pages,
      // owb-ss2b: the design pages that carry a saved place (ScanCodePlacement) — "0 of 3 placed" never stops the print.
      placed: placedCount(pages.filter((page) => page.fileId !== null)),
    }
  })
}
