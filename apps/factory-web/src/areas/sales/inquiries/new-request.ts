import { LAWFUL_BASES, TYPED_SOURCES, type LawfulBasis, type TypedSource } from '@nexus/factory-domain/sales/inquiries/rules'
import type { CreateInquiryBody, FromMailBody } from '@nexus/factory-domain/sales/inquiries/contracts'
import { requestTextOf } from '@nexus/factory-domain/sales/portal-requests/rules'
import { EMPTY_COMPOSE, fieldOfIssue, problemsOf, type ComposeDraft, type ComposeField, type ShipToChoice } from '../../../lib/request-compose/model'
import type { MailDraft, RequestCustomer } from './api'
import { isBlankLine, lineBodyOf, lineProblem, parsePrice, prospectProblem, type InquiriesCan, type LineDraft, type Phrase, type ProspectDraft } from './model'

/**
 * New request in the office (B-TH-221; threads plan O-SAL-INQ-LIST.band-F02, walls W23 and W37), pure: a phone call, a visit, a
 * fair or a letter written down as the portal's New order is (the shared compose, `lib/request-compose`: subject, message, the
 * PO, the day wanted, a delivery address), with what only the office says — how it came, the customer (picked among the
 * customers the API says this person may make a request for: GET /sales/inquiries/customers) OR a prospect (a name, company,
 * e-mail or phone, and the lawful basis, required with any of them: GDPR art. 6), the lines and target price (price grain),
 * "Give it to me". The same draft makes a request from a mail of Mail to sort (`?mail=`: the mail's words, its attachments as
 * the tech pack). Every word is a key of `sales-incoming-new` (`n(…)`), or of `sales-inquiries` for what the list already says.
 */

export const NEW_NS = 'sales-incoming-new'
/** A key of this dialog's own catalogue, as a phrase key the scoped translator reads (`sales-incoming-new:held.basis`). */
export const n = (key: string): string => `${NEW_NS}:${key}`

export { LAWFUL_BASES, TYPED_SOURCES }
export type { LawfulBasis, TypedSource }

export type Who = 'customer' | 'prospect'

export interface NewRequestDraft {
  /** What the portal's compose holds: subject, message, their PO, the day wanted, a delivery address of the customer. */
  readonly compose: ComposeDraft
  readonly source: TypedSource
  readonly who: Who
  readonly partyId: string | null
  readonly contactId: string | null
  readonly prospect: ProspectDraft
  /** The lawful basis of keeping a prospect's data: Contract by default (a request for a quote); required with any prospect field. */
  readonly lawfulBasis: LawfulBasis | null
  readonly lines: readonly LineDraft[]
  readonly targetPrice: string
  readonly currency: string
  readonly assignToMe: boolean
  /** From a mail: its kept attachments named as the customer's tech pack, and the version as they name it. */
  readonly techPackFileIds: readonly string[]
  readonly techPackVersion: string
}

/** Contract: a request for a quote is a step the person asked for (GDPR art. 6(1)(b)). */
export const DEFAULT_BASIS: LawfulBasis = 'CONTRACT'

export const emptyNewRequest = (currency = 'EUR'): NewRequestDraft => ({
  compose: EMPTY_COMPOSE,
  source: 'PHONE',
  who: 'customer',
  partyId: null,
  contactId: null,
  prospect: { name: '', company: '', email: '', phone: '' },
  lawfulBasis: DEFAULT_BASIS,
  lines: [],
  targetPrice: '',
  currency,
  assignToMe: false,
  techPackFileIds: [],
  techPackVersion: '',
})

/** The draft "Make incoming request" starts from: the sender as the customer Nexus knows (else a prospect from its From), its words. */
export function newRequestFromMail(mail: MailDraft, currency = 'EUR'): NewRequestDraft {
  const base = emptyNewRequest(currency)
  return {
    ...base,
    compose: { ...EMPTY_COMPOSE, message: mail.request },
    who: mail.party ? 'customer' : 'prospect',
    partyId: mail.party?.id ?? null,
    contactId: mail.contactId,
    prospect: { name: mail.prospect?.name ?? '', company: mail.prospect?.company ?? '', email: mail.prospect?.email ?? '', phone: mail.prospect?.phone ?? '' },
  }
}

const blank = (value: string): boolean => value.trim() === ''

/** Something of the prospect was typed (then the lawful basis is required). */
export const prospectTyped = (prospect: ProspectDraft): boolean => !blank(prospect.name) || !blank(prospect.company) || !blank(prospect.email) || !blank(prospect.phone)

/** Something was typed at all (closing then asks first). */
export function newRequestTyped(draft: NewRequestDraft): boolean {
  const c = draft.compose
  return [c.subject, c.message, c.customerRef, c.wantedDate, draft.targetPrice, draft.techPackVersion].some((value) => !blank(value)) || prospectTyped(draft.prospect) || draft.lines.some((line) => !isBlankLine(line)) || draft.partyId !== null
}

/** Picking another customer (or the prospect) forgets what belonged to the one before: its contact and its delivery address. */
export function withWho(draft: NewRequestDraft, who: Who, partyId: string | null = null): NewRequestDraft {
  const sameParty = who === 'customer' && draft.who === 'customer' && partyId === draft.partyId
  return { ...draft, who, partyId: who === 'customer' ? partyId : null, contactId: sameParty ? draft.contactId : null, compose: sameParty ? draft.compose : { ...draft.compose, shipToAddressId: '' } }
}

// ---- "Use Brand Alpha?" ----------------------------------------------------------------------------------------------------

const folded = (value: string): string => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * A typed prospect that is already one of the reader's customers (its company or name reads as the customer's legal or trade
 * name, or its code): that customer, so the office uses it and makes no duplicate. Only among the customers the picker holds —
 * the reader's own (W23): it never names a customer the reader may not see.
 */
export function prospectMatch(prospect: ProspectDraft, customers: readonly RequestCustomer[] | null): RequestCustomer | null {
  if (!customers || customers.length === 0) return null
  const typed = [prospect.company, prospect.name].map(folded).filter((value) => value.length >= 3)
  if (typed.length === 0) return null
  return customers.find((customer) => [customer.legalName, customer.tradeName ?? '', customer.code].map(folded).some((name) => name.length >= 3 && typed.includes(name))) ?? null
}

// ---- the styles a request may name -------------------------------------------------------------------------------------------

/** The styles a line may name: the open range, and the private labels of THIS customer only (never another's; a prospect: none). */
export function stylesFor<S extends { brand?: { id: string } | null }>(styles: readonly S[] | null, who: Who, partyId: string | null): S[] | null {
  if (styles === null) return null
  return styles.filter((style) => !style.brand || (who === 'customer' && partyId !== null && style.brand.id === partyId))
}

// ---- why Create request waits ---------------------------------------------------------------------------------------------

export interface HeldFacts {
  readonly can: Pick<InquiriesCan, 'manage' | 'price'>
  readonly offline: boolean
  readonly busy: boolean
  /** Made from a mail: its words may stay as they came. */
  readonly fromMail: boolean
  /** The company numbers no request yet (Admin › Numbering): the create would be refused. */
  readonly unnumbered: boolean
  readonly today: string
}

/** Why Create request is held, in words (a phrase), or null. Held, never hidden: the button says why. */
export function newRequestHeld(draft: NewRequestDraft, facts: HeldFacts): Phrase | null {
  if (!facts.can.manage) return { key: 'held.right', params: { right: 'right.sales.inquiries.manage' } }
  if (facts.busy) return { key: n('held.busy') }
  if (facts.unnumbered) return { key: n('held.unnumbered') }
  if (draft.who === 'customer' && !draft.partyId) return { key: n('held.customer') }
  if (draft.who === 'prospect') {
    const problem = prospectProblem(draft.prospect)
    if (problem) return problem
    if (draft.lawfulBasis === null) return { key: n('held.basis') }
  }
  if (!facts.fromMail && blank(draft.compose.message)) return { key: n('held.message') }
  if (Object.keys(composeProblems(draft, facts.today)).length > 0) return { key: n('held.problems') }
  if (facts.can.price && !blank(draft.targetPrice) && parsePrice(draft.targetPrice) === null) return { key: 'request.problem.price' }
  const lines = draft.lines.filter((line) => !isBlankLine(line))
  const index = lines.findIndex((line) => lineProblem(line) !== null)
  if (index >= 0) return { key: 'line.problem.at', params: { n: index + 1, problem: lineProblem(lines[index]!)!.key } }
  if (facts.offline) return { key: 'held.offline' }
  return null
}

/** The compose's own problems (the API's checks, said first), a delivery address only with a customer. */
export function composeProblems(draft: NewRequestDraft, today: string): Partial<Record<ComposeField, string>> {
  return problemsOf(draft.who === 'prospect' ? { ...draft.compose, shipToAddressId: '' } : draft.compose, today)
}

/** The API refused a field of the compose (`body/shipToAddressId`): that field and its words, so the box itself says it. */
export function composeRefusals(paths: readonly string[]): Partial<Record<ComposeField, string>> {
  const out: Partial<Record<ComposeField, string>> = {}
  for (const path of paths) {
    const field = fieldOfIssue(path) ?? (path.replace(/^body[/.]/, '') === 'request' ? 'message' : null)
    if (field === 'shipToAddressId') out.shipToAddressId = 'problem.shipTo'
    else if (field === 'customerRef') out.customerRef = 'problem.refLong'
    else if (field === 'wantedDate') out.wantedDate = 'problem.datePast'
    else if (field === 'message') out.message = 'problem.tooLong'
  }
  return out
}

// ---- what is sent -------------------------------------------------------------------------------------------------------------

const clean = (value: string): string | null => (blank(value) ? null : value.trim())

/** Who asks: the customer (and the contact), or the prospect with its lawful basis — never both, never a stranger's party. */
function whoBody(draft: NewRequestDraft) {
  if (draft.who === 'customer' && draft.partyId) return { partyId: draft.partyId, ...(draft.contactId ? { contactId: draft.contactId } : {}) }
  const p = draft.prospect
  return { prospect: { name: clean(p.name), company: clean(p.company), email: clean(p.email), phone: clean(p.phone), lawfulBasis: draft.lawfulBasis ?? DEFAULT_BASIS } }
}

/** What they asked, the details and the office's own fields; a delivery address only with a customer. */
function askedBody(draft: NewRequestDraft, can: Pick<InquiriesCan, 'price'>, me: string | null) {
  const c = draft.compose
  const price = can.price ? parsePrice(draft.targetPrice) : null
  const lines = draft.lines.filter((line) => !isBlankLine(line))
  return {
    ...(c.wantedDate ? { wantedDate: c.wantedDate } : {}),
    ...(clean(c.customerRef) ? { customerRef: c.customerRef.trim() } : {}),
    ...(draft.who === 'customer' && draft.partyId && c.shipToAddressId ? { shipToAddressId: c.shipToAddressId } : {}),
    ...(price !== null ? { targetUnitPrice: price } : {}),
    currency: draft.currency,
    ...(blank(draft.techPackVersion) ? {} : { techPackVersion: draft.techPackVersion.trim() }),
    ...(lines.length > 0 ? { lines: lines.map(lineBodyOf) } : {}),
    ...(draft.assignToMe && me ? { assigneeId: me } : {}),
  }
}

/** The request in words as the office reads it: the subject (when typed) as its first line, then the message as written. */
export const requestWords = (compose: Pick<ComposeDraft, 'subject' | 'message'>): string => requestTextOf(compose.subject, compose.message).trim()

/** POST /sales/inquiries: what New request sends. The company is the page's; the party one the picker offered, or none. */
export function newRequestBody(draft: NewRequestDraft, companyId: string, can: Pick<InquiriesCan, 'price'>, me: string | null): CreateInquiryBody {
  return { companyId, source: draft.source, ...whoBody(draft), request: requestWords(draft.compose), ...askedBody(draft, can, me) } as CreateInquiryBody
}

/** POST /sales/inquiries/from-mail/:id: "Make incoming request" (the MAIL's version; its words when left as they came). */
export function fromMailRequestBody(draft: NewRequestDraft, mail: MailDraft, version: number, can: Pick<InquiriesCan, 'price'>, me: string | null, companyId: string | null): FromMailBody {
  const words = requestWords(draft.compose)
  return {
    version,
    ...(mail.companyId === null && companyId ? { companyId } : {}),
    ...whoBody(draft),
    ...(words !== '' ? { request: words } : {}),
    ...(draft.techPackFileIds.length > 0 ? { techPackFileIds: [...draft.techPackFileIds] } : {}),
    ...askedBody(draft, can, me),
  } as FromMailBody
}

// ---- the customer's delivery addresses ------------------------------------------------------------------------------------------

export interface PartyAddressRead {
  readonly id: string
  readonly kinds: readonly string[]
  readonly name: string | null
  readonly line1: string
  readonly postalCode: string
  readonly city: string
  readonly status: string
  readonly isDefaultShipTo: boolean
  readonly approval?: { readonly status: string } | null
}

/** The delivery addresses a request may name: the customer's active SHIP_TO ones, never one we refused; the default first. */
export function shipToOf(addresses: readonly PartyAddressRead[]): ShipToChoice[] {
  return addresses
    .filter((address) => address.status === 'ACTIVE' && address.kinds.includes('SHIP_TO') && address.approval?.status !== 'REFUSED')
    .sort((a, b) => Number(b.isDefaultShipTo) - Number(a.isDefaultShipTo))
    .map((address) => ({
      id: address.id,
      label: [address.name, address.line1, [address.postalCode, address.city].filter(Boolean).join(' ')].filter((part): part is string => !!part && part.trim() !== '').join(', '),
      waiting: address.approval?.status === 'WAITING',
      isDefault: address.isDefaultShipTo,
    }))
}

// ---- the compose in the office's voice -----------------------------------------------------------------------------------------

/**
 * The compose's labels that speak to the customer in the portal ("Your message", "Your PO") and have the office's words here
 * ("What they asked", "Their PO"): `sales-incoming-new` `voice.<key>`.
 */
export const OFFICE_VOICE: ReadonlySet<string> = new Set([
  'compose.label',
  'subject.hint',
  'subject.used',
  'message.label',
  'message.hint',
  'problem.tooLong',
  'problem.refLong',
  'problem.datePast',
  'problem.shipTo',
  'details.none',
  'details.ref',
  'details.refHint',
  'details.dateHint',
  'details.shipToHint',
  'details.shipToWaiting',
  'details.shipToFailed',
  'details.sumRef',
  'kept.offline',
])
