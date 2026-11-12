import { HOLD_LIMITS, HOLD_REASONS } from '@nexus/factory-domain/parties/holds/holds'
import { LAWFUL_BASES, PRIVACY_LIMITS } from '@nexus/factory-domain/parties/contact-privacy/privacy'
import { REQUIREMENT_KINDS, REQUIREMENT_LIMITS, REQUIREMENT_STAGES } from '@nexus/factory-domain/parties/requirements/requirements'
import type { AccessCopy, CompanyTerms, Erased, Glance, Hold, HoldReason, LawfulBasis, PrivacyContact, Requirement, RequirementBody, RequirementKind, RequirementStage } from './api'

/**
 * Customer 360 and customers in depth (B-W2b-324), pure: who may do what (`depthCan`), the glance's words (free credit,
 * promises, the hold reason), the drafts and their problems of every dialog (a hold, its release, a requirement and its
 * replacement or end, the PO number per company, a lawful basis, an objection, an access copy, an erasure), and what each
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
export const valueOf = <T>(read: Read<T>): T | null => (read.status === 'ready' ? read.value : null)

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

/** The free-credit tile: value and hint as words (amounts only when the answer carries them: the price grain). */
export function creditTile(credit: Glance['credit'], money: (minor: number, currency: string) => string): { value: Words; hint: Words } {
  if (!credit) return { value: say('numbers.unknown'), hint: say('numbers.creditWithheld') }
  if (credit.state === 'NONE') return { value: say('credit.noLimit'), hint: say('credit.noLimitHint') }
  const amounts = credit.currency !== null && typeof credit.available === 'number' && typeof credit.limit === 'number'
  if (credit.state === 'OVER') {
    return amounts && typeof credit.overLimitBy === 'number'
      ? { value: say('credit.overBy', { amount: money(credit.overLimitBy > 0 ? credit.overLimitBy : -credit.available!, credit.currency!) }), hint: say('credit.ofLimit', { limit: money(credit.limit!, credit.currency!) }) }
      : { value: say('credit.over'), hint: say('credit.noPrice') }
  }
  return amounts ? { value: say('credit.available', { amount: money(credit.available!, credit.currency!) }), hint: say('credit.ofLimit', { limit: money(credit.limit!, credit.currency!) }) } : { value: say('credit.within'), hint: say('credit.noPrice') }
}

/** The promises tile: how many open orders are late, and the next promise. */
export function promisesTile(promises: Glance['promises'], date: (day: string) => string): { value: Words; hint: Words } {
  if (!promises) return { value: say('numbers.unknown'), hint: say('numbers.promisesWithheld') }
  if (promises.open === 0) return { value: say('promises.none'), hint: say('promises.noneHint') }
  const hint = promises.next ? say('promises.next', { date: date(promises.next) }) : promises.noPromise > 0 ? say('promises.without', { count: promises.noPromise }) : say('promises.noneComing')
  return { value: promises.late > 0 ? say('promises.late', { count: promises.late }) : say('promises.onTime', { count: promises.open }), hint }
}

/** A sample round's due words: late by N days, due today, due on a day, or no due day. */
export function dueWords(row: { readonly dueDate: string | null; readonly daysLate: number | null }, date: (day: string) => string): Words {
  if (!row.dueDate || row.daysLate === null) return say('samples.noDue')
  if (row.daysLate > 0) return say('samples.late', { count: row.daysLate })
  if (row.daysLate === 0) return say('samples.dueToday')
  return say('samples.due', { date: date(row.dueDate) })
}

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

/** The toggle of the card: on with any hold in force; switching it off releases the one hold, else it says to pick one. */
export function toggleHeld(holds: readonly Hold[], held: string | null): string | null {
  if (held) return held
  return holds.filter((hold) => hold.inForce).length > 1 ? 'hold.toggleMany' : null
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

/** Where a requirement is shown, as stage keys in the design's order ("the order · the pick & pack screen …"). */
export const shownOnKeys = (stages: readonly RequirementStage[]): string[] => STAGES.filter((stage) => stages.includes(stage)).map((stage) => `stage.${stage}`)

// ---- Customer PO number required (terms per company) ---------------------------------------------------------------------

export interface PoRow {
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly required: boolean
  /** The company's own row decides (else nothing is required). */
  readonly own: boolean
  readonly version: number | null
  readonly mayChange: boolean
  readonly setBy: string | null
  readonly setAt: string | null
}

export function poRows(terms: CompanyTerms): PoRow[] {
  return terms.companies.map((entry) => ({
    companyId: entry.company.id,
    code: entry.company.code,
    name: entry.company.name,
    required: entry.inForce.poNumberRequired,
    own: entry.terms !== null,
    version: entry.terms?.version ?? null,
    mayChange: entry.mayChange,
    setBy: entry.terms?.setBy ?? null,
    setAt: entry.terms?.setAt ?? null,
  }))
}

/** The companies whose switch the draft changes (draft: company id → required). */
export const poChanges = (rows: readonly PoRow[], draft: Readonly<Record<string, boolean>>): PoRow[] => rows.filter((row) => draft[row.companyId] !== undefined && draft[row.companyId] !== row.required)

/** Why one company's switch is held (a key), or null. */
export function poHeld(row: PoRow, can: DepthCan, status: string): string | null {
  if (!row.mayChange) return 'held.manageCompany'
  return writeHeld(can, 'manage', status)
}

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
