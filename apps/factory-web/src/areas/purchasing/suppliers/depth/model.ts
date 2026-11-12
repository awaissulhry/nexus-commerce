import { IBAN_LENGTHS, ibanRemainder, normaliseIban } from '@nexus/factory-domain/purchasing/bank/rules'
import { LIMITS, REASON_MAX, STATUS_MOVES } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import type { CalendarDay, CalendarKind } from '@nexus/ui/components/CalendarGrid/index'
import type { Tone } from '@nexus/ui/primitives'
import {
  CATEGORIES,
  KINDS,
  RECEIVES,
  STATUSES,
  type AskState,
  type BankAccount,
  type BankPill,
  type ChangeRequest,
  type Decision,
  type PlannedChange,
  type ProfileBody,
  type ProfileContact,
  type Qualification,
  type Receives,
  type StandingCode,
  type SupplierDocuments,
  type SupplierKind,
  type SupplierProfile,
  type SupplierStatus,
  type TannageCode,
  type Vault,
  type VaultCategory,
  type VaultUpload,
} from './api'

/**
 * Suppliers in depth on screen (B-W2b-334), pure: who may do what, the Overview's draft (kinds, lead time, origin) and what
 * a save sends, the status moves and why one needs a reason, the closures as calendar days, what each contact receives
 * and who gets what, the vault in our words (what we ask, the gate, the next step), the office review's drafts, the
 * qualifications' moves, the bank account's pill, who may call back or check it and why not, a typed IBAN checked as typed,
 * and the list's documents cell and Request documents reach. Every word is a key of `purchasing-suppliers-depth` with its
 * figures: the API's English is never drawn.
 */

export const NS = 'purchasing-suppliers-depth'

export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const w = (key: string, params?: Record<string, string | number>): Words => (params ? { key, params } : { key })

export type Read<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly value: T }
export const LOADING = { status: 'loading' } as const
export const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
export const failedRead = (problem: string): Read<never> => ({ status: 'error', problem })
export const valueOf = <T>(read: Read<T>): T | null => (read.status === 'ready' ? read.value : null)

/** A failed call as a `problem.*` key (the API's kind: never its English). */
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

/** The fields a 400 named (`body/kinds` → `kinds`). */
export function refusedOf(error: unknown): string[] {
  const issues = (error as { issues?: ReadonlyArray<{ path?: unknown }> } | null)?.issues ?? []
  return issues.map((issue) => (Array.isArray(issue.path) ? issue.path.join('/') : String(issue.path ?? ''))).map((path) => path.replace(/^body[/.]/, ''))
}

// ---- who may do what ------------------------------------------------------------------------------------------------------

export interface DepthCan {
  /** parties.manage: kinds, lead time, origin, what a contact receives. */
  readonly manage: boolean
  /** purchasing.suppliers.status. */
  readonly status: boolean
  readonly qualify: boolean
  readonly review: boolean
  readonly decideChanges: boolean
  /** partners.tasks.manage: Request documents. */
  readonly ask: boolean
  readonly bankView: boolean
  readonly bankPropose: boolean
  readonly bankCallBack: boolean
  readonly bankVerify: boolean
  readonly bankReveal: boolean
  /** inventory.stock.view: the receipts of Quality & rating. */
  readonly receipts: boolean
  /** purchasing.view: the claims of Quality & rating. */
  readonly claims: boolean
  /** files.read: open a document. */
  readonly files: boolean
  /** purchasing.questionnaire.view: the Questionnaire tab (Request by link). */
  readonly questionnaire: boolean
}

export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return {
    manage: held.has('parties.manage'),
    status: held.has('purchasing.suppliers.status'),
    qualify: held.has('purchasing.qualification.manage'),
    review: held.has('purchasing.supplierDocuments.review'),
    decideChanges: held.has('purchasing.supplierChanges.decide'),
    ask: held.has('partners.tasks.manage'),
    bankView: held.has('purchasing.bank.view'),
    bankPropose: held.has('purchasing.bank.propose'),
    bankCallBack: held.has('purchasing.bank.callBack'),
    bankVerify: held.has('purchasing.bank.verify'),
    bankReveal: held.has('purchasing.bank.reveal'),
    receipts: held.has('inventory.stock.view'),
    claims: held.has('purchasing.view'),
    files: held.has('files.read'),
    questionnaire: held.has('purchasing.questionnaire.view'),
  }
}

export const NO_DEPTH: DepthCan = depthCan([])

// ---- the Overview: kinds, lead time, origin ------------------------------------------------------------------------------

export interface ProfileDraft {
  readonly kinds: readonly SupplierKind[]
  readonly leadTimeDays: string
  readonly originCountry: string
  readonly originRegion: string
  readonly originNote: string
  /** Comma-separated alpha-2 codes, as typed. */
  readonly hideCountries: string
  readonly tannages: readonly TannageCode[]
}

export function draftOf(profile: SupplierProfile): ProfileDraft {
  return {
    kinds: KINDS.filter((kind) => profile.kinds.includes(kind)),
    leadTimeDays: profile.leadTimeDays === null ? '' : String(profile.leadTimeDays),
    originCountry: profile.origin.country ?? '',
    originRegion: profile.origin.region ?? '',
    originNote: profile.origin.note ?? '',
    hideCountries: profile.origin.hideCountries.join(', '),
    tannages: profile.origin.tannages,
  }
}

export const isTannery = (kinds: readonly SupplierKind[]) => kinds.includes('TANNERY')
export const countriesOf = (text: string): string[] => [...new Set(text.split(/[\s,;]+/).map((code) => code.trim().toUpperCase()).filter((code) => code !== ''))]
const sameSet = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((value) => b.includes(value))

/** What is wrong with the draft, per field. */
export function profileProblems(draft: ProfileDraft): Record<string, Words> {
  const problems: Record<string, Words> = {}
  const lead = draft.leadTimeDays.trim()
  if (lead !== '' && (!/^\d+$/.test(lead) || Number(lead) > LIMITS.leadTimeDays)) problems.leadTimeDays = w('profile.problem.leadTime', { max: LIMITS.leadTimeDays })
  const country = draft.originCountry.trim()
  if (country !== '' && !/^[A-Za-z]{2}$/.test(country)) problems.originCountry = w('profile.problem.country')
  if (draft.originRegion.length > LIMITS.region) problems.originRegion = w('profile.problem.tooLong', { max: LIMITS.region })
  if (draft.originNote.length > LIMITS.note) problems.originNote = w('profile.problem.tooLong', { max: LIMITS.note })
  if (isTannery(draft.kinds)) {
    const hides = countriesOf(draft.hideCountries)
    if (hides.some((code) => !/^[A-Z]{2}$/.test(code))) problems.hideCountries = w('profile.problem.hides')
    else if (hides.length > LIMITS.hideCountries) problems.hideCountries = w('profile.problem.tooMany', { max: LIMITS.hideCountries })
  }
  return problems
}

/**
 * What a save sends: only what changed (one PATCH for kinds, lead time and origin). Leaving TANNERY clears the raw hides'
 * countries and the tannages in the same save (the API refuses a tannery's facts on a supplier that is not one).
 */
export function profileBody(profile: SupplierProfile, draft: ProfileDraft): ProfileBody | null {
  const before = draftOf(profile)
  const body: { -readonly [K in keyof ProfileBody]: ProfileBody[K] } = { version: profile.version }
  if (!sameSet(before.kinds, draft.kinds)) body.kinds = KINDS.filter((kind) => draft.kinds.includes(kind))
  if (draft.leadTimeDays.trim() !== before.leadTimeDays) body.leadTimeDays = draft.leadTimeDays.trim() === '' ? null : Number(draft.leadTimeDays.trim())
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (draft.originCountry.trim().toUpperCase() !== before.originCountry) body.originCountry = text(draft.originCountry)?.toUpperCase() ?? null
  if (draft.originRegion.trim() !== before.originRegion) body.originRegion = text(draft.originRegion)
  if (draft.originNote.trim() !== before.originNote) body.originNote = text(draft.originNote)
  const tannery = isTannery(draft.kinds)
  const hides = tannery ? countriesOf(draft.hideCountries) : []
  const tannages = tannery ? [...draft.tannages] : []
  if (!sameSet(profile.origin.hideCountries, hides)) body.hideOriginCountries = hides
  if (!sameSet(profile.origin.tannages, tannages)) body.tannages = tannages
  return Object.keys(body).length > 1 ? body : null
}

/** How many fields the draft changes (the EditModeBar's count). */
export function changedFields(profile: SupplierProfile, draft: ProfileDraft): number {
  const body = profileBody(profile, draft)
  return body ? Object.keys(body).length - 1 : 0
}

/** The tannery's facts a save would clear because TANNERY is no longer ticked. */
export const clearsTanneryFacts = (profile: SupplierProfile, draft: ProfileDraft) =>
  !isTannery(draft.kinds) && (profile.origin.hideCountries.length > 0 || profile.origin.tannages.length > 0)

/** Why the Overview's card is read-only, or null. */
export function profileHeld(can: DepthCan, partyStatus: string): Words | null {
  if (!can.manage) return w('held.manage')
  if (partyStatus === 'ARCHIVED') return w('held.archived')
  return null
}

// ---- the status (SCM-008) ------------------------------------------------------------------------------------------------

export const STATUS_TONE: Readonly<Record<SupplierStatus, Tone>> = { PROSPECT: 'info', APPROVED: 'success', CONDITIONAL: 'warning', ON_HOLD: 'warning', BLOCKED: 'danger', INACTIVE: 'neutral' }
export const NEEDS_REASON: ReadonlySet<SupplierStatus> = new Set(['CONDITIONAL', 'ON_HOLD', 'BLOCKED'])
export const STOPS_NEW_ORDERS: ReadonlySet<SupplierStatus> = new Set(['ON_HOLD', 'BLOCKED', 'INACTIVE'])

/** Where the supplier may go from where it stands (the domain's moves; a first status may be any other). */
export function statusMoves(profile: SupplierProfile): SupplierStatus[] {
  const from = profile.standing.supplierStatus
  if (from === null) return STATUSES.filter((status) => status !== profile.standing.status)
  return [...STATUS_MOVES[from]]
}

/** Why "Change status" is held, or null. */
export function statusHeld(can: DepthCan, profile: SupplierProfile): Words | null {
  if (!can.status) return w('held.status')
  if (profile.partyStatus === 'ARCHIVED') return w('held.archived')
  return null
}

/** The reason's problem for a move (needed for CONDITIONAL, ON_HOLD and BLOCKED; one line). */
export function reasonProblem(status: SupplierStatus | null, reason: string): Words | null {
  if (status === null) return w('status.problem.pick')
  if (NEEDS_REASON.has(status) && reason.trim() === '') return w('status.problem.reason')
  if (reason.length > REASON_MAX) return w('profile.problem.tooLong', { max: REASON_MAX })
  return null
}

/** Why no new PO goes to the supplier now, in our words (null: one may). */
export function newOrderWords(profile: SupplierProfile): Words | null {
  if (profile.newOrderProblem === null) return null
  const { status, source } = profile.standing
  if (source === 'PARTY' && profile.partyStatus === 'BLOCKED') return w('now.noOrder.partyBlocked')
  if (source === 'PARTY' && profile.partyStatus === 'ARCHIVED') return w('now.noOrder.archived')
  return w(`now.noOrder.${status}`)
}

// ---- closures (SCM-012) --------------------------------------------------------------------------------------------------

export const CLOSURE_KINDS = (t: (key: string) => string): CalendarKind[] => [
  { id: 'work', label: t('closures.kind.work') },
  { id: 'off', label: t('closures.kind.off'), off: true, pattern: 'hatch' },
  { id: 'closed', label: t('closures.kind.closed'), off: true, tone: 'warning', pattern: 'stripe' },
]

const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The dated closed days as calendar days (each day of each span, with the closure's name). */
export function closureDays(ahead: SupplierProfile['closures']['ahead']): Record<string, CalendarDay> {
  const days: Record<string, CalendarDay> = {}
  for (const span of ahead) {
    for (let day = span.from, guard = 0; day <= span.to && guard < 400; day = addDays(day, 1), guard += 1) days[day] = { kind: 'closed', reason: span.name }
  }
  return days
}

/** The week (Monday first) from the ISO weekdays it never works. */
export const weekKindsOf = (weeklyDaysOff: readonly number[]): string[] => [1, 2, 3, 4, 5, 6, 7].map((day) => (weeklyDaysOff.includes(day) ? 'off' : 'work'))

// ---- what each contact receives (SCM-004) --------------------------------------------------------------------------------

export const activeContacts = (profile: SupplierProfile): ProfileContact[] => profile.contacts.filter((contact) => contact.status === 'ACTIVE')

/** The contact's list with one kind ticked or not (the whole list is what the API takes). */
export const toggled = (contact: ProfileContact, kind: Receives, on: boolean): Receives[] => RECEIVES.filter((item) => (item === kind ? on : contact.receives.includes(item)))

/** Why a contact's box is held, or null (a contact receives mail only with an e-mail address). */
export function receivesHeld(can: DepthCan, contact: ProfileContact, kind: Receives, partyStatus: string): Words | null {
  if (!can.manage) return w('held.manage')
  if (partyStatus === 'ARCHIVED') return w('held.archived')
  if (!contact.email && !contact.receives.includes(kind)) return w('held.noEmail')
  return null
}

/** Who gets each kind of mail, in our words (the routing's facts). */
export function routingWords(profile: SupplierProfile): Array<{ kind: Receives; words: Words; tone: Tone }> {
  const names = new Map(profile.contacts.map((contact) => [contact.id, contact.name]))
  return profile.routing.map((route) => {
    const who = route.contactIds.map((id) => names.get(id) ?? '—').join(', ')
    if (route.by === 'RECEIVES') return { kind: route.kind, words: w(`routing.receives.${route.kind}`, { who }), tone: 'success' as Tone }
    if (route.by === 'ROLE') return { kind: route.kind, words: w(`routing.role.${route.kind}`, { who }), tone: 'info' as Tone }
    return { kind: route.kind, words: w(`routing.none.${route.kind}`), tone: 'warning' as Tone }
  })
}

/** The design's empty state: nobody can receive a PO by e-mail. */
export const nobodyForPos = (profile: SupplierProfile) => profile.routing.find((route) => route.kind === 'PO')?.by === 'NONE'

// ---- the vault (SCM-020) -------------------------------------------------------------------------------------------------

export const ASK_TONE: Readonly<Record<AskState, Tone>> = { MET: 'success', EXPIRING: 'warning', EXPIRED: 'danger', MISSING: 'danger' }
export const DOC_TONE: Readonly<Record<'VALID' | 'EXPIRING' | 'EXPIRED', Tone>> = { VALID: 'success', EXPIRING: 'warning', EXPIRED: 'danger' }

/** The documents an ask means, in our words (a code each: `doc.<CODE>`). */
export const askWordsOf = (codes: readonly string[]): Words[] => codes.map((code) => w(`doc.${code}`))

/** The vault's next step in our words (the design's "2 documents expire in 30 days"). */
export function nextStepWords(vault: Vault): Words {
  const missing = vault.asked.filter((ask) => ask.required && ask.state === 'MISSING' && !ask.waiting).length
  const expired = vault.asked.filter((ask) => ask.required && ask.state === 'EXPIRED' && !ask.waiting).length + vault.documents.filter((doc) => doc.state === 'EXPIRED').length
  const expiring = vault.documents.filter((doc) => doc.state === 'EXPIRING').length
  const waiting = vault.review.uploads.length
  if (waiting > 0) return w('next.waiting', { count: waiting })
  if (missing > 0) return w('next.missing', { count: missing })
  if (expired > 0) return w('next.expired', { count: expired })
  if (expiring > 0) return w('next.expiring', { count: expiring })
  return w('next.nothing')
}

/** The gate sentences: the materials whose POs are held at Send for want of a document ("POs for A12 need …"). */
export function gateWords(vault: Vault): Words[] {
  const byNeed = new Map<string, string[]>()
  for (const material of vault.materials) if (material.checkedAtSend && material.state !== 'MET' && material.state !== 'EXPIRING') byNeed.set(material.needs, [...(byNeed.get(material.needs) ?? []), material.code])
  return [...byNeed.entries()].map(([need, codes]) => w(`gate.${need}`, { codes: [...codes].sort().join(', '), count: codes.length }))
}

/** Days from today to a business day (negative once past). */
export function daysFrom(today: string, day: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

/** "Expires in 12 days", "Expires today", "Expired 3 days ago" (no date: "No expiry"). */
export function expiryWords(today: string, day: string | null): Words {
  if (day === null) return w('expiry.none')
  const left = daysFrom(today, day)
  if (left > 0) return w('expiry.in', { count: left })
  if (left === 0) return w('expiry.today')
  return w('expiry.ago', { count: -left })
}

// ---- the office review (B-W2b-189's routes) ------------------------------------------------------------------------------

export interface AcceptDraft {
  readonly category: VaultCategory
  readonly expiresOn: string
  readonly replacesFileId: string | null
}

export const acceptDraftOf = (upload: VaultUpload): AcceptDraft => ({
  category: (CATEGORIES as readonly string[]).includes(upload.category) ? (upload.category as VaultCategory) : 'SUPPLIER_CERTIFICATE',
  expiresOn: upload.expiresOn ?? '',
  replacesFileId: upload.replacesFileId,
})

/** The expiry date: a real day, not past (an expired document is never accepted); empty = no expiry. */
export function acceptProblem(draft: AcceptDraft, today: string): Words | null {
  if (draft.expiresOn === '') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.expiresOn) || Number.isNaN(Date.parse(`${draft.expiresOn}T00:00:00Z`))) return w('review.problem.date')
  if (draft.expiresOn < today) return w('review.problem.past')
  return null
}

export const REFUSE_MIN = 3
export function refuseProblem(reason: string, max: number): Words | null {
  if (reason.trim().length < REFUSE_MIN) return w('review.problem.reason', { min: REFUSE_MIN })
  if (reason.length > max) return w('profile.problem.tooLong', { max })
  return null
}

/** A profile change in our words (what, and per changed field: before → after). */
export interface ChangeLine {
  readonly words: Words
  readonly fields: ReadonlyArray<{ field: string; before: string; after: string }>
}
const text = (value: unknown): string => (value === null || value === undefined || value === '' ? '—' : Array.isArray(value) ? value.join(', ') : String(value))
export function changeLines(changes: readonly PlannedChange[]): ChangeLine[] {
  return changes.map((change) => {
    if (change.target === 'COMPANY') return { words: w('change.website'), fields: [{ field: 'website', before: text(change.before?.website), after: text(change.after?.website) }] }
    const values = change.after ?? change.before
    const label = change.target === 'ADDRESS' ? text(values?.name ?? values?.line1) : text(values?.name)
    return { words: w(`change.${change.target}.${change.op}`, { what: label }), fields: change.op === 'CHANGE' ? change.changed.map((field) => ({ field, before: text(change.before?.[field]), after: text(change.after?.[field]) })) : [] }
  })
}
export type { ChangeRequest }

// ---- qualifications (SCM-027) --------------------------------------------------------------------------------------------

export const STANDING_TONE: Readonly<Record<StandingCode, Tone>> = {
  QUALIFIED: 'success',
  CONDITIONAL: 'warning',
  NOT_YET: 'info',
  EXPIRED: 'danger',
  EVIDENCE_EXPIRED: 'danger',
  SUSPENDED: 'danger',
  PENDING: 'info',
  REFUSED: 'danger',
  NONE: 'neutral',
}

export type QualificationDialog =
  | { readonly kind: 'ask'; readonly workCentreKinds: readonly string[]; readonly materialKinds: readonly string[]; readonly validFrom: string; readonly validUntil: string }
  | { readonly kind: 'decide'; readonly id: string; readonly decision: Decision; readonly conditions: string; readonly refuseReason: string; readonly validFrom: string; readonly validUntil: string }
  | { readonly kind: 'suspend' | 'withdraw'; readonly id: string; readonly reason: string }

/** A supplier is qualified by kinds of material; a workshop by kinds of work (the API's scope rule). */
export const qualifiesWork = (roles: readonly string[]) => roles.includes('SUBCONTRACTOR')

export function qualificationProblem(dialog: QualificationDialog, workshop: boolean): Words | null {
  if (dialog.kind === 'ask') {
    if (workshop ? dialog.workCentreKinds.length === 0 : dialog.materialKinds.length === 0) return w(workshop ? 'qual.problem.work' : 'qual.problem.materials')
    if (dialog.validFrom && dialog.validUntil && dialog.validUntil < dialog.validFrom) return w('qual.problem.days')
    return null
  }
  if (dialog.kind === 'decide') {
    if (dialog.decision === 'CONDITIONAL' && dialog.conditions.trim() === '') return w('qual.problem.conditions')
    if (dialog.decision === 'REFUSED' && dialog.refuseReason.trim() === '') return w('qual.problem.refuse')
    if (dialog.decision !== 'REFUSED' && dialog.validFrom && dialog.validUntil && dialog.validUntil < dialog.validFrom) return w('qual.problem.days')
    return null
  }
  return dialog.reason.trim() === '' ? w('qual.problem.reason') : null
}

/** Why a qualification's move is held, or null (the API's `may` says whether; the words are ours). */
export function moveHeld(can: DepthCan, qualification: Qualification, move: 'decide' | 'suspend' | 'lift' | 'withdraw'): Words | null {
  if (!can.qualify) return w('held.qualify')
  return qualification.may[move] ? null : w(`qual.heldMove.${move}`)
}

// ---- bank details (SCM-007) ----------------------------------------------------------------------------------------------

export const PILL_TONE: Readonly<Record<BankPill, Tone>> = { WAITING_CALL_BACK: 'warning', WAITING_SECOND_CHECK: 'warning', VERIFIED: 'info', USABLE: 'success', REFUSED: 'danger', RETIRED: 'neutral' }

/** The accounts newest first (the timeline of changes). */
export const newestFirst = (accounts: readonly BankAccount[]) => [...accounts].sort((a, b) => (a.proposedAt === b.proposedAt ? (a.id < b.id ? 1 : -1) : a.proposedAt < b.proposedAt ? 1 : -1))

/** The account a change waits on (proposed or checked, not yet in use), per currency. */
export const openChanges = (accounts: readonly BankAccount[]) => accounts.filter((account) => account.status === 'PROPOSED' || account.status === 'VERIFIED')

const isMine = (account: BankAccount, me: string) => account.proposedBy?.id === me

/** Why the call-back is held for this person, or null. */
export function callBackHeld(can: DepthCan, account: BankAccount, me: string): Words | null {
  if (!can.bankCallBack) return w('held.bankCallBack')
  if (account.status !== 'PROPOSED') return w('bank.held.notWaiting')
  if (account.callBack) return w('bank.held.calledBack')
  if (isMine(account, me)) return w('bank.held.ownCallBack')
  if (account.may.callBack) return null
  if ((account.callBackCandidates?.usable.length ?? 0) === 0) return w('bank.held.noNumber')
  return w('bank.held.notYou')
}

/** Why the second check is held for this person, or null. */
export function verifyHeld(can: DepthCan, account: BankAccount, me: string): Words | null {
  if (!can.bankVerify) return w('held.bankVerify')
  if (account.status !== 'PROPOSED' && account.status !== 'VERIFIED') return w('bank.held.notWaiting')
  if (!account.callBack) return w('bank.held.callBackFirst')
  if (account.approval && account.approval.status === 'PENDING') return w('bank.held.waitingYes')
  if (isMine(account, me)) return w('bank.held.ownCheck')
  return account.may.verify ? null : w('bank.held.notYou')
}

export interface ProposalDraft {
  readonly iban: string
  readonly holder: string
  readonly bankName: string
  readonly bic: string
  readonly currency: string
}
export const EMPTY_PROPOSAL: ProposalDraft = { iban: '', holder: '', bankName: '', bic: '', currency: 'EUR' }

/** What is wrong with a typed IBAN (as typed: spaces allowed), in our words; null when it is right. */
export function ibanWords(typed: string): Words | null {
  const iban = normaliseIban(typed)
  if (iban === '') return w('bank.problem.ibanEmpty')
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return w('bank.problem.ibanShape')
  const length = IBAN_LENGTHS[iban.slice(0, 2)]
  if (length !== undefined && iban.length !== length) return w('bank.problem.ibanLength', { country: iban.slice(0, 2), length, typed: iban.length })
  if (ibanRemainder(iban) !== 1) return w('bank.problem.ibanDigits')
  return null
}

export function proposalProblems(draft: ProposalDraft): Record<string, Words> {
  const problems: Record<string, Words> = {}
  const iban = ibanWords(draft.iban)
  if (iban) problems.iban = iban
  if (draft.holder.trim() === '') problems.holder = w('bank.problem.holder')
  if (draft.bic.trim() !== '' && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(draft.bic.trim().toUpperCase())) problems.bic = w('bank.problem.bic')
  if (!/^[A-Z]{3}$/.test(draft.currency.trim().toUpperCase())) problems.currency = w('bank.problem.currency')
  return problems
}

/** The masked form of a typed IBAN for the review (old → new, masked both sides). */
export function maskedTyped(typed: string): string {
  const iban = normaliseIban(typed)
  return iban.length < 8 ? '—' : `${iban.slice(0, 2)}** **** **** ${iban.slice(-4)}`
}

export const proposalBody = (draft: ProposalDraft) => ({
  iban: draft.iban,
  holder: draft.holder.trim(),
  bankName: draft.bankName.trim() || null,
  bic: draft.bic.trim().toUpperCase() || null,
  currency: draft.currency.trim().toUpperCase(),
})

/** The call-back's number as dialled: its digits must be the record's (the API checks it again). */
export const phoneMatches = (typed: string, onFile: string | null) => typed.replace(/[^0-9]/g, '') !== '' && typed.replace(/[^0-9]/g, '') === (onFile ?? '').replace(/[^0-9]/g, '')

// ---- the list: documents and Request documents ---------------------------------------------------------------------------

/** The Documents column's words (valid / expiring / expired / missing), or null when the supplier has none asked or held. */
export function documentsCell(row: SupplierDocuments | undefined): { tone: Tone; words: Words } | null {
  if (!row) return null
  if (row.valid + row.expiring + row.expired + row.missing === 0) return null
  const tone: Tone = row.expired > 0 || row.missing > 0 ? 'danger' : row.expiring > 0 ? 'warning' : 'success'
  return { tone, words: w('list.documents.cell', { valid: row.valid, expiring: row.expiring, expired: row.expired, missing: row.missing }) }
}

export const ASK_MAX = 50

/** Why "Request documents N" is held, or null. */
export function requestHeld(can: DepthCan, count: number): Words | null {
  if (!can.ask) return w('held.ask')
  if (count === 0) return w('request.held.none')
  if (count > ASK_MAX) return w('request.held.max', { max: ASK_MAX })
  return null
}

/** A due day as the API's instant (the end of that day, UTC): in the future and at most 180 days away. */
export function dueProblem(due: string, today: string): Words | null {
  if (due === '') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return w('review.problem.date')
  const left = daysFrom(today, due)
  if (left < 1) return w('request.problem.future')
  if (left > 180) return w('request.problem.far')
  return null
}
export const dueInstant = (due: string): string | null => (due === '' ? null : `${due}T17:00:00.000Z`)
