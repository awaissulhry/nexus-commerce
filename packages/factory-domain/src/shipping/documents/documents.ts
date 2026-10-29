import type { Issue } from '../../core/errors'
import { PURPOSE_RULES } from '../../links/purposes'
import { isLanguageCode } from '../../parties/geo'
import { DOCUMENT_RETENTION_YEARS, DOCUMENT_WORDS, type ComplianceCheck, type ComplianceCheckState, type DocumentKind } from '../../product/compliance/rules'
import type { ShipmentStatus } from '../shipments'

/**
 * The documents that travel with a shipment (B-W1-49; LOG-020, QHS-060, SAL-099; PLAN §4.7 stage 14-ship "DoC by link";
 * A2 SCR-067 Documents tab, SCR-101 the link page), pure. The API reads the facts; these rules answer:
 *
 *   which      the shipment's DDT (its PDF), its packing list (printed for the parcels), and for every style × FROZEN
 *              style revision on it (the work orders' StyleRevision, never the style's newest) its EU Declaration of
 *              Conformity and its user information leaflet, when the style is PPE (any category: Reg. (EU) 2016/425
 *              art. 8(7), 8(8), art. 15; product/compliance classificationOf)
 *   language   the buyer's language (the sales order's, as accepted), else English, else Italian: the first of that
 *              chain with a document issued for the revision (product/compliance currentDocFor). A document in another
 *              language than the buyer's travels, and is said (a warning, not a blocker): the law asks the language
 *              of the Member State where the PPE is made available (art. 8(7) for the leaflet, art. 15(2) for the
 *              DoC), which the order's language only stands for (a distributor may sell elsewhere)
 *   state      ATTACHED (a copy of exactly that file — same SHA-256 — is on the shipment, shared with its party: it
 *              travels by the party's link), ON_FILE (on file, not copied yet: attaching copies it), MISSING, or
 *              NOT_REQUIRED (not PPE; a shipment that leaves with an immediate invoice instead of a DDT)
 *   blockers   in the compliance step's own shape and words (product/compliance ComplianceCheck, blocks SHIPPING): a PPE
 *              style whose DoC or leaflet is not on file in any language of the chain for its frozen revision. The
 *              ship step calls them (apps/factory-api modules/shipping/documents/read.ts shipmentDocumentBlockers)
 *   link       what a party's DOCUMENT_VIEW link of the shipment lists: exactly the shipment's files shared with the
 *              party's links, each named after the document it is a copy of (by SHA-256), never a label or an office
 *              file (they are never shared with the party)
 *
 * A copy is the evidence of what travelled with the goods: kept ten years after the shipment left (art. 8(3)), and so
 * is the file it was copied from (DOCUMENT_RETENTION_YEARS).
 */

export const SHIPMENT_DOCUMENT_KINDS = ['DDT', 'PACKING_LIST', 'DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const
export type ShipmentDocumentKind = (typeof SHIPMENT_DOCUMENT_KINDS)[number]

export const SHIPMENT_DOCUMENT_STATES = ['ATTACHED', 'ON_FILE', 'MISSING', 'NOT_REQUIRED'] as const
export type ShipmentDocumentState = (typeof SHIPMENT_DOCUMENT_STATES)[number]

/** The kinds a link lists; a shared file that is a copy of none of the shipment's documents is OTHER. */
export const LINK_DOCUMENT_KINDS = ['DDT', 'DECLARATION_OF_CONFORMITY', 'USER_INFORMATION', 'OTHER'] as const
export type LinkDocumentKind = (typeof LINK_DOCUMENT_KINDS)[number]

/** After the buyer's language, in this order. */
export const FALLBACK_LANGUAGES = ['en', 'it'] as const

/** Where the law asks for each document (the compliance step's references). */
export const TRAVEL_LAW: Readonly<Record<DocumentKind, string>> = Object.freeze({
  DECLARATION_OF_CONFORMITY: 'Reg. (EU) 2016/425 art. 8(8), art. 15',
  USER_INFORMATION: 'Reg. (EU) 2016/425 art. 8(7), Annex II 1.4',
})

/**
 * The shipment's link (DOCUMENT_VIEW on the Shipment): the purpose's longest expiry and use limit. The DoC must stay
 * reachable for the buyer; a dead link is not a dead end ("Ask for a new link", to the address on file).
 */
export const LINK_EXPIRY_DAYS = PURPOSE_RULES.DOCUMENT_VIEW.expiryDays.max
export const LINK_MAX_USES = PURPOSE_RULES.DOCUMENT_VIEW.uses.max

/** Who gets the link: the party's ACTIVE contacts with an address and one of these roles (orders, certificates). */
export const LINK_CONTACT_ROLES = ['ORDERS', 'QUALITY'] as const

/** A new link asked for again within this time is not made again (no mail bombing). */
export const RENEW_COALESCE_MS = 10 * 60_000

/** The languages asked, in order: the buyer's (when it is an ISO 639-1 code), then English, then Italian. */
export function languageChain(wanted: string | null | undefined): string[] {
  const first = typeof wanted === 'string' ? wanted.trim().toLowerCase() : ''
  return [...new Set([...(isLanguageCode(first) ? [first] : []), ...FALLBACK_LANGUAGES])]
}

/** `it`, `it or en`, `de, en or it`. */
export function languagesText(languages: readonly string[]): string {
  if (languages.length <= 1) return languages[0] ?? ''
  return `${languages.slice(0, -1).join(', ')} or ${languages.at(-1)}`
}

/** Ten years after the goods left (or after now, before they left): the copies and their sources are kept until then. */
export function retainUntilFor(shippedAt: Date | null, now: Date): Date {
  const next = new Date((shippedAt ?? now).getTime())
  next.setUTCFullYear(next.getUTCFullYear() + DOCUMENT_RETENTION_YEARS)
  return next
}

// ---- the facts ------------------------------------------------------------------------------------------------------

export interface FileFacts {
  readonly id: string
  readonly originalName: string
  readonly sha256: string
  readonly sizeBytes: number
}

export interface SharedFile extends FileFacts {
  readonly contentType: string
  readonly availableAt: string
}

/** A DoC or leaflet issued for exactly the asked revision, in one language, with its signed file (currentDocFor). */
export interface DocOnFile {
  readonly documentId: string
  readonly language: string
  readonly revision: number
  readonly number: string | null
  readonly issuedAt: string | null
  readonly file: FileFacts
}

/** One style × frozen revision of the garments on the shipment. */
export interface StyleOnShipment {
  readonly styleId: string
  readonly code: string
  readonly name: string
  /** The work orders' frozen StyleRevision NUMBER; null when a work order has none. */
  readonly revision: number | null
  /** PPE of any category (product/compliance classificationOf documentsRequired). */
  readonly documentsRequired: boolean
  readonly garments: number
  /** Every document found for the revision, per kind, in the chain's languages (any order). */
  readonly onFile: Readonly<Record<DocumentKind, readonly DocOnFile[]>>
}

export interface DdtOnShipment {
  /** False when an immediate invoice travels instead (Shipment.ddtRequired). */
  readonly required: boolean
  readonly live: { readonly id: string; readonly number: string; readonly documentDate: string; readonly pdf: FileFacts | null } | null
}

export interface ShipmentDocumentsFacts {
  readonly shipment: { readonly number: string; readonly status: ShipmentStatus }
  /** The buyer's language (the sales order's). */
  readonly wantedLanguage: string | null
  readonly styles: readonly StyleOnShipment[]
  readonly ddt: DdtOnShipment
  /** The newest packing list printed for the parcels, or null. */
  readonly packingList: FileFacts | null
  /** The shipment's files shared with its party's links (AVAILABLE). */
  readonly shared: readonly SharedFile[]
}

// ---- the documents ----------------------------------------------------------------------------------------------------

export interface ShipmentDocument {
  /** `DDT`, `PACKING_LIST`, `<KIND>:<styleId>:<revision>`. */
  readonly key: string
  readonly kind: ShipmentDocumentKind
  readonly state: ShipmentDocumentState
  /** It travels by the party's link (a copy shared with the party); the packing list travels in the parcels only. */
  readonly byLink: boolean
  readonly style: { readonly id: string; readonly code: string; readonly name: string; readonly revision: number | null } | null
  /** DoC and leaflet: the buyer's language, the one chosen, and whether it is another one. */
  readonly wantedLanguage: string | null
  readonly language: string | null
  readonly fallback: boolean
  /** The DDT's number, the DoC's reference. */
  readonly number: string | null
  /** The DDT's date (YYYY-MM-DD), the DoC's or leaflet's issue (UTC). */
  readonly date: string | null
  /** The Ddt or ComplianceDocument it is. */
  readonly documentId: string | null
  /** The file that travels. */
  readonly source: FileFacts | null
  /** Its copy on the shipment, shared with the party. */
  readonly copy: SharedFile | null
  readonly message: string
}

export interface ShipmentDocuments {
  readonly languages: readonly string[]
  readonly documents: readonly ShipmentDocument[]
  /** The DoC and the leaflet as the compliance step words them (blocks SHIPPING). */
  readonly checks: readonly ComplianceCheck[]
  readonly blockers: readonly ComplianceCheck[]
  /** A DoC or leaflet that travels in another language than the buyer's. */
  readonly warnings: readonly Issue[]
  readonly counts: { readonly attached: number; readonly toAttach: number; readonly missing: number }
}

const copyOf = (shared: readonly SharedFile[], source: FileFacts | null): SharedFile | null =>
  source === null ? null : ([...shared].filter((file) => file.sha256 === source.sha256).sort((a, b) => a.availableAt.localeCompare(b.availableAt) || a.id.localeCompare(b.id))[0] ?? null)

const styleLabel = (style: StyleOnShipment) => `${style.code}${style.revision === null ? '' : ` (revision ${style.revision})`}`

/** The document of the chain's first language that has one, or null. */
export function chooseDocument(chain: readonly string[], found: readonly DocOnFile[]): DocOnFile | null {
  for (const language of chain) {
    const document = found.find((entry) => entry.language === language)
    if (document) return document
  }
  return null
}

function ddtDocument(facts: ShipmentDocumentsFacts): ShipmentDocument {
  const { ddt } = facts
  const base = { key: 'DDT', kind: 'DDT' as const, byLink: true, style: null, wantedLanguage: null, language: null, fallback: false }
  if (!ddt.required && ddt.live === null) {
    return { ...base, state: 'NOT_REQUIRED', number: null, date: null, documentId: null, source: null, copy: null, message: 'The goods leave with an immediate invoice instead of a DDT.' }
  }
  if (ddt.live === null) {
    return { ...base, state: 'MISSING', number: null, date: null, documentId: null, source: null, copy: null, message: 'The shipment has no live DDT: issue it first.' }
  }
  const { live } = ddt
  const common = { ...base, number: live.number, date: live.documentDate, documentId: live.id, source: live.pdf }
  if (live.pdf === null) {
    return { ...common, state: 'MISSING', copy: null, message: `DDT ${live.number} is issued, but its PDF is not stored yet: print it again, then attach the documents.` }
  }
  const copy = copyOf(facts.shared, live.pdf)
  return copy
    ? { ...common, state: 'ATTACHED', copy, message: `DDT ${live.number} is attached: it travels by the link.` }
    : { ...common, state: 'ON_FILE', copy: null, message: `DDT ${live.number} is stored: attaching copies it onto the shipment for the link.` }
}

function packingListDocument(facts: ShipmentDocumentsFacts): ShipmentDocument {
  const base = { key: 'PACKING_LIST', kind: 'PACKING_LIST' as const, byLink: false, style: null, wantedLanguage: null, language: null, fallback: false, number: facts.shipment.number, date: null, documentId: null, copy: null }
  return facts.packingList
    ? { ...base, state: 'ON_FILE', source: facts.packingList, message: 'The packing list is printed: it travels in the parcels.' }
    : { ...base, state: 'MISSING', source: null, message: 'No packing list is printed yet: print it for the parcels.' }
}

function styleDocument(kind: DocumentKind, style: StyleOnShipment, chain: readonly string[], facts: ShipmentDocumentsFacts): ShipmentDocument {
  const words = DOCUMENT_WORDS[kind]
  const wanted = chain[0] ?? null
  const base = {
    key: `${kind}:${style.styleId}:${style.revision ?? 'none'}`,
    kind,
    byLink: true,
    style: { id: style.styleId, code: style.code, name: style.name, revision: style.revision },
    wantedLanguage: wanted,
  }
  const none = { language: null, fallback: false, number: null, date: null, documentId: null, source: null, copy: null }
  if (!style.documentsRequired) return { ...base, ...none, state: 'NOT_REQUIRED', message: `${style.code} is not PPE: no ${words} travels with it.` }
  if (style.revision === null) {
    return { ...base, ...none, state: 'MISSING', message: `The garments of ${style.code} come from a work order with no frozen style revision, so no ${words} can be chosen for them.` }
  }
  const chosen = chooseDocument(chain, style.onFile[kind])
  if (!chosen) {
    return {
      ...base,
      ...none,
      state: 'MISSING',
      message: `No signed ${words} of ${style.code} for revision ${style.revision} is on file in ${languagesText(chain)}: PPE is shipped only with it (${TRAVEL_LAW[kind]}).`,
    }
  }
  const fallback = chosen.language !== wanted
  const copy = copyOf(facts.shared, chosen.file)
  const where = copy ? 'attached: it travels by the link' : 'on file: attaching copies it onto the shipment for the link'
  const instead = fallback ? ` It is not on file in ${wanted}: the one in ${chosen.language} travels instead.` : ''
  return {
    ...base,
    state: copy ? 'ATTACHED' : 'ON_FILE',
    language: chosen.language,
    fallback,
    number: chosen.number,
    date: chosen.issuedAt,
    documentId: chosen.documentId,
    source: chosen.file,
    copy,
    message: `The ${words} of ${styleLabel(style)} in ${chosen.language} is ${where}.${instead}`,
  }
}

function travelCheck(kind: DocumentKind, styles: readonly StyleOnShipment[], documents: readonly ShipmentDocument[]): ComplianceCheck {
  const words = DOCUMENT_WORDS[kind]
  const done = (state: ComplianceCheckState, message: string, problems: readonly Issue[] = []): ComplianceCheck => ({ code: kind, state, blocks: ['SHIPPING'], message, problems })
  if (!styles.some((style) => style.documentsRequired)) return done('NOT_REQUIRED', `No PPE on this shipment: no ${words} travels with it.`)
  const own = documents.filter((document) => document.kind === kind && document.state !== 'NOT_REQUIRED')
  const missing = own.filter((document) => document.state === 'MISSING')
  if (missing.length > 0) {
    const which = missing.map((document) => (document.style!.revision === null ? document.style!.code : `${document.style!.code} revision ${document.style!.revision}`)).join(', ')
    return done(
      'BLOCKED',
      `The ${words} is not on file for ${which} (${TRAVEL_LAW[kind]}): PPE is shipped only with it.`,
      missing.map((document) => ({ path: `documents/${kind}/${document.style!.code}`, message: document.message })),
    )
  }
  return done('OK', `The ${words} of every PPE style on the shipment is on file (${own.map((document) => `${document.style!.code} in ${document.language}`).join(', ')}).`)
}

/** Every document of the shipment with its state, the shipping checks and the language warnings (see above). */
export function shipmentDocuments(facts: ShipmentDocumentsFacts): ShipmentDocuments {
  const chain = languageChain(facts.wantedLanguage)
  const styles = [...facts.styles].sort((a, b) => a.code.localeCompare(b.code) || (a.revision ?? 0) - (b.revision ?? 0) || a.styleId.localeCompare(b.styleId))
  const documents: ShipmentDocument[] = [
    ddtDocument(facts),
    ...styles.flatMap((style) => [styleDocument('DECLARATION_OF_CONFORMITY', style, chain, facts), styleDocument('USER_INFORMATION', style, chain, facts)]),
    packingListDocument(facts),
  ]
  const checks = [travelCheck('DECLARATION_OF_CONFORMITY', styles, documents), travelCheck('USER_INFORMATION', styles, documents)]
  const warnings: Issue[] = documents
    .filter((document) => document.fallback)
    .map((document) => ({
      path: `documents/${document.kind}/${document.style!.code}`,
      message: `The ${DOCUMENT_WORDS[document.kind as DocumentKind]} of ${document.style!.code} is not on file in ${document.wantedLanguage}: the one in ${document.language} travels. Upload the signed one in ${document.wantedLanguage} when the country the goods are sold in asks for it (${TRAVEL_LAW[document.kind as DocumentKind]}).`,
    }))
  const byLink = documents.filter((document) => document.byLink)
  return {
    languages: chain,
    documents,
    checks,
    blockers: checks.filter((check) => check.state === 'BLOCKED'),
    warnings,
    counts: {
      attached: byLink.filter((document) => document.state === 'ATTACHED').length,
      toAttach: byLink.filter((document) => document.state === 'ON_FILE').length,
      missing: documents.filter((document) => document.state === 'MISSING').length,
    },
  }
}

/** The files attaching copies (one per distinct content): documents that travel by link, on file and not copied yet. */
export function toAttach(documents: readonly ShipmentDocument[]): ShipmentDocument[] {
  const seen = new Set<string>()
  return documents.filter((document) => {
    if (!document.byLink || document.state !== 'ON_FILE' || document.source === null || seen.has(document.source.sha256)) return false
    seen.add(document.source.sha256)
    return true
  })
}

/** The files kept ten years after the shipment left: every travelling document's source and copy. */
export function retainedFiles(documents: readonly ShipmentDocument[]): string[] {
  return [
    ...new Set(
      documents
        .filter((document) => document.byLink)
        .flatMap((document) => [document.source?.id, document.copy?.id])
        .filter((id): id is string => typeof id === 'string'),
    ),
  ].sort()
}

// ---- the link -----------------------------------------------------------------------------------------------------------

export interface LinkDocument {
  readonly fileId: string
  readonly kind: LinkDocumentKind
  readonly title: string
  readonly style: { readonly code: string; readonly name: string; readonly revision: number | null } | null
  readonly language: string | null
  readonly number: string | null
  readonly date: string | null
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly availableAt: string
}

const ORDER: Readonly<Record<LinkDocumentKind, number>> = { DDT: 0, DECLARATION_OF_CONFORMITY: 1, USER_INFORMATION: 2, OTHER: 3 }

/** A document's title in words (the link page's card, the mail's list). */
export function documentTitle(document: Pick<ShipmentDocument, 'kind' | 'number' | 'style' | 'language'>, locale: 'it' | 'en' = 'en'): string {
  const style = document.style ? [document.style.code, document.style.revision === null ? null : `${locale === 'it' ? 'rev.' : 'revision'} ${document.style.revision}`].filter(Boolean).join(' ') : ''
  const details = `${style ? `, ${style}` : ''}${document.language ? ` (${document.language})` : ''}`
  switch (document.kind) {
    case 'DDT':
      return `DDT ${document.number ?? ''}`.trim()
    case 'PACKING_LIST':
      return `${locale === 'it' ? 'Distinta colli' : 'Packing list'} ${document.number ?? ''}`.trim()
    case 'DECLARATION_OF_CONFORMITY':
      return `${locale === 'it' ? 'Dichiarazione UE di conformità' : 'EU Declaration of Conformity'}${details}`
    case 'USER_INFORMATION':
      return `${locale === 'it' ? 'Nota informativa del fabbricante' : 'User information'}${details}`
  }
}

/**
 * What a link lists: EXACTLY the files given (the shipment's files shared with the link's party, read in the link's own
 * scope), each named after the document it copies (same SHA-256), else OTHER with its file name. DDT first, then the
 * DoCs, the leaflets, the others; by title.
 */
export function linkDocuments(shared: readonly SharedFile[], documents: readonly ShipmentDocument[]): LinkDocument[] {
  return shared
    .map((file): LinkDocument => {
      const match = documents.find((document) => document.byLink && document.source !== null && document.source.sha256 === file.sha256) ?? null
      const kind: LinkDocumentKind = match ? (match.kind as Exclude<ShipmentDocumentKind, 'PACKING_LIST'>) : 'OTHER'
      return {
        fileId: file.id,
        kind,
        title: match ? documentTitle(match) : file.originalName,
        style: match?.style ? { code: match.style.code, name: match.style.name, revision: match.style.revision } : null,
        language: match?.language ?? null,
        number: match?.number ?? null,
        date: match?.date ?? null,
        originalName: file.originalName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        availableAt: file.availableAt,
      }
    })
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.title.localeCompare(b.title) || a.fileId.localeCompare(b.fileId))
}

// ---- who gets the link, and a new one -------------------------------------------------------------------------------------

export interface ContactFacts {
  readonly id: string
  readonly name: string
  readonly email: string | null
  readonly roles: readonly string[]
  readonly status: string
}

const normal = (email: string): string => email.trim().toLowerCase()

/** The party's ACTIVE contacts with an address and an ORDERS or QUALITY role, one per address, by name. */
export function linkRecipients<Contact extends ContactFacts>(contacts: readonly Contact[]): Contact[] {
  const seen = new Set<string>()
  return [...contacts]
    .filter((contact) => contact.status === 'ACTIVE' && contact.email !== null && contact.email.trim() !== '' && contact.roles.some((role) => (LINK_CONTACT_ROLES as readonly string[]).includes(role)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .filter((contact) => {
      const address = normal(contact.email!)
      if (seen.has(address)) return false
      seen.add(address)
      return true
    })
}

/** The address is on file: an ACTIVE contact of the party has it (whatever its roles). */
export const isAddressOnFile = (contacts: readonly ContactFacts[], email: string): boolean =>
  contacts.some((contact) => contact.status === 'ACTIVE' && contact.email !== null && normal(contact.email) === normal(email))

export const RENEWAL_REFUSALS = ['NOT_A_SHIPMENT_LINK', 'WITHDRAWN', 'NO_ADDRESS', 'STILL_LIVE', 'SHIPMENT_CANCELLED', 'ADDRESS_NOT_ON_FILE', 'ASKED_RECENTLY'] as const
export type RenewalRefusal = (typeof RENEWAL_REFUSALS)[number]

export interface RenewalFacts {
  readonly purpose: string
  readonly recordType: string
  readonly revoked: boolean
  readonly email: string | null
  /** links/purposes linkState: LIVE, REVOKED, USED_UP, EXPIRED. */
  readonly state: string
  readonly shipmentStatus: ShipmentStatus | null
  readonly contacts: readonly ContactFacts[]
  /** A link to the same address for the same shipment made since now − RENEW_COALESCE_MS. */
  readonly askedRecently: boolean
}

/**
 * Why "ask for a new link" sends nothing, or null when a new link goes to the address the old one was sent to. The
 * answer to the asker is the same either way (the API never tells): a withdrawn link stays withdrawn, a live one still
 * works, the address must still be an ACTIVE contact of the party (never one typed by the asker).
 */
export function renewalRefusal(facts: RenewalFacts): RenewalRefusal | null {
  if (facts.purpose !== 'DOCUMENT_VIEW' || facts.recordType !== 'Shipment') return 'NOT_A_SHIPMENT_LINK'
  if (facts.revoked) return 'WITHDRAWN'
  if (facts.email === null || facts.email.trim() === '') return 'NO_ADDRESS'
  if (facts.state === 'LIVE') return 'STILL_LIVE'
  if (facts.shipmentStatus === null || facts.shipmentStatus === 'CANCELLED') return 'SHIPMENT_CANCELLED'
  if (!isAddressOnFile(facts.contacts, facts.email)) return 'ADDRESS_NOT_ON_FILE'
  if (facts.askedRecently) return 'ASKED_RECENTLY'
  return null
}

/** The one answer of "ask for a new link", whatever the token was (A2 links.frame ask-new-link). */
export const RENEW_ANSWER = 'We passed this on. If the link was ours, the sender will write to the address it was sent to.'
