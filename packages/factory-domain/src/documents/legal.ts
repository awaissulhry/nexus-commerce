import type { Issue } from '../core/errors'
import { isCurrencyCode } from '../core/money'
import { parseDecimal } from '../tax/decimal'
import { formatMajorAmount } from './format'
import { countryName, DOCUMENT_WORDS } from './i18n'
import type { CompanyLegal, DocumentLanguage, PostalAddress } from './model'

/**
 * The company's legal block (codice civile art. 2250; DPR 633/1972 art. 35 for the VAT number): the lines every
 * document of the company prints under its name, and again in the footer of every page.
 *
 *   Pelletteria Fittizia S.r.l.                               (+ "in liquidazione" when it is, c. 3)
 *   Sede legale: Via dei Conciatori Finti 1, 20121 Milano (MI)  the registered office (c. 1)
 *   P. IVA IT12345670009 · C.F. 12345670009
 *   Registro Imprese di MI n. 12345670009 · REA MI-0000001    the register office and the registration number (c. 1)
 *   Capitale sociale versato € 10.000,00                      the paid-in capital, when there is one (c. 2)
 *   Società con socio unico                                   a single shareholder, when recorded (c. 4)
 *
 * For a company the number in the Registro delle imprese is its codice fiscale; REA is the economic and administrative
 * index number of the same office. A document is refused (legalProblems) while any line of c. 1 is missing: an issued
 * document without them would breach the article on every copy.
 */

const SEPARATOR = ' · '

/** An address on one line: "Via Esempio 1, 20121 Milano (MI)", the country added when it is not Italy. */
export function addressLine(address: PostalAddress, language: DocumentLanguage): string {
  const street = [address.line1, address.line2].filter((part): part is string => typeof part === 'string' && part.trim() !== '').map((part) => part.trim())
  const province = address.province?.trim() ? ` (${address.province.trim()})` : ''
  const place = `${address.postalCode.trim()} ${address.city.trim()}${province}`
  const country = address.country.toUpperCase() === 'IT' ? [] : [countryName(address.country, language)]
  return [...street, place, ...country].join(', ')
}

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''

/** What the company's row lacks for an art. 2250 document, as issues for the person who keeps the company. */
export function legalProblems(company: CompanyLegal, at = 'company'): Issue[] {
  const problems: Issue[] = []
  if (!filled(company.legalName)) problems.push({ path: `${at}/legalName`, message: 'The company needs its legal name (ragione sociale).' })
  const address = company.address
  if (!address || !filled(address.line1) || !filled(address.postalCode) || !filled(address.city) || !filled(address.country)) {
    problems.push({ path: `${at}/address`, message: 'The company needs its registered office: street, postal code, city and country (c.c. art. 2250).' })
  }
  if (!filled(company.vatNumber)) problems.push({ path: `${at}/vatNumber`, message: 'The company needs its VAT number (partita IVA).' })
  if (!filled(company.fiscalCode)) problems.push({ path: `${at}/fiscalCode`, message: 'The company needs its codice fiscale: it is its number in the Registro delle imprese (c.c. art. 2250).' })
  if (!filled(company.reaOffice) || !filled(company.reaNumber)) {
    problems.push({ path: `${at}/rea`, message: 'The company needs its Registro delle imprese office and REA number (c.c. art. 2250).' })
  }
  if (company.shareCapital !== null && company.shareCapital !== undefined) {
    const capital = parseDecimal(company.shareCapital)
    if (capital === null || capital.isNegative()) problems.push({ path: `${at}/shareCapital`, message: 'The share capital is a positive amount.' })
  }
  if (!isCurrencyCode(company.currency)) problems.push({ path: `${at}/currency`, message: 'The company needs its currency (ISO 4217).' })
  return problems
}

/** The name as printed: the legal name, with "in liquidazione" when the company is in liquidation (c. 3). */
export function legalName(company: CompanyLegal, language: DocumentLanguage): string {
  const name = company.legalName.trim()
  return company.inLiquidation === true ? `${name} ${DOCUMENT_WORDS[language].legal.inLiquidation}` : name
}

/** The lines under the company's name. Call legalProblems first: a missing value is left out here, not invented. */
export function legalLines(company: CompanyLegal, language: DocumentLanguage): string[] {
  const words = DOCUMENT_WORDS[language].legal
  const lines: string[] = []
  if (company.address) lines.push(`${words.registeredOffice}: ${addressLine(company.address, language)}`)
  const tax = [
    filled(company.vatNumber) ? `${words.vat} ${company.vatNumber.trim()}` : null,
    filled(company.fiscalCode) ? `${words.fiscalCode} ${company.fiscalCode.trim()}` : null,
  ].filter((part): part is string => part !== null)
  if (tax.length > 0) lines.push(tax.join(SEPARATOR))
  const register = [
    filled(company.reaOffice) && filled(company.fiscalCode) ? words.register(company.reaOffice.trim(), company.fiscalCode.trim()) : null,
    filled(company.reaOffice) && filled(company.reaNumber) ? words.rea(company.reaOffice.trim(), company.reaNumber.trim()) : null,
  ].filter((part): part is string => part !== null)
  if (register.length > 0) lines.push(register.join(SEPARATOR))
  const corporate = [
    company.shareCapital !== null && company.shareCapital !== undefined ? `${words.shareCapital} ${formatMajorAmount(company.shareCapital, company.currency, language)}` : null,
    company.soleShareholder === true ? words.soleShareholder : null,
  ].filter((part): part is string => part !== null)
  if (corporate.length > 0) lines.push(corporate.join(SEPARATOR))
  if (filled(company.pec)) lines.push(`${words.pec}: ${company.pec.trim()}`)
  return lines
}

/** The legal line of every page's footer: name, VAT, REA and capital on one line (art. 2250 "negli atti e nella corrispondenza"). */
export function legalFooter(company: CompanyLegal, language: DocumentLanguage): string {
  const words = DOCUMENT_WORDS[language].legal
  return [
    legalName(company, language),
    company.address ? `${words.registeredOffice}: ${addressLine(company.address, language)}` : null,
    filled(company.vatNumber) ? `${words.vat} ${company.vatNumber.trim()}` : null,
    filled(company.reaOffice) && filled(company.reaNumber) ? words.rea(company.reaOffice.trim(), company.reaNumber.trim()) : null,
    company.shareCapital !== null && company.shareCapital !== undefined ? `${words.shareCapital} ${formatMajorAmount(company.shareCapital, company.currency, language)}` : null,
    company.soleShareholder === true ? words.soleShareholder : null,
  ]
    .filter((part): part is string => part !== null)
    .join(SEPARATOR)
}
