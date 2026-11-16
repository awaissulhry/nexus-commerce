import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage, DocumentParty, DocumentReference, PostalAddress } from '@nexus/factory-domain/documents/model'
import { incotermWords } from '@nexus/factory-domain/sales/quote-terms/rules'
import type { CustomsLineInput } from '@nexus/factory-domain/shipping/customs/commercial-invoice'
import { destinationClassOf, type DestinationClass } from '@nexus/factory-domain/shipping/customs/rules'
import { specialTerritoryOf, type SpecialTerritory } from '@nexus/factory-domain/tax/special-territories'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import type { ShipmentHeader } from '../store'

/**
 * What the customs papers of a shipment say, read from the shipment (B-W2b-409; LOG-086, LOG-087; factory-domain
 * shipping/customs): where it goes, the company's EORI, the order's language, currency, Incoterm and buyer, the goods
 * grouped as the commercial invoice prints them (one line per order line and price, sizes in the words) and per parcel as
 * the CN 22 / CN 23 declare them, the parcels' weights, the goods' net weight and origin, the live DDT and the issued
 * invoices of the export. Every read names its columns; one query at a time (a scoped client's transaction has one
 * connection). Values are the order's net prices (a size's own price first), never a cost.
 */

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

export function postalOf(value: unknown): (PostalAddress & { name?: string | null }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const line1 = str(row.line1)
  const postalCode = str(row.postalCode)
  const city = str(row.city)
  const country = str(row.country)
  if (!line1 || !postalCode || !city || !country) return null
  return { line1, line2: str(row.line2), postalCode, city, province: str(row.province), country: country.toUpperCase(), name: str(row.name) }
}

/** B-W2b-GF2: the postal code and town a shipment's ship-to names (each null when it is not there). */
export function shipToPlace(shipTo: unknown): { readonly postalCode: string | null; readonly city: string | null } {
  if (!shipTo || typeof shipTo !== 'object' || Array.isArray(shipTo)) return { postalCode: null, city: null }
  const row = shipTo as Record<string, unknown>
  return { postalCode: str(row.postalCode), city: str(row.city) }
}

/** The country a shipment's ship-to names (even when the rest of the address is not complete). */
export function countryOf(shipTo: unknown): string | null {
  if (!shipTo || typeof shipTo !== 'object' || Array.isArray(shipTo)) return null
  const country = str((shipTo as Record<string, unknown>).country)
  return country ? country.toUpperCase() : null
}

/** One item of a parcel for the CN forms: the goods, pieces, net weight (null: the style has none) and value. */
export interface ParcelItemFacts {
  readonly code: string
  readonly goods: string
  readonly quantity: number
  readonly netKg: Decimal | null
  readonly value: Decimal | null
  readonly hsCode: string | null
  readonly originCountry: string | null
}

export interface ParcelFacts {
  readonly id: string
  readonly seq: number
  readonly grossKg: Decimal | null
  readonly items: readonly ParcelItemFacts[]
}

export interface CustomsFacts {
  readonly country: string | null
  readonly destination: DestinationClass | null
  /** B-W2b-GF2: the EU special fiscal territory the ship-to is in (told apart by its postal code and town), or null. */
  readonly territory: SpecialTerritory | null
  readonly eori: string | null
  readonly language: DocumentLanguage
  readonly currency: string
  readonly party: DocumentParty
  readonly deliverTo: (PostalAddress & { name?: string | null }) | null
  readonly references: readonly DocumentReference[]
  readonly deliveryTerms: string | null
  readonly paymentTerms: string | null
  /** The commercial invoice's lines. */
  readonly lines: readonly CustomsLineInput[]
  /** Garments packed in no parcel (pieces). */
  readonly unpacked: number
  readonly parcels: readonly ParcelFacts[]
  readonly grossKg: Decimal | null
  readonly netKg: Decimal | null
  readonly origin: readonly string[]
  readonly liveDdt: { readonly id: string; readonly number: string } | null
}

/** A party's name and address as an order keeps its buyer (billTo snapshot). */
function partyOfSnapshot(billTo: unknown, fallbackName: string): DocumentParty {
  const snapshot = (billTo && typeof billTo === 'object' ? billTo : {}) as Record<string, unknown>
  const address = postalOf(snapshot.address)
  return {
    name: str(snapshot.legalName) ?? fallbackName,
    address: address ? { line1: address.line1, line2: address.line2 ?? null, postalCode: address.postalCode, city: address.city, province: address.province ?? null, country: address.country } : null,
    vatNumber: str(snapshot.vatNumber),
    fiscalCode: str(snapshot.fiscalCode),
  }
}

/** Every fact of the shipment's customs papers (read by the office caller, or a command's transaction). */
export async function customsFactsOf(db: CommandTx, shipment: ShipmentHeader): Promise<CustomsFacts> {
  const company = await db.company.findUnique({ where: { id: shipment.companyId }, select: { eori: true } })
  const order = await db.salesOrder.findUnique({
    where: { id: shipment.salesOrderId },
    select: { number: true, orderDate: true, customerRef: true, billTo: true, language: true, currency: true, paymentTerms: true, incoterm: true, incotermPlace: true },
  })
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true } })
  const lines = await db.shipmentLine.findMany({
    where: { shipmentId: shipment.id },
    select: { parcelId: true, salesOrderLineId: true, size: true, quantity: true, workOrderSize: { select: { colourway: { select: { code: true, name: true } }, workOrder: { select: { style: { select: { code: true, name: true, hsCode: true, originCountry: true, netMassKg: true } } } } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const orderLineIds = [...new Set(lines.map((line) => line.salesOrderLineId))]
  const orderLines = new Map(
    (orderLineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, seq: true, unitPrice: true, sizes: { select: { size: true, unitPrice: true } } } })).map((row) => [row.id, row]),
  )
  const parcelRows = await db.parcel.findMany({ where: { shipmentId: shipment.id }, select: { id: true, seq: true, grossWeightKg: true }, orderBy: { seq: 'asc' } })
  const live = await db.ddt.findFirst({ where: { shipmentId: shipment.id, cancellations: { none: {} } }, select: { id: true, number: true }, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }] })
  const language: DocumentLanguage = order?.language === 'en' ? 'en' : 'it'

  // The commercial invoice: one line per order line and price; the CN forms: per parcel, per order line and price.
  type Group = { seq: number; code: string; goods: string; sizes: Map<string, number>; quantity: number; unitPrice: string | null; hsCode: string | null; originCountry: string | null; netKg: Decimal | null }
  const groups = new Map<string, Group>()
  const perParcel = new Map<string, Map<string, Group>>()
  let netKg: Decimal | null = lines.length > 0 ? new Dec(0) : null
  let unpacked = 0
  const origins = new Set<string>()
  const add = (into: Map<string, Group>, key: string, base: Omit<Group, 'sizes' | 'quantity' | 'netKg'>, size: string, quantity: number, mass: Decimal | null) => {
    const group = into.get(key) ?? { ...base, sizes: new Map<string, number>(), quantity: 0, netKg: new Dec(0) }
    group.sizes.set(size, (group.sizes.get(size) ?? 0) + quantity)
    group.quantity += quantity
    group.netKg = group.netKg === null || mass === null ? null : group.netKg.plus(mass.times(quantity))
    into.set(key, group)
  }
  for (const line of lines) {
    const orderLine = orderLines.get(line.salesOrderLineId)
    const style = line.workOrderSize.workOrder.style
    const colour = line.workOrderSize.colourway
    const mass = style.netMassKg === null ? null : new Dec(style.netMassKg.toString())
    netKg = netKg === null || mass === null ? null : netKg.plus(mass.times(line.quantity))
    if (style.originCountry?.trim()) origins.add(style.originCountry.trim().toUpperCase())
    const unitPrice = orderLine ? (orderLine.sizes.find((size) => size.size === line.size)?.unitPrice ?? orderLine.unitPrice).toString() : null
    const key = `${line.salesOrderLineId}|${unitPrice ?? '-'}|${style.code}|${colour.code}`
    const base = { seq: orderLine?.seq ?? Number.MAX_SAFE_INTEGER, code: `${style.code} ${colour.code}`, goods: `${style.name}, ${colour.name}`, unitPrice, hsCode: style.hsCode, originCountry: style.originCountry ? style.originCountry.trim().toUpperCase() : null }
    add(groups, key, base, line.size, line.quantity, mass)
    if (line.parcelId === null) unpacked += line.quantity
    else {
      const inParcel = perParcel.get(line.parcelId) ?? new Map<string, Group>()
      add(inParcel, key, base, line.size, line.quantity, mass)
      perParcel.set(line.parcelId, inParcel)
    }
  }
  const words = (group: Group): string => `${group.goods}, ${[...group.sizes].map(([size, quantity]) => `${size}×${quantity}`).join(', ')}`
  const sorted = (from: Map<string, Group>): Group[] => [...from.values()].sort((a, b) => a.seq - b.seq || a.code.localeCompare(b.code))
  const customsLines: CustomsLineInput[] = sorted(groups).map((group) => ({ code: group.code, goods: words(group), hsCode: group.hsCode, originCountry: group.originCountry, quantity: group.quantity, uom: 'PCS', unitPrice: group.unitPrice }))
  const parcels: ParcelFacts[] = parcelRows.map((parcel) => ({
    id: parcel.id,
    seq: parcel.seq,
    grossKg: parcel.grossWeightKg === null ? null : new Dec(parcel.grossWeightKg.toString()),
    items: sorted(perParcel.get(parcel.id) ?? new Map()).map((group) => ({
      code: group.code,
      goods: words(group),
      quantity: group.quantity,
      netKg: group.netKg,
      value: group.unitPrice === null ? null : new Dec(group.unitPrice).times(group.quantity),
      hsCode: group.hsCode,
      originCountry: group.originCountry,
    })),
  }))
  const weighed = parcels.length > 0 && parcels.every((parcel) => parcel.grossKg !== null)
  const references: DocumentReference[] = [
    ...(order ? [{ kind: 'SALES_ORDER' as const, number: order.number, date: dayOf(order.orderDate) }] : []),
    ...(order?.customerRef ? [{ kind: 'CUSTOMER_ORDER' as const, number: order.customerRef }] : []),
    { kind: 'SHIPMENT', number: shipment.number },
    ...(live ? [{ kind: 'DDT' as const, number: live.number }] : []),
  ]
  const country = countryOf(shipment.shipTo)
  // B-W2b-GF2: the postal code and town tell a special fiscal territory apart (Livigno, the Canary Islands …).
  const where = shipToPlace(shipment.shipTo)
  return {
    country,
    destination: destinationClassOf(country, undefined, where),
    territory: country ? specialTerritoryOf({ country, ...where }) : null,
    eori: company?.eori ?? null,
    language,
    currency: order?.currency ?? 'EUR',
    party: partyOfSnapshot(order?.billTo, party?.legalName ?? ''),
    deliverTo: postalOf(shipment.shipTo),
    references,
    deliveryTerms: order ? incotermWords(order.incoterm, order.incotermPlace, language) : null,
    paymentTerms: order?.paymentTerms ?? null,
    lines: customsLines,
    unpacked,
    parcels,
    grossKg: weighed ? parcels.reduce((sum, parcel) => sum.plus(parcel.grossKg!), new Dec(0)) : null,
    netKg: netKg !== null && netKg.greaterThan(0) ? netKg : null,
    origin: [...origins].sort(),
    liveDdt: live ? { id: live.id, number: live.number } : null,
  }
}

/** The issued invoices (not drafts, not credit notes) of the shipment's company to its customer: those that invoice its DDT first. */
export async function exportInvoicesOf(db: CommandTx, shipment: ShipmentHeader, liveDdtId: string | null) {
  const select = { id: true, number: true, docType: true, status: true, issueDate: true } as const
  const ofDdt = liveDdtId
    ? await db.invoice.findMany({ where: { companyId: shipment.companyId, buyerPartyId: shipment.partyId, status: { not: 'DRAFT' }, docType: { in: ['TD01', 'TD24'] }, lines: { some: { ddtId: liveDdtId } } }, select, orderBy: [{ issueDate: 'desc' }, { id: 'desc' }], take: 10 })
    : []
  const recent = await db.invoice.findMany({ where: { companyId: shipment.companyId, buyerPartyId: shipment.partyId, status: { not: 'DRAFT' }, docType: { in: ['TD01', 'TD24'] }, id: { notIn: ofDdt.map((row) => row.id) } }, select, orderBy: [{ issueDate: 'desc' }, { id: 'desc' }], take: 10 })
  return [...ofDdt.map((row) => ({ ...row, ofShipment: true })), ...recent.map((row) => ({ ...row, ofShipment: false }))].map((row) => ({
    id: row.id,
    number: row.number ?? '',
    docType: row.docType as string,
    status: row.status as string,
    date: row.issueDate ? dayOf(row.issueDate) : null,
    ofShipment: row.ofShipment,
  }))
}
