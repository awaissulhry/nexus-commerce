import type { Words } from '../../portal/tasks/kinds'

/**
 * A customer's document library in the portal (B-W2b-178; SAL-086, SAL-092, QHS-111; design portal.customer.documents
 * "Which documents", "All documents", the order record's Documents tab, Home's "New documents"), pure. The API reads the
 * facts (what the factory shared with the party, its issued invoices) and these rules answer:
 *
 *   which      only what was ISSUED and is FIXED: a file shared with the party's portal (status AVAILABLE: its content never
 *              changes, a new version is a new file) and the party's issued invoices and credit notes (never a draft, never
 *              one SDI rejected: it is corrected and sent again). Photos, voice notes, body photos and the carrier's
 *              invoice (a cost) are never part of it
 *   what       the document's kind, from what made the file (`kindOfFile`): the shipment's travelling copies (B-W1-49: DDT,
 *              declaration of conformity, user information), the quality documents shared on a shipment (B-W2b-123:
 *              inspection report, certificate of conformity), a quote sent (the ACCEPTED version is the order
 *              confirmation), a statement of account sent (B-W2a-55), the file's category (proof of delivery, CMR, test
 *              report …), else a plain document
 *   who        the kind's group, and the group's permission and grain (`groupRules`): delivery papers and other documents
 *              need portal.customerDocuments.view; conformity portal.customerDocuments.conformity; invoices and statements
 *              portal.customerDocuments.finance; order confirmations, quotes, invoices and statements also the price grain
 *              (they carry prices: never shown to a role without prices, a preview included)
 *   versions   a fixed version is never changed: an earlier one stays readable and names the one that replaced it
 *              (`replacementsOf`); a WITHDRAWN one leaves the library and the newer one is named instead
 *   new        NEW until the person opened it, for what arrived after their previous visit (`isNew`)
 */

export const DOCUMENT_GROUPS = ['DELIVERY', 'CONFORMITY', 'FINANCE', 'ORDERS', 'OTHER'] as const
export type DocumentGroup = (typeof DOCUMENT_GROUPS)[number]

/** The chips of the page: every group the person may see, and all of them. */
export const LIBRARY_CHIPS = ['ALL', ...DOCUMENT_GROUPS] as const
export type LibraryChip = (typeof LIBRARY_CHIPS)[number]

export const PORTAL_DOCUMENT_KINDS = [
  'DDT',
  'PACKING_LIST',
  'PROOF_OF_DELIVERY',
  'CMR',
  'DECLARATION_OF_CONFORMITY',
  'USER_INFORMATION',
  'CERTIFICATE_OF_CONFORMITY',
  'INSPECTION_REPORT',
  'TEST_REPORT',
  'CERTIFICATE',
  'DECLARATION',
  'QUALITY_REPORT',
  'INVOICE',
  'DEPOSIT_INVOICE',
  'CREDIT_NOTE',
  'STATEMENT',
  'FISCAL_DOCUMENT',
  'ORDER_CONFIRMATION',
  'QUOTE',
  'PROOF',
  'OTHER',
] as const
export type PortalDocumentKind = (typeof PORTAL_DOCUMENT_KINDS)[number]

/** What a group needs: the page permission's level, and whether it carries prices (the price grain). */
export interface GroupRule {
  readonly needs: 'view' | 'conformity' | 'finance'
  readonly price: boolean
  readonly words: Words
}

export const GROUP_RULES: Readonly<Record<DocumentGroup, GroupRule>> = Object.freeze({
  DELIVERY: { needs: 'view', price: false, words: { it: 'Documenti di consegna', en: 'Delivery papers' } },
  CONFORMITY: { needs: 'conformity', price: false, words: { it: 'Conformità', en: 'Conformity' } },
  FINANCE: { needs: 'finance', price: true, words: { it: 'Fatture ed estratti conto', en: 'Invoices and statements' } },
  ORDERS: { needs: 'view', price: true, words: { it: "Conferme d'ordine e preventivi", en: 'Order confirmations and quotes' } },
  OTHER: { needs: 'view', price: false, words: { it: 'Altri documenti', en: 'Other documents' } },
})

export const ALL_WORDS: Words = Object.freeze({ it: 'Tutti', en: 'All' })

interface KindRule {
  readonly group: DocumentGroup
  readonly words: Words
}

export const KIND_RULES: Readonly<Record<PortalDocumentKind, KindRule>> = Object.freeze({
  DDT: { group: 'DELIVERY', words: { it: 'DDT', en: 'Delivery note (DDT)' } },
  PACKING_LIST: { group: 'DELIVERY', words: { it: 'Distinta colli', en: 'Packing list' } },
  PROOF_OF_DELIVERY: { group: 'DELIVERY', words: { it: 'Prova di consegna', en: 'Proof of delivery' } },
  CMR: { group: 'DELIVERY', words: { it: 'Lettera di vettura CMR', en: 'CMR consignment note' } },
  DECLARATION_OF_CONFORMITY: { group: 'CONFORMITY', words: { it: 'Dichiarazione di conformità UE', en: 'EU declaration of conformity' } },
  USER_INFORMATION: { group: 'CONFORMITY', words: { it: 'Nota informativa del fabbricante', en: 'User information' } },
  CERTIFICATE_OF_CONFORMITY: { group: 'CONFORMITY', words: { it: 'Certificato di conformità', en: 'Certificate of conformity' } },
  INSPECTION_REPORT: { group: 'CONFORMITY', words: { it: 'Rapporto di ispezione', en: 'Inspection report' } },
  TEST_REPORT: { group: 'CONFORMITY', words: { it: 'Rapporto di prova', en: 'Test report' } },
  CERTIFICATE: { group: 'CONFORMITY', words: { it: 'Certificato', en: 'Certificate' } },
  DECLARATION: { group: 'CONFORMITY', words: { it: 'Dichiarazione', en: 'Declaration' } },
  QUALITY_REPORT: { group: 'CONFORMITY', words: { it: 'Rapporto qualità', en: 'Quality report' } },
  INVOICE: { group: 'FINANCE', words: { it: 'Fattura', en: 'Invoice' } },
  DEPOSIT_INVOICE: { group: 'FINANCE', words: { it: 'Fattura di acconto', en: 'Deposit invoice' } },
  CREDIT_NOTE: { group: 'FINANCE', words: { it: 'Nota di credito', en: 'Credit note' } },
  STATEMENT: { group: 'FINANCE', words: { it: 'Estratto conto', en: 'Statement of account' } },
  FISCAL_DOCUMENT: { group: 'FINANCE', words: { it: 'Documento fiscale', en: 'Fiscal document' } },
  ORDER_CONFIRMATION: { group: 'ORDERS', words: { it: "Conferma d'ordine", en: 'Order confirmation' } },
  QUOTE: { group: 'ORDERS', words: { it: 'Preventivo', en: 'Quote' } },
  PROOF: { group: 'OTHER', words: { it: 'Bozza da approvare', en: 'Proof' } },
  OTHER: { group: 'OTHER', words: { it: 'Documento', en: 'Document' } },
})

export const groupOf = (kind: PortalDocumentKind): DocumentGroup => KIND_RULES[kind].group

// ---- who sees what -------------------------------------------------------------------------------------------------

/** What the person holds over the portal's company and their party (the API's can() and grains). */
export interface DocumentAccess {
  readonly view: boolean
  readonly conformity: boolean
  readonly finance: boolean
  readonly price: boolean
}

/** May the person see a group's documents? */
export function maySee(access: DocumentAccess, group: DocumentGroup): boolean {
  const rule = GROUP_RULES[group]
  if (rule.price && !access.price) return false
  return access[rule.needs]
}

/** The groups the person sees, in the page's order (the chips after ALL). */
export const groupsFor = (access: DocumentAccess): DocumentGroup[] => DOCUMENT_GROUPS.filter((group) => maySee(access, group))

// ---- what a file is ------------------------------------------------------------------------------------------------

/** File kinds that are never documents of the library (a photo, a voice note). */
export const NOT_DOCUMENT_FILE_KINDS: readonly string[] = Object.freeze(['PHOTO', 'AUDIO'])
/** Categories never shown in the library: pictures, personal data and the carrier's invoice (what the transport cost us). */
export const NOT_DOCUMENT_CATEGORIES: readonly string[] = Object.freeze(['BODY_PHOTO', 'CARRIER_INVOICE', 'CLAIM_PHOTO', 'DDT_PHOTO', 'SAMPLE_PHOTO', 'BEFORE_WORK', 'AFTER_WORK'])

/** The facts of one shared file the API reads (partner scope for the file; the tenant's for what made it). */
export interface SharedFileFacts {
  readonly recordType: string
  /** FileKind. */
  readonly fileKind: string
  /** FileCategory, when tagged. */
  readonly category: string | null
  /** The command that recorded the file (its first audit row) and the details it wrote: what the document is. */
  readonly created: { readonly action: string; readonly details: Readonly<Record<string, unknown>> } | null
  /** A copy's source: a style's DoC or leaflet (ComplianceDocument) or a generated document's version (GeneratedDocument). */
  readonly source: { readonly complianceKind: string | null; readonly generatedKind: string | null } | null
  /** The file itself is a generated document's version (GeneratedDocument.fileId). */
  readonly generatedKind: string | null
  /** A quote's PDF: its version was ACCEPTED (the order confirmation). */
  readonly quoteAccepted: boolean | null
}

const SHIPMENT_COPY_KINDS: Readonly<Record<string, PortalDocumentKind>> = Object.freeze({
  DDT: 'DDT',
  PACKING_LIST: 'PACKING_LIST',
  DECLARATION_OF_CONFORMITY: 'DECLARATION_OF_CONFORMITY',
  USER_INFORMATION: 'USER_INFORMATION',
})

const GENERATED_KINDS: Readonly<Record<string, PortalDocumentKind>> = Object.freeze({
  INSPECTION_REPORT: 'INSPECTION_REPORT',
  CERTIFICATE_OF_CONFORMITY: 'CERTIFICATE_OF_CONFORMITY',
  PACKING_LIST: 'PACKING_LIST',
  NCR_REPORT: 'QUALITY_REPORT',
  EIGHT_D: 'QUALITY_REPORT',
  COMPLAINT_ANSWER: 'QUALITY_REPORT',
})

const CATEGORY_KINDS: Readonly<Record<string, PortalDocumentKind>> = Object.freeze({
  POD: 'PROOF_OF_DELIVERY',
  CMR: 'CMR',
  TEST_REPORT: 'TEST_REPORT',
  SUPPLIER_CERTIFICATE: 'CERTIFICATE',
  DECLARATION: 'DECLARATION',
  PROOF: 'PROOF',
})

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

/** What a shared file is for the customer, or null: never part of the library. */
export function kindOfFile(facts: SharedFileFacts): PortalDocumentKind | null {
  if (NOT_DOCUMENT_FILE_KINDS.includes(facts.fileKind)) return null
  if (facts.category !== null && NOT_DOCUMENT_CATEGORIES.includes(facts.category)) return null
  const compliance = facts.source?.complianceKind ?? null
  if (compliance === 'DECLARATION_OF_CONFORMITY' || compliance === 'USER_INFORMATION') return compliance
  const details = facts.created?.details ?? {}
  if (facts.created?.action === 'shipping.attachDocument') {
    const copied = SHIPMENT_COPY_KINDS[text(details.documentKind) ?? '']
    if (copied) return copied
  }
  const generated = facts.source?.generatedKind ?? facts.generatedKind ?? text(details.documentType)
  if (generated !== null && GENERATED_KINDS[generated]) return GENERATED_KINDS[generated]!
  if (facts.created?.action === 'receivables.statement') return 'STATEMENT'
  if (facts.recordType === 'Quote' && (facts.fileKind === 'FISCAL_ARCHIVE' || generated === 'QUOTE')) return facts.quoteAccepted ? 'ORDER_CONFIRMATION' : 'QUOTE'
  if (facts.category !== null && CATEGORY_KINDS[facts.category]) return CATEGORY_KINDS[facts.category]!
  if (facts.fileKind === 'CERTIFICATE') return 'CERTIFICATE'
  if (facts.fileKind === 'FISCAL_ARCHIVE') return 'FISCAL_DOCUMENT'
  return 'OTHER'
}

/** An issued invoice's kind (FatturaPA document type). */
export function kindOfInvoice(docType: string): PortalDocumentKind {
  if (docType === 'TD04') return 'CREDIT_NOTE'
  if (docType === 'TD02') return 'DEPOSIT_INVOICE'
  return 'INVOICE'
}

/** The invoice statuses the library shows: issued and not rejected by SDI (a rejected one is corrected and sent again). */
export const SHOWN_INVOICE_STATUSES = ['ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'ERROR'] as const

/** The title, in both languages: the kind's words and what it is of (a number, a style code), each part once. */
export function titleOf(kind: PortalDocumentKind, parts: readonly (string | null | undefined)[]): Words {
  const extra = [...new Set(parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0))]
  const join = (head: string): string => [head, ...extra].join(' · ')
  return { it: join(KIND_RULES[kind].words.it), en: join(KIND_RULES[kind].words.en) }
}

/** The short fingerprint shown beside the version ("v3 · 3f9a1c2b0d4e…"): the first 12 hex digits of the SHA-256. */
export const fingerprintOf = (sha256: string): string => sha256.slice(0, 12)

// ---- versions ------------------------------------------------------------------------------------------------------

export interface VersionedEntry {
  readonly id: string
  /** Entries of one series replace each other (a file's versions, a quote's revisions, a report's versions); null: none. */
  readonly series: string | null
  /** The version's number in its series (higher is newer). */
  readonly order: number
  /** The database says a later version replaced it (StoredFile.supersededAt); else the highest order is the current one. */
  readonly superseded: boolean
}

/**
 * For each entry, the entry that replaced it (the series' current one), or null when it is current. The current one is the
 * newest entry nobody superseded; earlier ones name it ("Replaced by v4").
 */
export function replacementsOf(entries: readonly VersionedEntry[]): Map<string, string | null> {
  const result = new Map<string, string | null>()
  const bySeries = new Map<string, VersionedEntry[]>()
  for (const entry of entries) {
    if (entry.series === null) result.set(entry.id, null)
    else bySeries.set(entry.series, [...(bySeries.get(entry.series) ?? []), entry])
  }
  for (const members of bySeries.values()) {
    const standing = members.filter((entry) => !entry.superseded)
    const pool = standing.length > 0 ? standing : members
    const current = pool.reduce((best, entry) => (entry.order > best.order || (entry.order === best.order && entry.id > best.id) ? entry : best))
    for (const entry of members) result.set(entry.id, entry.id === current.id ? null : current.id)
  }
  return result
}

// ---- new since the last visit --------------------------------------------------------------------------------------

/** On a person's first visit, what arrived in the last 30 days is new. */
export const FIRST_VISIT_NEW_DAYS = 30

/** NEW until the person opened it, for a document that arrived after their previous visit (first visit: the last 30 days). */
export function isNew(input: { readonly availableAt: Date; readonly lastVisitAt: Date | null; readonly opened: boolean; readonly now: Date }): boolean {
  if (input.opened) return false
  const since = input.lastVisitAt ?? new Date(input.now.getTime() - FIRST_VISIT_NEW_DAYS * 86_400_000)
  return input.availableAt.getTime() > since.getTime()
}

// ---- search and order ----------------------------------------------------------------------------------------------

/** Every word typed is found in one of the texts (case and accents aside). */
export function matchesSearch(q: string | null | undefined, texts: readonly (string | null | undefined)[]): boolean {
  const fold = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const words = fold(q ?? '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = fold(texts.filter((value): value is string => typeof value === 'string').join(' \u0001 '))
  return words.every((word) => haystack.includes(word))
}

/** Newest first, then by title, then by id (stable). */
export function byNewest<T extends { readonly date: Date; readonly title: Words; readonly id: string }>(a: T, b: T): number {
  return b.date.getTime() - a.date.getTime() || a.title.en.localeCompare(b.title.en) || a.id.localeCompare(b.id)
}
