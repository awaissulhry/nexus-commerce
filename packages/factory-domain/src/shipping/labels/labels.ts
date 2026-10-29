import type { Issue } from '../../core/errors'
import { businessDate, businessDayStart } from '../../core/time'
import type { CarrierAddress, CarrierLabelRequest, LabelFormat } from '../../ports/carrier'
import type { IntegrationMode } from '../../ports/provider'
import { parseDecimal } from '../../tax/decimal'
import { CUT_OFF_TIME, shippingAddressProblems, type ShippingAddress } from '../settings'
import type { ShipmentStatus, TransportBy } from '../shipments'

/**
 * Carrier labels (B-W1-48; features LOG-025 labels and tracking, LOG-032 multi-parcel labels, LOG-059 carrier
 * aggregator; PLAN §4.7 stage 14-ship "carrier label (fake)"). Pure rules; apps/factory-api's modules/shipping/labels
 * loads the facts, calls the carrier through the gateway (outside any transaction) and records what it bought in one
 * command on the shipment.
 *
 *   when      a PACKED shipment carried by a carrier, with a live DDT (the design's "buying a label is held until the
 *             DDT is issued"): one label per parcel that has none, each parcel weighed
 *   who pays  the shipment's company, through ITS OWN Sendcloud account (an IntegrationAccount of provider SENDCLOUD of
 *             that company; never another company's or a tenant-wide one: Owner Q20). FAKE accounts work in local and
 *             test only; without an account nothing is bought (LIVE needs the account)
 *   what      sender = the site's shipping settings (the return address when set is not the sender), recipient = the
 *             shipment's ship-to; the shipment's carrier and service (Sendcloud's shipping option)
 *   void      only before the goods leave (DRAFT or PACKED): the parcel can change again
 */

/** Environments (env.ts FACTORY_ENV). */
export type LabelEnvironment = 'local' | 'test' | 'staging' | 'production'

/** The carrier account a label is bought with. */
export interface LabelAccount {
  readonly id: string
  readonly provider: string
  readonly companyId: string | null
  readonly mode: IntegrationMode
  readonly status: 'ACTIVE' | 'PAUSED' | 'DISABLED'
}

/** A parcel as labels see it. */
export interface LabelParcel {
  readonly id: string
  readonly seq: number
  readonly version: number
  readonly grossWeightKg: string | null
  readonly lengthCm: string | null
  readonly widthCm: string | null
  readonly heightCm: string | null
  readonly trackingNumber: string | null
  readonly providerId: string | null
}

/** Everything a buy needs, read before the carrier is called (and again, under the shipment's lock, to record it). */
export interface LabelFacts {
  readonly shipment: {
    readonly number: string
    readonly status: ShipmentStatus
    readonly transportBy: TransportBy
    readonly companyId: string
    readonly shipTo: unknown
    readonly carrierCode: string | null
    readonly serviceCode: string | null
  }
  /** The site's shipping settings' sender address, or null when the site has none. */
  readonly sender: unknown
  /** The live DDT's number, or null. */
  readonly liveDdtNumber: string | null
  readonly parcels: readonly LabelParcel[]
  /** The account the shipment (or else its site) names; null: none. */
  readonly account: LabelAccount | null
  readonly environment: LabelEnvironment
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const text = (value: unknown): string | null => (filled(value) ? value.trim() : null)

/** A parcel has a carrier label. */
export const isLabelled = (parcel: Pick<LabelParcel, 'trackingNumber' | 'providerId'>): boolean => parcel.trackingNumber !== null || parcel.providerId !== null

/** The parcels a buy labels now: those without a label, in their order. */
export const parcelsToLabel = <Parcel extends LabelParcel>(parcels: readonly Parcel[]): Parcel[] => [...parcels].filter((parcel) => !isLabelled(parcel)).sort((a, b) => a.seq - b.seq)

/**
 * Why the shipment's labels cannot be bought with this account (empty: they can). Q20: the company's own Sendcloud
 * account, never a tenant-wide one or another company's; FAKE only in local and test; ACTIVE only (PAUSED is the kill
 * switch).
 */
export function accountProblems(account: LabelAccount | null, companyId: string, environment: LabelEnvironment): Issue[] {
  const at = 'account'
  if (!account) {
    return [
      {
        path: at,
        message:
          "This company has no Sendcloud connection: labels are bought only through the company's own Sendcloud account (an administrator adds it under Connections and names it in the site's shipping settings). Local and test use a FAKE account.",
      },
    ]
  }
  if (account.provider !== 'SENDCLOUD') return [{ path: at, message: 'The connection named for labels is not a Sendcloud account.' }]
  if (account.companyId !== companyId) return [{ path: at, message: "The Sendcloud connection named is not this company's own: labels are bought only with the shipping company's account." }]
  if (account.mode === 'FAKE' && environment !== 'local' && environment !== 'test') {
    return [{ path: at, message: 'The Sendcloud connection is a FAKE one: it buys no real labels, so it is refused here (FAKE works in local and test only).' }]
  }
  if (account.status === 'PAUSED') return [{ path: at, message: 'The Sendcloud connection is paused (the kill switch): resume it under Connections first.' }]
  if (account.status === 'DISABLED') return [{ path: at, message: 'The Sendcloud connection is disabled.' }]
  return []
}

/** The state problems of a buy (409): PACKED, carried by a carrier, with a live DDT, through a usable account. */
export function buyStateProblems(facts: LabelFacts): Issue[] {
  const problems: Issue[] = []
  if (facts.shipment.status !== 'PACKED') problems.push({ path: 'state', message: `The shipment is ${facts.shipment.status}; carrier labels are bought while it is PACKED (pack it first; once it left, nothing changes).` })
  if (facts.shipment.transportBy !== 'CARRIER') problems.push({ path: 'state', message: 'The goods do not travel with a carrier (own van or customer pickup): no carrier label is needed.' })
  if (facts.liveDdtNumber === null) problems.push({ path: 'state', message: 'The shipment has no live DDT: issue the DDT first (a label is bought only for goods the DDT declares).' })
  problems.push(...accountProblems(facts.account, facts.shipment.companyId, facts.environment))
  return problems
}

/** The field problems of a buy (400): the sender, the recipient, the service, each parcel's weight and sizes. */
export function buyFieldProblems(facts: LabelFacts, parcels: readonly LabelParcel[] = parcelsToLabel(facts.parcels)): Issue[] {
  const problems: Issue[] = []
  if (facts.sender === null || facts.sender === undefined) problems.push({ path: 'settings/senderAddress', message: "The site has no shipping settings: its sender address is printed on every label (shipping settings)." })
  else problems.push(...shippingAddressProblems(facts.sender as ShippingAddress, 'settings/senderAddress'))
  problems.push(...shippingAddressProblems(facts.shipment.shipTo as ShippingAddress, 'shipment/shipTo'))
  if (!filled(facts.shipment.serviceCode)) problems.push({ path: 'shipment/serviceCode', message: 'Choose the carrier service (Sendcloud shipping option) for the shipment, or a default one in the site settings.' })
  for (const parcel of parcels) {
    const weight = parcel.grossWeightKg === null ? null : parseDecimal(parcel.grossWeightKg)
    if (weight === null || !weight.greaterThan(0)) problems.push({ path: `parcels/${parcel.seq}/grossWeightKg`, message: `Parcel ${parcel.seq} has no weight: weigh it first.` })
    const sizes = [parcel.lengthCm, parcel.widthCm, parcel.heightCm]
    if (sizes.some((size) => size !== null) && sizes.some((size) => size === null)) {
      problems.push({ path: `parcels/${parcel.seq}`, message: `Parcel ${parcel.seq} has only some of its sizes: give length, width and height, or none.` })
    }
  }
  return problems
}

/** An address of the settings or the ship-to as the carrier prints it. */
export function carrierAddressOf(value: unknown): CarrierAddress {
  const address = record(value)
  return {
    name: text(address.name) ?? '',
    companyName: text(address.companyName),
    line1: text(address.line1) ?? '',
    line2: text(address.line2),
    postalCode: text(address.postalCode) ?? '',
    city: text(address.city) ?? '',
    province: text(address.province),
    country: text(address.country) ?? '',
    phone: text(address.phone),
    email: text(address.email),
  }
}

/**
 * The carrier's reference of one parcel's label: the parcel and its version. A repeat of the same buy (an answer lost,
 * a double click) sends the same reference and gets the same label back; a void bumps the parcel's version, so the
 * next buy is a new label.
 */
export const externalReferenceOf = (parcel: Pick<LabelParcel, 'id' | 'version'>): string => `${parcel.id}.v${parcel.version}`

/** The request of one parcel's label. */
export function labelRequestOf(facts: LabelFacts, parcel: LabelParcel): CarrierLabelRequest {
  return {
    shipmentNumber: facts.shipment.number,
    seq: parcel.seq,
    parcels: facts.parcels.length,
    externalReference: externalReferenceOf(parcel),
    from: carrierAddressOf(facts.sender),
    to: carrierAddressOf(facts.shipment.shipTo),
    carrierCode: facts.shipment.carrierCode,
    serviceCode: facts.shipment.serviceCode ?? '',
    weightKg: parcel.grossWeightKg ?? '',
    lengthCm: parcel.lengthCm,
    widthCm: parcel.widthCm,
    heightCm: parcel.heightCm,
  }
}

/** The label formats a buy keeps: the PDF always (any browser prints it), ZPL too when the site has a label printer. */
export const labelFormatsFor = (labelPrinterKind: string | null): LabelFormat[] => (labelPrinterKind === 'LABEL_ZPL' ? ['PDF', 'ZPL'] : ['PDF'])

/** A label file's name: the shipment, the parcel's place, the tracking number. */
export function labelFileName(shipmentNumber: string, seq: number, trackingNumber: string, format: LabelFormat): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '-')
  return `label-${safe(shipmentNumber)}-${seq}-${safe(trackingNumber)}.${format === 'PDF' ? 'pdf' : 'zpl'}`
}

/** What a void needs: a labelled parcel of a shipment that has not left (DRAFT or PACKED). */
export function voidProblems(status: ShipmentStatus, parcel: Pick<LabelParcel, 'seq' | 'trackingNumber' | 'providerId'>): string[] {
  if (status !== 'DRAFT' && status !== 'PACKED') return [`The shipment is ${status}; a label is voided only before the goods leave.`]
  if (!isLabelled(parcel)) return [`Parcel ${parcel.seq} has no carrier label.`]
  return []
}

/** What one parcel's buy came to, for the answer: bought, or why not. */
export type ParcelOutcome = { readonly parcelId: string; readonly seq: number; readonly ok: true } | { readonly parcelId: string; readonly seq: number; readonly ok: false; readonly problem: string }

/** The answer's summary of a buy that partly failed (null when every parcel got its label). */
export function partialProblem(outcomes: readonly ParcelOutcome[]): string | null {
  const failed = outcomes.filter((outcome) => !outcome.ok)
  if (failed.length === 0) return null
  const bought = outcomes.length - failed.length
  const list = failed.map((outcome) => `parcel ${outcome.seq}`).join(', ')
  return bought === 0
    ? `No label was bought (${list}): see each parcel's problem, then buy again.`
    : `${bought} of ${outcomes.length} labels were bought; ${list} still need one: see each parcel's problem, then buy again (the labels bought are kept).`
}

// ---- the carrier's cut-off (LOG-117; SCR-098 "the carrier cut-off countdown above the ship-today queue") -------------

/**
 * Today's cut-off of a site (its settings' HH:MM, Europe/Rome): the instant, and whether it passed (a parcel labelled
 * after it leaves the next working day). Null without a cut-off. The day's start plus the time: on the two days a year
 * the clock changes the instant is an hour off before 03:00, never at a working cut-off.
 */
export function cutOffOf(cutOffTime: string | null, now: Date): { readonly time: string; readonly at: Date; readonly passed: boolean } | null {
  if (cutOffTime === null || !CUT_OFF_TIME.test(cutOffTime)) return null
  const [hours, minutes] = cutOffTime.split(':').map((part) => Number.parseInt(part, 10)) as [number, number]
  const at = new Date(businessDayStart(businessDate(now)).getTime() + (hours * 60 + minutes) * 60_000)
  return { time: cutOffTime, at, passed: now.getTime() >= at.getTime() }
}
