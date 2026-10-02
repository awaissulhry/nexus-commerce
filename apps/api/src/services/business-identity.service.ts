/**
 * MCP full control O2 + O3 — who a business is to its buyers and on its documents.
 *
 * O3 — every buyer-facing output carries the identity of the business it is for: the business the call runs in (the
 * C3 business stamp of a Claude connection, the request's business in the app).
 *
 *   E-MAILS (send-customer-message, return, review and shipment e-mails) — `resolveBusinessIdentity`:
 *   - Xavia, the original (legacy) business, keeps exactly the name, contact and sender its e-mails carried before
 *     O3 (constants and NEXUS_EMAIL_FROM): byte-identical.
 *   - Every other business: its company settings (Settings › Company): company name, contact e-mail and address;
 *     its e-mails are sent from its contact address. Without them: refused, never sent as Xavia.
 *
 *   DOCUMENTS (invoice, packing slip, withdrawal form, corrispettivi, customs declaration) — `requireCompanyIdentity`:
 *   ONE company identity per business (lead review, 2026-10-01): its company settings first; for Xavia only, the
 *   NEXUS_ISSUER_* settings fill a field the company settings leave empty. There is no code placeholder anywhere: a
 *   document that would lack something it prints (the name, a full address with its postal code, the P.IVA) is
 *   refused with what to fill in, and nothing is printed or numbered. FatturaPA needs a structured address the company
 *   settings do not hold: it reads NEXUS_ISSUER_* only, for Xavia only, and is refused while one is missing.
 *
 * O2 — invoice and credit-note numbers run in series, one per (fiscal year, issuer). The counters' key is
 * ("fiscalYear", "issuer") and their rows are row-secured per business, so two businesses must never share an
 * issuer: the second one's number would bump a row it cannot see, and row-level security refuses it.
 *   - Xavia keeps 'XAVIA': its existing series goes on unchanged.
 *   - Every other business gets an issuer made from its own id, which no other business can hold.
 * The issuer is the series' key only; it is never printed (the invoice shows the business's legal identity).
 */

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, workspaceIdForQuery } from '../lib/workspace-context.js'

/** Xavia's series key since F.2 — the legacy business's invoices and credit notes. */
export const XAVIA_INVOICE_ISSUER = 'XAVIA'

/** O2 — the key of this business's own invoice and credit-note series. */
export function invoiceIssuerFor(workspaceId: string): string {
  return workspaceId === LEGACY_WORKSPACE_ID ? XAVIA_INVOICE_ISSUER : `BUSINESS-${workspaceId}`
}

/** O2 — the series key of the business this call runs in (the legacy business when profiles are off). */
export function currentInvoiceIssuer(): string {
  return invoiceIssuerFor(workspaceIdForQuery())
}

/** The seller as a document prints it. Every field is real: an empty one is '' (or null), never a placeholder. */
export interface LegalIdentity {
  name: string
  /** P.IVA (or the tax id); null when the business has none. */
  vatNumber: string | null
  /** The codice fiscale; the P.IVA when none is set (a company's is usually the same); '' when neither. */
  fiscalCode: string
  /** The registered address on one line, as printed. */
  addressLine: string
  /** The address line by line, as a parcel, a form or a customs declaration prints it after the name. */
  postalLines: string[]
  /** '' when none. */
  phone: string
  /** '' when none. */
  email: string
  /** '' when none. */
  pec: string
  /** The matricola of the business's registratore telematico (corrispettivi); '' when none is registered. */
  rtMatricola: string
}

/** O3 — the business as its buyers see it in an e-mail. */
export interface BusinessIdentity {
  workspaceId: string
  /** The legacy business: its e-mails keep their Xavia copy (taglines, the Italian review contact) exactly. */
  xavia: boolean
  /** The name in headers, subjects and sign-offs. */
  brandName: string
  /** The name as the letter-spaced logo in the review e-mails. */
  brandMark: string
  /** The From of its e-mails; undefined = the transport's own default (Xavia's NEXUS_EMAIL_FROM). */
  emailFrom: string | undefined
  /** Where a buyer writes to. */
  supportEmail: string
  /** The address the unsubscribe mailto points at. */
  unsubscribeEmail: string
}

/** O3 — why a business's buyers may not get this output. */
export class MissingBusinessIdentityError extends Error {
  readonly statusCode = 409
  constructor(message: string) {
    super(message)
    this.name = 'MissingBusinessIdentityError'
  }
}

export type IdentityResult = { ok: true; identity: BusinessIdentity } | { ok: false; reason: string }

/** Xavia's e-mail identity, exactly as its e-mails carried it before O3. */
export function xaviaIdentity(): BusinessIdentity {
  return {
    workspaceId: LEGACY_WORKSPACE_ID,
    xavia: true,
    brandName: 'Xavia',
    brandMark: 'XAVIA',
    emailFrom: undefined,
    supportEmail: 'support@xavia.it',
    unsubscribeEmail: 'unsubscribe@xavia.it',
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const env = (name: string): string => text(process.env[name])

/** A display name safe inside a quoted From header: no quotes, angle brackets or line breaks. */
const displayName = (name: string) => name.replace(/["<>\\\r\n]/g, '').replace(/\s+/g, ' ').trim()

const COMPANY_SETTINGS_SELECT = {
  companyName: true, contactEmail: true, contactPhone: true, addressLines: true, piva: true, taxId: true, codiceFiscale: true, pecEmail: true,
} as const

/** The business's company settings (Settings › Company), row-secured to the business the call runs in. */
async function companySettings(): Promise<Record<string, unknown> | null> {
  return (await prisma.brandSettings.findFirst({ orderBy: { createdAt: 'asc' }, select: COMPANY_SETTINGS_SELECT })) as Record<string, unknown> | null
}

const addressOf = (settings: Record<string, unknown> | null): string[] =>
  (Array.isArray(settings?.addressLines) ? (settings!.addressLines as unknown[]) : []).map(text).filter(Boolean)

const missingForBuyers = (what: string[]) =>
  `This business has no identity for buyers yet: set its ${what.join(', ')} in Settings › Company. ` +
  'Nothing was sent or printed, and nothing goes out as another business.'

/**
 * O3 — the e-mail identity of the business this call runs in, or why it has none. The legacy business is Xavia (no
 * database read); every other business reads its own company settings.
 */
export async function resolveBusinessIdentity(): Promise<IdentityResult> {
  const workspaceId = workspaceIdForQuery()
  if (workspaceId === LEGACY_WORKSPACE_ID) return { ok: true, identity: xaviaIdentity() }
  const settings = await companySettings()
  const name = text(settings?.companyName)
  const email = text(settings?.contactEmail)
  const gaps = [!name && 'company name', !email && 'contact e-mail', addressOf(settings).length === 0 && 'address'].filter(Boolean) as string[]
  if (gaps.length) return { ok: false, reason: missingForBuyers(gaps) }
  return {
    ok: true,
    identity: {
      workspaceId,
      xavia: false,
      brandName: name,
      brandMark: name.toUpperCase(),
      emailFrom: `"${displayName(name)}" <${email}>`,
      supportEmail: email,
      unsubscribeEmail: email,
    },
  }
}

/** O3 — the e-mail identity, or a MissingBusinessIdentityError (for outputs that throw rather than answer). */
export async function requireBusinessIdentity(): Promise<BusinessIdentity> {
  const found = await resolveBusinessIdentity()
  if (found.ok === false) throw new MissingBusinessIdentityError(found.reason)
  return found.identity
}

/** A postal code in an address line (4 to 6 digits, e.g. 47822, 1010, 75001): an address without one is not whole. */
const HAS_POSTAL_CODE = /\b\d{4,6}\b/

/**
 * The company identity of the business this call runs in: its company settings, and — for Xavia only — the
 * NEXUS_ISSUER_* settings where a company setting is empty. No field is ever invented: what neither holds is empty.
 */
export async function companyIdentity(): Promise<LegalIdentity> {
  const xavia = workspaceIdForQuery() === LEGACY_WORKSPACE_ID
  const settings = await companySettings()
  const fallback = (name: string) => (xavia ? env(name) : '')
  let postalLines = addressOf(settings)
  if (postalLines.length === 0) {
    const street = fallback('NEXUS_ISSUER_ADDRESS')
    const cityLine = [fallback('NEXUS_ISSUER_POSTAL'), fallback('NEXUS_ISSUER_CITY')].filter(Boolean).join(' ')
    postalLines = [street, cityLine, fallback('NEXUS_ISSUER_COUNTRY')].filter(Boolean)
  }
  const vatNumber = text(settings?.piva) || text(settings?.taxId) || fallback('NEXUS_ISSUER_VAT') || null
  return {
    name: text(settings?.companyName) || fallback('NEXUS_ISSUER_NAME'),
    vatNumber,
    fiscalCode: text(settings?.codiceFiscale) || fallback('NEXUS_ISSUER_CF') || vatNumber || '',
    addressLine: postalLines.join(', '),
    postalLines,
    phone: text(settings?.contactPhone) || fallback('NEXUS_ISSUER_PHONE'),
    email: text(settings?.contactEmail) || fallback('NEXUS_ISSUER_EMAIL'),
    pec: text(settings?.pecEmail) || fallback('NEXUS_ISSUER_PEC'),
    rtMatricola: fallback('NEXUS_RT_MATRICOLA'),
  }
}

/** What a document prints of the seller, so what it cannot be printed without. */
export type CompanyField = 'name' | 'address' | 'vat'
const FIELD_WORDS: Record<CompanyField, string> = { name: 'name', address: 'full address (street, postal code, town)', vat: 'P.IVA' }

/**
 * The company identity a document needs, or a MissingBusinessIdentityError that says what to fill in. `document` names
 * it in the sentence ("the invoice"); `numbered` adds that no number was taken.
 */
export async function requireCompanyIdentity(needs: CompanyField[], document: string, options: { numbered?: boolean } = {}): Promise<LegalIdentity> {
  const identity = await companyIdentity()
  const lacking = needs.filter((field) =>
    field === 'name' ? !identity.name
      : field === 'vat' ? !identity.vatNumber
        : identity.postalLines.length < 2 || !identity.postalLines.some((line) => HAS_POSTAL_CODE.test(line)))
  if (lacking.length) {
    throw new MissingBusinessIdentityError(
      `Fill in the company ${lacking.map((field) => FIELD_WORDS[field]).join(' and ')} in Settings › Company: ${document} is never printed ` +
        `with missing or made-up company details. Nothing was printed${options.numbered ? ' and no number was taken' : ''}.`,
    )
  }
  return identity
}

/** The invoice's and credit note's needs: the name, the full address and the P.IVA. */
export const requireInvoiceIdentity = (document = 'the invoice') =>
  requireCompanyIdentity(['name', 'address', 'vat'], document, { numbered: true })

/** The NEXUS_ISSUER_* values FatturaPA prints, each required (no placeholder). */
const FATTURAPA_ENV = ['NEXUS_ISSUER_NAME', 'NEXUS_ISSUER_VAT', 'NEXUS_ISSUER_CF', 'NEXUS_ISSUER_ADDRESS', 'NEXUS_ISSUER_CITY', 'NEXUS_ISSUER_POSTAL', 'NEXUS_ISSUER_PROVINCE', 'NEXUS_ISSUER_REGIME'] as const

/** FatturaPA's seller (cedente prestatore), structured. */
export interface FatturaPaIssuer {
  vatNumber: string
  fiscalCode: string
  countryCode: string
  name: string
  regime: string
  address: string
  city: string
  postalCode: string
  province: string
  country: string
}

/**
 * O3 — FatturaPA XML (invoice and credit note) carries the issuer's STRUCTURED legal identity (street, CAP, comune,
 * provincia, tax regime), which the company settings do not hold: it is built for Xavia only, from NEXUS_ISSUER_*,
 * and refused while one of them is missing (never a placeholder). For any other business it is refused before a number
 * is taken: an XML naming Xavia as the seller of another business's sale must never be built.
 */
export function requireFatturaPaIssuer(): FatturaPaIssuer {
  if (workspaceIdForQuery() !== LEGACY_WORKSPACE_ID) {
    throw new MissingBusinessIdentityError(
      'FatturaPA XML is built only for Xavia today: it needs the business\'s structured legal address and tax regime, ' +
        'which Settings › Company does not hold yet. No number was taken and nothing was generated as Xavia.',
    )
  }
  const missing = FATTURAPA_ENV.filter((name) => !env(name))
  if (missing.length) {
    throw new MissingBusinessIdentityError(
      `FatturaPA XML needs the issuer's structured details, and ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set: ` +
        'it is never generated with made-up company details. No number was taken.',
    )
  }
  return {
    vatNumber: env('NEXUS_ISSUER_VAT'),
    fiscalCode: env('NEXUS_ISSUER_CF'),
    countryCode: 'IT',
    name: env('NEXUS_ISSUER_NAME'),
    regime: env('NEXUS_ISSUER_REGIME'),
    address: env('NEXUS_ISSUER_ADDRESS'),
    city: env('NEXUS_ISSUER_CITY'),
    postalCode: env('NEXUS_ISSUER_POSTAL'),
    province: env('NEXUS_ISSUER_PROVINCE'),
    country: 'IT',
  }
}
