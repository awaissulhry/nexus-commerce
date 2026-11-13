import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { RowIssue, RowValues } from '@nexus/factory-domain/imports/importer'
import { groupOrders, orderImporter, type ImportOrder } from '@nexus/factory-domain/sales/order-import/importer'
import { isPriorityLevel } from '@nexus/factory-domain/sales/orders-depth/rules'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { CheckRow, ImportAdapter } from '../../../platform/imports/registry'
import { makeManualOrderInCommand, planManualOrder, type ManualOrderBody } from '../orders/manual'
import { seasonByCode } from '../seasons/store'

/**
 * The sheet import of sales orders (B-W2b-303; SAL-215; factory-domain sales/order-import; platform/imports): the importer
 * `sales.orders` with its adapter.
 *
 *   authorize  a company's import only (an order is a company's).
 *   load       none: every row is a new order line (an order imported before is the check's: its PO number).
 *   check      the rows grouped into orders (one per `order` reference: its header cells agree); per order the customer (by
 *              code, a customer of the company, orders.manage over it), the season (an OPEN season of the company by code),
 *              the priority, an order of the customer with the same PO number already there, and the whole order judged as
 *              the office's "Confirm order" judges it (orders/manual.ts planManualOrder: the customer's hold and PO rule, its
 *              addresses, each style, colour and size offered, list prices, the line rules) — every problem lands on the rows
 *              of that order. The dry run runs it for the person who started the job, each apply batch again for the person
 *              who applies.
 *   write      the apply is ONE batch (one command): the batch's check keeps the orders it passed, and the first row's write
 *              makes them ALL with the office's own work (makeManualOrderInCommand, credit step ORDER: its credit check and a
 *              SALES_ORDER rule may make an order wait, asked by the person who applied); each row answers the order line it
 *              went to. Every order or none.
 *
 * Running and applying it needs orders.manage (with imports.run / imports.apply); seeing its plans orders.view. The registry
 * lists this adapter, so it imports only the registry's types (no load-order cycle).
 */

const text = (value: unknown): string | null => (value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim())

interface PassedOrder {
  readonly order: ImportOrder
  readonly body: ManualOrderBody
}
const PASSED = new WeakMap<object, PassedOrder[]>()
const MADE = new WeakMap<object, Map<string, string>>()

/** The row key the write finds its line by: order reference, style, colour (folded). */
const lineKey = (reference: string, style: string, colour: string): string => `${reference}\u0000${style.toUpperCase()}\u0000${colour.trim().toLowerCase()}`

async function checkOrders(client: CommandTx, rows: readonly CheckRow[], companyId: string, actor: Actor): Promise<RowIssue[][]> {
  const values = rows.map((row): RowValues => ({ ...row.key, ...row.values }))
  const grouped = groupOrders(rows.map((row, index) => ({ rowNumber: row.rowNumber, values: values[index]! })))
  const answers = grouped.issues.map((list) => [...list])
  const indexOf = new Map(rows.map((row, index) => [row.rowNumber, index]))
  const now = new Date()
  const passed: PassedOrder[] = []
  for (const order of grouped.orders) {
    const at = order.rowNumbers.map((number) => indexOf.get(number)!)
    const all = (issue: RowIssue) => at.forEach((index) => answers[index]!.push(issue))
    if (at.some((index) => answers[index]!.length > 0)) continue
    const code = text(order.header.customer) ?? ''
    const party = await client.party.findFirst({ where: { code: { equals: code, mode: 'insensitive' }, OR: [{ companyId: null }, { companyId }] }, select: { id: true, code: true, roles: true } })
    if (!party) {
      all({ column: 'customer', message: `No customer ${code} in this company.` })
      continue
    }
    if (!can(actor, ORDERS_MANAGE, { companyId, partyId: party.id })) {
      all({ column: 'customer', message: `Making orders for ${party.code} needs orders.manage over it.` })
      continue
    }
    const seasonCode = text(order.header.season)
    let seasonId: string | null = null
    if (seasonCode !== null) {
      const season = await seasonByCode(client, companyId, seasonCode)
      if (!season) all({ column: 'season', message: `No season ${seasonCode} in this company.` })
      else if (season.status !== 'OPEN') all({ column: 'season', message: `Season ${season.code} is closed: name an open season.` })
      else seasonId = season.id
    }
    const priority = text(order.header.priority)
    if (priority !== null && !isPriorityLevel(priority)) all({ column: 'priority', message: 'LOW, NORMAL, HIGH or URGENT.' })
    const customerRef = text(order.header.customerPo)
    if (customerRef !== null) {
      const twin = await client.salesOrder.findFirst({ where: { companyId, partyId: party.id, customerRef: { equals: customerRef, mode: 'insensitive' }, status: { not: 'CANCELLED' } }, select: { number: true } })
      if (twin) all({ column: 'customerPo', message: `${party.code}'s order ${customerRef} is ${twin.number} already: the sheet was imported before, or the PO number is another order's.` })
    }
    if (at.some((index) => answers[index]!.length > 0)) continue
    // Each line: the style by code, the colourway by code or name (as the office picks them).
    const lines: ManualOrderBody['lines'][number][] = []
    for (const line of order.lines) {
      const rowsOf = line.sizes.map((size) => indexOf.get(size.rowNumber)!)
      const style = await client.style.findFirst({ where: { code: { equals: line.style, mode: 'insensitive' }, OR: [{ companyId: null }, { companyId }] }, select: { id: true, code: true } })
      if (!style) {
        rowsOf.forEach((index) => answers[index]!.push({ column: 'style', message: `No style ${line.style} in this company.` }))
        continue
      }
      const colourways = await client.colourway.findMany({ where: { styleId: style.id, status: 'ACTIVE' }, select: { id: true, code: true, name: true } })
      const colourway = colourways.find((row) => row.code.toLowerCase() === line.colour.toLowerCase()) ?? colourways.find((row) => row.name.toLowerCase() === line.colour.toLowerCase())
      if (!colourway) {
        rowsOf.forEach((index) => answers[index]!.push({ column: 'colour', message: `${style.code} has no active colour ${line.colour}.` }))
        continue
      }
      lines.push({ styleId: style.id, colourwayId: colourway.id, sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity })), ...(line.unitPrice !== null ? { unitPrice: line.unitPrice } : {}), ...(line.note !== null ? { note: line.note } : {}) })
    }
    if (at.some((index) => answers[index]!.length > 0)) continue
    const body: ManualOrderBody = {
      companyId,
      partyId: party.id,
      customerRef,
      requestedDate: text(order.header.requestedDate),
      promiseDate: text(order.header.promiseDate),
      seasonId,
      priorityLevel: priority !== null && isPriorityLevel(priority) ? priority : 'NORMAL',
      urgentReason: text(order.header.urgentReason),
      internalNote: `Imported from a sheet (order ${order.reference}).`,
      lines,
    }
    // The office's own judgement of the whole order (planManualOrder): its problems on the order's rows.
    try {
      const plan = await planManualOrder(client, body, now, null)
      if (Array.isArray(plan)) {
        for (const issue of plan as Issue[]) {
          const lineAt = /^body\/lines\/(\d+)/.exec(issue.path)
          const targets = lineAt ? order.lines[Number(lineAt[1])]!.sizes.map((size) => indexOf.get(size.rowNumber)!) : at
          targets.forEach((index) => answers[index]!.push({ message: issue.message }))
        }
        continue
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      all({ column: 'customer', message: error.message })
      continue
    }
    passed.push({ order, body })
  }
  PASSED.set(client, passed)
  return answers
}

export const orderImportAdapter: ImportAdapter = Object.freeze({
  importer: orderImporter,
  permission: ORDERS_MANAGE,
  viewPermission: ORDERS_VIEW,

  authorize(_actor, job) {
    const issues: Issue[] = []
    if (job.companyId === null) issues.push({ path: 'companyId', message: 'Orders are imported for one company: start the import for that company.' })
    return issues
  },

  load: async () => [],

  async check(client, rows, scope, actor) {
    if (scope.companyId === null) return rows.map(() => [{ message: 'Orders are imported for one company: start the import for that company.' }])
    return checkOrders(client, rows, scope.companyId, actor)
  },

  async write(tools: CommandTools, row) {
    if (row.action !== 'CREATE') throw new Error('The order import only makes new orders.')
    let made = MADE.get(tools.tx)
    if (!made) {
      const passed = PASSED.get(tools.tx)
      if (!passed || passed.length === 0) throw new Error('The order sheet was not checked in this batch: apply it again.')
      const job = tools.record?.id ? await tools.tx.importJob.findUnique({ where: { id: tools.record.id }, select: { applyRequestedById: true, createdById: true } }) : null
      const requesterId = job?.applyRequestedById ?? job?.createdById ?? null
      made = new Map<string, string>()
      for (const entry of passed) {
        const outcome = await makeManualOrderInCommand(tools, entry.body, null, 'ORDER', { requesterId })
        const lines = await tools.tx.salesOrderLine.findMany({ where: { orderId: outcome.orderId }, select: { id: true, seq: true }, orderBy: { seq: 'asc' } })
        entry.order.lines.forEach((line, index) => {
          const written = lines.find((candidate) => candidate.seq === (index + 1) * 10)
          if (written) made!.set(lineKey(entry.order.reference, line.style, line.colour), written.id)
        })
        tools.audit({ action: 'orders.imported', recordType: 'SalesOrder', recordId: outcome.orderId, companyId: entry.body.companyId, after: { importJobId: tools.record?.id ?? null, reference: entry.order.reference, number: outcome.number, rows: entry.order.rowNumbers.length } })
      }
      MADE.set(tools.tx, made)
    }
    const lineId = made.get(lineKey(String(row.key.order), String(row.key.style), String(row.key.colour)))
    if (!lineId) throw new Error(`Row of order ${String(row.key.order)} was not in an order the check passed: apply it again.`)
    return { recordId: lineId }
  },
} satisfies ImportAdapter)
