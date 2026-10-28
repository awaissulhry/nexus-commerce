import { Dec, parseDecimal, ZERO, ONE_CENT, type Decimal } from '../../tax/decimal'
import { isEuMemberState } from '../../tax/eu'
import { isNaturaCode, RETIRED_NATURA_CODES } from '../../tax/natura'
import { DEFAULT_TAX_RULES_CONFIG, type TaxRulesConfig } from '../../tax/rules'
import {
  isValidCodiceFiscale,
  isValidForeignTaxId,
  isValidIban,
  isValidPartitaIva,
  normalizeTaxId,
} from '../../tax/tax-ids'
import { isItalianVatRate } from '../../tax/vat-rates'
import type { PriceBasis } from '../../tax/vat-summary'
import { vatOn } from '../../tax/vat-summary'
import { treatmentKey, type VatTreatment } from '../../tax/vat-treatment'
import {
  fifteenthOfNextMonth,
  firstNonLatin1,
  formatDateIt,
  isBasicLatinText,
  isLatin1Text,
  isLocalDate,
  monthOf,
} from './format'
import type {
  Address,
  FatturaPaBuyer,
  FatturaPaDocumentType,
  FatturaPaInvoiceInput,
  FatturaPaIssue,
  ModalitaPagamento,
  RegimeFiscale,
} from './types'

// ── Normalised input: what the builder works from once the input is valid ─────────────────────────────────────────

export interface NormalizedAddress {
  readonly street: string
  readonly streetNumber: string | null
  /** CAP: the Italian postcode, or the generic 00000 abroad. */
  readonly cap: string
  /** Comune; abroad, the foreign postcode (when given) comes first. */
  readonly city: string
  readonly province: string | null
  readonly country: string
}

export interface NormalizedParty {
  readonly idFiscaleIva: { readonly country: string; readonly code: string } | null
  readonly fiscalCode: string | null
  readonly anagrafica: { readonly name: string } | { readonly firstName: string; readonly lastName: string }
  readonly address: NormalizedAddress
}

export interface NormalizedLine {
  readonly kind: 'GOODS' | 'DEPOSIT_DEDUCTION'
  readonly description: string
  readonly quantity: Decimal
  readonly unitOfMeasure: string | null
  readonly unitPrice: Decimal
  readonly discountPercent: Decimal | null
  readonly vat: VatTreatment
  readonly itemCode: { readonly type: string; readonly value: string } | null
  readonly ddtNumber: string | null
  /** Deposit deducted: amounts taken as they are (negative). */
  readonly fixed: { readonly net: Decimal; readonly gross: Decimal } | null
}

export interface NormalizedInvoice {
  readonly documentType: FatturaPaDocumentType
  readonly number: string
  readonly date: string
  readonly priceBasis: PriceBasis
  readonly progressive: string
  readonly transmitter: { readonly country: string; readonly code: string }
  readonly seller: NormalizedParty & {
    readonly taxRegime: RegimeFiscale
    readonly rea: {
      readonly office: string
      readonly number: string
      readonly shareCapital: Decimal | null
      readonly shareholders: 'SU' | 'SM' | null
      readonly inLiquidation: boolean
    } | null
    readonly contacts: { readonly phone: string | null; readonly email: string | null } | null
  }
  readonly buyer: NormalizedParty
  readonly codiceDestinatario: string
  readonly pecDestinatario: string | null
  /** Goods lines first, in input order, then one line per deposit amount deducted. */
  readonly lines: readonly NormalizedLine[]
  readonly ddts: readonly { readonly number: string; readonly date: string }[]
  readonly purchaseOrders: readonly { readonly number: string; readonly date: string | null }[]
  /** DatiFattureCollegate: the related invoices given, then each deposit invoice deducted (no duplicates). */
  readonly relatedInvoices: readonly { readonly number: string; readonly date: string | null }[]
  readonly payment: {
    readonly condition: 'TP01' | 'TP02' | 'TP03'
    readonly installments: readonly {
      readonly method: ModalitaPagamento
      readonly amount: Decimal
      readonly dueDate: string | null
      readonly iban: string | null
      readonly bic: string | null
      readonly bankName: string | null
      readonly beneficiary: string | null
    }[]
  } | null
  readonly causale: string | null
  readonly stampDuty: 'AUTO' | 'NONE'
  readonly taxRules: TaxRulesConfig
}

// ── Checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const DOCUMENT_TYPES: readonly FatturaPaDocumentType[] = ['TD01', 'TD02', 'TD04', 'TD24']
const REGIMES: readonly string[] = [
  'RF01', 'RF02', 'RF04', 'RF05', 'RF06', 'RF07', 'RF08', 'RF09', 'RF10', 'RF11',
  'RF12', 'RF13', 'RF14', 'RF15', 'RF16', 'RF17', 'RF18', 'RF19', 'RF20',
]
const PAYMENT_METHODS: readonly string[] = Array.from({ length: 23 }, (_, i) => `MP${String(i + 1).padStart(2, '0')}`)
const MAX_AMOUNT = new Dec('99999999999.99')
// The dot-atom form of the schema's EmailType (quoted local parts left out): letters, digits and !#$%&'*+-/=?^_`{|}~,
// a dot in the domain.
const EMAIL_ATOM = "[!#-'*+/-9=?A-Z^-~-]+"
const EMAIL = new RegExp(`^${EMAIL_ATOM}(\\.${EMAIL_ATOM})*@${EMAIL_ATOM}(\\.${EMAIL_ATOM})+$`)
const BIC = /^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/

class Issues {
  readonly list: FatturaPaIssue[] = []
  add(path: string, code: string, message: string): void {
    this.list.push({ path, code, message })
  }
}

type Charset = 'LATIN1' | 'ASCII'

/** A text field: trimmed, within the schema's character set and length. Returns null (and records why) when not. */
function text(
  issues: Issues,
  path: string,
  value: unknown,
  max: number,
  options: { charset?: Charset; required?: boolean; min?: number } = {},
): string | null {
  const { charset = 'LATIN1', required = true, min = 1 } = options
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) issues.add(path, 'REQUIRED', 'is required')
    return null
  }
  if (typeof value !== 'string') {
    issues.add(path, 'NOT_TEXT', 'must be text')
    return null
  }
  const trimmed = value.trim()
  if (charset === 'ASCII' && !isBasicLatinText(trimmed)) {
    issues.add(path, 'NOT_ASCII', 'may hold only printable ASCII characters (FatturaPA basic-Latin field)')
    return null
  }
  if (charset === 'LATIN1' && !isLatin1Text(trimmed)) {
    const bad = firstNonLatin1(trimmed)
    issues.add(
      path,
      'NOT_LATIN1',
      `holds "${bad}", which FatturaPA cannot carry (Latin-1 only); replace it (for instance "EUR" for "€", "-" for a dash)`,
    )
    return null
  }
  if (trimmed.length > max || trimmed.length < min) {
    issues.add(path, 'LENGTH', min > 1 ? `must be ${min} to ${max} characters` : `must be at most ${max} characters`)
    return null
  }
  return trimmed
}

function date(issues: Issues, path: string, value: unknown, required = true): string | null {
  if (value === undefined || value === null) {
    if (required) issues.add(path, 'REQUIRED', 'is required')
    return null
  }
  if (!isLocalDate(value)) {
    issues.add(path, 'DATE_INVALID', 'must be a real date written YYYY-MM-DD')
    return null
  }
  return value
}

/** A decimal within the schema's limits: at most `decimals` decimals and 11 integer digits. */
function decimal(
  issues: Issues,
  path: string,
  value: unknown,
  rule: { decimals: number; min?: 'POSITIVE' | 'ZERO_OR_MORE' },
): Decimal | null {
  if (value === undefined || value === null) {
    issues.add(path, 'REQUIRED', 'is required')
    return null
  }
  const parsed = parseDecimal(value)
  if (parsed === null) {
    issues.add(path, 'DECIMAL_INVALID', 'must be a Decimal or a plain decimal string such as "12.50" (never a number)')
    return null
  }
  if (parsed.decimalPlaces() > rule.decimals) {
    issues.add(path, 'DECIMAL_PLACES', `may have at most ${rule.decimals} decimals`)
    return null
  }
  if (parsed.abs().gt(MAX_AMOUNT)) {
    issues.add(path, 'DECIMAL_TOO_LARGE', 'is larger than FatturaPA allows (11 integer digits)')
    return null
  }
  if (rule.min === 'POSITIVE' && parsed.lte(ZERO)) {
    issues.add(path, 'NOT_POSITIVE', 'must be more than zero')
    return null
  }
  if (rule.min === 'ZERO_OR_MORE' && parsed.lt(ZERO)) {
    issues.add(path, 'NEGATIVE', 'must be zero or more')
    return null
  }
  return parsed
}

function documentNumber(issues: Issues, path: string, value: unknown): string | null {
  const number = text(issues, path, value, 20, { charset: 'ASCII' })
  if (number !== null && !/\d/.test(number)) {
    issues.add(path, 'NUMBER_WITHOUT_DIGIT', 'must contain at least one digit (SDI 00425)')
    return null
  }
  return number
}

function email(issues: Issues, path: string, value: unknown, min = 1): string | null {
  const address = text(issues, path, value, 256, { charset: 'ASCII', required: false, min })
  if (address !== null && !EMAIL.test(address)) {
    issues.add(path, 'EMAIL_INVALID', 'is not an e-mail address')
    return null
  }
  return address
}

function italianVat(issues: Issues, path: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.add(path, 'REQUIRED', 'is required')
    return null
  }
  const normalized = normalizeTaxId(value)
  if (/^IT\d{11}$/.test(normalized)) {
    issues.add(path, 'VAT_PREFIX', 'write the Partita IVA without the IT prefix (FatturaPA carries the country apart)')
    return null
  }
  if (!isValidPartitaIva(normalized)) {
    issues.add(path, 'PARTITA_IVA_INVALID', 'is not a valid Partita IVA (11 digits with a correct check digit)')
    return null
  }
  return normalized
}

function codiceFiscale(issues: Issues, path: string, value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) issues.add(path, 'REQUIRED', 'is required')
    return null
  }
  if (typeof value !== 'string') {
    issues.add(path, 'NOT_TEXT', 'must be text')
    return null
  }
  const normalized = normalizeTaxId(value)
  if (!isValidCodiceFiscale(normalized)) {
    issues.add(
      path,
      'CODICE_FISCALE_INVALID',
      'is not a valid codice fiscale (16 characters with a correct check letter, or 11 digits for a company)',
    )
    return null
  }
  return normalized
}

function address(issues: Issues, path: string, value: Address | undefined): NormalizedAddress | null {
  if (!value || typeof value !== 'object') {
    issues.add(path, 'REQUIRED', 'is required')
    return null
  }
  const street = text(issues, `${path}.street`, value.street, 60)
  const streetNumber = text(issues, `${path}.streetNumber`, value.streetNumber, 8, { charset: 'ASCII', required: false })
  const city = text(issues, `${path}.city`, value.city, 60)
  const country = typeof value.country === 'string' ? value.country.trim().toUpperCase() : ''
  if (!/^[A-Z]{2}$/.test(country)) {
    issues.add(`${path}.country`, 'COUNTRY_INVALID', 'must be an ISO 3166-1 alpha-2 code (IT, DE, FR…)')
    return null
  }
  if (country === 'IT') {
    const postcode = typeof value.postcode === 'string' ? value.postcode.trim() : ''
    if (!/^\d{5}$/.test(postcode)) issues.add(`${path}.postcode`, 'CAP_INVALID', 'an Italian postcode is 5 digits')
    const province = typeof value.province === 'string' ? value.province.trim().toUpperCase() : ''
    if (!/^[A-Z]{2}$/.test(province)) {
      issues.add(`${path}.province`, 'PROVINCE_INVALID', 'an Italian address needs its province, 2 letters (MI, RM…)')
    }
    if (street === null || city === null || !/^\d{5}$/.test(postcode) || !/^[A-Z]{2}$/.test(province)) return null
    return { street, streetNumber, cap: postcode, city, province, country }
  }
  if (value.province !== undefined) {
    issues.add(`${path}.province`, 'PROVINCE_ABROAD', 'a province is only written for an Italian address')
  }
  // Abroad: CAP is the generic 00000 (Agenzia delle Entrate FAQ on foreign customers); the real postcode is kept in
  // the city field so the address stays complete.
  const postcode = text(issues, `${path}.postcode`, value.postcode, 20, { charset: 'ASCII', required: false })
  if (street === null || city === null) return null
  const comune = postcode === null ? city : `${postcode} ${city}`
  if (comune.length > 60) {
    issues.add(`${path}.city`, 'LENGTH', 'postcode and city together must be at most 60 characters')
    return null
  }
  return { street, streetNumber, cap: '00000', city: comune, province: null, country }
}

/** Person (first and last name) or organisation (name), one or the other. */
function anagrafica(
  issues: Issues,
  path: string,
  value: { firstName?: string; lastName?: string; name?: string },
): NormalizedParty['anagrafica'] | null {
  const hasPerson = value.firstName !== undefined || value.lastName !== undefined
  if (value.name !== undefined && hasPerson) {
    issues.add(path, 'NAME_AND_PERSON', 'give either name (an organisation) or firstName and lastName (a person), not both')
    return null
  }
  if (value.name !== undefined || !hasPerson) {
    const name = text(issues, `${path}.name`, value.name, 80)
    return name === null ? null : { name }
  }
  const firstName = text(issues, `${path}.firstName`, value.firstName, 60)
  const lastName = text(issues, `${path}.lastName`, value.lastName, 60)
  return firstName === null || lastName === null ? null : { firstName, lastName }
}

function treatment(issues: Issues, path: string, value: VatTreatment | undefined): VatTreatment | null {
  if (!value || typeof value !== 'object') {
    issues.add(path, 'REQUIRED', 'is required')
    return null
  }
  if (value.kind === 'TAXABLE') {
    if (!isItalianVatRate(value.rate)) {
      issues.add(`${path}.rate`, 'VAT_RATE_INVALID', 'must be an Italian VAT rate: 22, 10, 5 or 4')
      return null
    }
    if (value.exigibility !== undefined && value.exigibility !== 'I' && value.exigibility !== 'D') {
      issues.add(`${path}.exigibility`, 'EXIGIBILITY_INVALID', 'must be I (immediate) or D (deferred)')
      return null
    }
    return value
  }
  if (value.kind === 'NON_TAXABLE') {
    if ((RETIRED_NATURA_CODES as readonly string[]).includes(value.natura)) {
      issues.add(
        `${path}.natura`,
        'NATURA_RETIRED',
        `${value.natura} is a parent code SDI refuses since 2021 (00445): use a detailed code such as N2.1 or N3.2`,
      )
      return null
    }
    if (!isNaturaCode(value.natura)) {
      issues.add(`${path}.natura`, 'NATURA_INVALID', 'is not a FatturaPA Natura code')
      return null
    }
    const wording = text(issues, `${path}.legalReference`, value.legalReference, 100)
    if (wording === null) return null
    return { kind: 'NON_TAXABLE', natura: value.natura, legalReference: wording }
  }
  issues.add(`${path}.kind`, 'VAT_KIND_INVALID', 'must be TAXABLE or NON_TAXABLE')
  return null
}

function sdiDelivery(
  issues: Issues,
  path: string,
  sdiCode: unknown,
  pec: unknown,
): { codiceDestinatario: string; pecDestinatario: string | null } | null {
  let code: string | null = null
  if (sdiCode !== undefined) {
    const normalized = typeof sdiCode === 'string' ? sdiCode.trim().toUpperCase() : ''
    if (/^[A-Z0-9]{6}$/.test(normalized)) {
      issues.add(
        `${path}.sdiCode`,
        'SDI_CODE_PUBLIC_ADMINISTRATION',
        '6-character codes belong to public bodies (format FPA12), which are not built; a business code has 7 characters (SDI 00427)',
      )
      return null
    }
    if (normalized === 'XXXXXXX') {
      issues.add(`${path}.sdiCode`, 'SDI_CODE_FOREIGN', 'XXXXXXX is only for buyers outside Italy (SDI 00313)')
      return null
    }
    if (!/^[A-Z0-9]{7}$/.test(normalized)) {
      issues.add(`${path}.sdiCode`, 'SDI_CODE_INVALID', 'an SDI recipient code is 7 letters or digits')
      return null
    }
    code = normalized
  }
  const pecAddress = email(issues, `${path}.pec`, pec)
  if (pec !== undefined && pecAddress === null) return null
  if (code !== null && code !== '0000000') return { codiceDestinatario: code, pecDestinatario: null }
  return { codiceDestinatario: '0000000', pecDestinatario: pecAddress }
}

function buyer(
  issues: Issues,
  value: FatturaPaBuyer | undefined,
  sellerVat: string | null,
): { party: NormalizedParty; codiceDestinatario: string; pecDestinatario: string | null } | null {
  if (!value || typeof value !== 'object') {
    issues.add('buyer', 'REQUIRED', 'is required')
    return null
  }
  if (value.kind === 'IT_BUSINESS') {
    const vat = italianVat(issues, 'buyer.vatNumber', value.vatNumber)
    if (vat !== null && vat === sellerVat) {
      issues.add('buyer.vatNumber', 'BUYER_IS_SELLER', 'the buyer cannot be the seller on this document type (SDI 00471)')
    }
    const fiscalCode = codiceFiscale(issues, 'buyer.fiscalCode', value.fiscalCode, false)
    const name = text(issues, 'buyer.name', value.name, 80)
    // A foreign company identified for VAT in Italy (directly or by a fiscal representative) has an Italian
    // Partita IVA and may have its address abroad, so the address country is not checked against the id.
    const place = address(issues, 'buyer.address', value.address)
    const delivery = sdiDelivery(issues, 'buyer', value.sdiCode, value.pec)
    if (vat === null || name === null || place === null || delivery === null) return null
    return {
      party: { idFiscaleIva: { country: 'IT', code: vat }, fiscalCode, anagrafica: { name }, address: place },
      ...delivery,
    }
  }
  if (value.kind === 'IT_CONSUMER') {
    const fiscalCode = codiceFiscale(issues, 'buyer.fiscalCode', value.fiscalCode, true)
    const names = anagrafica(issues, 'buyer', value)
    const place = address(issues, 'buyer.address', value.address)
    const delivery = sdiDelivery(issues, 'buyer', value.sdiCode, value.pec)
    if (fiscalCode === null || names === null || place === null || delivery === null) return null
    return { party: { idFiscaleIva: null, fiscalCode, anagrafica: names, address: place }, ...delivery }
  }
  if (value.kind === 'FOREIGN') {
    const country = typeof value.country === 'string' ? value.country.trim().toUpperCase() : ''
    let countryOk = true
    if (!/^[A-Z]{2}$/.test(country)) {
      issues.add('buyer.country', 'COUNTRY_INVALID', 'must be an ISO 3166-1 alpha-2 code')
      countryOk = false
    } else if (country === 'IT') {
      issues.add(
        'buyer.country',
        'FOREIGN_BUYER_ITALIAN',
        'a buyer with an Italian tax id is IT_BUSINESS or IT_CONSUMER (XXXXXXX needs a country other than IT, SDI 00313)',
      )
      countryOk = false
    }
    let taxId: string | null = null
    if (typeof value.taxId !== 'string' || value.taxId.trim() === '') {
      issues.add('buyer.taxId', 'REQUIRED', 'is required: the tax id the buyer has in its country (IdCodice)')
    } else {
      const normalized = normalizeTaxId(value.taxId).replace(/[.\-/]/g, '')
      const prefix = country === 'GR' ? 'EL' : country
      if (countryOk && isEuMemberState(country) && normalized.startsWith(prefix) && normalized.length > prefix.length) {
        issues.add('buyer.taxId', 'VAT_PREFIX', `write the VAT number without the ${prefix} prefix (IdPaese carries it)`)
      } else if (!isValidForeignTaxId(normalized)) {
        issues.add('buyer.taxId', 'FOREIGN_TAX_ID_INVALID', 'must be 1 to 28 letters or digits')
      } else {
        taxId = normalized
      }
    }
    const names = anagrafica(issues, 'buyer', value)
    const place = address(issues, 'buyer.address', value.address)
    if (!countryOk || taxId === null || names === null || place === null) return null
    return {
      party: { idFiscaleIva: { country, code: taxId }, fiscalCode: null, anagrafica: names, address: place },
      codiceDestinatario: 'XXXXXXX',
      pecDestinatario: null,
    }
  }
  issues.add('buyer.kind', 'BUYER_KIND_INVALID', 'must be IT_BUSINESS, IT_CONSUMER or FOREIGN')
  return null
}

/**
 * Checks the input against the FatturaPA schema, the SDI checks that can be made offline and the tax rules, and
 * returns every issue together with the normalised input (null when there is any issue).
 */
export function validateFatturaPaInput(input: FatturaPaInvoiceInput): {
  readonly issues: readonly FatturaPaIssue[]
  readonly normalized: NormalizedInvoice | null
} {
  const issues = new Issues()

  // Document.
  const documentType = DOCUMENT_TYPES.includes(input.documentType) ? input.documentType : null
  if (documentType === null) issues.add('documentType', 'DOCUMENT_TYPE_INVALID', 'must be TD01, TD02, TD04 or TD24')
  const number = documentNumber(issues, 'number', input.number)
  const invoiceDate = date(issues, 'date', input.date)
  if (input.currency !== undefined && input.currency !== 'EUR') {
    issues.add('currency', 'CURRENCY_NOT_BUILT', 'only EUR invoices are built')
  }
  const priceBasis: PriceBasis = input.priceBasis ?? 'NET'
  if (priceBasis !== 'NET' && priceBasis !== 'GROSS') issues.add('priceBasis', 'PRICE_BASIS_INVALID', 'must be NET or GROSS')
  const stampDuty = input.stampDuty ?? 'AUTO'
  if (stampDuty !== 'AUTO' && stampDuty !== 'NONE') issues.add('stampDuty', 'STAMP_DUTY_INVALID', 'must be AUTO or NONE')
  const progressive = typeof input.transmission?.progressive === 'string' ? input.transmission.progressive.trim() : ''
  if (!/^[A-Za-z0-9]{1,5}$/.test(progressive)) {
    issues.add('transmission.progressive', 'PROGRESSIVE_INVALID', 'must be 1 to 5 letters or digits (it is part of the SDI file name)')
  }
  const causale = text(issues, 'causale', input.causale, 2000, { required: false })

  // Seller.
  const seller = input.seller
  const sellerVat = italianVat(issues, 'seller.vatNumber', seller?.vatNumber)
  const sellerFiscalCode = codiceFiscale(issues, 'seller.fiscalCode', seller?.fiscalCode, false)
  const sellerName = text(issues, 'seller.name', seller?.name, 80)
  if (!REGIMES.includes(seller?.taxRegime)) issues.add('seller.taxRegime', 'REGIME_INVALID', 'must be a RegimeFiscale code, RF01 for the ordinary regime')
  const sellerAddress = address(issues, 'seller.address', seller?.address)
  if (sellerAddress !== null && sellerAddress.country !== 'IT') {
    issues.add('seller.address.country', 'SELLER_NOT_ITALIAN', 'the seller is an Italian company with its registered office in Italy')
  }
  let rea: NormalizedInvoice['seller']['rea'] = null
  if (seller?.rea !== undefined) {
    const office = typeof seller.rea.office === 'string' ? seller.rea.office.trim().toUpperCase() : ''
    if (!/^[A-Z]{2}$/.test(office)) issues.add('seller.rea.office', 'PROVINCE_INVALID', 'is the province of the register office, 2 letters')
    const reaNumber = text(issues, 'seller.rea.number', seller.rea.number, 20, { charset: 'ASCII' })
    const capital =
      seller.rea.shareCapital === undefined
        ? null
        : decimal(issues, 'seller.rea.shareCapital', seller.rea.shareCapital, { decimals: 2, min: 'ZERO_OR_MORE' })
    const shareholders = seller.rea.shareholders ?? null
    if (shareholders !== null && shareholders !== 'SU' && shareholders !== 'SM') {
      issues.add('seller.rea.shareholders', 'SHAREHOLDERS_INVALID', 'must be SU (one shareholder) or SM (several)')
    }
    if (typeof seller.rea.inLiquidation !== 'boolean') issues.add('seller.rea.inLiquidation', 'REQUIRED', 'is required (true or false)')
    if (/^[A-Z]{2}$/.test(office) && reaNumber !== null) {
      rea = { office, number: reaNumber, shareCapital: capital, shareholders, inLiquidation: seller.rea.inLiquidation === true }
    }
  }
  let contacts: NormalizedInvoice['seller']['contacts'] = null
  if (seller?.contacts !== undefined) {
    const phone = text(issues, 'seller.contacts.phone', seller.contacts.phone, 12, { charset: 'ASCII', required: false, min: 5 })
    const mail = email(issues, 'seller.contacts.email', seller.contacts.email, 7)
    contacts = { phone, email: mail }
  }

  // Transmitter.
  let transmitter = { country: 'IT', code: sellerFiscalCode ?? sellerVat ?? '' }
  if (input.transmission?.transmitter !== undefined) {
    const country = String(input.transmission.transmitter.country ?? '').trim().toUpperCase()
    const code = normalizeTaxId(String(input.transmission.transmitter.code ?? ''))
    if (!/^[A-Z]{2}$/.test(country)) issues.add('transmission.transmitter.country', 'COUNTRY_INVALID', 'must be an ISO 3166-1 alpha-2 code')
    if (!/^[A-Z0-9]{1,28}$/.test(code)) issues.add('transmission.transmitter.code', 'TRANSMITTER_INVALID', 'must be 1 to 28 letters or digits')
    transmitter = { country, code }
  }

  // Buyer.
  const buyerResult = buyer(issues, input.buyer, sellerVat)

  // Lines.
  const goods: NormalizedLine[] = []
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    issues.add('lines', 'LINES_EMPTY', 'a document needs at least one line')
  }
  const ddtNumbers = new Set((input.ddts ?? []).map((ddt) => (typeof ddt?.number === 'string' ? ddt.number.trim() : '')))
  ;(input.lines ?? []).forEach((line, index) => {
    const path = `lines[${index}]`
    const description = text(issues, `${path}.description`, line?.description, 1000)
    const quantity = decimal(issues, `${path}.quantity`, line?.quantity, { decimals: 8, min: 'POSITIVE' })
    const unitPrice = decimal(issues, `${path}.unitPrice`, line?.unitPrice, { decimals: 8, min: 'ZERO_OR_MORE' })
    let discount: Decimal | null = null
    if (line?.discountPercent !== undefined) {
      discount = decimal(issues, `${path}.discountPercent`, line.discountPercent, { decimals: 2, min: 'POSITIVE' })
      if (discount !== null && discount.gte(new Dec(100))) {
        issues.add(`${path}.discountPercent`, 'DISCOUNT_INVALID', 'must be less than 100')
        discount = null
      }
    }
    const unitOfMeasure = text(issues, `${path}.unitOfMeasure`, line?.unitOfMeasure, 10, { charset: 'ASCII', required: false })
    let itemCode: NormalizedLine['itemCode'] = null
    if (line?.itemCode !== undefined) {
      const type = text(issues, `${path}.itemCode.type`, line.itemCode.type, 35, { charset: 'ASCII' })
      const value = text(issues, `${path}.itemCode.value`, line.itemCode.value, 35)
      if (type !== null && value !== null) itemCode = { type, value }
    }
    const vat = treatment(issues, `${path}.vat`, line?.vat)
    let ddtNumber: string | null = null
    if (line?.ddtNumber !== undefined) {
      ddtNumber = typeof line.ddtNumber === 'string' ? line.ddtNumber.trim() : ''
      if (!ddtNumbers.has(ddtNumber)) {
        issues.add(`${path}.ddtNumber`, 'LINE_DDT_UNKNOWN', 'names a DDT that is not in ddts')
        ddtNumber = null
      }
    }
    if (description !== null && quantity !== null && unitPrice !== null && vat !== null) {
      goods.push({
        kind: 'GOODS',
        description,
        quantity,
        unitOfMeasure,
        unitPrice,
        discountPercent: discount,
        vat,
        itemCode,
        ddtNumber,
        fixed: null,
      })
    }
  })

  // DDTs.
  const ddts: { number: string; date: string }[] = []
  const ddtList = input.ddts ?? []
  if (documentType === 'TD24' && ddtList.length === 0) {
    issues.add('ddts', 'TD24_NEEDS_DDT', 'a deferred invoice (TD24) names the DDTs it invoices (DPR 633/1972 art. 21 c.4)')
  }
  if ((documentType === 'TD02' || documentType === 'TD04') && ddtList.length > 0) {
    issues.add('ddts', 'DDT_NOT_ALLOWED', `a ${documentType} does not invoice DDTs`)
  }
  const seenDdt = new Set<string>()
  ddtList.forEach((ddt, index) => {
    const ddtNumber = text(issues, `ddts[${index}].number`, ddt?.number, 20, { charset: 'ASCII' })
    const ddtDate = date(issues, `ddts[${index}].date`, ddt?.date)
    if (ddtNumber !== null && seenDdt.has(ddtNumber)) issues.add(`ddts[${index}].number`, 'DDT_DUPLICATE', 'is listed twice')
    if (ddtDate !== null && invoiceDate !== null && ddtDate > invoiceDate) {
      issues.add(`ddts[${index}].date`, 'DDT_AFTER_INVOICE', 'a DDT cannot be dated after the invoice')
    }
    if (ddtNumber !== null && ddtDate !== null) {
      seenDdt.add(ddtNumber)
      ddts.push({ number: ddtNumber, date: ddtDate })
    }
  })
  if (documentType === 'TD24' && ddts.length > 0 && invoiceDate !== null) {
    const months = new Set(ddts.map((ddt) => monthOf(ddt.date)))
    if (months.size > 1) {
      issues.add(
        'ddts',
        'TD24_DDTS_MONTHS',
        'one deferred invoice covers the DDTs of one calendar month (DPR 633/1972 art. 21 c.4 lett. a)',
      )
    } else {
      const deadline = fifteenthOfNextMonth(ddts[0]!.date)
      if (invoiceDate > deadline) {
        issues.add(
          'date',
          'TD24_LATE',
          `a deferred invoice for DDTs of ${monthOf(ddts[0]!.date)} is issued by ${deadline} (DPR 633/1972 art. 21 c.4 lett. a)`,
        )
      }
    }
  }
  if (ddts.length > 1) {
    goods.forEach((line, index) => {
      if (line.ddtNumber === null) {
        issues.add(`lines[${index}].ddtNumber`, 'LINE_DDT_MISSING', 'with several DDTs, each line names the DDT it shipped on')
      }
    })
    ddts.forEach((ddt, index) => {
      if (!goods.some((line) => line.ddtNumber === ddt.number)) {
        issues.add(`ddts[${index}]`, 'DDT_WITHOUT_LINES', 'no line of this invoice shipped on this DDT')
      }
    })
  }

  // Related documents.
  const related = (path: string, list: readonly { number?: string; date?: string }[] | undefined, notAfterInvoice: boolean) =>
    (list ?? []).flatMap((doc, index) => {
      const docNumber = text(issues, `${path}[${index}].number`, doc?.number, 20, { charset: 'ASCII' })
      const docDate = date(issues, `${path}[${index}].date`, doc?.date, false)
      if (notAfterInvoice && docDate !== null && invoiceDate !== null && docDate > invoiceDate) {
        issues.add(`${path}[${index}].date`, 'RELATED_AFTER_INVOICE', 'the related invoice cannot be dated after this one (SDI 00418)')
      }
      return docNumber === null ? [] : [{ number: docNumber, date: docDate }]
    })
  const purchaseOrders = related('purchaseOrders', input.purchaseOrders, false)
  const relatedInvoices = related('relatedInvoices', input.relatedInvoices, true)
  if (documentType === 'TD04' && (input.relatedInvoices ?? []).length === 0) {
    issues.add('relatedInvoices', 'TD04_NEEDS_INVOICE', 'a credit note names the invoice it corrects (DPR 633/1972 art. 26)')
  }

  // Deposits deducted.
  const deductions: NormalizedLine[] = []
  const deductionList = input.depositDeductions ?? []
  if (deductionList.length > 0 && (documentType === 'TD02' || documentType === 'TD04')) {
    issues.add('depositDeductions', 'DEPOSIT_DEDUCTION_NOT_ALLOWED', `a ${documentType} cannot deduct a deposit; only TD01 and TD24 do`)
  }
  const goodsKeys = new Set(goods.map((line) => treatmentKey(line.vat)))
  deductionList.forEach((deduction, index) => {
    const path = `depositDeductions[${index}]`
    const depositNumber = documentNumber(issues, `${path}.invoiceNumber`, deduction?.invoiceNumber)
    const depositDate = date(issues, `${path}.invoiceDate`, deduction?.invoiceDate)
    if (depositDate !== null && invoiceDate !== null && depositDate > invoiceDate) {
      issues.add(`${path}.invoiceDate`, 'RELATED_AFTER_INVOICE', 'the deposit invoice cannot be dated after this one (SDI 00418)')
    }
    const description =
      deduction?.description === undefined
        ? depositNumber !== null && depositDate !== null
          ? `Storno acconto fattura n. ${depositNumber} del ${formatDateIt(depositDate)}`
          : null
        : text(issues, `${path}.description`, deduction.description, 1000)
    if (!Array.isArray(deduction?.amounts) || deduction.amounts.length === 0) {
      issues.add(`${path}.amounts`, 'REQUIRED', 'a deposit deducted has at least one amount')
    }
    ;(deduction?.amounts ?? []).forEach((amount, amountIndex) => {
      const amountPath = `${path}.amounts[${amountIndex}]`
      const vat = treatment(issues, `${amountPath}.vat`, amount?.vat)
      const taxableAmount = decimal(issues, `${amountPath}.taxable`, amount?.taxable, { decimals: 2, min: 'POSITIVE' })
      const vatAmount = decimal(issues, `${amountPath}.vatAmount`, amount?.vatAmount, { decimals: 2, min: 'ZERO_OR_MORE' })
      if (vat === null || taxableAmount === null || vatAmount === null) return
      if (vat.kind === 'TAXABLE' && vatAmount.minus(vatOn(taxableAmount, vat)).abs().gt(ONE_CENT)) {
        issues.add(`${amountPath}.vatAmount`, 'DEPOSIT_VAT_MISMATCH', `is not the ${vat.rate}% VAT of the taxable amount`)
        return
      }
      if (vat.kind === 'NON_TAXABLE' && !vatAmount.isZero()) {
        issues.add(`${amountPath}.vatAmount`, 'DEPOSIT_VAT_MISMATCH', 'a non-taxable deposit carries no VAT')
        return
      }
      if (!goodsKeys.has(treatmentKey(vat))) {
        issues.add(`${amountPath}.vat`, 'DEPOSIT_TREATMENT_UNMATCHED', 'no line of this invoice has the VAT treatment of this deposit')
        return
      }
      if (description === null) return
      deductions.push({
        kind: 'DEPOSIT_DEDUCTION',
        description,
        quantity: new Dec(1),
        unitOfMeasure: null,
        unitPrice: taxableAmount.negated(),
        discountPercent: null,
        vat,
        itemCode: null,
        ddtNumber: null,
        fixed: { net: taxableAmount.negated(), gross: taxableAmount.plus(vatAmount).negated() },
      })
    })
    if (depositNumber !== null && !relatedInvoices.some((doc) => doc.number === depositNumber)) {
      relatedInvoices.push({ number: depositNumber, date: depositDate })
    }
  })

  if (goods.length + deductions.length > 9999) issues.add('lines', 'TOO_MANY_LINES', 'FatturaPA allows at most 9999 lines')

  // Payment.
  let payment: NormalizedInvoice['payment'] = null
  if (input.payment !== undefined) {
    const condition = input.payment.condition
    if (condition !== 'TP01' && condition !== 'TP02' && condition !== 'TP03') {
      issues.add('payment.condition', 'PAYMENT_CONDITION_INVALID', 'must be TP01 (instalments), TP02 (in full) or TP03 (advance)')
    }
    const list = input.payment.installments ?? []
    if (condition === 'TP01' && list.length < 2) issues.add('payment.installments', 'INSTALLMENTS_COUNT', 'TP01 (instalments) needs two or more')
    if ((condition === 'TP02' || condition === 'TP03') && list.length !== 1) {
      issues.add('payment.installments', 'INSTALLMENTS_COUNT', `${condition} has exactly one payment`)
    }
    const installments = list.flatMap((item, index) => {
      const path = `payment.installments[${index}]`
      if (!PAYMENT_METHODS.includes(item?.method)) issues.add(`${path}.method`, 'PAYMENT_METHOD_INVALID', 'must be a ModalitaPagamento code, MP01 to MP23')
      const amount = decimal(issues, `${path}.amount`, item?.amount, { decimals: 2, min: 'POSITIVE' })
      const dueDate = date(issues, `${path}.dueDate`, item?.dueDate, false)
      let iban: string | null = null
      if (item?.iban !== undefined) {
        iban = normalizeTaxId(String(item.iban))
        if (!isValidIban(iban)) {
          issues.add(`${path}.iban`, 'IBAN_INVALID', 'is not a valid IBAN (format and check digits)')
          iban = null
        }
      }
      let bic: string | null = null
      if (item?.bic !== undefined) {
        bic = normalizeTaxId(String(item.bic))
        if (!BIC.test(bic)) {
          issues.add(`${path}.bic`, 'BIC_INVALID', 'is not a valid BIC')
          bic = null
        }
      }
      const bankName = text(issues, `${path}.bankName`, item?.bankName, 80, { required: false })
      const beneficiary = text(issues, `${path}.beneficiary`, item?.beneficiary, 200, { required: false })
      if (amount === null || !PAYMENT_METHODS.includes(item?.method)) return []
      return [{ method: item.method, amount, dueDate, iban, bic, bankName, beneficiary }]
    })
    if (condition === 'TP01' || condition === 'TP02' || condition === 'TP03') payment = { condition, installments }
  }

  // Tax rule settings.
  const taxRules = input.taxRules ?? DEFAULT_TAX_RULES_CONFIG
  if (parseDecimal(taxRules.stampDuty?.threshold) === null || parseDecimal(taxRules.stampDuty?.amount) === null) {
    issues.add('taxRules.stampDuty', 'STAMP_DUTY_CONFIG_INVALID', 'threshold and amount must be plain decimal strings')
  }

  if (
    issues.list.length > 0 ||
    documentType === null ||
    number === null ||
    invoiceDate === null ||
    sellerVat === null ||
    sellerName === null ||
    sellerAddress === null ||
    buyerResult === null
  ) {
    return { issues: issues.list, normalized: null }
  }

  return {
    issues: [],
    normalized: {
      documentType,
      number,
      date: invoiceDate,
      priceBasis,
      progressive,
      transmitter,
      seller: {
        idFiscaleIva: { country: 'IT', code: sellerVat },
        fiscalCode: sellerFiscalCode,
        anagrafica: { name: sellerName },
        address: sellerAddress,
        taxRegime: seller.taxRegime,
        rea,
        contacts,
      },
      buyer: buyerResult.party,
      codiceDestinatario: buyerResult.codiceDestinatario,
      pecDestinatario: buyerResult.pecDestinatario,
      lines: [...goods, ...deductions],
      ddts,
      purchaseOrders,
      relatedInvoices,
      payment,
      causale,
      stampDuty,
      taxRules,
    },
  }
}
