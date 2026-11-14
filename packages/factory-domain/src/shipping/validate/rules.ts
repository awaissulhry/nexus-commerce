import { parseDecimal } from '../../tax/decimal'
import { carrierNameFor } from '../labels/labels'

/**
 * Check every parcel before its label is printed (B-W2b-390; LOG-045 "Sendcloud validates in W1; our own pre-check"),
 * pure. A label the carrier refuses at the dock stops the dock: before anything is bought (and before the TEST carrier
 * makes one), each parcel of the shipment is checked against what its carrier takes, and every problem is said in words
 * from its code:
 *
 *   addresses   the sender (the site's settings) and the recipient (the shipment's ship-to) name who, the street, the
 *               postal code, the city and the country; the postal code has the form of its country (POSTAL_CODE_FORMATS;
 *               a country not listed is not checked)
 *   phone       the recipient's phone is a phone number when given; it is needed when the carrier always asks for one
 *               (CARRIER_RULES `phone: 'ALWAYS'`) and for every parcel leaving the European Union (customs)
 *   weight      each parcel is weighed, and no heavier than the carrier takes a parcel
 *   sizes       length, width and height all or none; the longest side, the length plus girth (2 × (width + height)) and
 *               the carrier's largest box, where the carrier has such a limit
 *   service     the shipment names its carrier service
 *
 * The carriers' limits are STARTING values from the carriers' published limits for a standard parcel service, kept here
 * (no table yet: B-W2b-400's carrier contracts are where a contract's own limits belong); `verified: false` until checked
 * against the company's contract. A carrier not listed (the seed's carriers, BRT, GLS, Poste, SDA …) has no weight or size
 * limit here: its own refusal stays the carrier's (W1). The postal code, phone, address and weight checks hold for every
 * carrier.
 */

/** What the check can say, one code per kind of problem (`CHECK_WORDS` words each). */
export const CHECK_CODES = [
  'SENDER_INCOMPLETE',
  'RECIPIENT_INCOMPLETE',
  'POSTAL_CODE',
  'PHONE_NEEDED',
  'PHONE_FORMAT',
  'NO_SERVICE',
  'NO_WEIGHT',
  'TOO_HEAVY',
  'SIZES_PARTIAL',
  'TOO_LONG',
  'TOO_BIG',
  'DOES_NOT_FIT',
] as const
export type CheckCode = (typeof CHECK_CODES)[number]

/** The codes a label buy refuses on (409 `refusal/<CODE>`): the carrier's rules. The others are W1's field checks (400). */
export const CARRIER_RULE_CODES: readonly CheckCode[] = Object.freeze(['POSTAL_CODE', 'PHONE_NEEDED', 'PHONE_FORMAT', 'TOO_HEAVY', 'TOO_LONG', 'TOO_BIG', 'DOES_NOT_FIT'])

/** A carrier's limits for one parcel. */
export interface CarrierRule {
  /** Kilograms (decimal string); null: no limit kept here. */
  readonly maxWeightKg: string | null
  /** Centimetres on the longest side; null: none kept. */
  readonly maxLengthCm: number | null
  /** Centimetres of the length plus girth (2 × the two shorter sides); null: none kept. */
  readonly maxLengthPlusGirthCm: number | null
  /** The largest box, its sides longest first; null: none kept. */
  readonly maxBoxCm: readonly [number, number, number] | null
  /** When the recipient's phone is needed: always, or only for a parcel leaving the EU. */
  readonly phone: 'ALWAYS' | 'OUTSIDE_EU'
}

/** Every carrier not listed: no weight or size limit kept, a phone for a parcel leaving the EU. */
export const DEFAULT_CARRIER_RULE: CarrierRule = Object.freeze({ maxWeightKg: null, maxLengthCm: null, maxLengthPlusGirthCm: null, maxBoxCm: null, phone: 'OUTSIDE_EU' })

/**
 * Starting limits per carrier code (Sendcloud's codes, labels.ts CARRIER_NAMES), from the carriers' published limits for a
 * standard parcel service. UNVERIFIED: check them against the company's contract.
 */
export const CARRIER_RULES: Readonly<Record<string, CarrierRule>> = Object.freeze({
  ups: { maxWeightKg: '70', maxLengthCm: 274, maxLengthPlusGirthCm: 400, maxBoxCm: null, phone: 'ALWAYS' },
  fedex: { maxWeightKg: '68', maxLengthCm: 274, maxLengthPlusGirthCm: 330, maxBoxCm: null, phone: 'ALWAYS' },
  dhl_express: { maxWeightKg: '70', maxLengthCm: null, maxLengthPlusGirthCm: null, maxBoxCm: null, phone: 'ALWAYS' },
  dhl: { maxWeightKg: '31.5', maxLengthCm: null, maxLengthPlusGirthCm: null, maxBoxCm: [120, 60, 60], phone: 'OUTSIDE_EU' },
  dpd: { maxWeightKg: '31.5', maxLengthCm: 175, maxLengthPlusGirthCm: 300, maxBoxCm: null, phone: 'OUTSIDE_EU' },
  colissimo: { maxWeightKg: '30', maxLengthCm: 150, maxLengthPlusGirthCm: 300, maxBoxCm: null, phone: 'OUTSIDE_EU' },
  chronopost: { maxWeightKg: '30', maxLengthCm: 150, maxLengthPlusGirthCm: 300, maxBoxCm: null, phone: 'OUTSIDE_EU' },
  inpost: { maxWeightKg: '25', maxLengthCm: null, maxLengthPlusGirthCm: null, maxBoxCm: [64, 41, 38], phone: 'ALWAYS' },
})

/** The rule of a carrier code, and whether one is kept for it (false: the default). */
export function carrierRuleOf(carrierCode: string | null | undefined): { readonly rule: CarrierRule; readonly kept: boolean } {
  const code = carrierCode?.trim().toLowerCase() ?? ''
  if (code !== '' && Object.hasOwn(CARRIER_RULES, code)) return { rule: CARRIER_RULES[code]!, kept: true }
  return { rule: DEFAULT_CARRIER_RULE, kept: false }
}

/** The member states of the European Union (ISO 3166-1): a parcel to any other country leaves the EU. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'])

/** The form of a postal code per country (upper-cased before the test), with an example for the words. */
export const POSTAL_CODE_FORMATS: Readonly<Record<string, { readonly pattern: RegExp; readonly example: string }>> = Object.freeze({
  IT: { pattern: /^\d{5}$/, example: '20121' },
  SM: { pattern: /^4789\d$/, example: '47890' },
  VA: { pattern: /^00120$/, example: '00120' },
  DE: { pattern: /^\d{5}$/, example: '10115' },
  FR: { pattern: /^\d{5}$/, example: '75001' },
  MC: { pattern: /^980\d{2}$/, example: '98000' },
  ES: { pattern: /^\d{5}$/, example: '28001' },
  PT: { pattern: /^\d{4}-\d{3}$/, example: '1000-001' },
  NL: { pattern: /^\d{4} ?[A-Z]{2}$/, example: '1011 AB' },
  BE: { pattern: /^\d{4}$/, example: '1000' },
  LU: { pattern: /^(L-)?\d{4}$/, example: '1009' },
  AT: { pattern: /^\d{4}$/, example: '1010' },
  CH: { pattern: /^\d{4}$/, example: '8001' },
  LI: { pattern: /^\d{4}$/, example: '9490' },
  DK: { pattern: /^\d{4}$/, example: '1050' },
  SE: { pattern: /^\d{3} ?\d{2}$/, example: '111 22' },
  FI: { pattern: /^\d{5}$/, example: '00100' },
  NO: { pattern: /^\d{4}$/, example: '0150' },
  IS: { pattern: /^\d{3}$/, example: '101' },
  PL: { pattern: /^\d{2}-\d{3}$/, example: '00-001' },
  CZ: { pattern: /^\d{3} ?\d{2}$/, example: '110 00' },
  SK: { pattern: /^\d{3} ?\d{2}$/, example: '811 01' },
  HU: { pattern: /^\d{4}$/, example: '1011' },
  SI: { pattern: /^(SI-)?\d{4}$/, example: '1000' },
  HR: { pattern: /^\d{5}$/, example: '10000' },
  RO: { pattern: /^\d{6}$/, example: '010011' },
  BG: { pattern: /^\d{4}$/, example: '1000' },
  GR: { pattern: /^\d{3} ?\d{2}$/, example: '105 57' },
  CY: { pattern: /^\d{4}$/, example: '1010' },
  MT: { pattern: /^[A-Z]{3} ?\d{4}$/, example: 'VLT 1117' },
  EE: { pattern: /^\d{5}$/, example: '10111' },
  LV: { pattern: /^(LV-)?\d{4}$/, example: 'LV-1050' },
  LT: { pattern: /^(LT-)?\d{5}$/, example: 'LT-01100' },
  IE: { pattern: /^[A-Z]\d[\dW] ?[A-Z\d]{4}$/, example: 'D02 X285' },
  GB: { pattern: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/, example: 'SW1A 1AA' },
  US: { pattern: /^\d{5}(-\d{4})?$/, example: '10001' },
  CA: { pattern: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/, example: 'K1A 0B1' },
  AU: { pattern: /^\d{4}$/, example: '2000' },
  JP: { pattern: /^\d{3}-?\d{4}$/, example: '100-0001' },
})

/** A phone as carriers take it: digits with an optional leading +, spaces, dots, dashes, slashes and brackets; 6 to 15 digits. */
const PHONE = /^\+?[0-9 ()./-]+$/

export const isPhone = (value: string): boolean => {
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '').length
  return PHONE.test(trimmed) && digits >= 6 && digits <= 15
}

/** One problem of the check. `params` are what the words say; the screens word the code with them. */
export interface CheckProblem {
  readonly code: CheckCode
  /** The parcel it is about (its place in the shipment); null: the shipment (addresses, service). */
  readonly parcelSeq: number | null
  /** Where it is, as the request names it (`shipment/shipTo/postalCode`, `parcels/2/grossWeightKg`). */
  readonly path: string
  readonly params: Readonly<Record<string, string | number>>
  readonly words: string
}

/** The words of each code, from its parameters. */
export function checkWords(code: CheckCode, params: Readonly<Record<string, string | number>>): string {
  const p = (key: string): string => String(params[key] ?? '')
  switch (code) {
    case 'SENDER_INCOMPLETE':
      return `The sender's address (the site's shipping settings) lacks ${p('fields')}.`
    case 'RECIPIENT_INCOMPLETE':
      return `The delivery address lacks ${p('fields')}.`
    case 'POSTAL_CODE':
      return `${p('who') === 'sender' ? "The sender's" : 'The delivery'} postal code "${p('value')}" is not a postal code of ${p('country')} (like ${p('example')}).`
    case 'PHONE_NEEDED':
      return p('why') === 'OUTSIDE_EU'
        ? `A parcel leaving the European Union needs the recipient's phone (for customs): add it to the delivery address.`
        : `${p('carrier')} needs the recipient's phone: add it to the delivery address.`
    case 'PHONE_FORMAT':
      return `The recipient's phone "${p('value')}" is not a phone number (digits, with + and spaces).`
    case 'NO_SERVICE':
      return 'Choose the carrier service for the shipment (or a default one in the site settings).'
    case 'NO_WEIGHT':
      return `Parcel ${p('seq')} has no weight: weigh it first.`
    case 'TOO_HEAVY':
      return `Parcel ${p('seq')} weighs ${p('weightKg')} kg; ${p('carrier')} takes at most ${p('maxKg')} kg a parcel: repack it into lighter parcels.`
    case 'SIZES_PARTIAL':
      return `Parcel ${p('seq')} has only some of its sizes: give length, width and height, or none.`
    case 'TOO_LONG':
      return `Parcel ${p('seq')} is ${p('lengthCm')} cm on its longest side; ${p('carrier')} takes at most ${p('maxCm')} cm.`
    case 'TOO_BIG':
      return `Parcel ${p('seq')} measures ${p('sumCm')} cm in length plus girth; ${p('carrier')} takes at most ${p('maxCm')} cm.`
    case 'DOES_NOT_FIT':
      return `Parcel ${p('seq')} (${p('sizesCm')} cm) does not fit ${p('carrier')}'s largest parcel (${p('boxCm')} cm).`
  }
}

/** A parcel as the check reads it (decimal strings; null: not measured). */
export interface CheckParcel {
  readonly seq: number
  readonly grossWeightKg: string | null
  readonly lengthCm: string | null
  readonly widthCm: string | null
  readonly heightCm: string | null
}

/** What the check reads of a shipment. */
export interface CheckFacts {
  readonly carrierCode: string | null
  /** The site's sender address (its shipping settings), or null without settings. */
  readonly sender: unknown
  /** The shipment's ship-to. */
  readonly recipient: unknown
  readonly serviceCode: string | null
  readonly parcels: readonly CheckParcel[]
}

export interface CheckOutcome {
  readonly carrier: { readonly code: string | null; readonly name: string; readonly ruleKept: boolean; readonly verified: false; readonly rule: CarrierRule }
  readonly problems: readonly CheckProblem[]
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const plain = (value: string): string => {
  const parsed = parseDecimal(value)
  return parsed ? parsed.toString() : value
}

function addressProblems(value: unknown, who: 'sender' | 'recipient', at: string, problems: CheckProblem[]): void {
  const address = record(value)
  const missing = (['name', 'line1', 'postalCode', 'city', 'country'] as const).filter((key) => text(address[key]) === '')
  if (missing.length > 0) {
    const names: Record<string, string> = { name: 'who it is', line1: 'the street', postalCode: 'the postal code', city: 'the city', country: 'the country' }
    const params = { fields: missing.map((key) => names[key]).join(', ') }
    const code = who === 'sender' ? 'SENDER_INCOMPLETE' : 'RECIPIENT_INCOMPLETE'
    problems.push({ code, parcelSeq: null, path: `${at}/${missing[0]}`, params, words: checkWords(code, params) })
  }
  const country = text(address.country).toUpperCase()
  const postalCode = text(address.postalCode)
  const format = POSTAL_CODE_FORMATS[country]
  if (postalCode !== '' && format && !format.pattern.test(postalCode.toUpperCase())) {
    const params = { who, value: postalCode, country, example: format.example }
    problems.push({ code: 'POSTAL_CODE', parcelSeq: null, path: `${at}/postalCode`, params, words: checkWords('POSTAL_CODE', params) })
  }
}

/**
 * Every problem of the shipment's parcels with its carrier (empty: each parcel may be labelled). Pure: the API reads the
 * facts (labels/store.ts readLabelFacts) and refuses a buy on the carrier's rules (CARRIER_RULE_CODES) before any label.
 */
export function checkShipment(facts: CheckFacts): CheckOutcome {
  const { rule, kept } = carrierRuleOf(facts.carrierCode)
  const name = carrierNameFor('CARRIER', facts.carrierCode) ?? 'The carrier'
  const problems: CheckProblem[] = []
  addressProblems(facts.sender, 'sender', 'settings/senderAddress', problems)
  addressProblems(facts.recipient, 'recipient', 'shipment/shipTo', problems)

  const to = record(facts.recipient)
  const phone = text(to.phone)
  const country = text(to.country).toUpperCase()
  if (phone !== '' && !isPhone(phone)) {
    const params = { value: phone }
    problems.push({ code: 'PHONE_FORMAT', parcelSeq: null, path: 'shipment/shipTo/phone', params, words: checkWords('PHONE_FORMAT', params) })
  } else if (phone === '' && (rule.phone === 'ALWAYS' || (country !== '' && !EU_COUNTRIES.has(country)))) {
    const params = { carrier: name, why: rule.phone === 'ALWAYS' ? 'CARRIER' : 'OUTSIDE_EU' }
    problems.push({ code: 'PHONE_NEEDED', parcelSeq: null, path: 'shipment/shipTo/phone', params, words: checkWords('PHONE_NEEDED', params) })
  }
  if (text(facts.serviceCode) === '') problems.push({ code: 'NO_SERVICE', parcelSeq: null, path: 'shipment/serviceCode', params: {}, words: checkWords('NO_SERVICE', {}) })

  for (const parcel of [...facts.parcels].sort((a, b) => a.seq - b.seq)) {
    const seq = parcel.seq
    const weight = parcel.grossWeightKg === null ? null : parseDecimal(parcel.grossWeightKg)
    if (weight === null || !weight.greaterThan(0)) {
      problems.push({ code: 'NO_WEIGHT', parcelSeq: seq, path: `parcels/${seq}/grossWeightKg`, params: { seq }, words: checkWords('NO_WEIGHT', { seq }) })
    } else if (rule.maxWeightKg !== null && weight.greaterThan(rule.maxWeightKg)) {
      const params = { seq, weightKg: plain(parcel.grossWeightKg!), carrier: name, maxKg: rule.maxWeightKg }
      problems.push({ code: 'TOO_HEAVY', parcelSeq: seq, path: `parcels/${seq}/grossWeightKg`, params, words: checkWords('TOO_HEAVY', params) })
    }
    const sizes = [parcel.lengthCm, parcel.widthCm, parcel.heightCm]
    if (sizes.every((size) => size === null)) continue
    if (sizes.some((size) => size === null)) {
      problems.push({ code: 'SIZES_PARTIAL', parcelSeq: seq, path: `parcels/${seq}`, params: { seq }, words: checkWords('SIZES_PARTIAL', { seq }) })
      continue
    }
    const sorted = sizes.map((size) => Number(parseDecimal(size)?.toString() ?? 'NaN')).sort((a, b) => b - a) as [number, number, number]
    if (sorted.some((size) => !Number.isFinite(size))) continue
    const [longest, middle, shortest] = sorted
    const round = (value: number): number => Math.round(value * 100) / 100
    if (rule.maxLengthCm !== null && longest > rule.maxLengthCm) {
      const params = { seq, lengthCm: round(longest), carrier: name, maxCm: rule.maxLengthCm }
      problems.push({ code: 'TOO_LONG', parcelSeq: seq, path: `parcels/${seq}/lengthCm`, params, words: checkWords('TOO_LONG', params) })
    }
    const girth = round(longest + 2 * (middle + shortest))
    if (rule.maxLengthPlusGirthCm !== null && girth > rule.maxLengthPlusGirthCm) {
      const params = { seq, sumCm: girth, carrier: name, maxCm: rule.maxLengthPlusGirthCm }
      problems.push({ code: 'TOO_BIG', parcelSeq: seq, path: `parcels/${seq}`, params, words: checkWords('TOO_BIG', params) })
    }
    if (rule.maxBoxCm !== null && (longest > rule.maxBoxCm[0] || middle > rule.maxBoxCm[1] || shortest > rule.maxBoxCm[2])) {
      const params = { seq, sizesCm: sorted.map(round).join(' x '), carrier: name, boxCm: rule.maxBoxCm.join(' x ') }
      problems.push({ code: 'DOES_NOT_FIT', parcelSeq: seq, path: `parcels/${seq}`, params, words: checkWords('DOES_NOT_FIT', params) })
    }
  }
  return { carrier: { code: facts.carrierCode, name, ruleKept: kept, verified: false, rule }, problems }
}

/** The problems a label buy refuses on: the carrier's rules (the field checks are W1's 400s, checked before). */
export const carrierRuleProblems = (outcome: CheckOutcome): CheckProblem[] => outcome.problems.filter((problem) => CARRIER_RULE_CODES.includes(problem.code))
