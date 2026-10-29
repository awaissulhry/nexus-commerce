import type { Issue } from '../core/errors'

/**
 * A site's shipping settings (LOG-117; A2 SCR-068): what a carrier label and a DDT print as the sender, where returns
 * go, the default carrier and service (data: Sendcloud's carrier code and shipping method, B-W1-48), who carries by
 * default, the goods' appearance a DDT starts with, the packing station's printers (a label printer for carrier labels,
 * an A4 printer for the DDT and the packing list) and the daily cut-off. Pure rules; the API checks the printers and the
 * Sendcloud account against the database.
 */

/** An address as the settings keep it (ShippingSettings.senderAddress / returnAddress JSON). */
export interface ShippingAddress {
  readonly name: string
  readonly line1: string
  readonly line2?: string | null
  readonly postalCode: string
  readonly city: string
  /** Italian province code (MI, BO…), or a region. */
  readonly province?: string | null
  /** ISO 3166-1 alpha-2. */
  readonly country: string
  readonly phone?: string | null
  readonly email?: string | null
}

/** The settings as sent (the API's contract has their shape). */
export interface ShippingSettingsInput {
  readonly senderAddress: ShippingAddress
  readonly returnAddress?: ShippingAddress | null
  readonly defaultCarrierCode?: string | null
  readonly defaultServiceCode?: string | null
  readonly defaultGoodsAppearance?: string | null
  readonly cutOffTime?: string | null
}

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''

/** A carrier's code as Sendcloud names it (`brt`, `gls`, `poste_italiane`). */
export const CARRIER_CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/
/** A service (Sendcloud's shipping method: an id or a code). */
export const SERVICE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
/** A time of day, HH:MM (the site's zone): the database's rule too. */
export const CUT_OFF_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const COUNTRY = /^[A-Z]{2}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Who the address is, where it is (street, postal code, city, country), and how to reach it when given. */
export function shippingAddressProblems(address: ShippingAddress | null | undefined, at: string): Issue[] {
  if (!address || typeof address !== 'object') return [{ path: at, message: 'Give the address.' }]
  const problems: Issue[] = []
  for (const key of ['name', 'line1', 'postalCode', 'city'] as const) {
    if (!filled(address[key])) problems.push({ path: `${at}/${key}`, message: key === 'name' ? 'Name who sends (or receives) the goods.' : 'Required.' })
  }
  if (!COUNTRY.test(address.country ?? '')) problems.push({ path: `${at}/country`, message: 'Expected a two-letter country code (ISO 3166-1), in capitals.' })
  if (filled(address.email) && !EMAIL.test(address.email.trim())) problems.push({ path: `${at}/email`, message: 'Expected an email address.' })
  return problems
}

/** Every problem of the settings as sent (empty: none). */
export function shippingSettingsProblems(input: ShippingSettingsInput, at = 'body'): Issue[] {
  const problems: Issue[] = [...shippingAddressProblems(input.senderAddress, `${at}/senderAddress`)]
  if (input.returnAddress) problems.push(...shippingAddressProblems(input.returnAddress, `${at}/returnAddress`))
  if (filled(input.defaultCarrierCode) && !CARRIER_CODE.test(input.defaultCarrierCode)) {
    problems.push({ path: `${at}/defaultCarrierCode`, message: "Expected the carrier's code as the aggregator names it: lower-case letters, digits, '_', '.', '-'." })
  }
  if (filled(input.defaultServiceCode) && !SERVICE_CODE.test(input.defaultServiceCode)) {
    problems.push({ path: `${at}/defaultServiceCode`, message: 'Expected the shipping method as the aggregator names it: letters, digits, \'_\', \'.\', \':\', \'-\'.' })
  }
  if (filled(input.defaultServiceCode) && !filled(input.defaultCarrierCode)) {
    problems.push({ path: `${at}/defaultServiceCode`, message: 'A default service belongs to a default carrier: name the carrier too.' })
  }
  if (input.cutOffTime !== null && input.cutOffTime !== undefined && !CUT_OFF_TIME.test(input.cutOffTime)) {
    problems.push({ path: `${at}/cutOffTime`, message: 'Expected a time of day, HH:MM.' })
  }
  return problems
}

/** The printer kinds of the packing station: carrier labels on a label printer, documents on an A4 printer. */
export const PACKING_PRINTERS = { labelPrinterId: 'LABEL_ZPL', documentPrinterId: 'A4_PDF' } as const

/** Why a printer cannot be one of the site's packing printers (empty: it can). */
export function packingPrinterProblems(
  slot: keyof typeof PACKING_PRINTERS,
  printer: { readonly siteId: string; readonly kind: string; readonly status: string } | null,
  siteId: string,
  at: string,
): Issue[] {
  if (!printer || printer.siteId !== siteId) return [{ path: at, message: 'Not a printer of this site.' }]
  if (printer.kind !== PACKING_PRINTERS[slot]) {
    return [{ path: at, message: slot === 'labelPrinterId' ? 'Carrier labels print on a label printer (ZPL).' : 'The DDT and the packing list print on an A4 printer.' }]
  }
  if (printer.status === 'ARCHIVED') return [{ path: at, message: 'This printer is archived.' }]
  return []
}
