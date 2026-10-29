import { grainPermission, type Grain } from '../auth/grains/grains'
import { ValidationError, type Issue } from '../core/errors'
import { isUuid } from '../core/ids'
import type { Grant, Permission } from '../core/permissions'
import { LINK_ACCEPT, LINK_CONFIRM, LINK_DECLINE, LINK_OPEN } from './permissions'

/** files.read (auth/permissions/catalogue FILES_DEFINITIONS), named here: the catalogue imports this folder. */
const FILES_READ = 'files.read' satisfies Permission

/**
 * The purposes of a one-off link (plan A1 §3.10 "Links", §2.6, §3.11; PLAN §4.7 stages 06a-accept and 08-buy; features
 * SAL-099, PLT-007, PLT-035). A link is a bearer key for ONE purpose on ONE record of ONE party, with an expiry and a use
 * limit. Its session's grants come from the purpose, never from role assignments:
 *
 *   purpose        record          answers           counted uses           grains  typed name      email check
 *   QUOTE_ACCEPT   Quote           accept, decline   accept, decline (1)    price   accept: needed  accept, when known
 *   PO_CONFIRM     PurchaseOrder   confirm, decline  confirm, decline (1)   none    optional        no
 *   DOCUMENT_VIEW  StoredFile,     none              every open (20)        price   no              no
 *                  Shipment
 *   DEPOSIT_INFO   DepositRequest  none              every open (20)        price   no              no
 *
 * A DOCUMENT_VIEW session also reads files (files.read, over the link's company and party): platform/files lets a link
 * see only the files shared with its party's links that are its record or belong to it (audienceSees), behind the
 * partner role's wall. The shipping module's link of a Shipment shows its DDT, DoC and leaflet copies (B-W1-49).
 *
 * The price grain goes only to purposes that show the party its OWN document (its quote, its invoice, its deposit
 * request: the party scope of the session makes it its own). A PO_CONFIRM link holds no grain at all: the supplier
 * confirms quantities and dates, never sees a price on the link (PLAN §4.7 08-buy). Cost, margin and wages never reach
 * a link (the audience cap in auth/grains, and the partner role's column grants).
 *
 * Every open and every answer leaves an evidence row (LinkEvidence); a counted one also uses one of the link's uses.
 * The record types are named here; the module that owns each record brings its tables and its link routes (W1).
 */

export const LINK_PURPOSES = ['QUOTE_ACCEPT', 'PO_CONFIRM', 'DOCUMENT_VIEW', 'DEPOSIT_INFO'] as const
export type LinkPurpose = (typeof LINK_PURPOSES)[number]

/** What a link session does with its record: open it, or answer it. */
export const LINK_ACTIONS = ['open', 'accept', 'decline', 'confirm'] as const
export type LinkAction = (typeof LINK_ACTIONS)[number]
export type LinkAnswer = Exclude<LinkAction, 'open'>

/** The evidence row's action for each link action (the LinkEvidenceAction enum of factory-db). */
export const EVIDENCE_ACTIONS = { open: 'OPENED', accept: 'ACCEPTED', decline: 'DECLINED', confirm: 'CONFIRMED' } as const satisfies Record<LinkAction, string>
export type EvidenceAction = (typeof EVIDENCE_ACTIONS)[LinkAction]

/** The permission a link session holds for each action. */
export const ACTION_PERMISSIONS: Readonly<Record<LinkAction, Permission>> = {
  open: LINK_OPEN,
  accept: LINK_ACCEPT,
  decline: LINK_DECLINE,
  confirm: LINK_CONFIRM,
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
}

const notCounted: ActionRule = Object.freeze({ counts: false, typedName: 'none', checksEmail: false })
const counted = (typedName: TypedNameRule, checksEmail = false): ActionRule => Object.freeze({ counts: true, typedName, checksEmail })

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
  }),
  DOCUMENT_VIEW: rule({
    purpose: 'DOCUMENT_VIEW',
    description: 'The customer or supplier opens one of its own documents (an invoice copy, a DDT, a declaration of conformity), or the documents of one of its shipments, to read or download them.',
    recordTypes: ['StoredFile', 'Shipment'],
    actions: { open: counted('none') },
    grains: ['price'],
    expiryDays: { default: 30, max: 365 },
    uses: { default: 20, max: 100 },
    readsFiles: true,
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

/** The answers a purpose allows (open aside), in the order of LINK_ACTIONS. */
export function answersOf(purpose: LinkPurpose): LinkAnswer[] {
  const actions = PURPOSE_RULES[purpose].actions
  return LINK_ACTIONS.filter((action): action is LinkAnswer => action !== 'open' && actions[action] !== undefined)
}

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
