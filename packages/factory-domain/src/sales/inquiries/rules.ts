import type { Issue } from '../../core/errors'

/**
 * Inquiries and requests for quotation (B-W2b-295; SAL-032 inquiry and RFQ intake, SAL-033 inquiry from email, SAL-305 the
 * brand's tech pack on the inquiry and the order; design sales.inquiries SCR-105: the tiles, the list, the inquiry with its
 * Request, Files & specs, Quote and Activity tabs, New inquiry, Assign, Decline inquiry), pure. factory-db sales-intake.prisma
 * (B-W2b-279) holds the rows and the …_sales_intake_w2b_guards triggers repeat every rule below for every login; this file says
 * each refusal FIRST, in words, so a person never meets the database's message.
 *
 * An inquiry is what a customer (a party) or a prospect (a person or company not yet a party) asks: in words, and as lines
 * (a style in a colourway, or a description; the pieces by size or in all), with a target price and the day they want the
 * goods by. It is typed by the office (a visit, a phone call, a fair, a portal request recorded by hand) or made from a mail
 * in Mail to sort ("Make an inquiry": the mail and its attachments are kept with it). Someone answers it:
 *
 *   NEW ──assign──▶ ASSIGNED ──ask for more information──▶ NEED_INFO ──answered──▶ ASSIGNED (or NEW: nobody assigned)
 *    ◀──take off──┘     │                                        │
 *                       └── make quote · make order · decline · lost ──┴──▶ QUOTED | ORDERED | DECLINED | LOST (final)
 *
 * A QUOTED inquiry names the quote it became (one quote per inquiry, one inquiry per quote); a quote needs a customer, so a
 * prospect is matched to a party first. DECLINED says why (OTHER in words); LOST says in words why the customer went away.
 * TH-2 (threads schema wave 3/9, B-TH-022): an ORDERED inquiry names the order made straight from it (one order per inquiry,
 * B-TH-025); "Not an order" (NOT_AN_ORDER) is a decline reason for a request that asks nothing to make (B-TH-043).
 * TH-9 (threads schema wave 9/9, B-TH-090): a customer may withdraw its own request before the office decided (WITHDRAWN, from
 * an open state, closed by a portal person of that customer: B-TH-095); production's answer (OK, or not before a week) is a
 * column of the office's (B-TH-094).
 * A closed inquiry is frozen but for its note (and the erasure of its prospect, GDPR art. 17). The brand's tech pack is a set
 * of files of the inquiry or of its mail with the version the brand names; the quote and the order made from it read it from
 * the inquiry, each file as its current version ("always the version in force").
 */

export const INQUIRY_SOURCES = ['OFFICE', 'MAIL', 'PORTAL', 'PHONE', 'FAIR'] as const
export type InquirySource = (typeof INQUIRY_SOURCES)[number]
/** What the office types by hand (New inquiry); MAIL only through "Make an inquiry" from a mail. */
export const TYPED_SOURCES = ['OFFICE', 'PHONE', 'FAIR', 'PORTAL'] as const satisfies readonly InquirySource[]
export type TypedSource = (typeof TYPED_SOURCES)[number]

// B-TH-090: WITHDRAWN, the customer withdrew it before the office decided (final, like the others closed).
export const INQUIRY_STATUSES = ['NEW', 'ASSIGNED', 'NEED_INFO', 'QUOTED', 'DECLINED', 'LOST', 'ORDERED', 'WITHDRAWN'] as const
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number]
export const OPEN_STATUSES = ['NEW', 'ASSIGNED', 'NEED_INFO'] as const satisfies readonly InquiryStatus[]
export const CLOSED_STATUSES = ['QUOTED', 'DECLINED', 'LOST', 'ORDERED', 'WITHDRAWN'] as const satisfies readonly InquiryStatus[]
export const isOpen = (status: InquiryStatus): boolean => (OPEN_STATUSES as readonly string[]).includes(status)

export const DECLINE_REASONS = ['CAPACITY', 'LEAD_TIME', 'NOT_OUR_PRODUCT', 'PRICE', 'OTHER', 'NOT_AN_ORDER'] as const
export type DeclineReason = (typeof DECLINE_REASONS)[number]

/** GDPR art. 6(1): a contact's and a prospect's lawful basis. A request for a quote is CONTRACT (steps at the person's request). */
export const LAWFUL_BASES = ['CONTRACT', 'CONSENT', 'LEGITIMATE_INTEREST', 'LEGAL_DUTY'] as const
export type LawfulBasis = (typeof LAWFUL_BASES)[number]
export const PROSPECT_DEFAULT_BASIS: LawfulBasis = 'CONTRACT'

/**
 * The list's saved filters (SCR-105 inquiries.tiles and the Rows ▾ saved rows): NEW; WAITING_US (open, not waiting for the
 * customer, more than one working day since it came); WAITING_CUSTOMER (NEED_INFO); QUOTED_THIS_WEEK; MINE (assigned to the
 * reader, open); OPEN; QUOTED; DECLINED; LOST; ALL.
 */
export const INQUIRY_TILES = ['NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'QUOTED_THIS_WEEK', 'MINE', 'OPEN', 'QUOTED', 'DECLINED', 'LOST', 'ALL'] as const
export type InquiryTile = (typeof INQUIRY_TILES)[number]

export const INQUIRY_LIMITS = Object.freeze({
  request: 20_000,
  note: 4000,
  closeNote: 2000,
  prospectName: 200,
  prospectCompany: 200,
  email: 254,
  phone: 40,
  techPackFiles: 50,
  techPackVersion: 100,
  lines: 100,
  lineDescription: 2000,
  colourText: 100,
  lineNote: 2000,
  sizes: 60,
  sizeCode: 20,
  sizePieces: 100_000,
  quantity: 1_000_000,
  list: 200,
  bulk: 100,
  summary: 120,
  customerRef: 100,
})

/** "Waiting for us over 1 working day": one working day of the default pattern (08:00-17:00 with a lunch hour, 480 minutes). */
export const WORKING_DAY_MINUTES = 480

type Words = { readonly it: string; readonly en: string }

export const STATUS_WORDS: Readonly<Record<InquiryStatus, Words>> = Object.freeze({
  NEW: { it: 'Nuova', en: 'New' },
  ASSIGNED: { it: 'In lavorazione', en: 'In progress' },
  NEED_INFO: { it: 'Servono informazioni', en: 'Need info' },
  QUOTED: { it: 'Preventivata', en: 'Quoted' },
  DECLINED: { it: 'Rifiutata', en: 'Declined' },
  LOST: { it: 'Persa', en: 'Lost' },
  ORDERED: { it: 'Ordinata', en: 'Ordered' },
  WITHDRAWN: { it: 'Ritirata', en: 'Withdrawn' },
})
export const SOURCE_WORDS: Readonly<Record<InquirySource, Words>> = Object.freeze({
  OFFICE: { it: 'Ufficio', en: 'Office' },
  MAIL: { it: 'E-mail', en: 'E-mail' },
  PORTAL: { it: 'Portale', en: 'Portal' },
  PHONE: { it: 'Telefono', en: 'Phone' },
  FAIR: { it: 'Fiera', en: 'Fair' },
})
export const DECLINE_WORDS: Readonly<Record<DeclineReason, Words>> = Object.freeze({
  CAPACITY: { it: 'Capacità', en: 'Capacity' },
  LEAD_TIME: { it: 'Tempi di consegna', en: 'Lead time' },
  NOT_OUR_PRODUCT: { it: 'Non è un nostro prodotto', en: 'Not our product' },
  PRICE: { it: 'Prezzo', en: 'Price' },
  OTHER: { it: 'Altro', en: 'Other' },
  NOT_AN_ORDER: { it: 'Non è un ordine', en: 'Not an order' },
})

// ---- refusals ----------------------------------------------------------------------------------------------------------

export const INQUIRY_REFUSALS = [
  'CLOSED',
  'SAME_ASSIGNEE',
  'NOT_ASSIGNED',
  'ALREADY_WAITING',
  'NOT_WAITING',
  'NEEDS_CUSTOMER',
  'OTHER_NEEDS_WORDS',
  'MAIL_TAKEN',
  'QUOTE_TAKEN',
  'MAIL_NOT_WAITING',
  // B-TH-014: the reader's role reads requests and answers none (the production manager).
  'READ_ONLY',
  // ---- B-TH-025 / B-TH-026: Make order and Make style draft
  'NO_LINES',
  'LINES_NOT_READY',
  'STYLE_DRAFTS_FULL',
  // ---- end B-TH-025 / B-TH-026
  // ---- B-TH-042: answer a new customer (make the customer from the prospect, or match it after the check)
  'NOT_PROSPECT',
  'PROSPECT_ERASED',
  'CONFIRM_MATCH',
  'MATCH_FOUND',
  'CODE_TAKEN',
  // ---- end B-TH-042
  // ---- B-TH-043: "Not an order" sends nothing to the customer
  'SENDS_NOTHING',
  // ---- end B-TH-043
] as const
export type InquiryRefusalCode = (typeof INQUIRY_REFUSALS)[number]
export interface InquiryRefusal {
  readonly code: InquiryRefusalCode
  readonly message: string
}
const refusal = (code: InquiryRefusalCode, message: string): InquiryRefusal => ({ code, message })

/** What a refusal reads of an inquiry. */
export interface InquiryFacts {
  readonly number: string
  readonly status: InquiryStatus
  readonly assigneeId: string | null
  readonly partyId: string | null
}

const closed = (facts: InquiryFacts): InquiryRefusal | null =>
  isOpen(facts.status) ? null : refusal('CLOSED', `${facts.number} is ${STATUS_WORDS[facts.status].en.toLowerCase()}: a closed inquiry changes no more (only its note).`)

/** Changing what is asked (request, lines, target, tech pack, the customer or prospect): only while open. */
export const editRefusal = (facts: InquiryFacts): InquiryRefusal | null => closed(facts)

/** Giving it to someone (or to someone else). */
export function assignRefusal(facts: InquiryFacts, assigneeId: string): InquiryRefusal | null {
  return closed(facts) ?? (facts.assigneeId === assigneeId ? refusal('SAME_ASSIGNEE', `${facts.number} is already with this person.`) : null)
}

/** Taking the assignee off (back to NEW; a NEED_INFO inquiry keeps waiting, with nobody). */
export function unassignRefusal(facts: InquiryFacts): InquiryRefusal | null {
  return closed(facts) ?? (facts.assigneeId === null ? refusal('NOT_ASSIGNED', `${facts.number} is with nobody.`) : null)
}

/** "Ask for more information": NEED_INFO, waiting for the customer. */
export function askInfoRefusal(facts: InquiryFacts): InquiryRefusal | null {
  return closed(facts) ?? (facts.status === 'NEED_INFO' ? refusal('ALREADY_WAITING', `${facts.number} already waits for the customer.`) : null)
}

/** The customer answered: back to ASSIGNED (or NEW with nobody assigned). */
export function resumeRefusal(facts: InquiryFacts): InquiryRefusal | null {
  return closed(facts) ?? (facts.status !== 'NEED_INFO' ? refusal('NOT_WAITING', `${facts.number} does not wait for the customer.`) : null)
}

export function declineRefusal(facts: InquiryFacts, reason: DeclineReason, note: string | null): InquiryRefusal | null {
  return closed(facts) ?? (reason === 'OTHER' && (note === null || note.trim() === '') ? refusal('OTHER_NEEDS_WORDS', 'Say in words why it is declined (the reason is Other).') : null)
}

export const loseRefusal = (facts: InquiryFacts): InquiryRefusal | null => closed(facts)

// ---- B-TH-043 (threads plan G6, N13): Decline with one message, and Not an order ------------------------------------------

/**
 * The one message a single decline may send to the customer (the "Send to the customer" tick; a decline of several requests never
 * sends: its body has no message). "Not an order" closes a request that asks nothing to make (spam, a wrong address, a question)
 * without a word to the customer, who reads "Closed"; a prospect is no customer yet: it is made a customer first (B-TH-042), as
 * for Ask for info.
 */
export function declineMessageRefusal(facts: InquiryFacts, reason: DeclineReason): InquiryRefusal | null {
  if (reason === 'NOT_AN_ORDER') return refusal('SENDS_NOTHING', `"Not an order" closes ${facts.number} without a word to the customer (they read "Closed"): pick another reason to send a message.`)
  return messageRefusal(facts)
}

/** A message from the request (Decline's, the record's "who gets it"): only to a customer of it, never to a prospect. */
export function messageRefusal(facts: InquiryFacts): InquiryRefusal | null {
  return facts.partyId === null ? refusal('NEEDS_CUSTOMER', `${facts.number} is from a prospect: make the customer first; a message goes to a customer of this request.`) : null
}
// ---- end B-TH-043

/** Making the quote: open, and a customer (a quote is made for a party; a prospect is matched to one first). */
export function quoteRefusal(facts: InquiryFacts): InquiryRefusal | null {
  return closed(facts) ?? (facts.partyId === null ? refusal('NEEDS_CUSTOMER', `${facts.number} is from a prospect: match it to a customer (or make the customer) first; a quote is made for a customer.`) : null)
}

// ---- B-TH-025 (threads plan G3): Make order — the order made straight from the request -----------------------------------

/** One line as "Make order" reads it (the same facts as a quote's). */
export type OrderableLine = QuotableLine

/**
 * Making the order: open, from a customer (an order is made for a party; a prospect is made a customer first), with lines, and
 * every line ready to order (a style, its colourway, pieces by size). A line that is not is never left out of an order (unlike a
 * quote, which the office prices and completes later): the refusal names each line and what it lacks ("Make the style draft
 * first" for a line asked in words).
 */
export function orderRefusal(facts: InquiryFacts, lines: readonly OrderableLine[]): InquiryRefusal | null {
  const shut = closed(facts)
  if (shut) return shut
  if (facts.partyId === null) return refusal('NEEDS_CUSTOMER', `${facts.number} is from a prospect: make the customer first (or match it to one); an order is made for a customer.`)
  if (lines.length === 0) return refusal('NO_LINES', `${facts.number} names nothing to make yet: add its lines (style, colourway, pieces by size), then make the order.`)
  const { leftOut } = quotableLines(lines)
  if (leftOut.length === 0) return null
  const said = leftOut.map((line) => `line ${line.seq}: ${line.reason.replace(/: add (it|the sizes) on the quote\.$/, '')}`).join('; ')
  const draftFirst = leftOut.some((line) => lines.find((each) => each.seq === line.seq)?.styleId === null) ? ' A line asked in words needs its style first: make the style draft, then pick it on the line.' : ''
  return refusal('LINES_NOT_READY', `${facts.number} cannot become an order yet (${said}).${draftFirst}`)
}

/** Why an order made from a request waits for a yes: the customer's credit, or an approval rule for orders. */
export type OrderWaitsFor = 'CREDIT' | 'APPROVAL'

/** What "Make order" says (the toast, the answer): made and confirmed, or made and waiting — never "confirmed" while it waits (L2-G06). */
export function orderMadeWords(order: string, request: string, waitsFor: OrderWaitsFor | null): Words {
  if (waitsFor === 'CREDIT') {
    return {
      it: `L'ordine ${order} è stato creato da ${request} ed è in attesa di approvazione: il cliente supera il fido o ha un blocco del credito.`,
      en: `Order ${order} was made from ${request} and waits for approval: the customer is over its credit limit or on a credit hold.`,
    }
  }
  if (waitsFor === 'APPROVAL') {
    return {
      it: `L'ordine ${order} è stato creato da ${request} ed è in attesa di approvazione: una regola di approvazione degli ordini chiede prima un sì.`,
      en: `Order ${order} was made from ${request} and waits for approval: an approval rule for orders asks for a yes first.`,
    }
  }
  return { it: `L'ordine ${order} è stato creato da ${request} ed è confermato.`, en: `Order ${order} was made from ${request} and is confirmed.` }
}

// ---- B-TH-026 (threads plan L2-G18): Make style draft — a draft style named on the request ---------------------------------

/** The most style drafts one request names (the database's Inquiry_style_drafts_check). */
export const STYLE_DRAFTS_MAX = 50

/**
 * Making a style draft: the request stays open (it is not answered by a draft), so a closed request takes none (the database
 * freezes its drafts with it); a prospect has no brand to make it for yet; at most STYLE_DRAFTS_MAX per request.
 */
export function styleDraftRefusal(facts: InquiryFacts, drafts: number): InquiryRefusal | null {
  const shut = closed(facts)
  if (shut) return shut
  if (facts.partyId === null) return refusal('NEEDS_CUSTOMER', `${facts.number} is from a prospect: make the customer first; a style draft is made for the customer's own label.`)
  if (drafts >= STYLE_DRAFTS_MAX) return refusal('STYLE_DRAFTS_FULL', `${facts.number} already names ${STYLE_DRAFTS_MAX} style drafts, the most one request names.`)
  return null
}
// ---- end B-TH-025 / B-TH-026

/** B-TH-014: an action the reader's role does not take (it reads requests; sales answers them), said instead of hiding it. */
export const readOnlyRefusal = (): InquiryRefusal => refusal('READ_ONLY', 'Your role reads requests; answering them (a quote, a question, a decline, who keeps it) is for sales.')

/** A mail already made into an inquiry (one inquiry per mail). */
export const mailTakenRefusal = (number: string | null): InquiryRefusal => refusal('MAIL_TAKEN', number ? `This mail was already made into ${number}.` : 'This mail was already made into an inquiry.')
export const quoteTakenRefusal = (): InquiryRefusal => refusal('QUOTE_TAKEN', 'This quote was already made from another inquiry.')
/** "Make an inquiry" takes a mail that waits in Mail to sort (TRIAGE or HELD) or one already in a thread; never a thrown-away or unread one. */
export function mailRefusal(status: string): InquiryRefusal | null {
  return ['TRIAGE', 'HELD', 'MATCHED'].includes(status) ? null : refusal('MAIL_NOT_WAITING', `This mail is ${status.toLowerCase()}: only a mail that was read (waiting in Mail to sort, or in a thread) is made into an inquiry.`)
}

// ---- moves -------------------------------------------------------------------------------------------------------------

/** The status after an assignee is given: NEW becomes ASSIGNED; ASSIGNED and NEED_INFO stay. */
export const statusAfterAssign = (status: InquiryStatus): InquiryStatus => (status === 'NEW' ? 'ASSIGNED' : status)
/** The status after the assignee is taken off: ASSIGNED goes back to NEW; NEED_INFO keeps waiting. */
export const statusAfterUnassign = (status: InquiryStatus): InquiryStatus => (status === 'ASSIGNED' ? 'NEW' : status)
/** The status when the customer answered: someone has it, else nobody. */
export const statusAfterResume = (assigneeId: string | null): InquiryStatus => (assigneeId === null ? 'NEW' : 'ASSIGNED')

// ---- what is asked -----------------------------------------------------------------------------------------------------

/** Pieces per size code, as the database keeps them: { "50": 5, "52": 10 }. */
export type SizePieces = Readonly<Record<string, number>>
export const SIZE_CODE = /^[A-Za-z0-9][A-Za-z0-9 ./+-]{0,19}$/

export function sizesProblems(sizes: SizePieces, path: string): Issue[] {
  const entries = Object.entries(sizes)
  const problems: Issue[] = []
  if (entries.length > INQUIRY_LIMITS.sizes) problems.push({ path, message: `At most ${INQUIRY_LIMITS.sizes} sizes on a line.` })
  for (const [code, pieces] of entries) {
    if (!SIZE_CODE.test(code)) problems.push({ path: `${path}/${code}`, message: `"${code}" is not a size code (letters, digits, space . / + -; up to 20).` })
    if (!Number.isInteger(pieces) || pieces < 1 || pieces > INQUIRY_LIMITS.sizePieces) problems.push({ path: `${path}/${code}`, message: `Size ${code}: whole pieces from 1 to ${INQUIRY_LIMITS.sizePieces}.` })
  }
  return problems
}

export const piecesOfSizes = (sizes: SizePieces): number => Object.values(sizes).reduce((sum, pieces) => sum + pieces, 0)

/** One line as it is asked (design inquiry.req.form "Styles or products asked", "Quantities by size"). */
export interface LineInput {
  readonly styleId?: string | null | undefined
  readonly colourwayId?: string | null | undefined
  readonly colourText?: string | null | undefined
  readonly description?: string | null | undefined
  readonly sizes?: SizePieces | undefined
  readonly quantity?: number | null | undefined
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): boolean => value === undefined || value === null || value.trim() === ''

/** A line's own problems (the database's InquiryLine_guard, said first): a style or words; a colourway with its style; the sizes; the quantity. */
export function lineProblems(line: LineInput, path: string): Issue[] {
  const problems: Issue[] = []
  if (blank(line.styleId) && blank(line.description)) problems.push({ path: `${path}/description`, message: 'Pick a style, or say in words what is asked.' })
  if (!blank(line.colourwayId) && blank(line.styleId)) problems.push({ path: `${path}/colourwayId`, message: 'A colourway is picked with its style.' })
  if (!blank(line.colourText) && /[\r\n]/.test(line.colourText!)) problems.push({ path: `${path}/colourText`, message: 'The colour in words is one line.' })
  const sizes = line.sizes ?? {}
  problems.push(...sizesProblems(sizes, `${path}/sizes`))
  const total = piecesOfSizes(sizes)
  if (line.quantity !== undefined && line.quantity !== null) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > INQUIRY_LIMITS.quantity) problems.push({ path: `${path}/quantity`, message: `Whole pieces from 1 to ${INQUIRY_LIMITS.quantity}.` })
    else if (total > 0 && line.quantity !== total) problems.push({ path: `${path}/quantity`, message: `The pieces in all are the sum of the sizes (${total}).` })
  }
  if (total > INQUIRY_LIMITS.quantity) problems.push({ path: `${path}/sizes`, message: `At most ${INQUIRY_LIMITS.quantity} pieces on a line.` })
  return problems
}

/** The quantity a line keeps: the sum of its sizes when they are given, else what was said (or none). */
export const quantityOf = (line: LineInput): number | null => {
  const total = piecesOfSizes(line.sizes ?? {})
  return total > 0 ? total : (line.quantity ?? null)
}

/** The sizes kept as stored JSON: whole pieces per code, codes trimmed, in the order given. */
export const storedSizes = (sizes: SizePieces | undefined): Record<string, number> => Object.fromEntries(Object.entries(sizes ?? {}).map(([code, pieces]) => [code.trim(), pieces]))

/** The stored sizes read back (a JSON column): whole pieces per code; anything else is left out. */
export function sizesOf(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isInteger(entry[1])))
}

/** "Quantity by size (short)" of the list: 50:5 52:10 54:5, up to six sizes, then "…". */
export function sizesShort(sizes: SizePieces): string {
  const entries = Object.entries(sizes)
  const shown = entries.slice(0, 6).map(([code, pieces]) => `${code}:${pieces}`)
  return entries.length > 6 ? `${shown.join(' ')} …` : shown.join(' ')
}

/** The list's Summary: the request's first non-empty line, at most 120 characters. */
export function summaryOf(request: string): string {
  const first = request.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? ''
  return first.length > INQUIRY_LIMITS.summary ? `${first.slice(0, INQUIRY_LIMITS.summary - 1)}…` : first
}

// ---- who asks ----------------------------------------------------------------------------------------------------------

export interface ProspectInput {
  readonly name?: string | null | undefined
  readonly company?: string | null | undefined
  readonly email?: string | null | undefined
  readonly phone?: string | null | undefined
  readonly lawfulBasis?: LawfulBasis | undefined
}

/** A prospect as kept: trimmed words, the e-mail in lower case, blanks as none. */
export interface Prospect {
  readonly name: string | null
  readonly company: string | null
  readonly email: string | null
  readonly phone: string | null
  readonly lawfulBasis: LawfulBasis
}

const trimmed = (value: string | null | undefined): string | null => (blank(value) ? null : value!.trim())
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const PHONE = /^\+?[0-9][0-9 ()./-]{2,38}$/

export function prospectOf(input: ProspectInput): Prospect {
  const email = trimmed(input.email)
  return { name: trimmed(input.name), company: trimmed(input.company), email: email === null ? null : email.toLowerCase(), phone: trimmed(input.phone), lawfulBasis: input.lawfulBasis ?? PROSPECT_DEFAULT_BASIS }
}

/** The database's prospect rules, said first: a name, company or e-mail; one-line words; an e-mail address and a phone number in their shapes. */
export function prospectProblems(prospect: Prospect, path: string): Issue[] {
  const problems: Issue[] = []
  if (prospect.name === null && prospect.company === null && prospect.email === null) problems.push({ path, message: 'Say who asks: a name, a company or an e-mail address.' })
  for (const [field, value, max] of [['name', prospect.name, INQUIRY_LIMITS.prospectName], ['company', prospect.company, INQUIRY_LIMITS.prospectCompany]] as const) {
    if (value !== null && (value.length > max || /[\r\n]/.test(value))) problems.push({ path: `${path}/${field}`, message: `One line of up to ${max} characters.` })
  }
  if (prospect.email !== null && (prospect.email.length > INQUIRY_LIMITS.email || !EMAIL.test(prospect.email))) problems.push({ path: `${path}/email`, message: 'Not an e-mail address.' })
  if (prospect.phone !== null && !PHONE.test(prospect.phone)) problems.push({ path: `${path}/phone`, message: 'A phone number: digits, spaces and ( ) . / -, an optional + first (3 to 40).' })
  return problems
}

/** The prospect a mail's sender is (Make an inquiry from an unknown sender): their name and address. */
export function prospectFromMail(mail: { readonly fromAddress: string | null; readonly fromName: string | null }): Prospect {
  const name = trimmed(mail.fromName)
  return prospectOf({ name: name === null ? null : name.replace(/[\r\n]+/g, ' ').slice(0, INQUIRY_LIMITS.prospectName), email: mail.fromAddress })
}

/** What a mail asks, as the inquiry's request: the subject, then the text (at most 20 000 characters; a mail without either: its subject line "—"). */
export function requestFromMail(mail: { readonly subject: string | null; readonly bodyText: string | null }): string {
  const subject = trimmed(mail.subject)
  const text = trimmed(mail.bodyText)
  const request = [subject, text].filter((part): part is string => part !== null).join('\n\n')
  return (request === '' ? '—' : request).slice(0, INQUIRY_LIMITS.request)
}

// ---- the tech pack -----------------------------------------------------------------------------------------------------

export function techPackProblems(fileIds: readonly string[], path: string): Issue[] {
  if (fileIds.length > INQUIRY_LIMITS.techPackFiles) return [{ path, message: `A tech pack is at most ${INQUIRY_LIMITS.techPackFiles} files.` }]
  return new Set(fileIds).size === fileIds.length ? [] : [{ path, message: 'Each file once.' }]
}

/** A tech pack file as named and its version in force: the series' newest AVAILABLE version not superseded. */
export interface TechPackFile {
  readonly id: string
  readonly seriesId: string | null
  readonly versionNo: number
  readonly status: string
  readonly supersededAt: Date | null
}
export const seriesOf = (file: Pick<TechPackFile, 'id' | 'seriesId'>): string => file.seriesId ?? file.id
/** The version in force of a series (its newest AVAILABLE version that no later one superseded), or null. */
export function currentOf<File extends TechPackFile>(versions: readonly File[]): File | null {
  const live = versions.filter((version) => version.status === 'AVAILABLE' && version.supersededAt === null)
  return live.sort((a, b) => b.versionNo - a.versionNo)[0] ?? null
}

// ---- waiting -----------------------------------------------------------------------------------------------------------

/** Who it waits for now (the list's Waiting column): us while NEW or ASSIGNED, the customer while NEED_INFO, nobody once closed. */
export type WaitingFor = 'US' | 'CUSTOMER' | null
export const waitingFor = (status: InquiryStatus): WaitingFor => (status === 'NEED_INFO' ? 'CUSTOMER' : status === 'NEW' || status === 'ASSIGNED' ? 'US' : null)
/** Waiting for us over one working day (the tone of the Waiting cell, the WAITING_US tile). */
export const overdue = (status: InquiryStatus, workingMinutes: number | null): boolean => waitingFor(status) === 'US' && workingMinutes !== null && workingMinutes > WORKING_DAY_MINUTES

// ---- the quote ---------------------------------------------------------------------------------------------------------

/** A line as "Make quote" reads it. */
export interface QuotableLine {
  readonly seq: number
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly description: string | null
  readonly note: string | null
  readonly sizes: SizePieces
}

/** What the quote leaves out of an inquiry, and why (in words). */
export interface LeftOut {
  readonly seq: number
  readonly size: string | null
  readonly reason: string
}

/**
 * Which lines become size-grid lines of the quote (a style in one colourway with pieces per size) and which are left out with
 * why: no style picked, no colourway picked, no pieces by size. The quote's own copy then leaves out what the colourway no
 * longer offers (W1's duplicate rules).
 */
export function quotableLines<Line extends QuotableLine>(lines: readonly Line[]): { readonly copy: Line[]; readonly leftOut: LeftOut[] } {
  const copy: Line[] = []
  const leftOut: LeftOut[] = []
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    if (line.styleId === null) leftOut.push({ seq: line.seq, size: null, reason: 'No style picked: add it on the quote.' })
    else if (line.colourwayId === null) leftOut.push({ seq: line.seq, size: null, reason: 'No colourway picked: add it on the quote.' })
    else if (Object.keys(line.sizes).length === 0) leftOut.push({ seq: line.seq, size: null, reason: 'No pieces by size: add the sizes on the quote.' })
    else copy.push(line)
  }
  return { copy, leftOut }
}

// ---- B-TH-042 (threads plan G5; O-SAL-INQ-LIST.pane-actions-F08, O-SAL-INQ-REC.side, wall W23): answer a new customer --------

/** How the check found a customer the prospect may already be: its contact's address, its contacts' e-mail domain, its name. */
export const CUSTOMER_MATCHES = ['CONTACT', 'DOMAIN', 'NAME'] as const
export type CustomerMatch = (typeof CUSTOMER_MATCHES)[number]
/** The strongest first: a candidate found several ways is named by the strongest. */
export const MATCH_RANK: Readonly<Record<CustomerMatch, number>> = Object.freeze({ CONTACT: 0, DOMAIN: 1, NAME: 2 })
/** The most candidates the check names. */
export const CANDIDATES_MAX = 20

/** Why a prospect's request may not be made a customer, or matched to one, now (null: it may). */
export function makeCustomerRefusal(facts: InquiryFacts & { readonly prospectErased: boolean }, making: boolean): InquiryRefusal | null {
  const shut = closed(facts)
  if (shut) return shut
  if (facts.partyId !== null) return refusal('NOT_PROSPECT', `${facts.number} is already from its customer: a request of another customer is a new request.`)
  if (making && facts.prospectErased) return refusal('PROSPECT_ERASED', `The prospect of ${facts.number} was erased: nothing is left to make a customer from; match it to a customer instead.`)
  return null
}

/**
 * Whether matching to this customer asks first (W23): only a match by the address of one of ITS active contacts, and no other
 * customer found that strongly, goes on without the person's yes; a match by domain or name, an ambiguous one, or a customer the
 * check did not find, waits for `confirmed` (refusal CONFIRM_MATCH, the words name only the customer the person picked).
 */
export function matchRefusal(input: { readonly number: string; readonly customer: string; readonly found: CustomerMatch | null; readonly contactMatches: number; readonly confirmed: boolean }): InquiryRefusal | null {
  if (input.confirmed) return null
  if (input.found === 'CONTACT' && input.contactMatches === 1) return null
  const why =
    input.found === 'CONTACT'
      ? `the prospect's address is a contact of more than one customer`
      : input.found === 'DOMAIN'
        ? `only the e-mail domain ties the prospect to ${input.customer}`
        : input.found === 'NAME'
          ? `only the name ties the prospect to ${input.customer}`
          : `nothing ties the prospect to ${input.customer} yet (no contact, no e-mail domain, no name)`
  return refusal('CONFIRM_MATCH', `Check that ${input.number} is from ${input.customer}: ${why}. Confirm to match it.`)
}

/** Making a new customer while the check found one the prospect may already be asks first (no duplicate by mistake). */
export function makeRefusal(input: { readonly number: string; readonly candidates: readonly string[]; readonly confirmed: boolean }): InquiryRefusal | null {
  if (input.confirmed || input.candidates.length === 0) return null
  return refusal('MATCH_FOUND', `${input.number}'s prospect may already be a customer (${input.candidates.join(', ')}): use it, or confirm a new customer.`)
}

export const codeTakenRefusal = (code: string): InquiryRefusal => refusal('CODE_TAKEN', `The code ${code} is another party's: choose another.`)

const CODE_MAX = 24
/** A party code proposed from the prospect's company (or name): capital letters and digits, at most 24, never empty. */
export function suggestedCode(prospect: { readonly company: string | null; readonly name: string | null; readonly email: string | null }): string {
  const words = prospect.company ?? prospect.name ?? prospect.email?.split('@')[0] ?? ''
  const folded = words.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const code = folded.slice(0, CODE_MAX).replace(/-+$/g, '')
  return code === '' ? 'NEW-CUSTOMER' : code
}

/** The consent of a prospect, carried to its contact (GDPR art. 7(1)): when the request came, and how. */
export function carriedConsent(basis: LawfulBasis | null, request: { readonly number: string; readonly receivedAt: Date; readonly source: InquirySource }): { readonly lawfulBasis: LawfulBasis; readonly consentAt: Date | null; readonly consentSource: string | null } {
  const lawfulBasis = basis ?? PROSPECT_DEFAULT_BASIS
  if (lawfulBasis !== 'CONSENT') return { lawfulBasis, consentAt: null, consentSource: null }
  return { lawfulBasis, consentAt: request.receivedAt, consentSource: `Given with request ${request.number} (${SOURCE_WORDS[request.source].en.toLowerCase()})` }
}
// ---- end B-TH-042
