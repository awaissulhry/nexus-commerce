import { grainPermission, type Grain } from '../auth/grains/grains'
import { ValidationError, type Issue } from '../core/errors'
import { isUuid } from '../core/ids'
import type { Grant, Permission } from '../core/permissions'
import {
  LINK_ACCEPT,
  LINK_APPROVE,
  LINK_CONFIRM,
  LINK_DECLINE,
  LINK_DOWNLOAD,
  LINK_MOVE_DATE,
  LINK_OPEN,
  LINK_PAY,
  LINK_POST,
  LINK_RECEIVE,
  LINK_REFUSE,
  LINK_SUBMIT,
  LINK_UPLOAD,
} from './permissions'

/** files.read (auth/permissions/catalogue FILES_DEFINITIONS), named here: the catalogue imports this folder. */
const FILES_READ = 'files.read' satisfies Permission

/**
 * The purposes of a one-off link (plan A1 §3.10 "Links", §2.6, §3.11; PLAN §4.7 stages 06a-accept and 08-buy; features
 * SAL-099, PLT-007, PLT-035; W2b-3 B-W2b-163: design 02 portal-links "New link purposes", COL-051, MES-274). A link is a
 * bearer key for ONE purpose on ONE record of ONE party, with an expiry and a use limit. Its session's grants come from
 * the purpose, never from role assignments:
 *
 *   purpose           record                    actions (counted)                       grains  days      uses     more
 *   QUOTE_ACCEPT      Quote                     accept*, decline*                       price   30 / 90   1 / 1
 *   PO_CONFIRM        PurchaseOrder             confirm*, decline*                      none    14 / 60   1 / 1
 *   DOCUMENT_VIEW     StoredFile, Shipment,     open*, download                         price   30 / 365  20 / 100 files, password
 *                     PayrollExport
 *   DEPOSIT_INFO      DepositRequest            open*                                   price   30 / 90   20 / 100
 *   SHIPMENT_TRACK    Shipment                  open                                    none    60 / 180  1 / 1
 *   MEASUREMENTS      MeasurementProfile        submit*                                 none    21 / 60   1 / 1    draft
 *   CLAIM             SalesOrder, Shipment      submit*                                 none    60 / 90   5 / 20   draft
 *   PAYMENT           DepositRequest, Invoice   pay*                                    price   30 / 90   1 / 1
 *   SUPPLIER_ONBOARD  Party                     submit* (typed name)                    none    30 / 60   1 / 1    draft
 *   JOB_ACCEPT        SubcontractOrder          accept*, decline*, moveDate*            none    7 / 30    1 / 1
 *   APPROVAL          ApprovalRequest           approve*, refuse* (typed name)          none    14 / 60   1 / 1
 *   RECORD_INVITE     a record with a thread    post, upload                            none    30 / 180  1 / 1
 *   SECURE_FILE       StoredFile                download*, receive                      none    7 / 30    5 / 20   files, password, receipt
 *
 * (`days` and `uses`: the default and the most the office may give; `*`: the action uses one of the link's uses.) A view
 * purpose counts every open (DOCUMENT_VIEW, DEPOSIT_INFO); a purpose whose holder answers counts the answers, never the
 * open, so a mail scanner cannot burn it (links.frame). SHIPMENT_TRACK and RECORD_INVITE count nothing: "unlimited
 * opens" until they expire (their one use is never taken). A download is evidence on every purpose that has one
 * (DOWNLOADED); it uses the link only on SECURE_FILE ("5 downloads left").
 *
 * A DOCUMENT_VIEW session also reads files (files.read, over the link's company and party): platform/files lets a link
 * see only the files shared with its party's links that are its record or belong to it (audienceSees), behind the
 * partner role's wall; so do an APPROVAL session (the request's own files) and a RECORD_INVITE session (the shared
 * record's). The shipping module's link of a Shipment shows its DDT, DoC and leaflet copies (B-W1-49). A link of a
 * PayrollExport (B-W2b-54; MES-274) brings the labour consultant the month's file through that module's own route; its
 * party id is the export's own.
 *
 * A set of files (COL-051, MES-274; links-depth.prisma LinkFile) is a DOCUMENT_VIEW or SECURE_FILE link of a StoredFile:
 * the link's record is the set's first file, and platform/links serves the set itself (in the tenant's system scope, the
 * files being the office's). Such a link may have a password sent apart (5 wrong ones hold it 15 minutes: links/password),
 * and a SECURE_FILE link takes the receipt "I received these files" once (RECEIVED, never counted). A long form keeps a
 * draft with us (MEASUREMENTS, CLAIM, SUPPLIER_ONBOARD: links/drafts).
 *
 * The price grain goes only to purposes that show the party its OWN document (its quote, its documents, its deposit
 * request, the deposit or invoice it pays: the party scope of the session makes it its own; plan B-W2b-163: PAYMENT and
 * none of the other new ones). A PO_CONFIRM link holds no grain at all: the supplier confirms quantities and dates, never
 * sees a price on the link (PLAN §4.7 08-buy). Cost, margin, wages and pay never reach a link (the audience cap in
 * auth/grains, the partner role's column grants, and links/pay: no link ever opens a record or a file with pay figures).
 *
 * Every open and every answer leaves an evidence row (LinkEvidence); a counted one also uses one of the link's uses.
 * The record types are named here; the module that owns each record brings its tables and its link routes.
 */

export const LINK_PURPOSES = [
  'QUOTE_ACCEPT',
  'PO_CONFIRM',
  'DOCUMENT_VIEW',
  'DEPOSIT_INFO',
  // W2b-3 (B-W2b-163; in the schema since B-W2b-154).
  'SHIPMENT_TRACK',
  'MEASUREMENTS',
  'CLAIM',
  'PAYMENT',
  'SUPPLIER_ONBOARD',
  'JOB_ACCEPT',
  'APPROVAL',
  'RECORD_INVITE',
  'SECURE_FILE',
] as const
export type LinkPurpose = (typeof LINK_PURPOSES)[number]

/**
 * What a link session does with its record: open it, download one of its files (both reads), or answer it. W2b-3
 * (B-W2b-163): download, the receipt, a form sent, an approval or a refusal, a payment, another date proposed, a post or
 * an upload on a shared record.
 */
export const LINK_ACTIONS = ['open', 'accept', 'decline', 'confirm', 'download', 'receive', 'submit', 'approve', 'refuse', 'pay', 'moveDate', 'post', 'upload'] as const
export type LinkAction = (typeof LINK_ACTIONS)[number]
/** The reads: an open, a download. Every other action answers the link. */
export const LINK_READS = ['open', 'download'] as const satisfies readonly LinkAction[]
export type LinkAnswer = Exclude<LinkAction, (typeof LINK_READS)[number]>

/** The evidence row's action for each link action (the LinkEvidenceAction enum of factory-db). */
export const EVIDENCE_ACTIONS = {
  open: 'OPENED',
  accept: 'ACCEPTED',
  decline: 'DECLINED',
  confirm: 'CONFIRMED',
  download: 'DOWNLOADED',
  receive: 'RECEIVED',
  submit: 'SUBMITTED',
  approve: 'APPROVED',
  refuse: 'REFUSED',
  pay: 'PAID',
  moveDate: 'MOVED_DATE',
  post: 'POSTED',
  upload: 'UPLOADED',
} as const satisfies Record<LinkAction, string>
export type EvidenceAction = (typeof EVIDENCE_ACTIONS)[LinkAction]

/** The permission a link session holds for each action. */
export const ACTION_PERMISSIONS: Readonly<Record<LinkAction, Permission>> = {
  open: LINK_OPEN,
  accept: LINK_ACCEPT,
  decline: LINK_DECLINE,
  confirm: LINK_CONFIRM,
  download: LINK_DOWNLOAD,
  receive: LINK_RECEIVE,
  submit: LINK_SUBMIT,
  approve: LINK_APPROVE,
  refuse: LINK_REFUSE,
  pay: LINK_PAY,
  moveDate: LINK_MOVE_DATE,
  post: LINK_POST,
  upload: LINK_UPLOAD,
}

/** A typed full name ("Nome e cognome", ported from the old app's accept evidence): needed, optional or not asked. */
export type TypedNameRule = 'required' | 'optional' | 'none'

export interface ActionRule {
  /** The action uses one of the link's uses. */
  readonly counts: boolean
  readonly typedName: TypedNameRule
  /** The person types the address the link was sent to, which must match it when the link has one. */
  readonly checksEmail: boolean
}

export interface PurposeRule {
  readonly purpose: LinkPurpose
  /** What the link lets its holder do, for the office screens. */
  readonly description: string
  /** The models a link of this purpose may open (their modules bring them). */
  readonly recordTypes: readonly string[]
  /** `open` always; the answers the purpose allows. */
  readonly actions: Readonly<Partial<Record<LinkAction, ActionRule>>>
  /** The money grains its session holds: only `price`, only for the party's own documents. */
  readonly grains: readonly Grain[]
  /** Days until it expires: the default, and the most the office may give. */
  readonly expiryDays: { readonly default: number; readonly max: number }
  /** Counted uses: the default, and the most the office may give. */
  readonly uses: { readonly default: number; readonly max: number }
  /** The session reads the files shared with its party's links on its record (files.read). */
  readonly readsFiles: boolean
  /**
   * W2b (B-W2b-163). `set`: the link may carry a set of files (LinkFile), served by platform/links; `password`: the office
   * may give it a password sent apart; `receipt`: its holder may confirm "I received these files" once; `draft`: a long
   * form keeps its draft with us.
   */
  readonly fileSet: boolean
  readonly password: boolean
  readonly receipt: boolean
  readonly draft: boolean
  /**
   * "Ask for a new link" on a dead link (links/renew): `files`, platform/links renews a set of files by itself; `module`,
   * the module that owns the record renews it (it knows whether the record still waits), or nothing happens.
   */
  readonly renewal: 'files' | 'module'
}

const notCounted: ActionRule = Object.freeze({ counts: false, typedName: 'none', checksEmail: false })
const notCountedNamed = (typedName: TypedNameRule): ActionRule => Object.freeze({ counts: false, typedName, checksEmail: false })
const counted = (typedName: TypedNameRule, checksEmail = false): ActionRule => Object.freeze({ counts: true, typedName, checksEmail })

/** What a purpose of W0 and W1 does not have (W2b-3's columns and tables). */
const PLAIN = { fileSet: false, password: false, receipt: false, draft: false, renewal: 'module' } as const

const rule = (spec: PurposeRule): PurposeRule =>
  Object.freeze({
    ...spec,
    recordTypes: Object.freeze([...spec.recordTypes]),
    actions: Object.freeze({ ...spec.actions }),
    grains: Object.freeze([...spec.grains]),
    expiryDays: Object.freeze({ ...spec.expiryDays }),
    uses: Object.freeze({ ...spec.uses }),
  })

export const PURPOSE_RULES: Readonly<Record<LinkPurpose, PurposeRule>> = Object.freeze({
  QUOTE_ACCEPT: rule({
    purpose: 'QUOTE_ACCEPT',
    description: 'The customer opens one sent quote, with its own prices, and accepts it (typed name; the email is checked when known) or declines it.',
    recordTypes: ['Quote'],
    actions: { open: notCounted, accept: counted('required', true), decline: counted('optional') },
    grains: ['price'],
    expiryDays: { default: 30, max: 90 },
    uses: { default: 1, max: 1 },
    readsFiles: false,
    ...PLAIN,
  }),
  PO_CONFIRM: rule({
    purpose: 'PO_CONFIRM',
    description: 'The supplier opens one purchase order, without any price, and confirms it or declines it.',
    recordTypes: ['PurchaseOrder'],
    actions: { open: notCounted, confirm: counted('optional'), decline: counted('optional') },
    grains: [],
    expiryDays: { default: 14, max: 60 },
    uses: { default: 1, max: 1 },
    readsFiles: false,
    ...PLAIN,
  }),
  DOCUMENT_VIEW: rule({
    purpose: 'DOCUMENT_VIEW',
    description:
      'The customer or supplier opens one of its own documents (an invoice copy, a DDT, a declaration of conformity), a set of them with an optional password sent apart, or the documents of one of its shipments, to read or download them; the labour consultant downloads a payroll file.',
    recordTypes: ['StoredFile', 'Shipment', 'PayrollExport'],
    // Every open counts; a download is logged (DOWNLOADED) but uses nothing (B-W1-49).
    actions: { open: counted('none'), download: notCounted },
    grains: ['price'],
    expiryDays: { default: 30, max: 365 },
    uses: { default: 20, max: 100 },
    readsFiles: true,
    fileSet: true,
    password: true,
    receipt: false,
    draft: false,
    renewal: 'files',
  }),
  DEPOSIT_INFO: rule({
    purpose: 'DEPOSIT_INFO',
    description: 'The customer opens the deposit request of its accepted quote: the amount to pay and how to pay it.',
    recordTypes: ['DepositRequest'],
    actions: { open: counted('none') },
    grains: ['price'],
    expiryDays: { default: 30, max: 90 },
    uses: { default: 20, max: 100 },
    readsFiles: false,
    ...PLAIN,
  }),
  // ---- W2b-3 (B-W2b-163; design 02 portal-links, "New link purposes") ----------------------------------------------
  SHIPMENT_TRACK: rule({
    purpose: 'SHIPMENT_TRACK',
    description: 'The customer follows one shipment: its steps and the carrier\'s tracking, without any price.',
    recordTypes: ['Shipment'],
    // "Unlimited opens" until it expires (60 days after delivery: the module renews it at delivery, links.tracking).
    actions: { open: notCounted },
    grains: [],
    expiryDays: { default: 60, max: 180 },
    uses: { default: 1, max: 1 },
    readsFiles: false,
    ...PLAIN,
  }),
  MEASUREMENTS: rule({
    purpose: 'MEASUREMENTS',
    description: 'A rider sends the measurements (and body photos) of one measurement profile, with a draft kept with us until it is sent.',
    recordTypes: ['MeasurementProfile'],
    actions: { open: notCounted, submit: counted('optional') },
    grains: [],
    expiryDays: { default: 21, max: 60 },
    uses: { default: 1, max: 1 },
    readsFiles: false,
    ...PLAIN,
    draft: true,
  }),
  CLAIM: rule({
    purpose: 'CLAIM',
    description: 'The customer reports a problem with one sales order or shipment (a return or a complaint), with a draft kept with us.',
    recordTypes: ['SalesOrder', 'Shipment'],
    actions: { open: notCounted, submit: counted('optional') },
    grains: [],
    expiryDays: { default: 60, max: 90 },
    uses: { default: 5, max: 20 },
    readsFiles: false,
    ...PLAIN,
    draft: true,
  }),
  PAYMENT: rule({
    purpose: 'PAYMENT',
    description: 'The customer pays one of its own deposit requests or invoices online, with its own amount.',
    recordTypes: ['DepositRequest', 'Invoice'],
    actions: { open: notCounted, pay: counted('none') },
    grains: ['price'],
    expiryDays: { default: 30, max: 90 },
    uses: { default: 1, max: 1 },
    readsFiles: false,
    ...PLAIN,
  }),
  SUPPLIER_ONBOARD: rule({
    purpose: 'SUPPLIER_ONBOARD',
    description: 'A prospective supplier answers the supplier questionnaire and signs it with a typed name, with a draft kept with us.',
    recordTypes: ['Party'],
    actions: { open: notCounted, submit: counted('required') },
    grains: [],
    expiryDays: { default: 30, max: 60 },
    uses: { default: 1, max: 1 },
    readsFiles: false,
    ...PLAIN,
    draft: true,
  }),
  JOB_ACCEPT: rule({
    purpose: 'JOB_ACCEPT',
    description: 'A subcontractor accepts or declines one subcontract order, or proposes another date, without any price.',
    recordTypes: ['SubcontractOrder'],
    actions: { open: notCounted, accept: counted('optional'), decline: counted('optional'), moveDate: counted('optional') },
    grains: [],
    expiryDays: { default: 7, max: 30 },
    uses: { default: 1, max: 1 },
    readsFiles: false,
    ...PLAIN,
  }),
  APPROVAL: rule({
    purpose: 'APPROVAL',
    description: 'A customer or supplier approves (with or without changes) or refuses one approval request, signed with a typed name.',
    recordTypes: ['ApprovalRequest'],
    // "Approve with changes" is an approval with words (ApprovalRequest APPROVED_WITH_CHANGES; evidence APPROVED).
    actions: { open: notCounted, approve: counted('required'), refuse: counted('required') },
    grains: [],
    expiryDays: { default: 14, max: 60 },
    uses: { default: 1, max: 1 },
    readsFiles: true,
    ...PLAIN,
  }),
  RECORD_INVITE: rule({
    purpose: 'RECORD_INVITE',
    description: 'An invited partner joins one shared record: reads its shared fields and files, and posts or uploads when the share allows it.',
    recordTypes: ['Style', 'Quote', 'SalesOrder', 'PurchaseOrder', 'SubcontractOrder', 'Shipment', 'Complaint', 'ReturnAuthorisation', 'SupplierClaim'],
    // Unlimited opens, posts and uploads until the share ends (links-depth.prisma RecordShare); each one is evidence.
    actions: { open: notCounted, post: notCounted, upload: notCounted },
    grains: [],
    expiryDays: { default: 30, max: 180 },
    uses: { default: 1, max: 1 },
    readsFiles: true,
    ...PLAIN,
  }),
  SECURE_FILE: rule({
    purpose: 'SECURE_FILE',
    description: 'A set of files to download (a payroll export, a tech pack), with an optional password sent apart and the receipt "I received these files".',
    recordTypes: ['StoredFile'],
    // Opening never counts; each download uses the link ("5 downloads left"); the receipt is evidence, never a use.
    actions: { open: notCounted, download: counted('none'), receive: notCountedNamed('optional') },
    grains: [],
    expiryDays: { default: 7, max: 30 },
    uses: { default: 5, max: 20 },
    readsFiles: false,
    fileSet: true,
    password: true,
    receipt: true,
    draft: false,
    renewal: 'files',
  }),
})

export function isLinkPurpose(value: unknown): value is LinkPurpose {
  return typeof value === 'string' && (LINK_PURPOSES as readonly string[]).includes(value)
}

export function isLinkAction(value: unknown): value is LinkAction {
  return typeof value === 'string' && (LINK_ACTIONS as readonly string[]).includes(value)
}

/** The rule of an action of a purpose, or undefined when the purpose does not allow it. */
export function actionRule(purpose: LinkPurpose, action: LinkAction): ActionRule | undefined {
  return PURPOSE_RULES[purpose]?.actions[action]
}

const isRead = (action: LinkAction): boolean => (LINK_READS as readonly LinkAction[]).includes(action)

/** The answers a purpose allows (the reads aside: open, download), in the order of LINK_ACTIONS. */
export function answersOf(purpose: LinkPurpose): LinkAnswer[] {
  const actions = PURPOSE_RULES[purpose].actions
  return LINK_ACTIONS.filter((action): action is LinkAnswer => !isRead(action) && actions[action] !== undefined)
}

/** The purposes that may carry a set of files (DOCUMENT_VIEW, SECURE_FILE). */
export const FILE_SET_PURPOSES = Object.freeze(LINK_PURPOSES.filter((purpose) => PURPOSE_RULES[purpose].fileSet))
/** The purposes whose long form keeps a draft with us (MEASUREMENTS, CLAIM, SUPPLIER_ONBOARD). */
export const DRAFT_PURPOSES = Object.freeze(LINK_PURPOSES.filter((purpose) => PURPOSE_RULES[purpose].draft))

/** The permissions a link session of this purpose holds: open, its answers, and its grains as `money.<grain>`. */
export function linkPermissions(purpose: LinkPurpose): Permission[] {
  const rule = PURPOSE_RULES[purpose]
  if (!rule) return []
  const actions = LINK_ACTIONS.filter((action) => rule.actions[action] !== undefined).map((action) => ACTION_PERMISSIONS[action])
  const files: Permission[] = rule.readsFiles ? [FILES_READ] : []
  return [...new Set([...actions, ...files, ...rule.grains.map((grain) => grainPermission(grain) as Permission)])].sort()
}

/**
 * The grants of a link session (A1 §3.11): one grant with the purpose's permissions, over the link's company and its
 * party only. Fixed by the purpose; a role assignment never adds to it.
 */
export function linkGrants(purpose: LinkPurpose, scope: { readonly companyId: string; readonly partyId: string }): readonly Grant[] {
  if (!isLinkPurpose(purpose) || !isUuid(scope.companyId) || !isUuid(scope.partyId)) return Object.freeze([])
  return Object.freeze([
    Object.freeze({
      permissions: Object.freeze(linkPermissions(purpose)),
      companies: Object.freeze([scope.companyId]),
      sites: 'all' as const,
      parties: Object.freeze([scope.partyId]),
    }),
  ])
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The expiry and use limit of a new link: the purpose's defaults, or what the office asked within the purpose's
 * maximum. A ValidationError names each field that is out of range.
 */
export function linkTerms(
  purpose: LinkPurpose,
  asked: { readonly expiresInDays?: number | undefined; readonly maxUses?: number | undefined },
  now: Date,
): { readonly expiresAt: Date; readonly maxUses: number } {
  const rule = PURPOSE_RULES[purpose]
  if (!rule) throw new ValidationError('The purpose is not known.', [{ path: 'purpose', message: `Expected one of ${LINK_PURPOSES.join(', ')}.` }])
  const issues: Issue[] = []
  const days = asked.expiresInDays ?? rule.expiryDays.default
  if (!Number.isSafeInteger(days) || days < 1 || days > rule.expiryDays.max) {
    issues.push({ path: 'expiresInDays', message: `Expected 1 to ${rule.expiryDays.max} days for a ${purpose} link.` })
  }
  const maxUses = asked.maxUses ?? rule.uses.default
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > rule.uses.max) {
    issues.push({ path: 'maxUses', message: `Expected 1 to ${rule.uses.max} uses for a ${purpose} link.` })
  }
  if (issues.length > 0) throw new ValidationError('The link terms are not valid.', issues)
  return { expiresAt: new Date(now.getTime() + days * DAY_MS), maxUses }
}

/** Where a link stands. Only a LIVE link opens anything. */
export const LINK_STATES = ['LIVE', 'REVOKED', 'USED_UP', 'EXPIRED'] as const
export type LinkState = (typeof LINK_STATES)[number]

export interface LinkStatus {
  readonly expiresAt: Date
  readonly revokedAt: Date | null
  readonly uses: number
  readonly maxUses: number
}

/** Revoked first, then used up, then expired; otherwise live. */
export function linkState(link: LinkStatus, now: Date): LinkState {
  if (link.revokedAt !== null) return 'REVOKED'
  if (link.uses >= link.maxUses) return 'USED_UP'
  if (link.expiresAt.getTime() <= now.getTime()) return 'EXPIRED'
  return 'LIVE'
}

export const isLinkLive = (link: LinkStatus, now: Date): boolean => linkState(link, now) === 'LIVE'
