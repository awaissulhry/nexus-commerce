import type { Issue } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { RowIssue, RowValues } from '@nexus/factory-domain/imports/importer'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { INVENTORY_RECEIVE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import {
  hideListBody,
  hideListImporter,
  hideListTotals,
  lineOfRow,
  listProblems,
  lotKeyOf,
  receivedHideValues,
  type HideListOrderLine,
} from '@nexus/factory-domain/inventory/receipts/hide-list'
import { expectedBaseOf, hideAreaUnit, isAreaUnit, receivingProblem } from '@nexus/factory-domain/inventory/receipts/rules'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { CheckRow, ImportAdapter } from '../../../platform/imports/registry'
import { recordReceiptInCommand } from './record'
import { readItems, readOrderLines, type ItemRow, type OrderLineRow, type Reader } from './store'

/**
 * The tannery's hide list import's adapter (factory-domain inventory/receipts/hide-list; platform/imports; B-W2a-31,
 * SCM-248): one sheet, one purchase order, one goods receipt.
 *
 *   authorize  a company's import only (a receipt is a company's).
 *   load       the hides of the order its rows name already received (a POSTED receipt of the order, the tannery's
 *              number): the plan answers UNCHANGED for the same area, an error for another, never a second receipt.
 *   check      every row against the order (in the job's company, receiving now, at a site the person receives at with
 *              inventory.receive), its order line (a leather line: by seq, article or the only one), its area unit, the
 *              list's own rules (one order, one delivery note, one place, each tannery number once), and the totals per
 *              order line: beyond the line's tolerance over, the rows give the reason. A hide received before is left to
 *              the plan (load above) and never part of the new receipt. The dry
 *              run runs it for the person who started the job, each apply batch again for the person who applies (a row
 *              it refuses then is SKIPPED, never written).
 *   write      the apply is ONE batch (the importer's batchSize = its maxRows): the batch's check (above, inside the
 *              batch's command, with every row of the batch) keeps the rows it passed with their order line here, and
 *              the first row's write records them ALL as one goods receipt with the receipts' own work
 *              (record.ts recordReceiptInCommand: the order's locks, GR and LOT numbers, HIDE tags, lots by dye batch,
 *              hides one by one, RECEIPT moves valued at the order's price, the order moved on, its audit and
 *              `inventory.receipt_posted`); every row answers its own hide. The receipt is the system's (the worker
 *              applies), its audit names the import.
 *
 * Running and applying it needs inventory.receive (with imports.run / imports.apply); seeing its plans
 * inventory.stock.view. The registry lists this adapter, so it imports only the registry's types (no load-order cycle).
 */

export const text = (value: CellValue | undefined): string | null => (value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim())

/** The order a list names (by number, in the company) with its leather lines' facts, read only. */
export async function orderOf(client: Reader, companyId: string, number: string) {
  const order = await client.purchaseOrder.findFirst({ where: { companyId, number: { equals: number, mode: 'insensitive' } }, select: { id: true, number: true, companyId: true, siteId: true, status: true, partyId: true } })
  if (!order) return null
  const { lines, received } = await readOrderLines(client, order.id)
  const items = await readItems(client, lines.map((line) => line.itemId))
  const extra = new Map((await client.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id }, select: { id: true, supplierArticleCode: true, cancelledAt: true, closedShortAt: true } })).map((row) => [row.id, row]))
  const codes = new Map([...extra.values()].map((row) => [row.id, row.supplierArticleCode]))
  // A cancelled or closed-short line receives nothing more (the …_supply_w2a_guards trigger refuses it too).
  const view: HideListOrderLine[] = lines
    .filter((line) => !extra.get(line.id)?.cancelledAt && !extra.get(line.id)?.closedShortAt)
    .map((line) => {
      const item = items.get(line.itemId)!
      return {
        id: line.id,
        seq: line.seq,
        itemCode: item.code,
        supplierArticleCode: codes.get(line.id) ?? null,
        uom: line.uom,
        leather: item.tracking === 'HIDE',
        expected: quantityText(expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null })),
        received: quantityText(received.get(line.id) ?? ZERO),
        tolerancePct: line.areaTolerancePct === null ? null : line.areaTolerancePct.toString(),
        baseUom: item.baseUom,
      }
    })
  return { order, lines: view, orderLines: new Map(lines.map((line) => [line.id, line])), items }
}
export type OrderFacts = NonNullable<Awaited<ReturnType<typeof orderOf>>>

/** The hides of the order received before, by the tannery's number. */
async function receivedHides(client: Reader, orderId: string, tanneryNumbers: readonly string[]) {
  if (tanneryNumbers.length === 0) return new Map<string, { id: string; code: string; area: string; unit: string; receipt: string }>()
  const receiptLines = await client.goodsReceiptLine.findMany({ where: { receipt: { purchaseOrderId: orderId, status: 'POSTED' } }, select: { id: true, receiptId: true } })
  const receipts = new Map((await client.goodsReceipt.findMany({ where: { id: { in: [...new Set(receiptLines.map((line) => line.receiptId))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const lots = await client.lot.findMany({ where: { receiptLineId: { in: receiptLines.map((line) => line.id) } }, select: { id: true, receiptLineId: true } })
  const hides = await client.hide.findMany({ where: { lotId: { in: lots.map((lot) => lot.id) }, supplierCode: { in: [...tanneryNumbers] } }, select: { id: true, code: true, supplierCode: true, area: true, areaUom: true, lotId: true } })
  const found = new Map<string, { id: string; code: string; area: string; unit: string; receipt: string }>()
  for (const hide of hides) {
    const lot = lots.find((entry) => entry.id === hide.lotId)
    const line = receiptLines.find((entry) => entry.id === lot?.receiptLineId)
    found.set(hide.supplierCode!, { id: hide.id, code: hide.code, area: hide.area.toString(), unit: hide.areaUom, receipt: receipts.get(line?.receiptId ?? '') ?? '' })
  }
  return found
}

/** A row's hide in the base unit of its line's material, or why not. */
export function baseAreaOf(values: RowValues, line: OrderLineRow, item: ItemRow): { readonly base: Decimal; readonly problem?: undefined } | { readonly problem: RowIssue } {
  const uom = hideAreaUnit({ areaUom: (values.unit as 'M2' | 'DM2' | 'FT2' | undefined) ?? undefined }, line.uom, item.baseUom)
  if (!isAreaUnit(uom)) return { problem: { column: 'unit', message: 'Give the unit the hide is measured in: m², dm² or ft².' } }
  const units = { baseUom: item.baseUom, purchaseUom: item.purchaseUom, purchaseFactor: item.purchaseFactor.toString(), consumptionUom: item.consumptionUom, consumptionFactor: item.consumptionFactor.toString() }
  const result = baseQuantityOf({ quantity: String(values.area), uom }, units)
  if (result.problem) return { problem: { column: 'unit', message: result.problem.message } }
  return { base: new Dec(result.baseQuantity) }
}

/** What the batch's check passed, for the writes of the same transaction (the apply's ONE command). */
interface Passed {
  readonly purchaseOrderId: string
  readonly locationId: string | undefined
  readonly rows: { readonly line: HideListOrderLine; readonly values: RowValues }[]
}
const PASSED = new WeakMap<object, Passed>()
const RECORDED = new WeakMap<object, Map<string, string>>()

/** Every row judged with the list (see the module comment): one list of issues per row, in order. */
async function checkList(client: CommandTx, rows: readonly CheckRow[], companyId: string, actor: Actor): Promise<RowIssue[][]> {
  const answers = rows.map((): RowIssue[] => [])
  const all = (issue: RowIssue) => answers.forEach((list) => list.push(issue))
  const own = listProblems(rows.map((row) => ({ rowNumber: row.rowNumber, values: { ...row.key, ...row.values } })))
  own.forEach((issues, index) => answers[index]!.push(...issues))
  const number = String(rows[0]!.key.order ?? rows[0]!.values.order)
  const facts = await orderOf(client, companyId, number)
  if (!facts) {
    all({ column: 'order', message: `No purchase order ${number} in this company.` })
    return answers
  }
  // A hide received on the order before is the plan's (UNCHANGED with the same area, else an error; the apply skips a
  // row received since the dry run): never judged here, never part of the new receipt or its totals.
  const before = await receivedHides(client, facts.order.id, rows.map((row) => String(row.key.tanneryNumber ?? row.values.tanneryNumber)))
  const fresh = rows.map((row) => !before.has(String(row.key.tanneryNumber ?? row.values.tanneryNumber)))
  const allFresh = (issue: RowIssue) => answers.forEach((list, index) => (fresh[index] ? list.push(issue) : undefined))
  const problem = receivingProblem(facts.order.status as PurchaseOrderStatus)
  if (problem) allFresh({ column: 'order', message: `${facts.order.number}: ${problem}` })
  if (!can(actor, INVENTORY_RECEIVE, { companyId: facts.order.companyId, siteId: facts.order.siteId })) allFresh({ column: 'order', message: `Receiving goods at the site of ${facts.order.number} needs inventory.receive there.` })
  // An order that receives nothing now (or not by this person): its lines are not judged.
  if (problem || answers.some((list) => list.some((issue) => issue.column === 'order'))) return answers
  // The place: the one named (a location of the order's site, active), else the site's one goods-in dock.
  const named = rows.map((row) => text(row.values.location)).find((value) => value !== null) ?? null
  let locationId: string | undefined
  if (named !== null) {
    const location = await client.location.findFirst({ where: { siteId: facts.order.siteId, code: named }, select: { id: true, status: true } })
    if (!location || location.status !== 'ACTIVE') allFresh({ column: 'location', message: `${named} is not an active location of the order's delivery site.` })
    else locationId = location.id
  } else {
    const docks = await client.location.count({ where: { siteId: facts.order.siteId, kind: 'RECEIVING', status: 'ACTIVE' } })
    if (docks !== 1) allFresh({ column: 'location', message: docks === 0 ? 'The delivery site has no goods-in dock: name the location the hides go to.' : 'The delivery site has several goods-in docks: name the one the hides go to.' })
  }
  const judged: { index: number; line: HideListOrderLine; base: Decimal; values: RowValues }[] = []
  rows.forEach((row, index) => {
    if (!fresh[index]) return
    const values = { ...row.key, ...row.values }
    const found = lineOfRow(values, facts.lines)
    if (found.problem) {
      answers[index]!.push(found.problem)
      return
    }
    const area = baseAreaOf(values, facts.orderLines.get(found.line.id)!, facts.items.get(facts.orderLines.get(found.line.id)!.itemId)!)
    if (area.problem) {
      answers[index]!.push(area.problem)
      return
    }
    judged.push({ index, line: found.line, base: area.base, values })
  })
  // The totals per order line: beyond its tolerance over, its rows name the reason.
  for (const total of hideListTotals(judged.map((row) => ({ line: row.line, baseArea: row.base, lotKey: lotKeyOf(row.values), differenceReason: text(row.values.differenceReason) })))) {
    if (!total.needsReason) continue
    const words = `Order line ${total.line.seq} (${total.line.itemCode}): ${total.difference.after} ${total.line.baseUom} with the earlier receipts against ${total.difference.expected} expected (tolerance ${total.difference.tolerancePct}%: at most ${total.difference.upTo}). Give the reason in Difference reason, or leave the extra hides out.`
    for (const row of judged.filter((entry) => entry.line.id === total.line.id)) answers[row.index]!.push({ column: 'differenceReason', message: words })
  }
  PASSED.set(client, { purchaseOrderId: facts.order.id, locationId, rows: judged.filter((row) => answers[row.index]!.length === 0).map((row) => ({ line: row.line, values: row.values })) })
  return answers
}

export const hideListImportAdapter: ImportAdapter = Object.freeze({
  importer: hideListImporter,
  permission: INVENTORY_RECEIVE,
  viewPermission: INVENTORY_STOCK_VIEW,

  authorize(_actor, job) {
    const issues: Issue[] = []
    if (job.companyId === null) issues.push({ path: 'companyId', message: "A hide list is received by one company: start the import for the order's company." })
    return issues
  },

  async load(client, keys, scope) {
    if (scope.companyId === null || keys.length === 0) return []
    const answer = []
    for (const number of [...new Set(keys.map((key) => String(key.order)))]) {
      const order = await client.purchaseOrder.findFirst({ where: { companyId: scope.companyId, number: { equals: number, mode: 'insensitive' } }, select: { id: true } })
      if (!order) continue
      const found = await receivedHides(client, order.id, keys.filter((key) => String(key.order) === number).map((key) => String(key.tanneryNumber)))
      for (const [tanneryNumber, hide] of found) answer.push({ id: hide.id, values: receivedHideValues(number, tanneryNumber, { receiptNumber: hide.receipt, tag: hide.code, area: hide.area, unit: hide.unit as 'M2' }) })
    }
    return answer
  },

  async check(client, rows, scope, actor) {
    if (scope.companyId === null) return rows.map(() => [{ message: "A hide list is received by one company: start the import for the order's company." }])
    return checkList(client, rows, scope.companyId, actor)
  },

  async write(tools: CommandTools, row) {
    if (row.action !== 'CREATE') throw new Error('The hide list import only receives new hides.')
    const tanneryNumber = String(row.key.tanneryNumber)
    let recorded = RECORDED.get(tools.tx)
    if (!recorded) {
      const passed = PASSED.get(tools.tx)
      if (!passed || passed.rows.length === 0) throw new Error('The hide list was not checked in this batch: apply it again.')
      const body = hideListBody(passed.rows, { purchaseOrderId: passed.purchaseOrderId, locationId: passed.locationId })
      const key = `inventory.hideList:${tools.record?.id ?? 'import'}`
      const receipt = await recordReceiptInCommand(tools, body, key)
      tools.audit({ action: 'inventory.hideListReceived', recordType: 'GoodsReceipt', recordId: receipt.receiptId, companyId: receipt.order.companyId, siteId: receipt.order.siteId, after: { importJobId: tools.record?.id ?? null, number: receipt.number, hides: passed.rows.length } })
      const hides = await tools.tx.hide.findMany({ where: { lot: { receiptLine: { receiptId: receipt.receiptId } } }, select: { id: true, supplierCode: true } })
      recorded = new Map(hides.map((hide) => [hide.supplierCode!, hide.id]))
      RECORDED.set(tools.tx, recorded)
    }
    const hideId = recorded.get(tanneryNumber)
    if (!hideId) throw new Error(`Hide ${tanneryNumber} was not on the list the check passed: apply it again.`)
    return { recordId: hideId }
  },
} satisfies ImportAdapter)
