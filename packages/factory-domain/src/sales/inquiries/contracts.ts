import { z } from 'zod'
import { businessDate, currency, id, input, instant, output, unitPrice } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { CUSTOMER_MATCHES, DECLINE_REASONS, INQUIRY_LIMITS, INQUIRY_REFUSALS, INQUIRY_SOURCES, INQUIRY_STATUSES, INQUIRY_TILES, LAWFUL_BASES, SIZE_CODE, STYLE_DRAFTS_MAX, TYPED_SOURCES } from './rules'
// B-TH-026: a style draft's fields are the style library's.
import { PPE_CATEGORIES, PRODUCT_TYPES } from '../../product/styles/rules'
import { styleCode } from '../../product/styles/contracts'
import { sizeCode } from '../../product/sizes/contracts'
// B-TH-094: production's answer on a request (office only).
import { productionActionView, productionView } from './production-answer'

/**
 * Inquiries' contracts (B-W2b-295): what apps/factory-api's modules/sales/inquiries accepts and answers. A refusal is a 409 whose
 * issue is `refusal/<CODE>` (INQUIRY_REFUSALS) with the words. The money fields are the target unit price (a decimal string,
 * net) and the quote's value (minor units), both money.price: the value only with the price grain; a target price sent without
 * it is refused. People as user ids in a row (`mine` says whether it is the reader) and, B-TH-016 (Owner decision 4), the
 * assignee by name; by name inside the one record; nobody is counted. The prospect's personal data (name, e-mail, phone) only inside the record and as the list's "From".
 */

const version = () => z.number().int().min(1)
/** Words of several lines (no control characters but line breaks and tabs). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), { message: 'No control characters.' })
/** One line of words. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value), { message: 'One line, no control characters.' })

export const inquiryParams = input({ inquiryId: id() })
export const mailParams = input({ inboundEmailId: id() })

/** Pieces per size code: { "50": 5, "52": 10 } (at most 60 sizes, 1 to 100 000 each). */
export const sizesBody = z
  .record(z.string().regex(SIZE_CODE, 'A size code: letters, digits, space . / + - (up to 20).'), z.number().int().min(1).max(INQUIRY_LIMITS.sizePieces))
  .refine((sizes) => Object.keys(sizes).length <= INQUIRY_LIMITS.sizes, { message: `At most ${INQUIRY_LIMITS.sizes} sizes.` })

/** One thing asked: a style (in a colourway, or a colour in words) or words; the pieces by size, or in all. */
export const lineBody = input({
  styleId: id().nullable().optional(),
  colourwayId: id().nullable().optional(),
  colourText: line(INQUIRY_LIMITS.colourText).nullable().optional(),
  description: text(INQUIRY_LIMITS.lineDescription).nullable().optional(),
  sizes: sizesBody.optional(),
  /** Pieces in all; with sizes, their sum (left out: the sum). */
  quantity: z.number().int().min(1).max(INQUIRY_LIMITS.quantity).nullable().optional(),
  note: text(INQUIRY_LIMITS.lineNote).nullable().optional(),
})
export type LineBody = z.output<typeof lineBody>

/** A prospect not yet a party: a name, company or e-mail; the lawful basis (default CONTRACT: a request for a quote). */
export const prospectBody = input({
  name: line(INQUIRY_LIMITS.prospectName).nullable().optional(),
  company: line(INQUIRY_LIMITS.prospectCompany).nullable().optional(),
  email: z.string().trim().max(INQUIRY_LIMITS.email).nullable().optional(),
  phone: z.string().trim().max(INQUIRY_LIMITS.phone).nullable().optional(),
  lawfulBasis: z.enum(LAWFUL_BASES).optional(),
})
export type ProspectBody = z.output<typeof prospectBody>

const asked = {
  /** What is asked, in words (the call's notes, the visit's request). */
  request: text(INQUIRY_LIMITS.request),
  wantedDate: businessDate().optional(),
  /** The target unit price the customer named, net (price grain). */
  targetUnitPrice: money.price(unitPrice()),
  /** Default: the company's currency. */
  currency: currency().optional(),
  techPackVersion: line(INQUIRY_LIMITS.techPackVersion).optional(),
  note: text(INQUIRY_LIMITS.note).optional(),
  lines: z.array(lineBody).max(INQUIRY_LIMITS.lines).optional(),
  /** Give it to someone at once (an active office person who keeps inquiries there): ASSIGNED. */
  assigneeId: id().optional(),
}

// ---- B-TH-221 (threads plan O-SAL-INQ-LIST.band-F02): the office's New request carries the customer's PO and its delivery
// address as the portal's New order does (B-TH-010, the columns of B-TH-009); the address is one of THAT customer's own (W23).
const officeDetails = {
  /** The customer's own order number, if they gave one. */
  customerRef: line(INQUIRY_LIMITS.customerRef).optional(),
  /** One of the customer's active delivery addresses (never with a prospect). */
  shipToAddressId: id().optional(),
}
// ---- end B-TH-221

/** "New inquiry (phone or visit)" (SCR-105 inquiries.new): the customer (and contact) or a prospect, what is asked. */
export const createInquiryBody = input({
  companyId: id(),
  source: z.enum(TYPED_SOURCES),
  /** When it came (default: now; never in the future). */
  receivedAt: instant().optional(),
  partyId: id().optional(),
  contactId: id().optional(),
  prospect: prospectBody.optional(),
  ...asked,
  ...officeDetails, // B-TH-221
})
export type CreateInquiryBody = z.output<typeof createInquiryBody>

/** "Make an inquiry" from a mail (Mail to sort): the mail's sender as the customer, or a prospect; its words as the request. */
export const fromMailBody = input({
  /** The mail's version (it is the guarded record). */
  version: version(),
  /** A mail of a tenant-wide account: the company it is for (a company's mail: its own). */
  companyId: id().optional(),
  /** Left out: the party the mail's sender is a contact of, when Nexus knows one; else a prospect from its From line. */
  partyId: id().optional(),
  contactId: id().optional(),
  prospect: prospectBody.optional(),
  /** Default: the mail's subject and text. */
  request: text(INQUIRY_LIMITS.request).optional(),
  wantedDate: businessDate().optional(),
  targetUnitPrice: money.price(unitPrice()),
  currency: currency().optional(),
  /** The mail's kept attachments that are the brand's tech pack. */
  techPackFileIds: z.array(id()).max(INQUIRY_LIMITS.techPackFiles).optional(),
  techPackVersion: line(INQUIRY_LIMITS.techPackVersion).optional(),
  note: text(INQUIRY_LIMITS.note).optional(),
  lines: z.array(lineBody).max(INQUIRY_LIMITS.lines).optional(),
  assigneeId: id().optional(),
  ...officeDetails, // B-TH-221
})
export type FromMailBody = z.output<typeof fromMailBody>

/**
 * The Request tab's Apply (EditModeBar) while open: what is asked, the target, the tech pack, the customer (a prospect matched
 * to a party: `partyId`, and its prospect columns cleared with `prospect: null`) or the prospect. `lines` replaces every line.
 * null clears a field. A closed inquiry takes only its note.
 */
export const updateInquiryBody = input({
  version: version(),
  request: text(INQUIRY_LIMITS.request).optional(),
  wantedDate: businessDate().nullable().optional(),
  targetUnitPrice: money.price(unitPrice().nullable()),
  currency: currency().optional(),
  note: text(INQUIRY_LIMITS.note).nullable().optional(),
  techPackFileIds: z.array(id()).max(INQUIRY_LIMITS.techPackFiles).optional(),
  techPackVersion: line(INQUIRY_LIMITS.techPackVersion).nullable().optional(),
  partyId: id().optional(),
  contactId: id().nullable().optional(),
  prospect: prospectBody.nullable().optional(),
  lines: z.array(lineBody).max(INQUIRY_LIMITS.lines).optional(),
})
export type UpdateInquiryBody = z.output<typeof updateInquiryBody>

export const assignBody = input({ version: version(), assigneeId: id().nullable() })
export type AssignBody = z.output<typeof assignBody>
const item = input({ inquiryId: id(), version: version() })
/** "Assign to…" on a selection: all or none. */
export const bulkAssignBody = input({ items: z.array(item).min(1).max(INQUIRY_LIMITS.bulk), assigneeId: id().nullable() })
export type BulkAssignBody = z.output<typeof bulkAssignBody>

export const versionBody = input({ version: version() })
export type VersionBody = z.output<typeof versionBody>

/**
 * B-TH-013 (threads plan G4): "Ask for more information" carries the question. On a request sent from the portal the question
 * is a reply the customer reads in its portal (and its "We need something from you" news); on any other request a mail on the
 * request's thread to `to` (default: the request's contact, else the prospect's e-mail is no address of a customer: a prospect
 * is made a customer first), under the one recipient rule (B-TH-004: `sendOutside` ticked for an address of another party).
 * Without `message` the request only waits for the customer, as before.
 */
export const askInfoBody = input({
  version: version(),
  message: input({
    body: text(20_000),
    subject: line(200).optional(),
    to: z.array(z.string().trim().min(3).max(320)).min(1).max(20).optional(),
    sendOutside: z.boolean().optional(),
  }).optional(),
})
export type AskInfoBody = z.output<typeof askInfoBody>

/**
 * "Decline inquiry": the reason (OTHER with words). B-TH-043 (threads plan G6): with `message` ("Send to the customer" ticked) ONE
 * message goes to the customer in the same command, as Ask for info's question does: on a request sent from the portal a reply the
 * customer reads in its portal, on any other a mail on the request's thread to `to` (default: the request's contact) under the one
 * recipient rule (B-TH-004: `sendOutside` ticked for an address of another party). Never with "Not an order" (it sends nothing),
 * never to a prospect (made a customer first). Without `message` nothing is sent.
 */
export const declineBody = input({
  version: version(),
  reason: z.enum(DECLINE_REASONS),
  note: text(INQUIRY_LIMITS.closeNote).optional(),
  // ---- B-TH-043
  message: input({
    body: text(20_000),
    subject: line(200).optional(),
    to: z.array(z.string().trim().min(3).max(320)).min(1).max(20).optional(),
    sendOutside: z.boolean().optional(),
  }).optional(),
  // ---- end B-TH-043
})
export type DeclineBody = z.output<typeof declineBody>
/** "Decline N" on a selection: all or none. B-TH-043: it never sends anything to the customers (no message here, by design). */
export const bulkDeclineBody = input({ items: z.array(item).min(1).max(INQUIRY_LIMITS.bulk), reason: z.enum(DECLINE_REASONS), note: text(INQUIRY_LIMITS.closeNote).optional() })
export type BulkDeclineBody = z.output<typeof bulkDeclineBody>

/** The customer went away before a quote: why, in words. */
export const loseBody = input({ version: version(), note: text(INQUIRY_LIMITS.closeNote) })
export type LoseBody = z.output<typeof loseBody>

/** "Make quote" (Q): the W1 quote pre-filled from the inquiry (customer, contact, styles, sizes, wanted date). */
export const quoteBody = input({
  version: version(),
  /** The customer's own reference of the request, printed on the quote. */
  customerRef: line(INQUIRY_LIMITS.customerRef).optional(),
})
export type QuoteBody = z.output<typeof quoteBody>

// ---- B-TH-025 (threads plan G3): Make order -----------------------------------------------------------------------------

/**
 * "Make order": the order made straight from the request with the normal order checks (the customer on hold or blocked, its PO
 * number where its terms want one, the minimum quantities, the credit limit and an approval rule: CONFIRMED, or PENDING_APPROVAL
 * and said so). Every line of the request becomes a line of the order (a style, its colourway, pieces by size); its price is the
 * one typed here (by the line's seq, on the order's basis), else the customer's list price. The promise date defaults to the
 * wanted date while it is ahead; the PO to the request's.
 */
export const orderBody = input({
  version: version(),
  /** A unit price typed for a line of the request (by its seq; on the order's basis); a line not named takes the list price. */
  lines: z
    .array(input({ seq: z.number().int().min(1), unitPrice: money.price(unitPrice()) }))
    .max(INQUIRY_LIMITS.lines)
    .optional(),
  promiseDate: businessDate().nullish(),
  customerRef: line(INQUIRY_LIMITS.customerRef).optional(),
  /** Carry the request's files to the order (Use on…; default true): a copy each, shared as the original was. */
  carryFiles: z.boolean().optional(),
})
export type OrderBody = z.output<typeof orderBody>

// ---- B-TH-026 (threads plan L2-G18): Make style draft ---------------------------------------------------------------------

/**
 * "Make style draft": a DRAFT style of the request's company for the request's customer's own label (never another brand), its
 * name the request's subject unless typed, its range from the size scale (or the product type that gives one); the request's
 * files picked here are carried to it (Use on…). The request stays open and names the draft.
 */
export const styleDraftBody = input({
  version: version(),
  code: styleCode(),
  name: line(200).optional(),
  productType: z.enum(PRODUCT_TYPES),
  productTypeProfileId: id().nullish(),
  sizeScaleId: id().optional(),
  sizes: z.array(sizeCode()).max(60).optional(),
  baseSize: sizeCode().nullish(),
  season: line(20).nullish(),
  ppeCategory: z.enum(PPE_CATEGORIES).optional(),
  /** Files of the request (or of its mail) to carry to the style. */
  fileIds: z.array(id()).max(STYLE_DRAFTS_MAX).optional(),
})
export type StyleDraftBody = z.output<typeof styleDraftBody>
// ---- end B-TH-025 / B-TH-026

export const inquiryListQuery = input({
  tile: z.enum(INQUIRY_TILES).optional(),
  status: z.enum(INQUIRY_STATUSES).optional(),
  source: z.enum(INQUIRY_SOURCES).optional(),
  partyId: id().optional(),
  /** true: from prospects only (no party yet). */
  prospect: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  companyId: id().optional(),
  receivedFrom: businessDate().optional(),
  receivedTo: businessDate().optional(),
  /** Part of the number, the request, the customer's code or name, the prospect's company or e-mail. */
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(INQUIRY_LIMITS.list).optional(),
})
export type InquiryListQuery = z.output<typeof inquiryListQuery>

/** The inquiry a quote or an order came from (SAL-305: the tech pack carried to them): exactly one of the two. */
export const sourceQuery = input({ quoteId: id().optional(), salesOrderId: id().optional() })
export type SourceQuery = z.output<typeof sourceQuery>

// ---- answers -----------------------------------------------------------------------------------------------------------

export const inquiryRefusal = output({ code: z.enum(INQUIRY_REFUSALS), message: z.string() })
const action = output({ allowed: z.boolean(), refusal: inquiryRefusal.nullable() })
const partyRef = output({ id: id(), code: z.string(), name: z.string() })
const numbered = output({ id: id(), number: z.string() })
const waiting = output({
  /** US (NEW, ASSIGNED), CUSTOMER (NEED_INFO), null once closed. */
  for: z.enum(['US', 'CUSTOMER']).nullable(),
  /** Working minutes since it came, on its company's working calendar (null once closed). */
  workingMinutes: z.number().int().nullable(),
  /** Waiting for us over one working day (the tone). */
  overdue: z.boolean(),
})

/** One row of the list (SCR-105 inquiries.grid). */
export const inquiryRow = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  source: z.enum(INQUIRY_SOURCES),
  status: z.enum(INQUIRY_STATUSES),
  receivedAt: instant(),
  /** From: the customer, else the prospect (their company, else name, else e-mail), else the mail's sender address. */
  party: partyRef.nullable(),
  fromWords: z.string(),
  prospect: z.boolean(),
  summary: z.string(),
  /** Products asked: the styles' codes, else the lines' first words. */
  products: z.array(z.string()),
  pieces: z.number().int(),
  sizes: z.string(),
  targetUnitPrice: money.price(z.string().nullable()),
  currency: z.string(),
  wantedDate: businessDate().nullable(),
  waiting,
  /** An office user id; `mine`: the reader. */
  assigneeId: id().nullable(),
  /** B-TH-016 (Owner decision 4): who keeps it, by name. Always sent; optional only until the Incoming list reads it (TH-1b web). */
  assignee: output({ id: id(), name: z.string() }).nullable().optional(),
  mine: z.boolean(),
  quote: numbered.nullable(),
  /** B-TH-025: the order made straight from it, with ITS own status (never the request's). Always sent; optional for the web's typed demo data. */
  order: output({ id: id(), number: z.string(), status: z.string() }).nullable().optional(),
  declineReason: z.enum(DECLINE_REASONS).nullable(),
  closedAt: instant().nullable(),
  version: z.number().int(),
  // ── B-TH-216 (threads plan TH-1b, Sales › Incoming: the Picture and Files cells). Always sent; optional only so typed demo
  //    data elsewhere stays as it is. ──
  /** The first line's style that names one, and its main picture (fileId null: the placeholder; `small`: its ~320 px preview
   *  exists, GET /sales/inquiries/:inquiryId/picture serves it; the list never loads the original). Null: no style named. */
  picture: output({ styleId: id(), styleCode: z.string(), styleName: z.string(), fileId: id().nullable(), contentType: z.string().nullable(), small: z.boolean() }).nullable().optional(),
  /** The distinct styles its lines name ("+2" beside the picture). */
  styleCount: z.number().int().optional(),
  /** The request's files and its mail's kept attachments, counted by kind (null: no files.read over its company). */
  fileCounts: output({ photos: z.number().int(), documents: z.number().int() }).nullable().optional(),
  // ── end B-TH-216 ──
  // ---- B-TH-094 (N17; O-SAL-INQ-LIST.list-F10 the Production column, .pane-head-F07 its chip): production's answer — OK, or
  //      not before week N (null: not answered); the record adds who answered. Office only. Always sent; optional for the web's
  //      typed demo data.
  production: productionView.nullable().optional(),
  // ---- end B-TH-094
})

/** B-TH-216: GET /sales/inquiries/:inquiryId/picture — a presigned GET of the small preview (60 s); null until it exists. */
export const inquiryPictureView = output({
  picture: output({
    fileId: id(),
    styleId: id(),
    contentType: z.string(),
    small: output({ method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }).nullable(),
  }),
})

export const inquiryList = output({
  rows: z.array(inquiryRow),
  /** Each tile's number under the filters (null: not counted, "—"). */
  counts: z.record(z.string(), z.number().int().nullable()),
  /** The waiting time read the company calendar for at most this many open inquiries; false: the WAITING_US count is partial. */
  complete: z.boolean(),
})

const fileView = output({
  id: id(),
  recordType: z.string(),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  status: z.string(),
  versionNo: z.number().int(),
})

/** One tech pack file as named and the version in force of its series (null: no version is available now). */
export const techPackFileView = output({
  named: fileView,
  current: fileView.nullable(),
  /** A newer version than the one named is in force. */
  newer: z.boolean(),
})
export const techPackView = output({ version: z.string().nullable(), files: z.array(techPackFileView) })

const lineView = output({
  id: id(),
  seq: z.number().int(),
  style: partyRef.nullable(),
  colourway: partyRef.nullable(),
  colourText: z.string().nullable(),
  description: z.string().nullable(),
  sizes: z.record(z.string(), z.number().int()),
  quantity: z.number().int().nullable(),
  note: z.string().nullable(),
  /** B-TH-009 (L2-G08): the net unit price the customer was shown when it asked (price grain; null: none shown). The API always
   *  sends it; optional only until the Incoming screens read it (TH-1b web), so their typed demo data stays as it is. */
  unitPriceShown: money.price(z.string().nullable()).optional(),
})

const mailView = output({
  id: id(),
  status: z.string(),
  receivedAt: instant(),
  from: output({ address: z.string().nullable(), name: z.string().nullable() }),
  subject: z.string().nullable(),
  /** The mail as sent: its text and its sanitised HTML. */
  bodyText: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  threadId: id().nullable(),
})

/** The inquiry (its DetailModal and full page: Request, Files & specs, Quote, Activity). */
export const inquiryView = inquiryRow.extend({
  request: z.string(),
  /** B-TH-009 (L2-G01): the customer's own reference (its PO), carried to the quote. Always sent; optional as unitPriceShown. */
  customerRef: z.string().nullable().optional(),
  /** B-TH-009 (L2-G01): where the customer wants the goods (one of its addresses; `waiting`: added in the portal, not yet checked). */
  shipTo: output({ id: id(), name: z.string().nullable(), line1: z.string(), postalCode: z.string(), city: z.string(), country: z.string(), waiting: z.boolean() }).nullable().optional(),
  note: z.string().nullable(),
  closeNote: z.string().nullable(),
  contact: output({ id: id(), name: z.string(), email: z.string().nullable() }).nullable(),
  prospectDetails: output({ name: z.string().nullable(), company: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable(), lawfulBasis: z.enum(LAWFUL_BASES).nullable(), erased: z.boolean() }).nullable(),
  assignee: output({ id: id(), name: z.string() }).nullable(),
  assignedAt: instant().nullable(),
  lines: z.array(lineView),
  mail: mailView.nullable(),
  techPack: techPackView,
  /** Files people added to the inquiry, and the mail's kept attachments. */
  files: z.array(fileView),
  mailFiles: z.array(fileView),
  /** The quote it became, its status and its value (net, minor units of its currency; price grain). */
  quoteDetail: output({ id: id(), number: z.string(), status: z.string(), revision: z.number().int(), netAmount: money.price(z.number().int()), currency: z.string() }).nullable(),
  /** B-TH-026: the style drafts made from it, each with its own state (oldest first). Always sent; optional for the web's typed demo data. */
  styleDrafts: z.array(output({ id: id(), code: z.string(), name: z.string(), status: z.string() })).optional(),
  closedBy: output({ id: id(), name: z.string() }).nullable(),
  createdBy: output({ id: id(), name: z.string() }).nullable(),
  createdAt: instant(),
  /**
   * B-TH-043: where a message from this request goes, so the Decline and Ask for info dialogs name it before anything is sent:
   * PORTAL (the customer reads it in its portal), MAIL (to `to`, the request's contact by default; the person may name others),
   * null with the refusal (a prospect: made a customer first). `language`: the customer's (its contact's, else its own). Always
   * sent; optional for the web's typed demo data.
   */
  messageTo: output({ via: z.enum(['PORTAL', 'MAIL']).nullable(), to: z.array(z.string()), language: z.string().nullable(), refusal: inquiryRefusal.nullable() }).optional(),
  /** B-TH-094: whether this reader types production's answer (planning.promise.manage over the request), else why not. Optional as messageTo. */
  productionAction: productionActionView.optional(),
  actions: output({
    edit: action,
    assign: action,
    unassign: action,
    askInfo: action,
    resume: action,
    decline: action,
    lose: action,
    quote: action,
    // B-TH-025 / B-TH-026: Make order, Make style draft (always sent; optional for the web's typed demo data).
    order: action.optional(),
    styleDraft: action.optional(),
  }),
})

export const inquiryAnswer = output({ inquiry: inquiryView })
export const bulkAnswer = output({ inquiries: z.array(output({ id: id(), number: z.string(), status: z.enum(INQUIRY_STATUSES), version: z.number().int() })) })

/** "Make quote": the inquiry QUOTED, the quote made, what was left out and the copy's warnings. */
export const quoteAnswer = output({
  inquiry: inquiryView,
  quote: numbered,
  leftOut: z.array(output({ seq: z.number().int(), size: z.string().nullable(), reason: z.string() })),
  warnings: z.array(z.string()),
})

// ---- B-TH-025 / B-TH-026 answers --------------------------------------------------------------------------------------------

/** The request's files carried to what was made from it: each copy, and each file that could not be carried with why. */
export const carriedFiles = output({
  carried: z.array(output({ sourceFileId: id(), fileId: id(), name: z.string() })),
  notCarried: z.array(output({ sourceFileId: id(), name: z.string(), reason: z.string() })),
})

/** "Make order": the request ORDERED, its order as made (CONFIRMED, or PENDING_APPROVAL and why), said in words; the files carried. */
export const orderAnswer = output({
  inquiry: inquiryView,
  order: output({ id: id(), number: z.string(), status: z.enum(['CONFIRMED', 'PENDING_APPROVAL']), waitsFor: z.enum(['CREDIT', 'APPROVAL']).nullable() }),
  said: output({ it: z.string(), en: z.string() }),
  files: carriedFiles,
})

/** "Make style draft": the request (still open) naming the draft, the draft style, the files carried. */
export const styleDraftAnswer = output({
  inquiry: inquiryView,
  style: output({ id: id(), code: z.string(), name: z.string(), status: z.string() }),
  files: carriedFiles,
})
// ---- end B-TH-025 / B-TH-026

/** "Make an inquiry": what the form starts from (the mail's sender as a customer or a prospect, its words, its attachments). */
export const mailDraftView = output({
  /** The inquiry already made from this mail (one per mail). */
  inquiry: numbered.nullable(),
  mail: mailView,
  companyId: id().nullable(),
  party: partyRef.nullable(),
  contactId: id().nullable(),
  /** How the customer was found: the mail's sender is a contact of the party, or a contact's company domain; null: a prospect. */
  matchedBy: z.enum(['CONTACT', 'DOMAIN']).nullable(),
  prospect: output({ name: z.string().nullable(), company: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  request: z.string(),
  attachments: z.array(fileView),
  refusal: inquiryRefusal.nullable(),
})

/** People an inquiry may be given to (the Assign popover): ACTIVE office people who keep inquiries there; by name, nobody counted. */
export const assigneesView = output({ people: z.array(output({ id: id(), name: z.string(), me: z.boolean() })), complete: z.boolean() })

// ---- B-TH-221 (wall W23): New request's customer picker ------------------------------------------------------------------
/**
 * The customers and brands a person may make a request for at a company: active, and reached by BOTH their
 * sales.inquiries.manage and their parties.view (a person limited to customer A never reads customer B's name here). `q`
 * finds by code or name; `total` says how many match beyond `limit`; `limited` says no grant reaches every customer.
 */
export const inquiryCustomersQuery = input({
  companyId: id(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
})
export type InquiryCustomersQuery = z.output<typeof inquiryCustomersQuery>
export const inquiryCustomersView = output({
  customers: z.array(output({ id: id(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })),
  /** How many customers match (a count, not money). */
  total: notMoney(z.number().int()),
  limited: z.boolean(),
})
// ---- end B-TH-221

/** The inquiry a quote or order came from, with its tech pack in force (null: none). */
export const sourceView = output({
  inquiry: output({
    id: id(),
    number: z.string(),
    status: z.enum(INQUIRY_STATUSES),
    source: z.enum(INQUIRY_SOURCES),
    receivedAt: instant(),
    wantedDate: businessDate().nullable(),
    targetUnitPrice: money.price(z.string().nullable()),
    currency: z.string(),
    techPack: techPackView,
  }).nullable(),
})

// ---- B-TH-042 (threads plan G5; O-SAL-INQ-LIST.pane-actions-F08, wall W23): answer a new customer ------------------------------

/**
 * GET /sales/inquiries/:inquiryId/customer — the check before a prospect's request gets its customer: the customers it may already be
 * (among those the reader may make a request for: never a customer the reader may not see), each found by the address of one of its
 * contacts, its contacts' company e-mail domain (never a shared mail provider's) or its name; what a new customer would be called.
 */
export const customerCheckView = output({
  prospect: output({ name: z.string().nullable(), company: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable(), lawfulBasis: z.enum(LAWFUL_BASES).nullable(), erased: z.boolean() }),
  candidates: z.array(
    output({
      party: partyRef,
      /** The contact whose address is the prospect's (CONTACT), else null. */
      contact: output({ id: id(), name: z.string() }).nullable(),
      matchedBy: z.enum(CUSTOMER_MATCHES),
    }),
  ),
  /** More than one customer is found by the same address or domain: the person picks (W23). */
  ambiguous: z.boolean(),
  /** A new customer as it would be made (the code proposed, free; the name from the prospect). */
  suggestion: output({ code: z.string(), legalName: z.string(), kind: z.enum(['ORGANISATION', 'PERSON']) }),
  /** Making a customer needs parties.manage over the request's company; matching, the request's own rights. */
  make: action,
  match: action,
})

/**
 * POST /sales/inquiries/:inquiryId/customer — the prospect's request gets its customer in ONE command: `match` an existing customer
 * (the reader may make requests for it; its contact, or the prospect added as a new contact with `addContact`), or `make` a new one
 * from the prospect (its contact with the prospect's name, address and phone and the lawful basis carried). A match the check did
 * not find by one of the customer's own contact addresses, or a new customer while the check found one, asks first: `confirmed`.
 * Then the prospect's columns are cleared (its data lives in the contact), the customer's own number is given, and the mail the
 * request came from, while it waits in Mail to sort, joins the request's thread — shared with that customer only.
 */
export const makeCustomerBody = input({
  version: version(),
  match: input({
    partyId: id(),
    /** One of its active contacts (default: the contact the check found by the prospect's address). */
    contactId: id().nullable().optional(),
    /** Add the prospect as a new contact of the customer (parties.manage), when no contact has its address. */
    addContact: z.boolean().optional(),
  }).optional(),
  make: input({
    /** Default: the check's suggestion. */
    code: z.string().trim().min(1).max(24).optional(),
    legalName: line(200).optional(),
    kind: z.enum(['ORGANISATION', 'PERSON']).optional(),
    country: z.string().trim().length(2).optional(),
    language: z.string().trim().min(2).max(5).optional(),
    /** PROSPECT (default: a customer not confirmed yet) or ACTIVE. */
    status: z.enum(['PROSPECT', 'ACTIVE']).optional(),
    /** A customer of every company (default: of the request's company only). */
    everyCompany: z.boolean().optional(),
  }).optional(),
  /** The person's yes to what the check asked first (W23). */
  confirmed: z.boolean().optional(),
})
export type MakeCustomerBody = z.output<typeof makeCustomerBody>

export const makeCustomerAnswer = output({
  inquiry: inquiryView,
  party: partyRef,
  contactId: id().nullable(),
  /** What was made: the customer and its contact, a contact of an existing customer, or nothing (a match). */
  made: z.enum(['CUSTOMER', 'CONTACT']).nullable(),
  /** The mail the request came from joined its thread now. */
  mailJoined: z.boolean(),
})
// ---- end B-TH-042
