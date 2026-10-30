import type { FactoryClient } from '@nexus/factory-db'
import type { TraceStartKind } from '@nexus/factory-domain/inventory/trace/rules'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import type { CommandCaller } from '../../../core/command'
import { mayAt, officeContextOf } from '../ledger/access'
import type { TRACE_MATCHES } from './contract'

/**
 * The Trace dialog's one field (design warehouse.lots lt-trace: "scan or type any code; the kind is recognised and the
 * trace opens on that node"): every record of the tenant the code names exactly (letter case aside) that the caller may
 * trace (inventory.stock.view on its company and site): a lot by our code, the supplier's lot or the dye batch; a hide
 * by its tag or the tannery's number; a bundle by its ticket, also an old one (a reprint keeps the replaced codes); a
 * garment serial; a work order by its batch number or number; a shipment by its number or a DDT that carries it. A
 * label code is read as the scanner reads it (scan-id: hyphens and case aside): another factory's label, a typo or a
 * label the trace does not take (a location, a carton) is said in words when nothing matches. Read only.
 */

type Match = (typeof TRACE_MATCHES)[number]
interface Found {
  readonly kind: TraceStartKind
  readonly id: string
  readonly code: string
  readonly matchedBy: Match
  readonly label: string
  readonly companyId: string
  readonly siteId: string
}

const MAX_MATCHES = 20

async function lookUp(client: FactoryClient, code: string): Promise<Found[]> {
  const is = { equals: code, mode: 'insensitive' as const }
  const found: Found[] = []
  const lotSelect = { id: true, code: true, companyId: true, siteId: true, supplierLotRef: true, dyeBatch: true, item: { select: { name: true } }, itemColour: { select: { code: true } } } as const
  const lots = await client.lot.findMany({ where: { OR: [{ code: is }, { supplierLotRef: is }, { dyeBatch: is }] }, select: lotSelect, orderBy: { id: 'desc' }, take: MAX_MATCHES })
  for (const lot of lots) {
    const matchedBy: Match = lot.code.toUpperCase() === code.toUpperCase() ? 'LOT_CODE' : lot.supplierLotRef?.toUpperCase() === code.toUpperCase() ? 'SUPPLIER_LOT' : 'DYE_BATCH'
    found.push({ kind: 'LOT', id: lot.id, code: lot.code, matchedBy, label: [lot.item.name, lot.itemColour?.code].filter(Boolean).join(' · '), companyId: lot.companyId, siteId: lot.siteId })
  }
  const hides = await client.hide.findMany({ where: { OR: [{ code: is }, { supplierCode: is }] }, select: { id: true, code: true, siteId: true, lot: { select: { code: true, companyId: true } } }, take: MAX_MATCHES })
  for (const hide of hides) {
    found.push({ kind: 'HIDE', id: hide.id, code: hide.code, matchedBy: hide.code.toUpperCase() === code.toUpperCase() ? 'HIDE_TAG' : 'TANNERY_NUMBER', label: `Hide of lot ${hide.lot.code}`, companyId: hide.lot.companyId, siteId: hide.siteId })
  }
  const bundleSelect = { id: true, code: true, siteId: true, quantity: true, workOrder: { select: { number: true, companyId: true } } } as const
  for (const bundle of await client.bundle.findMany({ where: { code: is }, select: bundleSelect, take: MAX_MATCHES })) {
    found.push({ kind: 'BUNDLE', id: bundle.id, code: bundle.code, matchedBy: 'BUNDLE_TICKET', label: `${bundle.workOrder.number} · ${bundle.quantity} garments`, companyId: bundle.workOrder.companyId, siteId: bundle.siteId })
  }
  for (const bundle of await client.bundle.findMany({ where: { replacedCodes: { has: code.toUpperCase() } }, select: bundleSelect, take: MAX_MATCHES })) {
    found.push({ kind: 'BUNDLE', id: bundle.id, code: bundle.code, matchedBy: 'OLD_BUNDLE_TICKET', label: `${bundle.workOrder.number} · old ticket, now ${bundle.code}`, companyId: bundle.workOrder.companyId, siteId: bundle.siteId })
  }
  for (const serial of await client.garmentSerial.findMany({ where: { serial: is }, select: { id: true, serial: true, siteId: true, status: true, workOrderSize: { select: { workOrder: { select: { number: true, companyId: true } } } } }, take: MAX_MATCHES })) {
    found.push({ kind: 'SERIAL', id: serial.id, code: serial.serial, matchedBy: 'SERIAL', label: `${serial.workOrderSize.workOrder.number} · ${serial.status}`, companyId: serial.workOrderSize.workOrder.companyId, siteId: serial.siteId })
  }
  const orders = await client.workOrder.findMany({ where: { OR: [{ batchNumber: is }, { number: is }] }, select: { id: true, number: true, batchNumber: true, companyId: true, siteId: true, style: { select: { code: true } } }, take: MAX_MATCHES })
  for (const order of orders) {
    const byBatch = order.batchNumber?.toUpperCase() === code.toUpperCase()
    found.push({ kind: 'WORK_ORDER', id: order.id, code: order.number, matchedBy: byBatch ? 'BATCH_NUMBER' : 'WORK_ORDER_NUMBER', label: [order.style.code, order.batchNumber ? `batch ${order.batchNumber}` : null].filter(Boolean).join(' · '), companyId: order.companyId, siteId: order.siteId })
  }
  for (const shipment of await client.shipment.findMany({ where: { number: is }, select: { id: true, number: true, status: true, companyId: true, siteId: true }, take: MAX_MATCHES })) {
    found.push({ kind: 'SHIPMENT', id: shipment.id, code: shipment.number, matchedBy: 'SHIPMENT_NUMBER', label: shipment.status, companyId: shipment.companyId, siteId: shipment.siteId })
  }
  const ddtSelect = { number: true, cancellations: { select: { id: true }, take: 1 }, shipment: { select: { id: true, number: true, status: true, companyId: true, siteId: true } } } as const
  for (const ddt of await client.ddt.findMany({ where: { number: is, shipmentId: { not: null } }, select: ddtSelect, orderBy: { issuedAt: 'desc' }, take: MAX_MATCHES })) {
    if (!ddt.shipment) continue
    // A cancelled DDT still names the goods it was printed for (a paper copy may be all a customer has).
    const cancelled = ddt.cancellations.length > 0 ? ' (cancelled)' : ''
    found.push({ kind: 'SHIPMENT', id: ddt.shipment.id, code: ddt.shipment.number, matchedBy: 'DDT_NUMBER', label: `DDT ${ddt.number}${cancelled} · ${ddt.shipment.status}`, companyId: ddt.shipment.companyId, siteId: ddt.shipment.siteId })
  }
  return found
}

export async function findTraceStart(caller: CommandCaller, typed: string) {
  const context = officeContextOf(caller)
  const code = typed.trim()
  const scan = parseScanId(code, { tenantTag: tenantTag(context.tenantId) })
  // A label code is looked up as printed; anything else as typed.
  const wanted = scan.ok ? scan.text : code
  let problem: string | null = null
  if (scan.ok && (scan.type === 'LOCATION' || scan.type === 'CARTON')) problem = `This is a ${scan.type.toLowerCase()} label: the trace takes a lot, a hide, a bundle, a batch, a garment serial or a shipment.`
  else if (!scan.ok && (scan.problem === 'tenant' || scan.problem === 'check')) problem = scan.message
  return caller.withClient(async (client) => {
    const seen = new Set<string>()
    const matches = (await lookUp(client, wanted))
      .filter((row) => mayAt(context, INVENTORY_STOCK_VIEW, row))
      .filter((row) => {
        const key = `${row.kind}:${row.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, MAX_MATCHES)
      .map(({ companyId: _company, siteId: _site, ...row }) => row)
    return { code: wanted, matches, problem: matches.length > 0 ? null : (problem ?? null) }
  })
}
