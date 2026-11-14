import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage, DocumentParty, DocumentReference, PostalAddress } from '@nexus/factory-domain/documents/model'
import { priceBasisOf } from '@nexus/factory-domain/sales/quotes/quotes'
import { incotermWords } from '@nexus/factory-domain/sales/quote-terms/rules'
import { customsDescription, prepaymentLineText, purposeOf, treatmentOfStored, type ProformaLineInput, type ProformaRecordType, type ProformaSource } from '@nexus/factory-domain/shipping/proforma/rules'
import { Dec, parseDecimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'

/**
 * What a proforma says, read from its record (B-W2b-391; LOG-058; factory-domain shipping/proforma/rules.ts): the record's
 * company, site and party (for the caller's can() check), and everything the document needs but its number and day. Every
 * read names its columns; one query at a time (a scoped client's transaction has one connection).
 */

export interface ProformaRecord {
  readonly recordType: ProformaRecordType
  readonly recordId: string
  /** The record's own number as people know it (SH-…, the sample round, the order of a deposit). */
  readonly label: string
  readonly companyId: string
  readonly siteId: string | null
  readonly partyId: string
}

export interface ProformaFacts extends ProformaRecord {
  /** Why it may have no proforma now (empty: it may), in words. */
  readonly problems: readonly string[]
  readonly source: Omit<ProformaSource, 'number' | 'date'>
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const languageOf = (value: unknown): DocumentLanguage => (value === 'en' ? 'en' : 'it')

function postalOf(value: unknown): (PostalAddress & { name?: string | null }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const line1 = str(row.line1)
  const postalCode = str(row.postalCode)
  const city = str(row.city)
  const country = str(row.country)
  if (!line1 || !postalCode || !city || !country) return null
  return { line1, line2: str(row.line2), postalCode, city, province: str(row.province), country, name: str(row.name) }
}

/** The buyer as an order or a quote version keeps it (billTo snapshot). */
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

/** What a person may add for samples: the value per piece for customs (a decimal) and its currency. */
export interface SampleValue {
  readonly unitValue?: string | undefined
  readonly currency?: string | undefined
}

/** The proforma facts of a record, or 404 when the caller's scope does not reach it. */
export async function proformaFactsOf(db: CommandTx, recordType: ProformaRecordType, recordId: string, asked: SampleValue = {}): Promise<ProformaFacts> {
  if (!isUuid(recordId)) throw new NotFoundError(`${recordType} not found.`)
  if (recordType === 'Shipment') return shipmentFacts(db, recordId)
  if (recordType === 'SampleShipment') return sampleFacts(db, recordId, asked)
  return depositFacts(db, recordId)
}

/** A shipment (customs): its goods priced as the order sells them, its parcels, weights and origin. */
async function shipmentFacts(db: CommandTx, shipmentId: string): Promise<ProformaFacts> {
  const shipment = await db.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, companyId: true, siteId: true, partyId: true, salesOrderId: true, number: true, status: true, shipTo: true } })
  if (!shipment) throw new NotFoundError('Shipment not found.')
  const order = await db.salesOrder.findUnique({
    where: { id: shipment.salesOrderId },
    select: { number: true, orderDate: true, customerRef: true, billTo: true, language: true, currency: true, taxMode: true, paymentTerms: true, incoterm: true, incotermPlace: true },
  })
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true } })
  const lines = await db.shipmentLine.findMany({
    where: { shipmentId },
    select: { salesOrderLineId: true, size: true, quantity: true, workOrderSize: { select: { colourway: { select: { code: true, name: true } }, workOrder: { select: { style: { select: { code: true, name: true, hsCode: true, originCountry: true, netMassKg: true } } } } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const orderLineIds = [...new Set(lines.map((line) => line.salesOrderLineId))]
  const orderLines = new Map(
    (orderLineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, seq: true, unitPrice: true, vatRatePct: true, vatNature: true, sizes: { select: { size: true, unitPrice: true } } } })).map((row) => [row.id, row]),
  )
  const parcels = await db.parcel.findMany({ where: { shipmentId }, select: { grossWeightKg: true } })
  const live = await db.ddt.findFirst({ where: { shipmentId, cancellations: { none: {} } }, select: { number: true } })
  const language = languageOf(order?.language)
  const problems: string[] = []
  if (shipment.status === 'CANCELLED') problems.push(`${shipment.number} is cancelled: it has no proforma.`)

  // One proforma line per order line and price (a size of its own price is a line of its own), sizes in the description.
  const groups = new Map<string, { orderLineSeq: number; code: string; goods: string; sizes: Map<string, number>; quantity: number; unitPrice: string; treatment: ProformaLineInput['treatment'] | null; customs: { hsCode: string | null; originCountry: string | null } }>()
  let netMass = new Dec(0)
  let massKnown = lines.length > 0
  const origins = new Set<string>()
  for (const line of lines) {
    const orderLine = orderLines.get(line.salesOrderLineId)
    const style = line.workOrderSize.workOrder.style
    const colour = line.workOrderSize.colourway
    if (style.netMassKg === null) massKnown = false
    else netMass = netMass.plus(new Dec(style.netMassKg.toString()).times(line.quantity))
    if (style.originCountry) origins.add(style.originCountry.toUpperCase())
    if (!orderLine) {
      problems.push(`${style.code} ${colour.code} ${line.size}: no order line prices it.`)
      continue
    }
    const unitPrice = (orderLine.sizes.find((size) => size.size === line.size)?.unitPrice ?? orderLine.unitPrice).toString()
    const key = `${orderLine.id}|${unitPrice}`
    const group = groups.get(key) ?? {
      orderLineSeq: orderLine.seq,
      code: `${style.code} ${colour.code}`,
      goods: `${style.name}, ${colour.name}`,
      sizes: new Map<string, number>(),
      quantity: 0,
      unitPrice,
      treatment: treatmentOfStored(orderLine.vatRatePct.toFixed(2), orderLine.vatNature),
      customs: { hsCode: style.hsCode, originCountry: style.originCountry },
    }
    group.sizes.set(line.size, (group.sizes.get(line.size) ?? 0) + line.quantity)
    group.quantity += line.quantity
    groups.set(key, group)
  }
  const proformaLines: ProformaLineInput[] = []
  for (const group of [...groups.values()].sort((a, b) => a.orderLineSeq - b.orderLineSeq)) {
    if (!group.treatment) {
      problems.push(`${group.code}: its order line has a VAT the proforma cannot print.`)
      continue
    }
    const sizes = [...group.sizes].map(([size, quantity]) => `${size}×${quantity}`).join(', ')
    proformaLines.push({ code: group.code, description: customsDescription(`${group.goods}, ${sizes}`, group.customs, language), quantity: group.quantity, uom: 'PCS', unitPrice: group.unitPrice, treatment: group.treatment })
  }
  const weighed = parcels.length > 0 && parcels.every((parcel) => parcel.grossWeightKg !== null)
  const gross = weighed ? parcels.reduce((sum, parcel) => sum.plus(new Dec(parcel.grossWeightKg!.toString())), new Dec(0)) : null
  const shipTo = postalOf(shipment.shipTo)
  const references: DocumentReference[] = [
    ...(order ? [{ kind: 'SALES_ORDER' as const, number: order.number, date: dayOf(order.orderDate) }] : []),
    ...(order?.customerRef ? [{ kind: 'CUSTOMER_ORDER' as const, number: order.customerRef }] : []),
    { kind: 'SHIPMENT', number: shipment.number },
    ...(live ? [{ kind: 'DDT' as const, number: live.number }] : []),
  ]
  return {
    recordType: 'Shipment',
    recordId: shipment.id,
    label: shipment.number,
    companyId: shipment.companyId,
    siteId: shipment.siteId,
    partyId: shipment.partyId,
    problems,
    source: {
      purpose: purposeOf('Shipment'),
      language,
      currency: order?.currency ?? 'EUR',
      party: partyOfSnapshot(order?.billTo, party?.legalName ?? ''),
      deliverTo: shipTo,
      references,
      lines: proformaLines,
      basis: order ? priceBasisOf(order.taxMode) : 'NET',
      paymentTerms: order?.paymentTerms ?? null,
      deliveryTerms: order ? incotermWords(order.incoterm, order.incotermPlace, language) : null,
      facts: {
        packages: parcels.length > 0 ? parcels.length : null,
        grossWeightKg: gross && gross.greaterThan(0) ? gross.toFixed(4) : null,
        netWeightKg: massKnown && netMass.greaterThan(0) ? netMass.toFixed(4) : null,
        origin: [...origins].sort(),
      },
    },
  }
}

/** A sample shipment (samples): its round's cells, valued by the person (or by the round's charge), for customs. */
async function sampleFacts(db: CommandTx, sampleShipmentId: string, asked: SampleValue): Promise<ProformaFacts> {
  const shipment = await db.sampleShipment.findUnique({ where: { id: sampleShipmentId }, select: { id: true, roundId: true, partyId: true, direction: true, shipToAddressId: true, sentAt: true, carrierName: true } })
  if (!shipment) throw new NotFoundError('Sample shipment not found.')
  const round = await db.sampleRound.findUnique({ where: { id: shipment.roundId }, select: { companyId: true, number: true, styleId: true, cells: true, chargeAmountMinor: true, chargeCurrency: true } })
  if (!round) throw new NotFoundError('Sample shipment not found.')
  const style = await db.style.findUnique({ where: { id: round.styleId }, select: { code: true, name: true, hsCode: true, originCountry: true, netMassKg: true } })
  const company = await db.company.findUnique({ where: { id: round.companyId }, select: { currency: true } })
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true, language: true } })
  const addressId = shipment.shipToAddressId
  const address = addressId
    ? await db.partyAddress.findUnique({ where: { id: addressId }, select: { name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true } })
    : await db.partyAddress.findFirst({ where: { partyId: shipment.partyId }, select: { name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true }, orderBy: [{ isDefaultShipTo: 'desc' }, { isDefaultBillTo: 'desc' }, { id: 'asc' }] })
  const cells = Array.isArray(round.cells) ? (round.cells as { colourwayId?: unknown; size?: unknown; quantity?: unknown }[]) : []
  const colourIds = [...new Set(cells.flatMap((cell) => (typeof cell.colourwayId === 'string' ? [cell.colourwayId] : [])))]
  const colours = new Map((colourIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const language = languageOf(party?.language)
  const problems: string[] = []
  if (shipment.direction !== 'OUTBOUND') problems.push('This sample shipment comes back to us: a proforma goes with samples we send.')
  const pieces = cells.reduce((sum, cell) => sum + (typeof cell.quantity === 'number' ? cell.quantity : 0), 0)
  const charged = round.chargeAmountMinor !== null && round.chargeCurrency !== null && round.chargeAmountMinor > 0
  const currency = asked.currency ?? (charged ? round.chargeCurrency! : (company?.currency ?? 'EUR'))
  // The value per piece: the person's, else the round's charge spread over its pieces.
  const value = asked.unitValue !== undefined ? parseDecimal(asked.unitValue) : charged && pieces > 0 ? fromMinorUnits(round.chargeAmountMinor!, round.chargeCurrency!).dividedBy(pieces).toDecimalPlaces(6) : null
  if (value === null || value.isNegative()) problems.push(charged ? 'Give a value per piece for customs.' : "Give a value per piece for customs: the round is not charged, so the samples have no price of their own.")
  if (charged && asked.currency !== undefined && asked.currency !== round.chargeCurrency) problems.push(`The round is charged in ${round.chargeCurrency}: value the samples in it.`)
  const lines: ProformaLineInput[] = cells.map((cell) => {
    const colour = typeof cell.colourwayId === 'string' ? colours.get(cell.colourwayId) : undefined
    const goods = [style?.name ?? '', colour?.name, typeof cell.size === 'string' ? cell.size : null].filter(Boolean).join(', ')
    return {
      code: [style?.code, colour?.code].filter(Boolean).join(' ') || null,
      description: customsDescription(goods, { hsCode: style?.hsCode ?? null, originCountry: style?.originCountry ?? null }, language),
      quantity: typeof cell.quantity === 'number' ? cell.quantity : 0,
      uom: 'PCS',
      unitPrice: (value ?? new Dec(0)).toFixed(),
      treatment: null,
    }
  })
  const mass = style?.netMassKg ? new Dec(style.netMassKg.toString()).times(pieces) : null
  return {
    recordType: 'SampleShipment',
    recordId: shipment.id,
    label: round.number,
    companyId: round.companyId,
    siteId: null,
    partyId: shipment.partyId,
    problems,
    source: {
      purpose: purposeOf('SampleShipment'),
      language,
      currency,
      party: { name: party?.legalName ?? '', address: address ? { line1: address.line1, line2: address.line2, postalCode: address.postalCode, city: address.city, province: address.province, country: address.country } : null },
      deliverTo: address?.name ? { line1: address.line1, line2: address.line2, postalCode: address.postalCode, city: address.city, province: address.province, country: address.country, name: address.name } : null,
      references: [{ kind: 'SAMPLE_ROUND', number: round.number }],
      lines,
      basis: 'NET',
      facts: {
        noCommercialValue: !charged,
        netWeightKg: mass && mass.greaterThan(0) ? mass.toFixed(4) : null,
        origin: style?.originCountry ? [style.originCountry.toUpperCase()] : [],
      },
    },
  }
}

/** A deposit request (prepayment): the amount asked, VAT included, at its order's (or quote's) rate, due on its day. */
async function depositFacts(db: CommandTx, depositRequestId: string): Promise<ProformaFacts> {
  const request = await db.depositRequest.findUnique({ where: { id: depositRequestId }, select: { id: true, companyId: true, partyId: true, quoteVersionId: true, orderId: true, kind: true, currency: true, amount: true, dueDate: true, status: true } })
  if (!request) throw new NotFoundError('Deposit request not found.')
  const order = request.orderId ? await db.salesOrder.findUnique({ where: { id: request.orderId }, select: { number: true, orderDate: true, billTo: true, language: true, paymentTerms: true } }) : null
  const version = request.quoteVersionId ? await db.quoteVersion.findUnique({ where: { id: request.quoteVersionId }, select: { revision: true, billTo: true, language: true, quote: { select: { number: true } } } }) : null
  const vatLine = request.orderId
    ? await db.salesOrderLine.findFirst({ where: { orderId: request.orderId }, select: { vatRatePct: true, vatNature: true }, orderBy: { seq: 'asc' } })
    : request.quoteVersionId
      ? await db.quoteLine.findFirst({ where: { versionId: request.quoteVersionId }, select: { vatRatePct: true, vatNature: true }, orderBy: { seq: 'asc' } })
      : null
  const party = await db.party.findUnique({ where: { id: request.partyId }, select: { legalName: true } })
  const language = languageOf(order?.language ?? version?.language)
  const problems: string[] = []
  if (request.status !== 'OPEN') problems.push(request.status === 'PAID' ? 'This deposit is paid: its invoice is the document now.' : `This deposit request is ${request.status.toLowerCase()}: it asks for no payment.`)
  const treatment = vatLine ? treatmentOfStored(vatLine.vatRatePct.toFixed(2), vatLine.vatNature) : null
  if (!treatment) problems.push('The order has no VAT the proforma can print the payment with.')
  const quoteNumber = version ? `${version.quote.number}/${version.revision}` : null
  return {
    recordType: 'DepositRequest',
    recordId: request.id,
    label: order?.number ?? quoteNumber ?? '',
    companyId: request.companyId,
    siteId: null,
    partyId: request.partyId,
    problems,
    source: {
      purpose: purposeOf('DepositRequest'),
      language,
      currency: request.currency,
      party: partyOfSnapshot(order?.billTo ?? version?.billTo, party?.legalName ?? ''),
      references: [...(order ? [{ kind: 'SALES_ORDER' as const, number: order.number, date: dayOf(order.orderDate) }] : []), ...(quoteNumber ? [{ kind: 'QUOTE' as const, number: quoteNumber }] : [])],
      lines: treatment
        ? [{ code: null, description: prepaymentLineText(request.kind, { order: order?.number ?? null, quote: quoteNumber }, language), quantity: 1, uom: 'PCS', unitPrice: fromMinorUnits(request.amount, request.currency).toFixed(), treatment }]
        : [],
      basis: 'GROSS',
      paymentTerms: order?.paymentTerms ?? null,
      facts: { dueDate: dayOf(request.dueDate) },
    },
  }
}
