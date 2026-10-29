import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { PURPOSE_RULES } from '../../links/purposes'
import type { TaxIdentityFields, PartyTaxMode } from '../../parties/tax'
import { addDays, sendBlockers, STATUS_WORDS, type QuoteIssue, type QuoteVersionStatus } from './quotes'

/**
 * Sending a quote (B-W1-24; A1 §2.5 "Sending freezes a version"; SAL-157, SAL-192; the design's Send dialog `quotes.send`),
 * pure: what the send checks before it freezes a version, the snapshots it freezes, how long the accept link lives and
 * which version a link belongs to.
 *
 * The checks (one list, the Send dialog's GateChecklist): every issue of B-W1-21 that blocks the send (`sendBlockers`:
 * no lines, unpriced, cost incomplete, validity, addresses, contact email, a consumer's promise date, an approval the
 * rules need), and the send's own: the company's letterhead data (c.c. art. 2250: the PDF cannot be printed without it),
 * complete invoice and delivery addresses, a tax identity an invoice can reach (SDI code or PEC for an Italian
 * business), the VAT still as priced (a VIES proof that lapsed or arrived since: recompute first), a firm offer that
 * still stands (c.c. art. 1329: it cannot be withdrawn before its day, so no new version replaces it), terms of the
 * company's own named by their version (the acceptance records it). Warnings never stop it: a size not covered by a
 * valid certificate, an EU business taxed at 22 % for want of a VIES proof, a deposit without the company's bank details.
 */

export const SEND_CHECK_CODES = ['COMPANY_LEGAL', 'BILL_TO_INCOMPLETE', 'SHIP_TO_INCOMPLETE', 'SDI_IDENTITY', 'VAT_CHANGED', 'FIRM_OFFER_STANDS', 'TERMS_VERSION', 'NO_BANK_DETAILS'] as const
export type SendCheckCode = (typeof SEND_CHECK_CODES)[number]

export interface SendCheck {
  readonly code: QuoteIssue['code'] | SendCheckCode
  readonly severity: 'BLOCKS' | 'WARNING'
  readonly path: string
  /** In words, without a cost or margin figure. */
  readonly message: string
  readonly lineId: string | null
  readonly size: string | null
}

/** An address as the party keeps it (PartyAddress). */
export interface AddressFacts {
  readonly name: string | null
  readonly line1: string
  readonly line2: string | null
  readonly postalCode: string
  readonly city: string
  readonly province: string | null
  readonly country: string
  readonly contactName: string | null
  readonly phone: string | null
}

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''

/** Street, postal code, city and a two-letter country: what an invoice (FatturaPA Sede) and a carrier need. */
export function addressComplete(address: Pick<AddressFacts, 'line1' | 'postalCode' | 'city' | 'country'> | null): boolean {
  return address !== null && filled(address.line1) && filled(address.postalCode) && filled(address.city) && /^[A-Z]{2}$/.test(address.country)
}

export interface SendCheckFacts {
  /** quoteIssues of the current version (B-W1-21). */
  readonly issues: readonly QuoteIssue[]
  readonly status: QuoteVersionStatus
  readonly approvalNeeded: boolean
  /** documents/legal legalProblems of the company (empty: it can print). */
  readonly companyLegal: readonly Issue[]
  /** The chosen addresses (null: none chosen, which `issues` already says). */
  readonly billTo: AddressFacts | null
  readonly shipTo: AddressFacts | null
  /** The party's tax identity in force today. */
  readonly identity: Pick<TaxIdentityFields, 'taxMode' | 'sdiRecipientCode' | 'pec'> | null
  /** The VAT as decided today differs from the one the lines were priced with (a VIES proof lapsed or arrived). */
  readonly vatChanged: boolean
  /** An older SENT version that is a firm offer whose day has not passed. */
  readonly standingFirmOffer: { readonly revision: number; readonly validUntil: BusinessDate } | null
  readonly termsText: string | null
  readonly termsVersion: string | null
  /** The version asks a deposit, and the company has bank details to give for it. */
  readonly depositAsked: boolean
  readonly bankDetailsKnown: boolean
}

const check = (code: SendCheck['code'], severity: SendCheck['severity'], path: string, message: string): SendCheck => ({ code, severity, path, message, lineId: null, size: null })

/** Every check of the send, blocking ones first; `ready` when none blocks. */
export function sendChecks(facts: SendCheckFacts): { readonly ready: boolean; readonly checks: SendCheck[] } {
  const checks: SendCheck[] = sendBlockers(facts.issues, facts.status, facts.approvalNeeded).map((issue) => ({ ...issue, severity: 'BLOCKS' as const }))
  if (facts.companyLegal.length > 0) {
    checks.push(check('COMPANY_LEGAL', 'BLOCKS', 'company', `The company's letterhead data is incomplete, so the quote cannot be printed: ${facts.companyLegal.map((issue) => issue.message).join(' ')}`))
  }
  if (facts.billTo !== null && !addressComplete(facts.billTo)) checks.push(check('BILL_TO_INCOMPLETE', 'BLOCKS', 'billToAddressId', 'The invoice address needs its street, postal code, city and country.'))
  if (facts.shipTo !== null && !addressComplete(facts.shipTo)) checks.push(check('SHIP_TO_INCOMPLETE', 'BLOCKS', 'shipToAddressId', 'The delivery address needs its street, postal code, city and country.'))
  if (facts.identity?.taxMode === 'IT_B2B' && !filled(facts.identity.sdiRecipientCode) && !filled(facts.identity.pec)) {
    checks.push(check('SDI_IDENTITY', 'BLOCKS', 'party/taxIdentity', 'An Italian business is invoiced through SDI: add its SDI code or PEC to the customer first.'))
  }
  if (facts.vatChanged) {
    checks.push(check('VAT_CHANGED', 'BLOCKS', 'party/vies', "The customer's VAT treatment changed since the quote was priced (a VIES check ran or lapsed): recompute the quote first (reopen it if it was approved)."))
  }
  if (facts.standingFirmOffer) {
    const { revision, validUntil } = facts.standingFirmOffer
    checks.push(check('FIRM_OFFER_STANDS', 'BLOCKS', 'firmOffer', `Version ${revision} is a firm offer until ${validUntil} (c.c. art. 1329): it cannot be replaced before then.`))
  }
  if (filled(facts.termsText) && !filled(facts.termsVersion)) {
    checks.push(check('TERMS_VERSION', 'BLOCKS', 'termsVersion', 'Give your terms a version (for example 2026-1): the acceptance records which terms were accepted.'))
  }
  checks.push(...facts.issues.filter((issue) => issue.severity === 'WARNING').map((issue) => ({ ...issue, severity: 'WARNING' as const })))
  if (facts.depositAsked && !facts.bankDetailsKnown) {
    checks.push(check('NO_BANK_DETAILS', 'WARNING', 'company/bank', "The company has no bank details yet: the deposit page and mail say they follow separately."))
  }
  const blocking = checks.filter((entry) => entry.severity === 'BLOCKS')
  return { ready: blocking.length === 0, checks: [...blocking, ...checks.filter((entry) => entry.severity === 'WARNING')] }
}

// ---- the frozen snapshots (QuoteVersion.billTo, shipTo: the shapes of sales.prisma) ---------------------------------

export interface PostalSnapshot {
  readonly line1: string
  readonly line2?: string
  readonly postalCode: string
  readonly city: string
  readonly province?: string
  readonly country: string
}

export interface BillToSnapshot {
  readonly legalName: string
  readonly kind: string
  readonly country: string
  readonly taxMode: PartyTaxMode
  readonly vatNumber?: string
  readonly fiscalCode?: string
  readonly sdiRecipientCode?: string
  readonly pec?: string
  readonly viesConsultationNumber?: string
  readonly address: PostalSnapshot
}

export interface ShipToSnapshot extends PostalSnapshot {
  readonly name?: string
  readonly contactName?: string
  readonly phone?: string
}

const optional = <K extends string>(key: K, value: string | null | undefined): Partial<Record<K, string>> => (filled(value) ? ({ [key]: value.trim() } as Record<K, string>) : {})

const postal = (address: AddressFacts): PostalSnapshot => ({
  line1: address.line1.trim(),
  ...optional('line2', address.line2),
  postalCode: address.postalCode.trim(),
  city: address.city.trim(),
  ...optional('province', address.province),
  country: address.country,
})

/**
 * The buyer as sent: the party's name and kind, its tax identity in force (and the VIES consultation that proved an EU
 * VAT number), and the invoice address. The version's taxMode stays the VAT treatment it was priced with.
 */
export function billToSnapshot(input: {
  readonly legalName: string
  readonly kind: string
  readonly identity: Pick<TaxIdentityFields, 'country' | 'taxMode' | 'vatNumber' | 'fiscalCode' | 'sdiRecipientCode' | 'pec'>
  readonly viesConsultationNumber: string | null
  readonly address: AddressFacts
}): BillToSnapshot {
  const { identity } = input
  return {
    legalName: input.legalName.trim(),
    kind: input.kind,
    country: identity.country,
    taxMode: identity.taxMode,
    ...optional('vatNumber', identity.vatNumber),
    ...optional('fiscalCode', identity.fiscalCode),
    ...optional('sdiRecipientCode', identity.sdiRecipientCode),
    ...optional('pec', identity.pec),
    ...optional('viesConsultationNumber', input.viesConsultationNumber),
    address: postal(input.address),
  }
}

/** The delivery address as sent, with whom to ask for there. */
export function shipToSnapshot(address: AddressFacts): ShipToSnapshot {
  return { ...optional('name', address.name), ...postal(address), ...optional('contactName', address.contactName), ...optional('phone', address.phone) }
}

// ---- the accept link ------------------------------------------------------------------------------------------------

/**
 * Days the accept link outlives the offer: after its last day the link still opens, says the offer ended and lets the
 * customer ask for a new one (the design's "Ask for a new link"); then it opens nothing.
 */
export const ACCEPT_LINK_GRACE_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000
const daysBetween = (from: BusinessDate, to: BusinessDate): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

/** The accept link's life in days: to the offer's last day, plus the grace, within the purpose's maximum (90). */
export function acceptLinkDays(today: BusinessDate, validUntil: BusinessDate): number {
  const max = PURPOSE_RULES.QUOTE_ACCEPT.expiryDays.max
  return Math.min(max, Math.max(1, daysBetween(today, validUntil) + 1 + ACCEPT_LINK_GRACE_DAYS))
}

/**
 * The version a QUOTE_ACCEPT link belongs to: the newest version sent at or before the link was made (the send makes
 * the link in its own command, at the version's sentAt; a resend later). A link never reaches a version sent after it:
 * an old link of version 1 says "replaced by version 2", it never accepts version 2.
 */
export function versionOfLink<Version extends { readonly sentAt: Date | null; readonly revision: number }>(versions: readonly Version[], linkCreatedAt: Date): Version | null {
  const sent = versions.filter((version) => version.sentAt !== null && version.sentAt.getTime() <= linkCreatedAt.getTime())
  return sent.reduce<Version | null>((newest, version) => (newest === null || version.revision > newest.revision ? version : newest), null)
}

/** The day a new version's offer stands until by default (the company's validity days from today). */
export const revisedValidUntil = (today: BusinessDate, validityDays: number): BusinessDate => addDays(today, validityDays)

/** A version may be revised (a new DRAFT made from it) when it was sent and not accepted or withdrawn. */
export function reviseProblem(status: QuoteVersionStatus): string | null {
  if (status === 'SENT' || status === 'DECLINED' || status === 'EXPIRED') return null
  if (status === 'DRAFT' || status === 'PENDING_APPROVAL' || status === 'APPROVED') return `The quote is ${STATUS_WORDS[status]}: change it as it is; a new version is made from a sent one.`
  return `The quote is ${STATUS_WORDS[status]}: it gets no new version.`
}
