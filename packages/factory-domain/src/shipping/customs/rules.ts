// B-W2b-GF2: the EU's special fiscal territories, told apart by the address.
import { specialTerritoryOf, type TerritoryAddress } from '../../tax/special-territories'
import type { CurrencyCode } from '../../core/money'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Export and customs (B-W2b-409; LOG-086, LOG-087, LOG-088, LOG-089, LOG-095, LOG-097; design warehouse.shipments record ›
 * Export "Export papers", Warehouse › Shipping "EORI"; plan rule 2: the proof of exit decides whether an export stays VAT-free,
 * today it is a folder), pure. factory-db customs.prisma CustomsDeclaration, Company.eori, ShippingSettings.brokerPackOn and
 * gendocs.prisma COMMERCIAL_INVOICE, CN22, CN23 keep it; apps/factory-api's modules/shipping/{customs,broker-pack} write it.
 *
 *   where it goes      DOMESTIC (Italy), EU (another member state: an intra-EU supply, no customs) or EXPORT (outside the
 *                      EU): only an EXPORT has export papers ("Not needed: delivered in Italy" otherwise)
 *   EORI               each company's own (Company.eori: the country's two capitals, then 1 to 15 capitals or digits),
 *                      printed on every customs paper; an export paper is refused while the company has none
 *   commercial invoice the customs invoice of the shipment (./commercial-invoice.ts): HS codes, origin, values, Incoterm,
 *                      EORI, weights and currency, in the order's language
 *   CN22 / CN23        the postal customs declaration of each parcel (./postal-forms.ts): CN 22 for a small packet, CN 23
 *                      for a parcel or for contents worth more (postalFormOf below); a CN 23 is always accepted
 *   declaration        the export declaration (Union Customs Code) filed by a broker (a party) or by the carrier: the data
 *                      pack sent (PACK_SENT), the MRN typed in or answered by the broker's link (FILED), the exit confirmed
 *                      with its proof against the issued invoice (EXITED: art. 8 c. 1 lett. a DPR 633/1972 keeps the export
 *                      VAT-free on that proof); one declaration per shipment; removed only while PACK_SENT (sent by mistake)
 *   the alert          a proof still missing `alertAfterDays` after the goods left raises the exception rule
 *                      EXIT_PROOF_MISSING (alerts/kinds.ts) until the exit is confirmed
 *
 * Nothing here reaches customs, a broker or a carrier by itself: the papers are downloads, the MRN is typed in, and the
 * broker's link is sent only while the site's switch (ShippingSettings.brokerPackOn) is ON, OFF by default (Owner, 11-13).
 */

/** The member states of the European Union (ISO 3166-1 alpha-2; Greece is GR here, EL only in VAT numbers). */
export const EU_COUNTRIES = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'] as const

/** Where a shipment goes, seen from the company's country (Italy). */
export const DESTINATION_CLASSES = ['DOMESTIC', 'EU', 'EXPORT'] as const
export type DestinationClass = (typeof DESTINATION_CLASSES)[number]

/** The company's own country: every factory company is Italian (VAT, SDI, DDT). */
export const HOME_COUNTRY = 'IT'

/**
 * Where goods for this country go (null: no country known). B-W2b-GF2 (G463): with the address's postal code and town,
 * the EU's special fiscal territories are told apart (tax/special-territories.ts): a place outside the EU's VAT area —
 * Livigno or Campione d'Italia at home, the Canary Islands, Ceuta, Melilla, Mount Athos, Heligoland, Büsingen, Åland,
 * France's overseas departments — is an EXPORT (export papers); Monaco is in the EU (France's VAT area).
 */
export function destinationClassOf(country: string | null | undefined, home: string = HOME_COUNTRY, address: Omit<TerritoryAddress, 'country'> = {}): DestinationClass | null {
  const code = typeof country === 'string' ? country.trim().toUpperCase() : ''
  if (!/^[A-Z]{2}$/.test(code)) return null
  const territory = specialTerritoryOf({ country: code, ...address })
  if (territory?.vat === 'OUTSIDE') return 'EXPORT'
  const state = territory?.state ?? code
  if (state === home) return 'DOMESTIC'
  return (EU_COUNTRIES as readonly string[]).includes(state) ? 'EU' : 'EXPORT'
}

/** An EORI as Company.eori keeps it (the database's own pattern). */
export const EORI_PATTERN = /^[A-Z]{2}[A-Z0-9]{1,15}$/

/** An EORI typed by a person: upper case, without spaces, dots or dashes; null when it is not one. */
export function eoriOf(typed: string): string | null {
  const value = typed.replace(/[\s.\-]/g, '').toUpperCase()
  return EORI_PATTERN.test(value) ? value : null
}

/** A Movement Reference Number (the database's pattern: two digits of the year, the country, 14 capitals or digits). */
export const MRN_PATTERN = /^[0-9]{2}[A-Z]{2}[A-Z0-9]{14}$/

/** An MRN typed by a person or a broker: upper case, without spaces; null when it is not one. The check digit is not read. */
export function mrnOf(typed: string): string | null {
  const value = typed.replace(/\s/g, '').toUpperCase()
  return MRN_PATTERN.test(value) ? value : null
}

export const DECLARATION_STATUSES = ['PACK_SENT', 'FILED', 'EXITED'] as const
export type DeclarationStatus = (typeof DECLARATION_STATUSES)[number]

/** After how many days from the goods leaving a missing proof of exit raises its alert: the default and the bounds. */
export const EXIT_ALERT_DAYS = Object.freeze({ default: 30, min: 1, max: 365 })

const DAY_MS = 86_400_000

/** When a missing proof of exit raises its alert: the goods left + its days (null: they have not left). */
export function exitDueAt(shippedAt: Date | null, alertAfterDays: number): Date | null {
  return shippedAt === null ? null : new Date(shippedAt.getTime() + alertAfterDays * DAY_MS)
}

/** The proof of exit is overdue: the goods left more than its days ago and the exit is not confirmed. */
export function exitOverdue(declaration: { readonly status: string; readonly alertAfterDays: number }, shippedAt: Date | null, now: Date): boolean {
  const due = exitDueAt(shippedAt, declaration.alertAfterDays)
  return declaration.status !== 'EXITED' && due !== null && due.getTime() < now.getTime()
}

/** Whole days until the alert (negative: overdue by so many days); null: the goods have not left. */
export function exitDaysLeft(shippedAt: Date | null, alertAfterDays: number, now: Date): number | null {
  const due = exitDueAt(shippedAt, alertAfterDays)
  return due === null ? null : Math.floor((due.getTime() - now.getTime()) / DAY_MS)
}

/**
 * Why the goods travel, on the commercial invoice and the CN 22 / CN 23 (the UPU forms' boxes): a sales shipment is a SALE.
 * OTHER needs its words.
 */
export const EXPORT_REASONS = ['SALE_OF_GOODS', 'COMMERCIAL_SAMPLE', 'RETURNED_GOODS', 'GIFT', 'DOCUMENTS', 'OTHER'] as const
export type ExportReason = (typeof EXPORT_REASONS)[number]

/** The postal customs forms (UPU): CN 22 for a small packet, CN 23 for a parcel or contents worth more. */
export const POSTAL_FORMS = ['CN22', 'CN23'] as const
export type PostalForm = (typeof POSTAL_FORMS)[number]

/**
 * When a CN 22 may go (UPU Letter Post Regulations: a CN 22 for contents worth up to 300 SDR; letter-post items, the small
 * packets a CN 22 rides on, weigh up to 2 kg; heavier goods travel as postal parcels with a CN 23). The value is read in
 * euro against 300: 300 EUR is never more than 300 SDR while one SDR is worth at least one euro, as it has been since the
 * euro began, so a CN 22 here is always within the UPU's limit. Any other currency, a parcel not weighed or contents worth
 * more ask a CN 23, which is always accepted.
 */
export const CN22_LIMITS = Object.freeze({ grossKg: '2', valueEur: '300' })

export interface PostalParcelFacts {
  /** The parcel's gross weight in kilograms (null: not weighed). */
  readonly grossKg: Decimal | null
  /** The contents' value, in the shipment's currency. */
  readonly value: Decimal
}

/** Why a CN 23 is needed (empty: a CN 22 may go). */
export const CN23_BECAUSE = ['HEAVY', 'VALUE', 'CURRENCY', 'NOT_WEIGHED'] as const
export type Cn23Because = (typeof CN23_BECAUSE)[number]

/** The form the parcels need: CN 22 when every parcel fits its limits, else CN 23 with the reasons. */
export function postalFormOf(parcels: readonly PostalParcelFacts[], currency: CurrencyCode | string): { readonly form: PostalForm; readonly because: readonly Cn23Because[] } {
  const because = new Set<Cn23Because>()
  const maxKg = new Dec(CN22_LIMITS.grossKg)
  const maxValue = new Dec(CN22_LIMITS.valueEur)
  if (currency !== 'EUR') because.add('CURRENCY')
  for (const parcel of parcels) {
    if (parcel.grossKg === null) because.add('NOT_WEIGHED')
    else if (parcel.grossKg.greaterThan(maxKg)) because.add('HEAVY')
    if (currency === 'EUR' && parcel.value.greaterThan(maxValue)) because.add('VALUE')
  }
  const reasons = CN23_BECAUSE.filter((reason) => because.has(reason))
  return { form: reasons.length === 0 ? 'CN22' : 'CN23', because: reasons }
}

/** The words of why a CN 23 is needed. */
export const CN23_BECAUSE_WORDS: Readonly<Record<Cn23Because, string>> = Object.freeze({
  HEAVY: `A parcel weighs more than ${CN22_LIMITS.grossKg} kg: it travels as a postal parcel with a CN 23.`,
  VALUE: `A parcel's contents are worth more than ${CN22_LIMITS.valueEur} EUR: a CN 23 declares them.`,
  CURRENCY: 'The shipment is not priced in euro: a CN 23 declares its value without the CN 22 limit.',
  NOT_WEIGHED: 'A parcel is not weighed yet: a CN 23 goes until every parcel is weighed under the CN 22 limit.',
})

/** The refusals of export and customs (409 `refusal/<CODE>`), with their words. */
export const CUSTOMS_REFUSALS = [
  'NOT_EXPORT',
  'NO_DESTINATION',
  'CANCELLED',
  'NO_EORI',
  'NO_LINES',
  'CUSTOMS_DATA',
  'NO_PRICE',
  'NOT_PACKED',
  'NOT_WEIGHED',
  'CN22_LIMIT',
  'LETTERHEAD',
  'DECLARED',
  'BROKER',
  'NOT_FILED',
  'MRN_KEPT',
  'NOT_LEFT',
  'EXIT_TIME',
  'NO_INVOICE',
  'INVOICE',
  'INVOICE_KEPT',
  'PROOF_FILE',
  'EXITED',
  'KEPT',
] as const
export type CustomsRefusal = (typeof CUSTOMS_REFUSALS)[number]
export const customsRefusalPath = (code: CustomsRefusal): string => `refusal/${code}`

export const CUSTOMS_REFUSAL_WORDS: Readonly<Record<CustomsRefusal, string>> = Object.freeze({
  NOT_EXPORT: 'The goods stay in the EU: a shipment within Italy or to another member state has no export papers.',
  NO_DESTINATION: 'The shipment has no country to go to: complete its delivery address first.',
  CANCELLED: 'The shipment is cancelled: it has no export papers.',
  NO_EORI: "The company has no EORI yet: give it in the shipping settings (EORI) before any customs paper is made.",
  NO_LINES: 'The shipment has no garments yet: add its lines first.',
  CUSTOMS_DATA: 'Every style on a customs paper needs its HS code and its country of origin.',
  NO_PRICE: 'A line of the shipment has no price from its order: customs papers declare the value.',
  NOT_PACKED: 'Every garment must be packed in a parcel first: the CN 22 or CN 23 says what each parcel holds.',
  NOT_WEIGHED: 'Every parcel must be weighed first.',
  CN22_LIMIT: 'These parcels need a CN 23 (see why); a CN 22 is not allowed.',
  LETTERHEAD: "The company's letterhead is not complete: the commercial invoice cannot be printed.",
  DECLARED: 'This shipment has its export declaration already: remove it while its pack is merely sent, or follow it up.',
  BROKER: 'Choose an active party of the company that carries or supplies us (a carrier or a supplier) as the customs broker.',
  NOT_FILED: 'The declaration has no MRN yet: record the MRN first.',
  MRN_KEPT: 'The declaration has its MRN already; it never changes.',
  NOT_LEFT: 'The goods have not left yet: the exit is confirmed once they are shipped.',
  EXIT_TIME: 'The exit cannot be confirmed before the goods left, nor in the future.',
  NO_INVOICE: 'Name the issued invoice of the export first: the exit is proven against it.',
  INVOICE: "Choose an issued invoice of the company to the shipment's customer.",
  INVOICE_KEPT: 'The declaration names its invoice already; it never changes.',
  PROOF_FILE: 'The proof of exit is a file uploaded on the declaration (a PDF or a picture), available.',
  EXITED: 'The exit is confirmed: the declaration never changes.',
  KEPT: 'Only a declaration whose pack is merely sent is removed; once filed it is kept.',
})
