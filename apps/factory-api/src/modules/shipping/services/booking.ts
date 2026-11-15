import type { Prisma } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { holds } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { convertMinor } from '@nexus/factory-domain/money/currency/convert'
import type { CarrierLabelRequest } from '@nexus/factory-domain/ports/carrier'
import { contractFor } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import { bookingCheck, bookingExtrasOf, servicesChangeRefusal, type BookingCheck, type BookingFacts } from '@nexus/factory-domain/shipping/services/booking'
import { carrierOfferOf, destinationOf, DESTINATION_WORDS, offerWords, type ServiceAccount } from '@nexus/factory-domain/shipping/services/catalogue'
import { goodsValues, insuranceRuleOf, type InsuranceRuleView } from '@nexus/factory-domain/shipping/services/insurance'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { dayRate } from '../../../platform/currency/service'
import { carrierAccountIdOf } from '../labels/store'
import type { ShipmentHeader } from '../store'

/**
 * A shipment's booking with its carrier (B-W2b-400; LOG-033, LOG-038, LOG-041, LOG-042; rules factory-domain
 * shipping/services/booking.ts): the facts read in one place for the booking read ("shown in the booking cost"), the services
 * and values routes, and the label buy (modules/shipping/labels/labels.ts calls `bookingForBuy` after W1's checks and the
 * carrier rules, before anything is bought or the TEST carrier makes a label; each parcel's request then carries the
 * booking's extras, and the buy's command records who was billed).
 *
 * Values are the price grain (the order's currency, minor units): a reader without money.price gets none (the contract's
 * marking drops them) and words without amounts.
 */

const PARCEL_SELECT = { id: true, seq: true, trackingNumber: true, carrierParcelId: true, declaredValue: true, insuredValue: true, version: true } as const satisfies Prisma.ParcelSelect

export interface BookingRead {
  readonly facts: BookingFacts
  readonly check: BookingCheck
  readonly companyCurrency: string
  readonly insureAbove: number | null
  /** A value of the order's currency in the company's at today's rate (null: no rate). */
  readonly inCompany: (value: number | null) => number | null
  readonly senderCountry: string | null
  readonly shipToCountry: string | null
  readonly goods: ReadonlyMap<string, number>
  readonly parcelVersions: ReadonlyMap<string, number>
  readonly customer: { readonly partyId: string; readonly defaultService: string | null } | null
  readonly accountMode: ServiceAccount['mode'] | null
  readonly contract: { readonly id: string; readonly siteId: string | null; readonly ownRatesOnly: boolean } | null
  readonly version: number
}

const countryOf = (value: unknown): string | null => {
  const country = (value as { country?: unknown } | null)?.country
  return typeof country === 'string' ? country.trim().toUpperCase() : null
}

/**
 * A declared value (the order's currency) in the company's currency at today's rate: the same value when they agree; null
 * without a value, or without a rate kept for today.
 */
async function converterOf(db: CommandTx, orderCurrency: string, companyCurrency: string): Promise<(value: number | null) => number | null> {
  if (orderCurrency === companyCurrency) return (value) => value
  const rate = await dayRate(db, companyCurrency, orderCurrency, businessDate(serverClock.now()))
  return (value) => (value === null || rate === null ? null : convertMinor(value, orderCurrency, companyCurrency, rate))
}

/** What the site's rule says of a declared value (`amounts` false: words without amounts). */
export const ruleFor = (read: Pick<BookingRead, 'inCompany' | 'insureAbove' | 'companyCurrency'> & { readonly facts: Pick<BookingFacts, 'currency'> }, declared: number | null, amounts = true): InsuranceRuleView =>
  insuranceRuleOf({ declared, declaredInCompany: read.inCompany(declared), insureAbove: read.insureAbove, companyCurrency: read.companyCurrency, orderCurrency: read.facts.currency }, amounts)

/** Everything the booking needs, read on the caller's client or the command's transaction. `amounts`: the reader holds the price grain. */
export async function readBooking(db: CommandTx, shipment: ShipmentHeader, options: { readonly amounts: boolean }): Promise<BookingRead> {
  // One query after another: a transaction's client has one connection.
  const own = await db.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { express: true, dutyPayer: true, paperless: true, integrationAccountId: true, salesOrder: { select: { currency: true } } } })
  const settings = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { senderAddress: true, testMode: true, integrationAccountId: true, insureAbove: true } })
  const company = await db.company.findUnique({ where: { id: shipment.companyId }, select: { currency: true } })
  const accountId = await carrierAccountIdOf(db, { ...shipment, integrationAccountId: own.integrationAccountId }, settings?.integrationAccountId ?? null)
  const account = accountId ? await db.integrationAccount.findUnique({ where: { id: accountId }, select: { provider: true, mode: true, settings: true } }) : null
  const contracts = shipment.carrierCode ? await db.carrierAccount.findMany({ where: { companyId: shipment.companyId, carrierCode: shipment.carrierCode, active: true }, select: { id: true, companyId: true, siteId: true, carrierCode: true, active: true, ownRatesOnly: true } }) : []
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true, tradeName: true, preferredCarrierCode: true, freightBilling: true, carrierAccountSecretId: true, defaultCarrierService: true } })
  const parcels = await db.parcel.findMany({ where: { shipmentId: shipment.id }, select: PARCEL_SELECT, orderBy: { seq: 'asc' } })
  const lines = await db.shipmentLine.findMany({ where: { shipmentId: shipment.id }, select: { id: true, parcelId: true, quantity: true, salesOrderLine: { select: { quantity: true, netAmount: true } } } })
  const contents = await db.parcelLine.findMany({ where: { shipmentId: shipment.id }, select: { shipmentLineId: true, parcelId: true, quantity: true } })

  const orderCurrency = own.salesOrder.currency
  const companyCurrency = company?.currency ?? orderCurrency
  const insureAbove = settings?.insureAbove ?? null
  const inCompany = await converterOf(db, orderCurrency, companyCurrency)
  const rule = (declared: number | null) => ruleFor({ inCompany, insureAbove, companyCurrency, facts: { currency: orderCurrency } }, declared, options.amounts)
  const contract = contractFor(contracts, { companyId: shipment.companyId, siteId: shipment.siteId, carrierCode: shipment.carrierCode })
  const senderCountry = countryOf(settings?.senderAddress)
  const shipToCountry = countryOf(shipment.shipTo)
  const facts: BookingFacts = {
    shipment: { number: shipment.number, status: shipment.status, transportBy: shipment.transportBy, carrierCode: shipment.carrierCode, serviceCode: shipment.serviceCode, express: own.express, dutyPayer: own.dutyPayer, paperless: own.paperless },
    destination: destinationOf(senderCountry, shipToCountry),
    testMode: settings?.testMode ?? true,
    account: account && account.provider === 'SENDCLOUD' ? { mode: account.mode, settings: account.settings } : null,
    contract: contract ? { id: contract.id, siteId: contract.siteId, ownRatesOnly: contract.ownRatesOnly } : null,
    customer: party
      ? { name: party.tradeName ?? party.legalName, carrierCode: party.preferredCarrierCode, freightBilling: party.freightBilling, accountOnFile: party.carrierAccountSecretId !== null, defaultService: party.defaultCarrierService }
      : null,
    currency: orderCurrency,
    parcels: parcels.map((parcel) => ({ id: parcel.id, seq: parcel.seq, labelled: parcel.trackingNumber !== null || parcel.carrierParcelId !== null, declaredValue: parcel.declaredValue, insuredValue: parcel.insuredValue, rule: rule(parcel.declaredValue) })),
  }
  const goods = goodsValues(
    parcels.map((parcel) => parcel.id),
    lines.map((line) => ({ id: line.id, parcelId: line.parcelId, quantity: line.quantity, orderLineQuantity: line.salesOrderLine.quantity, orderLineNet: line.salesOrderLine.netAmount })),
    contents,
  )
  return {
    facts,
    check: bookingCheck(facts),
    companyCurrency,
    insureAbove,
    inCompany,
    senderCountry,
    shipToCountry,
    goods,
    parcelVersions: new Map(parcels.map((parcel) => [parcel.id, parcel.version])),
    customer: party ? { partyId: shipment.partyId, defaultService: party.defaultCarrierService } : null,
    accountMode: facts.account?.mode ?? null,
    contract: facts.contract,
    version: shipment.version,
  }
}

/** The booking read's answer (GET /shipping/shipments/:shipmentId/booking). Values only with the price grain (the contract drops them). */
export function bookingView(shipment: ShipmentHeader, read: BookingRead) {
  const { facts, check } = read
  const { offer, known } = carrierOfferOf(facts.shipment.carrierCode)
  const labelled = facts.parcels.filter((parcel) => parcel.labelled).length
  const refusal = servicesChangeRefusal(shipment.status, labelled)
  const customer = facts.customer
  const insured = facts.parcels.filter((parcel) => !parcel.labelled && parcel.insuredValue !== null)
  return {
    shipment: {
      id: shipment.id,
      number: shipment.number,
      status: shipment.status,
      transportBy: shipment.transportBy,
      carrierCode: shipment.carrierCode,
      carrierName: shipment.carrierName,
      serviceCode: shipment.serviceCode,
      express: facts.shipment.express,
      dutyPayer: facts.shipment.dutyPayer,
      paperless: facts.shipment.paperless,
      version: shipment.version,
    },
    destination: { from: read.senderCountry, to: read.shipToCountry, kind: facts.destination, words: facts.destination ? DESTINATION_WORDS[facts.destination] : 'A country is missing (the sender’s or the delivery address’s).' },
    carrier: { known, offers: offer, words: offerWords(facts.shipment.carrierCode, known) },
    testMode: facts.testMode,
    connection: read.accountMode ? { mode: read.accountMode } : null,
    billedTo: { kind: check.billedTo, words: check.billedToWords, contractId: check.contract?.id ?? null },
    contract: read.contract,
    customer: customer
      ? {
          partyId: read.customer!.partyId,
          name: customer.name,
          carrierCode: customer.carrierCode,
          carrierName: carrierNameFor('CARRIER', customer.carrierCode),
          freightBilling: customer.freightBilling,
          accountOnFile: customer.accountOnFile,
          defaultCarrierService: customer.defaultService,
          /** The shipment goes with the customer's carrier and its default service. */
          applied: customer.carrierCode !== null && customer.carrierCode === shipment.carrierCode && (customer.defaultService === null || customer.defaultService === shipment.serviceCode),
        }
      : null,
    currency: facts.currency,
    companyCurrency: read.companyCurrency,
    insureAbove: asMoney('price', read.insureAbove),
    parcels: facts.parcels.map((parcel) => ({
      id: parcel.id,
      seq: parcel.seq,
      labelled: parcel.labelled,
      goodsValue: asMoney('price', read.goods.get(parcel.id) ?? 0),
      declaredValue: asMoney('price', parcel.declaredValue),
      insuredValue: asMoney('price', parcel.insuredValue),
      rule: parcel.rule,
      version: read.parcelVersions.get(parcel.id) ?? 1,
    })),
    insuredParcels: insured.length,
    insuredTotal: asMoney('price', insured.reduce((sum, parcel) => sum + (parcel.insuredValue ?? 0), 0)),
    extras: [...check.extras],
    problems: [...check.problems],
    warnings: [...check.warnings],
    bookable: check.problems.length === 0,
    may: { change: { allowed: refusal === null, refusal } },
  }
}

/** The caller holds the price grain (a booking's values and the rule's amounts). */
export const holdsPrice = (caller: CommandCaller): boolean => {
  const context = caller.factoryContext
  return context?.audience === 'office' && holds(actorOf(context), 'money.price')
}

/**
 * The label buy's booking (labels.ts): read with the buy's facts, refused 409 with one `refusal/<CODE>` issue per problem
 * (nothing bought, the TEST carrier not asked), else the booking whose extras each parcel's request carries.
 */
export async function bookingForBuy(caller: CommandCaller, shipment: ShipmentHeader, parcelIds: readonly string[]): Promise<BookingRead> {
  const read = await caller.withClient((client) => readBooking(client, shipment, { amounts: holdsPrice(caller) }))
  const check = bookingCheck(read.facts, parcelIds)
  if (check.problems.length > 0) {
    const first = check.problems[0]!
    throw new DomainError('conflict', check.problems.length === 1 ? first.message : `The booking cannot go as it stands: ${check.problems.map((problem) => problem.message).join(' ')}`, check.problems.map((problem) => ({ path: `refusal/${problem.code}`, message: problem.message })))
  }
  return { ...read, check }
}

/** One parcel's label request with the booking's extras (the TEST carrier ignores them). */
export const withBooking = (request: CarrierLabelRequest, read: BookingRead, parcelId: string): CarrierLabelRequest => ({ ...request, extras: bookingExtrasOf(read.facts, read.check, parcelId) })

/** Inside the buy's command: who the carrier billed and which services the labels carried (no number, no value). */
export function auditBooking(tools: CommandTools, shipment: Pick<ShipmentHeader, 'id' | 'companyId' | 'siteId'>, read: BookingRead, parcelIds: readonly string[]): void {
  if (parcelIds.length === 0) return
  tools.audit({
    action: 'shipping.bookedWith',
    recordType: 'Shipment',
    recordId: shipment.id,
    companyId: shipment.companyId,
    siteId: shipment.siteId,
    after: {
      parcelIds: [...parcelIds],
      billedTo: read.check.billedTo,
      contractId: read.check.contract?.id ?? null,
      services: read.check.extras.map((extra) => ({ service: extra.service, state: extra.state })),
      destination: read.facts.destination,
    },
  })
}

