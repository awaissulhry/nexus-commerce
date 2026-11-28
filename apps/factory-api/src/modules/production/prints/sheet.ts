import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { floorCustomer } from '@nexus/factory-domain/production/floor-customer'
import { cardPrintNo, cardShipped, pagePrintNo } from '@nexus/factory-domain/production/print-start/prints'
import { routeOfLine } from '@nexus/factory-domain/product/routing/route-of-line'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { floorOrderPicture } from '../../sales/orders/floor-picture'
import { designFilesOf, goodsLinesOf, printOrder, printsOf, workOrdersOf } from '../print-start/store'
import { printBasketsOf } from './again'

/**
 * GET /production/orders/:orderId/print-sheet?printId= (production.print.start; owb- order workflow, S3 ss2 step 2.3; settles L7,
 * L8; the Shape of build/briefs/owb-ss2.md + S3 lead settle 09:13). What the browser draws and prints (an HTML sheet: the browser
 * shapes Urdu, pdfjs draws the design page, qrcode the code):
 *
 *   printId given     that print: FIRST — every design page and every basket made at it; AGAIN — the pages and cards it names
 *   printId left out  the order's CURRENT sheet for "Print again": every design page and every ACTIVE basket card of its FIRST print
 *   pages             a goods line's design page: its newest design file, the page, the line's WORK ORDER NUMBER as the QR (the
 *                     traveller's form; a work order has no scan id), the place of the code (null: the usual place, top right,
 *                     20 mm — owb-ss2b keeps the placements), the print number ("Print N · date" from 2)
 *   cards             a basket: its BN code, its number for the eye, its pieces, the picture (the order's, as the floor of its site
 *                     sees it, else the line's design), the customer's CODE (never the name, never a price), the due date, the
 *                     route's steps with their department's number, names (Urdu too) and look, the print number, and `shipped`
 *                     (its garments left, or its work order is closed: the window does not offer it again)
 * 404 in words before the FIRST print, and for a print of another order.
 */
export async function printSheet(caller: CommandCaller, orderId: string, query: { readonly printId?: string | undefined }) {
  const { order } = await printOrder(caller, orderId)
  return caller.withClient(async (client) => {
    const db = client as unknown as CommandTx
    const prints = await printsOf(db, order.id)
    const first = prints.find((row) => row.kind === 'FIRST')
    if (!first) throw new NotFoundError('Nothing was printed yet: Print and start the work first.')
    const asked = query.printId !== undefined ? (isUuid(query.printId) ? prints.find((row) => row.id === query.printId) : undefined) : null
    if (asked === undefined) throw new NotFoundError('Print not found.')
    const shown = asked ?? first
    // The print numbers count the prints up to the one shown (the current sheet: all of them).
    const upTo = asked ? prints.slice(0, prints.indexOf(asked) + 1) : prints

    const lines = await goodsLinesOf(db, order.id)
    const lineOf = new Map(lines.map((line) => [line.id, line]))
    const files = await designFilesOf(db, lines)
    const workOrders = await workOrdersOf(db, lines.map((line) => line.id))
    const workOrderOfLine = new Map<string, (typeof workOrders)[number]>()
    for (const workOrder of workOrders) for (const cell of workOrder.cells) if (cell.salesOrderLineId && !workOrderOfLine.has(cell.salesOrderLineId)) workOrderOfLine.set(cell.salesOrderLineId, workOrder)
    const party = await db.party.findUnique({ where: { id: order.partyId }, select: { code: true } })
    const customerCode = floorCustomer(party ? [party] : []) ?? ''
    const due = order.promiseDate ?? order.requestedDate
    const dueDate = due ? due.toISOString().slice(0, 10) : null

    // Pages: FIRST / the current sheet — every design page (page 1 of each line with a design file); AGAIN — its own.
    const pageAsks = shown.kind === 'AGAIN' ? shown.pages : lines.filter((line) => files.has(line.id)).map((line) => ({ salesOrderLineId: line.id, page: 1 }))
    const pages = pageAsks.flatMap((page) => {
      const line = lineOf.get(page.salesOrderLineId)
      const file = files.get(page.salesOrderLineId)
      const workOrder = workOrderOfLine.get(page.salesOrderLineId)
      if (!line || !file || !workOrder) return []
      return [
        {
          salesOrderLineId: line.id,
          label: line.label,
          styleCode: line.styleCode,
          fileId: file.fileId,
          page: page.page,
          contentType: file.contentType,
          qr: workOrder.number,
          workOrderNumber: workOrder.number,
          // owb-ss2b: the place saved for this line, file and page (ScanCodePlacement); null until then: top right, 20 mm.
          placement: null as { xMm: number; yMm: number; sizeMm: number } | null,
          printNo: pagePrintNo(upTo, page),
        },
      ]
    })

    // Cards: FIRST — every basket made at print; the current sheet — every ACTIVE one; AGAIN — the ones it names.
    const baskets = await printBasketsOf(db, workOrders.map((workOrder) => workOrder.id))
    const named = shown.kind === 'AGAIN' && asked ? new Set(shown.cards.map((card) => card.bundleId)) : null
    const chosen = baskets.filter((basket) => (named ? named.has(basket.id) : asked ? true : basket.status === 'ACTIVE'))
    const steps = await stepsOfWorkOrders(db, order.companyId, [...new Set(chosen.map((basket) => basket.workOrderId))])
    const pictures = new Map<string, string | null>()
    for (const siteId of new Set(chosen.map((basket) => basket.workOrder.siteId))) pictures.set(siteId, (await floorOrderPicture(db, { salesOrderId: order.id, siteId }))?.fileId ?? null)
    const cellOf = new Map(workOrders.flatMap((workOrder) => workOrder.cells.map((cell) => [cell.id, { ...cell, workOrder }] as const)))
    const cards = chosen.flatMap((basket) => {
      const cell = cellOf.get(basket.workOrderSizeId)
      if (!cell) return []
      const line = cell.salesOrderLineId ? lineOf.get(cell.salesOrderLineId) : undefined
      return [
        {
          bundleId: basket.id,
          code: basket.code,
          basketNo: basketNoOf(basket.code),
          pieces: basket.quantity,
          styleCode: cell.workOrder.styleCode,
          label: `${cell.workOrder.styleCode} ${cell.colourwayCode} ${cell.size}`,
          pictureFileId: pictures.get(basket.workOrder.siteId) ?? (line ? (files.get(line.id)?.fileId ?? null) : null),
          customerCode,
          dueDate,
          printNo: cardPrintNo(upTo, basket.id),
          steps: steps.get(basket.workOrderId) ?? [],
          shipped: cardShipped(basket.workOrderStatus, basket.shipped),
        },
      ]
    })
    return {
      printId: shown.id,
      kind: shown.kind,
      printedAt: toUtcIso(shown.createdAt),
      order: { number: order.number, customerCode, dueDate },
      pages,
      cards,
    }
  })
}

/** "B-0431": the basket's number for the eye, from its BN code's running part (the code itself is what scans). */
function basketNoOf(code: string): string {
  const parts = code.split('-')
  return parts.length >= 3 ? `B-${parts[2]}` : code
}

/** Each work order's route steps as the card prints them: the department's number, short name, names (Urdu too) and look. */
async function stepsOfWorkOrders(db: CommandTx, companyId: string, workOrderIds: readonly string[]) {
  const out = new Map<string, { departmentNumber: number; shortName: string; name: string; nameUr: string | null; tone: string; icon: string }[]>()
  if (workOrderIds.length === 0) return out
  const departments = await db.department.findMany({ where: { OR: [{ companyId: null }, { companyId }] }, select: { id: true, number: true, name: true, shortName: true, nameI18n: true, tone: true, icon: true } })
  const byNumber = new Map(departments.map((department) => [department.number, department]))
  const operations = await db.workOrderOperation.findMany({
    where: { workOrderId: { in: [...workOrderIds] } },
    select: { id: true, workOrderId: true, seq: true, code: true, name: true, operationId: true, parallelGroup: true, workCentre: { select: { kind: true } }, routingOperation: { select: { departmentId: true, operationId: true } } },
    orderBy: [{ workOrderId: 'asc' }, { seq: 'asc' }],
  })
  for (const workOrderId of workOrderIds) {
    const route = routeOfLine({
      steps: operations
        .filter((operation) => operation.workOrderId === workOrderId)
        .map((operation) => ({ id: operation.id, seq: operation.seq, operationId: operation.routingOperation?.operationId ?? operation.operationId ?? '', code: operation.code, name: operation.name, workCentreKind: operation.workCentre.kind, departmentId: operation.routingOperation?.departmentId ?? null, parallelGroup: operation.parallelGroup })),
      departments: departments.map((department) => ({ id: department.id, number: department.number })),
    })
    const seen = new Set<number>()
    const steps: { departmentNumber: number; shortName: string; name: string; nameUr: string | null; tone: string; icon: string }[] = []
    for (const step of route.steps) {
      if (step.departmentNo === null || seen.has(step.departmentNo)) continue
      seen.add(step.departmentNo)
      const department = byNumber.get(step.departmentNo)
      if (!department) continue
      const names = department.nameI18n !== null && typeof department.nameI18n === 'object' ? (department.nameI18n as Record<string, unknown>) : {}
      steps.push({ departmentNumber: department.number, shortName: department.shortName, name: department.name, nameUr: typeof names.ur === 'string' ? names.ur : null, tone: department.tone, icon: department.icon })
    }
    out.set(workOrderId, steps)
  }
  return out
}
