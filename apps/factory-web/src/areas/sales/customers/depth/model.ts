import { HOLD_LIMITS, HOLD_REASONS } from '@nexus/factory-domain/parties/holds/holds'
import { LAWFUL_BASES, PRIVACY_LIMITS } from '@nexus/factory-domain/parties/contact-privacy/privacy'
import { REQUIREMENT_KINDS, REQUIREMENT_LIMITS, REQUIREMENT_STAGES } from '@nexus/factory-domain/parties/requirements/requirements'
import type { AccessCopy, Erased, Hold, HoldReason, LawfulBasis, PrivacyContact, Requirement, RequirementBody, RequirementKind, RequirementStage } from './api'

/**
 * Customer 360 and customers in depth (B-W2b-324), pure: who may do what (`depthCan`), the glance's words (free credit,
 * promises, the hold reason), the drafts and their problems of every dialog (a hold, its release, a requirement and its
 * replacement or end, a lawful basis, an objection, an access copy, an erasure), and what each
 * refusal means in words. Every word is a key of `sales-customers-depth` with its figures: the API's English is never
 * drawn. The tests hold it.
 */

export const NS = 'sales-customers-depth'

export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
export const say = (key: string, params?: Record<string, string | number>): Words => (params ? { key, params } : { key })

export type Read<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly value: T }
export const LOADING = { status: 'loading' } as const
export const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
export const failedRead = (problem: string): Read<never> => ({ status: 'error', problem })

export const REASONS = HOLD_REASONS
export const KINDS = REQUIREMENT_KINDS
export const STAGES = REQUIREMENT_STAGES
export const BASES = LAWFUL_BASES

/** A failed call as a `problem.*` key (the API's kind, never its English). */
export function problemOf(error: unknown): string {
  const kind = (error as { kind?: string } | null)?.kind
  switch (kind) {
    case 'forbidden':
      return 'problem.forbidden'
    case 'not_found':
      return 'problem.notFound'
    case 'conflict':
      return 'problem.conflict'
    case 'invalid':
      return 'problem.invalid'
    case 'step_up':
      return 'problem.stepUp'
    case 'rate_limited':
      return 'problem.rateLimited'
    case 'signed_out':
      return 'problem.signedOut'
    case 'network':
    case 'unavailable':
      return 'problem.offline'
    default:
      return 'problem.unavailable'
  }
}

/** The issue paths of a refusal (`body/words`, `privacy/PORTAL_USER` …). */
export function pathsOf(error: unknown): string[] {
  const issues = (error as { issues?: ReadonlyArray<{ path?: unknown }> } | null)?.issues ?? []
  return issues.map((issue) => (typeof issue.path === 'string' ? issue.path : Array.isArray(issue.path) ? issue.path.join('/') : ''))
}

/** A notice of the depth's cards (a write done), in words. */
export type Notice = { readonly tone: 'success' | 'info' | 'warning' | 'danger'; readonly words: Words } | null

/** The dialogs, as the container holds them (the views draw them; every edit goes back through `onDraft`). */
interface DialogState {
  readonly busy: boolean
  /** A refusal or a failed call, as a key. */
  readonly failed: string | null
  readonly tried: boolean
}
export type HoldDialog = (DialogState & { readonly kind: 'place'; readonly draft: PlaceDraft }) | (DialogState & { readonly kind: 'release'; readonly hold: Hold; readonly draft: ReleaseDraft })
export type RequirementDialog =
  | (DialogState & { readonly kind: 'add' | 'replace'; readonly target: Requirement | null; readonly draft: RequirementDraft })
  | (DialogState & { readonly kind: 'end'; readonly target: Requirement; readonly reason: string })
export type PrivacyDialog =
  | (DialogState & { readonly kind: 'basis'; readonly contact: PrivacyContact; readonly draft: BasisDraft; readonly portal: boolean })
  | (DialogState & {
      readonly kind: 'objection' | 'copy' | 'erase'
      readonly contact: PrivacyContact
      readonly words: string
      /** A 409: a portal user of the customer still holds the e-mail (Portal access ends it). */
      readonly portal: boolean
      /** The access copy made (copy). */
      readonly copy: (AccessCopy & { raw: unknown }) | null
      /** What the erasure kept (erase, done). */
      readonly kept: Erased['kept'] | null
      /** F-CA-228 (R-B7): the day the person objected (objection only; YYYY-MM-DD, today or before). */
      readonly day?: string
    })

// ---- who may do what -------------------------------------------------------------------------------------------------------

export interface DepthCan {
  /** parties.manage: requirements and the PO number. */
  readonly manage: boolean
  /** parties.hold: put on hold and release. */
  readonly hold: boolean
  /** parties.privacy: lawful basis, objection, access copy. */
  readonly privacy: boolean
  /** parties.erase: erase a contact (with a fresh code). */
  readonly erase: boolean
  /** money.price: the amounts of free credit. */
  readonly price: boolean
  /** product.styles.view: name the styles a requirement applies to. */
  readonly styles: boolean
  /** files.read: pick the routing guide among the customer's files. */
  readonly files: boolean
}

export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return {
    manage: held.has('parties.manage'),
    hold: held.has('parties.hold'),
    privacy: held.has('parties.privacy'),
    erase: held.has('parties.erase'),
    price: held.has('money.price'),
    styles: held.has('product.styles.view'),
    files: held.has('files.read'),
  }
}

/** Why a write of the kind is held (a message key), or null: the right, then an archived customer. */
export function writeHeld(can: DepthCan, right: 'manage' | 'hold' | 'privacy' | 'erase', status: string): string | null {
  if (!can[right]) return `held.${right}`
  if (status === 'ARCHIVED') return 'held.archived'
  return null
}

// ---- the glance -----------------------------------------------------------------------------------------------------------

// F-CO-203 (customer Overview co-w2 W2.3): the free-credit and promises tiles and a sample round's due words went with the Overview's
// old parts; the Overview's rules say the credit, the promises and the samples' days (areas/sales/customers/record/overview).

// ---- Tax & terms › Hold ---------------------------------------------------------------------------------------------------

export interface PlaceDraft {
  /** null: every company. */
  readonly companyId: string | null
  readonly reason: HoldReason | null
  readonly words: string
}
export interface ReleaseDraft {
  readonly holdId: string
  readonly words: string
}

/** What a placement or a release still needs, as words (null: ready). */
export function holdDraftProblem(draft: { readonly reason?: HoldReason | null; readonly words: string }, what: 'place' | 'release'): Words | null {
  if (what === 'place' && !draft.reason) return say('hold.problem.reason')
  const words = draft.words.trim()
  if (words === '') return say(what === 'place' ? 'hold.problem.why' : 'hold.problem.whyRelease')
  if (words.length > HOLD_LIMITS.words) return say('problem.tooLong', { max: HOLD_LIMITS.words })
  return null
}

/** A refusal of a hold write in words: one in force for that reason already, or the API's kind. */
export function holdRefusal(error: unknown): string {
  const paths = pathsOf(error)
  if (paths.includes('body/reason')) return 'hold.refused.same'
  if (paths.includes('body/companyId')) return 'hold.refused.company'
  if (paths.includes('body/version')) return 'problem.conflict'
  return problemOf(error)
}

// ---- Requirements ---------------------------------------------------------------------------------------------------------

export interface RequirementDraft {
  /** null: every company. */
  readonly companyId: string | null
  readonly kind: RequirementKind
  readonly words: string
  readonly appliesAt: readonly RequirementStage[]
  readonly everyStyle: boolean
  readonly styles: readonly { readonly id: string; readonly code: string }[]
  readonly fileId: string | null
  /** A replacement: why it changed (optional). */
  readonly reason: string
}

export const blankRequirement = (companyId: string | null): RequirementDraft => ({ companyId, kind: 'PACKING', words: '', appliesAt: ['ORDER'], everyStyle: true, styles: [], fileId: null, reason: '' })

/** A requirement in force as the replacement's start (its content; the reason empty). */
export const requirementDraftOf = (row: Requirement): RequirementDraft => ({
  companyId: row.companyId,
  kind: row.kind,
  words: row.words,
  appliesAt: row.appliesAt,
  everyStyle: row.everyStyle,
  styles: row.styles.map((style) => ({ id: style.id, code: style.code })),
  fileId: row.file?.id ?? null,
  reason: '',
})

/** What the draft still needs, field by field (keys of the catalogue). */
export function requirementProblems(draft: RequirementDraft): Partial<Record<'words' | 'appliesAt' | 'styles' | 'reason', Words>> {
  const out: Partial<Record<'words' | 'appliesAt' | 'styles' | 'reason', Words>> = {}
  const words = draft.words.trim()
  if (words === '') out.words = say('req.problem.words')
  else if (words.length > REQUIREMENT_LIMITS.words) out.words = say('problem.tooLong', { max: REQUIREMENT_LIMITS.words })
  if (draft.appliesAt.length === 0) out.appliesAt = say('req.problem.where')
  if (!draft.everyStyle && draft.styles.length === 0) out.styles = say('req.problem.styles')
  if (draft.styles.length > REQUIREMENT_LIMITS.styles) out.styles = say('req.problem.tooManyStyles', { max: REQUIREMENT_LIMITS.styles })
  if (draft.reason.trim().length > REQUIREMENT_LIMITS.endReason) out.reason = say('problem.tooLong', { max: REQUIREMENT_LIMITS.endReason })
  return out
}

/** The body the API takes: stages in the design's order, no styles for every style. */
export function requirementBody(draft: RequirementDraft): RequirementBody {
  return {
    companyId: draft.companyId,
    kind: draft.kind,
    words: draft.words.trim(),
    appliesAt: STAGES.filter((stage) => draft.appliesAt.includes(stage)),
    styleIds: draft.everyStyle ? [] : draft.styles.map((style) => style.id),
    fileId: draft.fileId,
  }
}

/** The reason an end needs (1..500 characters). */
export function endReasonProblem(reason: string): Words | null {
  const text = reason.trim()
  if (text === '') return say('req.problem.endReason')
  if (text.length > REQUIREMENT_LIMITS.endReason) return say('problem.tooLong', { max: REQUIREMENT_LIMITS.endReason })
  return null
}

/** A refusal of a requirement write in words. */
export function requirementRefusal(error: unknown): string {
  const paths = pathsOf(error)
  if (paths.includes('body/companyId')) return 'req.refused.company'
  if (paths.some((path) => path.startsWith('body/styleIds'))) return 'req.refused.styles'
  if (paths.includes('body/fileId')) return 'req.refused.file'
  if (paths.includes('body/version')) return 'problem.conflict'
  return problemOf(error)
}

// F-CT-535 (ct-w2 W2.4): the old cards' rules went with them — the Hold card's toggle, the PO number card's rows, changes and switch
// (Commercial terms says the PO rule per company: cu/record/terms/commercial.ts), the Requirements card's "shown on" keys.

// ---- contacts: consent, lawful basis, personal-data actions -------------------------------------------------------------

export interface BasisDraft {
  readonly contactId: string
  readonly basis: LawfulBasis | null
  /** YYYY-MM-DD, when the person consented (CONSENT only). */
  readonly consentDay: string
  readonly consentSource: string
}

export const basisDraftOf = (contact: PrivacyContact): BasisDraft => ({ contactId: contact.id, basis: contact.lawfulBasis, consentDay: contact.consentAt?.slice(0, 10) ?? '', consentSource: contact.consentSource ?? '' })

/** What a basis still needs (CONSENT: when and how, not in the future). */
export function basisProblems(draft: BasisDraft, today: string): Partial<Record<'basis' | 'consentDay' | 'consentSource', Words>> {
  const out: Partial<Record<'basis' | 'consentDay' | 'consentSource', Words>> = {}
  if (!draft.basis) out.basis = say('privacy.problem.basis')
  if (draft.basis === 'CONSENT') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.consentDay)) out.consentDay = say('privacy.problem.consentDay')
    else if (draft.consentDay > today) out.consentDay = say('privacy.problem.future')
    const source = draft.consentSource.trim()
    if (source === '') out.consentSource = say('privacy.problem.consentSource')
    else if (source.length > PRIVACY_LIMITS.consentSource) out.consentSource = say('problem.tooLong', { max: PRIVACY_LIMITS.consentSource })
  }
  return out
}

/** The basis body: the consent's day as noon UTC of that day (never "in the future" for a consent given today). */
export function basisBody(draft: BasisDraft, version: number, now: Date = new Date()) {
  const consent = draft.basis === 'CONSENT'
  const noon = `${draft.consentDay}T12:00:00.000Z`
  const at = consent ? (Date.parse(noon) > now.getTime() ? now.toISOString() : noon) : null
  return { version, lawfulBasis: draft.basis!, consentAt: at, consentSource: consent ? draft.consentSource.trim() : null }
}

/** The words a personal-data act asks for (an objection, an access copy, an erasure): 1..2000 characters. */
export function wordsProblem(words: string): Words | null {
  const text = words.trim()
  if (text === '') return say('privacy.problem.words')
  if (text.length > PRIVACY_LIMITS.words) return say('problem.tooLong', { max: PRIVACY_LIMITS.words })
  return null
}

/** F-CA-228 (R-B7): the objection's day as the API's instant — noon UTC of that day, never later than now (today's stays today). */
export function objectionAt(day: string | undefined, now: Date = new Date()): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const noon = `${day}T12:00:00.000Z`
  return Date.parse(noon) > now.getTime() ? now.toISOString() : noon
}

/** Why an act on a contact is held (a key), or null. */
export function privacyHeld(contact: PrivacyContact, act: 'basis' | 'objection' | 'copy' | 'erase', can: DepthCan, status: string): string | null {
  if (contact.erased) return 'held.erased'
  if (act === 'erase') return writeHeld(can, 'erase', status)
  if (act === 'objection' && contact.objectedAt) return 'held.objected'
  if (act === 'copy') return can.privacy ? null : 'held.privacy'
  return writeHeld(can, 'privacy', status)
}

/** A refusal of a personal-data act in words: a portal user still holds the address, an objection already recorded, … */
export function privacyRefusal(error: unknown): { key: string; portal: boolean } {
  const paths = pathsOf(error)
  if (paths.some((path) => path.includes('PORTAL_USER'))) return { key: 'privacy.refused.portalUser', portal: true }
  if (paths.some((path) => path.includes('CONTACT_ERASED'))) return { key: 'held.erased', portal: false }
  if (paths.includes('body/consentAt')) return { key: 'privacy.problem.future', portal: false }
  if (paths.includes('body/version')) return { key: 'problem.conflict', portal: false }
  return { key: problemOf(error), portal: false }
}

/** An access copy in numbers: what we hold, kind by kind (the person's details are shown apart). */
export function copyCounts(copy: { readonly records: Readonly<Record<'quotes' | 'inquiries' | 'returns' | 'complaints', readonly unknown[]>>; readonly mailsReceived: readonly unknown[]; readonly mailsSent: readonly unknown[]; readonly messages: readonly unknown[]; readonly links: readonly unknown[]; readonly measurementProfiles: readonly unknown[]; readonly portalUsers: readonly unknown[]; readonly changes: readonly unknown[] }): { key: string; count: number }[] {
  return [
    { key: 'copy.quotes', count: copy.records.quotes.length },
    { key: 'copy.inquiries', count: copy.records.inquiries.length },
    { key: 'copy.returns', count: copy.records.returns.length },
    { key: 'copy.complaints', count: copy.records.complaints.length },
    { key: 'copy.mailsReceived', count: copy.mailsReceived.length },
    { key: 'copy.mailsSent', count: copy.mailsSent.length },
    { key: 'copy.messages', count: copy.messages.length },
    { key: 'copy.links', count: copy.links.length },
    { key: 'copy.profiles', count: copy.measurementProfiles.length },
    { key: 'copy.portalUsers', count: copy.portalUsers.length },
    { key: 'copy.changes', count: copy.changes.length },
  ]
}

/** What an erasure kept, in words per kind (the API's `kind`: documents, auditRows, mails, messages, …). */
export const KEPT_KINDS = ['documents', 'inboundMails', 'messages', 'auditRows', 'links', 'measurementProfiles'] as const
export const keptKey = (kind: string): string => ((KEPT_KINDS as readonly string[]).includes(kind) ? `erase.kept.${kind}` : 'erase.kept.other')

/** Today in Europe/Rome, YYYY-MM-DD. */
export function todayOf(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
