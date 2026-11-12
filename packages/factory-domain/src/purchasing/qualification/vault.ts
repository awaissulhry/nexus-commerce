import type { BusinessDate } from '../../core/time'
import { daysUntil, EXPIRY_WINDOWS } from '../../files/expiry/rules'
import type { SupplierKind } from '../suppliers-depth/rules'

/**
 * The supplier document vault (B-W2b-315; SCM-020; design purchasing.suppliers › Documents & qualification › Documents
 * "Certificates and declarations with expiry, and what each one unlocks"), pure. What we ask of a supplier, per supplier
 * kind and per material it sells us; what is in force and until when; what each document unlocks.
 *
 *   per kind      a tannery: a chromium VI test report (REACH Annex XVII entry 47) and a REACH declaration; a protector
 *                 maker: the protectors' EU type-examination certificate (EN 1621) and the declaration of conformity; a
 *                 workshop: the DURC (D.Lgs. 276/2003 art. 29: the client answers jointly for the workshop's contributions);
 *                 and what is asked, not required (an LWG audit, the signed code of conduct, a carrier's insurance)
 *   per material  a leather that needs a chromium VI test asks the supplier's chromium VI test report; a PPE component
 *                 (a protector) asks a VALID certificate of the register covering it (B-W1-12's Certificate +
 *                 CertificateCoverage) — the gate on a PO (./gate.ts) holds a send without them
 *
 * A document is a CURRENT file of the supplier (StoredFile of its Party: AVAILABLE, not superseded) tagged with a category
 * (SUPPLIER_CERTIFICATE, TEST_REPORT, DECLARATION) and its last valid day — what the office tags, what a buyer accepted from
 * the portal (B-W2b-189) and what an accepted questionnaire put in force (B-W2b-172). The schema keeps the category, not
 * the type (an LWG audit and a DURC are both certificates): a kind's ask is met by a document of its category, and the
 * words say which document is meant (Gaps: a document type column).
 */

export const VAULT_CATEGORIES = ['SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION'] as const
export type VaultCategory = (typeof VAULT_CATEGORIES)[number]
export const isVaultCategory = (value: unknown): value is VaultCategory => (VAULT_CATEGORIES as readonly unknown[]).includes(value)

/** What we ask a kind of supplier: the document meant, its category, whether a PO or a qualification rests on it, the law. */
export interface KindAsk {
  readonly code: string
  readonly category: VaultCategory
  readonly required: boolean
  readonly words: string
  readonly law: string | null
}

const ask = (code: string, category: VaultCategory, required: boolean, words: string, law: string | null = null): KindAsk => Object.freeze({ code, category, required, words, law })

export const ASKED_BY_KIND: Readonly<Record<SupplierKind, readonly KindAsk[]>> = Object.freeze({
  TANNERY: [
    ask('CR_VI_TEST_REPORT', 'TEST_REPORT', true, 'a chromium VI test report (below 3 mg/kg)', 'REACH Annex XVII entry 47'),
    ask('REACH_DECLARATION', 'DECLARATION', true, 'a REACH declaration (no SVHC above 0.1 %)', 'REACH art. 33'),
    ask('LWG_AUDIT', 'SUPPLIER_CERTIFICATE', false, 'an LWG audit or an ISO 9001 / 14001 certificate'),
  ],
  TEXTILE_MILL: [
    ask('REACH_DECLARATION', 'DECLARATION', true, 'a REACH declaration (no SVHC above 0.1 %)', 'REACH art. 33'),
    ask('AZO_TEST_REPORT', 'TEST_REPORT', false, 'a test report on azo dyes', 'REACH Annex XVII entry 43'),
  ],
  TRIMS: [ask('REACH_DECLARATION', 'DECLARATION', true, 'a REACH declaration (nickel release of metal parts)', 'REACH Annex XVII entry 27')],
  PROTECTOR_MAKER: [
    ask('EN_1621_CERTIFICATE', 'SUPPLIER_CERTIFICATE', true, 'the EU type-examination certificate of the protectors (EN 1621)', 'Reg. (EU) 2016/425 Annex V'),
    ask('DECLARATION_OF_CONFORMITY', 'DECLARATION', true, 'the EU declaration of conformity of the protectors', 'Reg. (EU) 2016/425 art. 15'),
  ],
  SUBCONTRACTOR: [
    ask('DURC', 'SUPPLIER_CERTIFICATE', true, 'the DURC (regularity of social contributions, valid 120 days)', 'D.Lgs. 276/2003 art. 29'),
    ask('CODE_OF_CONDUCT', 'DECLARATION', false, 'the signed code of conduct'),
  ],
  CARRIER: [ask('CARRIER_INSURANCE', 'SUPPLIER_CERTIFICATE', false, "the carrier's insurance and its registration")],
  SERVICE: [],
})

/** One category asked of a supplier with several kinds: the asks of its kinds merged (required when any one is). */
export interface CategoryAsk {
  readonly category: VaultCategory
  readonly required: boolean
  readonly codes: readonly string[]
  readonly words: string
  readonly laws: readonly string[]
}

export function askedOf(kinds: readonly SupplierKind[]): CategoryAsk[] {
  const byCategory = new Map<VaultCategory, KindAsk[]>()
  for (const kind of kinds) for (const entry of ASKED_BY_KIND[kind]) byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry])
  return VAULT_CATEGORIES.flatMap((category) => {
    const asks = byCategory.get(category)
    if (!asks) return []
    const unique = asks.filter((entry, index) => asks.findIndex((other) => other.code === entry.code) === index)
    return [{ category, required: unique.some((entry) => entry.required), codes: unique.map((entry) => entry.code), words: unique.map((entry) => entry.words).join(' or '), laws: [...new Set(unique.flatMap((entry) => (entry.law ? [entry.law] : [])))] }]
  })
}

/** A document's state on a day: VALID (no date, or more than 30 days left), EXPIRING (0..30 days left), EXPIRED. */
export type DocumentState = 'VALID' | 'EXPIRING' | 'EXPIRED'
export function documentStateOf(expiresOn: BusinessDate | null, today: BusinessDate): DocumentState {
  if (expiresOn === null) return 'VALID'
  const left = daysUntil(expiresOn, today)
  if (left < 0) return 'EXPIRED'
  return left <= EXPIRY_WINDOWS[0] ? 'EXPIRING' : 'VALID'
}

/** A document of the vault as these rules read it. */
export interface VaultDocument {
  readonly fileId: string
  readonly category: VaultCategory
  readonly expiresOn: BusinessDate | null
  /** The articles the supplier said it covers (its upload's codes, as typed); empty: every article. */
  readonly articleCodes: readonly string[]
}

/** The document in force of a category that holds longest (no date first), or null; an expired one only when none holds. */
export function bestDocument<Doc extends VaultDocument>(documents: readonly Doc[], category: VaultCategory, today: BusinessDate, articleCodes: readonly string[] = []): Doc | null {
  const wanted = new Set(articleCodes.map((code) => code.trim().toUpperCase()).filter((code) => code !== ''))
  const covers = (doc: Doc): boolean => doc.articleCodes.length === 0 || wanted.size === 0 || doc.articleCodes.some((code) => wanted.has(code.trim().toUpperCase()))
  const ofCategory = documents.filter((doc) => doc.category === category && covers(doc))
  const holding = ofCategory.filter((doc) => doc.expiresOn === null || doc.expiresOn >= today)
  const pool = holding.length > 0 ? holding : ofCategory
  return [...pool].sort((a, b) => (a.expiresOn === b.expiresOn ? (a.fileId < b.fileId ? -1 : 1) : a.expiresOn === null ? -1 : b.expiresOn === null ? 1 : a.expiresOn < b.expiresOn ? 1 : -1))[0] ?? null
}

/** An ask's state: MET (in force), EXPIRING (in force, 30 days or less), EXPIRED (only an expired one), MISSING (none). */
export type AskState = 'MET' | 'EXPIRING' | 'EXPIRED' | 'MISSING'
export function askStateOf(document: Pick<VaultDocument, 'expiresOn'> | null, today: BusinessDate): AskState {
  if (!document) return 'MISSING'
  const state = documentStateOf(document.expiresOn, today)
  return state === 'VALID' ? 'MET' : state
}

/** A day as the API's English sentences say it ("2 Oct 2026"). */
export function dayWords(day: BusinessDate): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return `${date} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${year}`
}

/** "A12 and A14", "A12, A14 and A20". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** What a document unlocks, in words ("POs for A12 and A14 need a valid chromium VI test report to be sent."). */
export const unlocksWords = (materialCodes: readonly string[], what: string): string =>
  materialCodes.length === 0 ? '' : `POs for ${listWords([...materialCodes].sort())} need ${what} in force to be sent.`
