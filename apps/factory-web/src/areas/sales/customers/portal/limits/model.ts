import { PRODUCTION_ASK_KINDS, URGENT_ASK_KIND, type ProductionAskKind } from '@nexus/factory-domain/production-brand/kinds'
import { maskOf, PRODUCTION_SHARE_LEVELS, SHARE_SECTIONS, type ProductionShareLevel, type ShareSection } from '@nexus/factory-domain/production-brand/levels'
import { URGENT_MAX } from '@nexus/factory-domain/production-brand/urgency'
import { dormantMarksWords, overQuotaWords } from '@nexus/factory-domain/production-brand/words'
import { FREEZE_LIMITS, looseningProblem, ORDER_FREEZE_ACTIONS, ORDER_FREEZE_STAGES, stageRank, type OrderFreezeAction, type OrderFreezeField, type OrderFreezeStage } from '@nexus/factory-domain/sales/order-changes/freeze'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { PartnerPerson, ProductionLimits, ProductionLimitsBody, ProductionLimitsView } from '../../../../admin/users/partners/api'
import { partnerProblem } from '../../../../admin/users/partners/model'
import { skipKeyOf, type Person } from '../../../../_shared/production-supervisor/model'
import type { FreezeList, FreezeRule, FreezeRuleDraftBody } from './api'

/**
 * F-PR-07 — the per-customer limits card on Customer › Portal access (production plan §3 "Who may do what", "Plain rules", §4
 * sharing levels, §7.1 "everything starts OFF", §7.7 the urgent quota; lead picks L18, L21; review fixes R-46, R-50, R-53; 06-tree
 * §C S-LIM-*; 09-design (g); 17-web-r2 §1.7), pure. ONE card per customer, nothing else holds these limits:
 *   sees        the share level (Status only by default · + Progress · + Gates & dates · + Quality & photos)
 *   may do      Urgent orders on/off with "At most n urgent at once" (0–20, default 3) and the rule in words; switched off, the
 *               marks are kept but count for nothing (the words say how many, R-46); the production asks (pause, resume, ship
 *               what is ready, another sample round) — "Urgent – asked" follows the urgency switch (R-50); change and cancel
 *               follow the company's cut-offs
 *   approver    anyone with the Production role, or ONE named active portal person of theirs for the production approvals
 *               (PP, size set, top of production, fabric, trims)
 *   overrides   whether deciding for them or undoing what they did needs a second person of ours
 *   freeze      the company's freeze points beside the customer's own (its own replace the company's for that field)
 *   looks after the production supervisor and backup — OFFICE ONLY (never in their portal or the preview; shown while the portal is
 *               off: a supervisor needs no portal), saved through their own route with production.brand.manage, else held in words;
 *               a new supervisor says before Apply how many orders without their own supervisor move
 * The preset "Production partner" fills Progress, urgency on (quota 3) and every production ask in one click; Apply saves with a
 * fresh code when the API asks (partners.production.manage). Words: catalogue `portal-access` (`limits.*`), the supervisor's
 * own words from `production-supervisor`.
 */

export { PRODUCTION_ASK_KINDS, URGENT_MAX, ORDER_FREEZE_ACTIONS, ORDER_FREEZE_STAGES }
export type { ProductionAskKind, ProductionShareLevel, OrderFreezeAction, OrderFreezeField, OrderFreezeStage }

/** The card's anchor (the Customer card's and the Overview's "Limits" link opens `?tab=portal#production-limits`). */
export const LIMITS_ANCHOR = 'production-limits'

// ---- the draft --------------------------------------------------------------------------------------------------------------

export type ApproverMode = 'ANYONE' | 'NAMED'

export interface LimitsDraft {
  readonly level: ProductionShareLevel
  readonly urgencyOn: boolean
  readonly urgentMax: number
  readonly askKinds: readonly ProductionAskKind[]
  readonly approverMode: ApproverMode
  /** The named approver (NAMED; null: not picked yet). */
  readonly approverId: string | null
  readonly fourEyes: boolean
  /** The customer's default supervisor (null: none) and backup (only beside a supervisor). */
  readonly supervisorId: string | null
  readonly backupId: string | null
  /** The preset was pressed (sent while the draft still holds what it set). */
  readonly preset: boolean
}

export function limitsDraftOf(saved: ProductionLimitsView): LimitsDraft {
  return {
    level: saved.level,
    urgencyOn: saved.urgency.on,
    urgentMax: saved.urgency.max,
    askKinds: inCardOrder(saved.askKinds),
    approverMode: saved.approver ? 'NAMED' : 'ANYONE',
    approverId: saved.approver?.id ?? null,
    fourEyes: saved.overrideFourEyes,
    supervisorId: saved.supervisor?.id ?? null,
    backupId: saved.backup?.id ?? null,
    preset: false,
  }
}

/** The asks in the card's order, each once. */
export const inCardOrder = (kinds: readonly string[]): ProductionAskKind[] => PRODUCTION_ASK_KINDS.filter((kind) => kinds.includes(kind))

/** What the preset "Production partner" sets (the API's PRODUCTION_PARTNER: Progress, urgency on with 3, every ask). */
export const PRODUCTION_PARTNER = Object.freeze({ level: 'PROGRESS' as ProductionShareLevel, urgencyOn: true, urgentMax: URGENT_MAX.byDefault, askKinds: [...PRODUCTION_ASK_KINDS] as readonly ProductionAskKind[] })

/** The preset pressed: the four limits it sets; the approver, the second person and the supervisor stay as they are. */
export function withPreset(draft: LimitsDraft): LimitsDraft {
  return { ...draft, level: PRODUCTION_PARTNER.level, urgencyOn: PRODUCTION_PARTNER.urgencyOn, urgentMax: PRODUCTION_PARTNER.urgentMax, askKinds: [...PRODUCTION_PARTNER.askKinds], preset: true }
}

const sameKinds = (a: readonly string[], b: readonly string[]) => inCardOrder(a).join() === inCardOrder(b).join()

/** The draft still holds the preset's four limits (else the preset is not named in the change). */
export const presetHolds = (draft: LimitsDraft): boolean =>
  draft.preset && draft.level === PRODUCTION_PARTNER.level && draft.urgencyOn === PRODUCTION_PARTNER.urgencyOn && draft.urgentMax === PRODUCTION_PARTNER.urgentMax && sameKinds(draft.askKinds, PRODUCTION_PARTNER.askKinds)

/** The draft's own changes (the supervisor slots go to their own route). */
export const approverOf = (draft: LimitsDraft): string | null => (draft.approverMode === 'NAMED' ? draft.approverId : null)

/** Only what changes on the limits route, with the version read; null: nothing changes there. */
export function limitsBody(saved: ProductionLimitsView, draft: LimitsDraft): ProductionLimitsBody | null {
  const body: ProductionLimitsBody = { version: saved.version }
  if (draft.level !== saved.level) body.productionLevel = draft.level
  if (draft.urgencyOn !== saved.urgency.on) body.productionUrgencyOn = draft.urgencyOn
  if (draft.urgentMax !== saved.urgency.max) body.productionUrgentMax = draft.urgentMax
  if (!sameKinds(draft.askKinds, saved.askKinds)) body.productionAskKinds = inCardOrder(draft.askKinds)
  const approver = approverOf(draft)
  if (approver !== (saved.approver?.id ?? null) && !(draft.approverMode === 'NAMED' && draft.approverId === null)) body.productionApproverId = approver
  if (draft.fourEyes !== saved.overrideFourEyes) body.overrideFourEyes = draft.fourEyes
  if (Object.keys(body).length === 1) return null
  return presetHolds(draft) ? { preset: 'PRODUCTION_PARTNER', ...body } : body
}

/** The supervisor's own route: both slots with the version read; null: neither changes. */
export function supervisorBody(saved: ProductionLimitsView, draft: LimitsDraft): { supervisorId: string | null; backupId: string | null; version: number } | null {
  const backupId = draft.supervisorId === null ? null : draft.backupId
  if (draft.supervisorId === (saved.supervisor?.id ?? null) && backupId === (saved.backup?.id ?? null)) return null
  return { supervisorId: draft.supervisorId, backupId, version: saved.version }
}

/** How many things the Apply bar counts (each limit, the approver, the second person, the supervisor, the backup). */
export function changeCount(saved: ProductionLimitsView, draft: LimitsDraft): number {
  const limits = limitsBody(saved, draft)
  const supervisor = supervisorBody(saved, draft)
  const own = limits ? Object.keys(limits).filter((key) => key !== 'version' && key !== 'preset').length : 0
  const slots = supervisor ? Number(supervisor.supervisorId !== (saved.supervisor?.id ?? null)) + Number(supervisor.backupId !== (saved.backup?.id ?? null)) : 0
  // "One named person" chosen with nobody picked yet: counted, so the bar shows and holds Apply with the field's words.
  const unpicked = draft.approverMode === 'NAMED' && draft.approverId === null ? 1 : 0
  return own + slots + unpicked
}

/** Field → words key (portal-access): the quota's range, a named approver not picked, a backup without a supervisor or the same one. */
export function limitsProblems(draft: LimitsDraft): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Number.isInteger(draft.urgentMax) || draft.urgentMax < URGENT_MAX.min || draft.urgentMax > URGENT_MAX.max) out.urgentMax = 'limits.urgency.maxRange'
  if (draft.approverMode === 'NAMED' && draft.approverId === null) out.approver = 'limits.approver.pick'
  if (draft.backupId !== null && draft.supervisorId === null) out.backup = 'limits.supervisor.backupAlone'
  else if (draft.backupId !== null && draft.backupId === draft.supervisorId) out.backup = 'limits.supervisor.backupSame'
  return out
}

// ---- what the card says -----------------------------------------------------------------------------------------------------

type Words = { readonly it: string; readonly en: string }

/**
 * The urgency's words under the switch: switched off with marks kept ("3 urgent marks are kept but not used while this is off"),
 * or a quota lowered under today's marks ("they stay urgent; new marks only below the quota") — from the draft, before Apply.
 */
export function urgencyNote(saved: ProductionLimitsView, draft: LimitsDraft): Words | null {
  const now = saved.urgency.now
  if (!draft.urgencyOn) return dormantMarksWords(now)
  return overQuotaWords(now, draft.urgentMax)
}

/** What a level adds to what every level shows: one mark per section (pieces, gates & dates, quality & photos). */
export function seesNow(level: ProductionShareLevel): ReadonlyArray<{ readonly section: ShareSection; readonly shared: boolean }> {
  const mask = maskOf(level)
  return SHARE_SECTIONS.map((section) => ({ section, shared: mask[section] }))
}

/** "Urgent – asked" is open exactly while the urgency switch is on (R-50); the others while ticked. */
export const openAsksOf = (draft: LimitsDraft): readonly string[] => [...(draft.urgencyOn ? [URGENT_ASK_KIND] : []), ...inCardOrder(draft.askKinds)]

/** The customer's portal people who may be its named approver: active ones of its customer portal, by name. */
export function approverChoices(people: readonly PartnerPerson[], saved: ProductionLimitsView): Array<{ value: string; label: string; active: boolean }> {
  const active = people.filter((person) => person.status === 'ACTIVE' && person.kind === 'CUSTOMER').sort((a, b) => a.displayName.localeCompare(b.displayName))
  const out = active.map((person) => ({ value: person.id, label: person.roleName ? `${person.displayName} · ${person.roleName}` : person.displayName, active: true }))
  // The approver saved but no longer active stays shown (it counts as nobody named until changed).
  if (saved.approver && !out.some((entry) => entry.value === saved.approver!.id)) out.push({ value: saved.approver.id, label: saved.approver.name, active: false })
  return out
}

// ---- the supervisor ---------------------------------------------------------------------------------------------------------

/** Who may supervise this customer: held (no right, or not over every company), reading, read, or failed. */
export type PickState =
  | { readonly status: 'held'; readonly key: string; readonly ns: 'portal-access' | 'production-supervisor' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly people: readonly Person[]; readonly complete: boolean; readonly ordersOnDefault: number }
  | { readonly status: 'error'; readonly key: string }

/** The pick list's refusal: 404 means the reader does not manage this customer's production at EVERY company it works with. */
export function pickProblemOf(error: unknown): PickState {
  if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden')) return { status: 'held', key: 'limits.supervisor.heldEveryCompany', ns: 'portal-access' }
  return { status: 'error', key: 'limits.supervisor.readFailed' }
}

/** The people a slot offers: the pick list (the reader first), plus the one saved there if the list no longer holds them. */
export function slotChoices(pick: PickState, saved: { readonly id: string; readonly name: string; readonly active: boolean } | null, exclude: string | null): Array<{ value: string; label: string; listed: boolean }> {
  const people = pick.status === 'ready' ? pick.people : []
  const out = people.filter((person) => person.id !== exclude).map((person) => ({ value: person.id, label: person.name, listed: true }))
  if (saved && saved.id !== exclude && !out.some((entry) => entry.value === saved.id)) out.push({ value: saved.id, label: saved.name, listed: false })
  return out
}

/** Before Apply: a new default supervisor moves the customer's open orders that have no supervisor of their own. */
export function supervisorMove(saved: ProductionLimitsView, draft: LimitsDraft, pick: PickState): { readonly key: string; readonly count: number } | null {
  if (draft.supervisorId === (saved.supervisor?.id ?? null)) return null
  if (pick.status !== 'ready') return null
  const count = pick.ordersOnDefault
  if (count === 0) return { key: 'limits.supervisor.movesNone', count }
  return { key: draft.supervisorId === null ? 'limits.supervisor.clears' : 'limits.supervisor.moves', count }
}

/** A refused supervisor change, in words: the person's refusal from its code (the supervisor's words), the backup's shape, the rest. */
export function supervisorProblemOf(error: unknown): { readonly key: string; readonly ns: 'portal-access' | 'production-supervisor' } {
  if (!isApiError(error)) return { key: 'problem.internal', ns: 'portal-access' }
  if (error.kind === 'invalid') {
    for (const issue of error.issues) {
      const message = issue.message ?? ''
      if (message === BACKUP_SENTENCES.alone) return { key: 'limits.supervisor.backupAlone', ns: 'portal-access' }
      if (message === BACKUP_SENTENCES.same) return { key: 'limits.supervisor.backupSame', ns: 'portal-access' }
      const key = skipKeyOf(message)
      if (key !== 'skip.other') return { key, ns: 'production-supervisor' }
    }
    return { key: 'problem.invalid', ns: 'portal-access' }
  }
  if (error.kind === 'forbidden' && error.message === EVERY_COMPANY_SENTENCE) return { key: 'limits.supervisor.heldEveryCompany', ns: 'portal-access' }
  return { key: partnerProblem(error), ns: 'portal-access' }
}

/** The API's own sentences (factory-domain production-brand/supervisor backupProblems; supervisor/assign.ts): a test finds each. */
export const BACKUP_SENTENCES = Object.freeze({ alone: 'A backup is named only beside a supervisor.', same: 'The backup is another person than the supervisor.' })
export const EVERY_COMPANY_SENTENCE = "Your role does not set this customer's production supervisor at every company it works with."

// ---- the limits route's refusals --------------------------------------------------------------------------------------------

/** The API's own sentences of the limits route (platform/auth/partners office.ts): a test finds each. */
export const LIMITS_SENTENCES = Object.freeze({ onlyCustomers: 'Production limits are set only for a customer or a brand.', approver: "The approver is an active person of this customer's portal." })

/** A refused Apply of the limits, as a key of `portal-access`. */
export function limitsProblemOf(error: unknown): string {
  if (isApiError(error)) {
    if (error.message === LIMITS_SENTENCES.onlyCustomers) return 'limits.problem.onlyCustomers'
    if (error.message === LIMITS_SENTENCES.approver || error.issues.some((issue) => /productionApproverId/.test(issuePath(issue)))) return 'limits.problem.approver'
    if (error.kind === 'conflict' && error.message.startsWith('Nothing changes')) return 'limits.problem.nothing'
  }
  return partnerProblem(error)
}

// ---- one Apply: the limits, then the supervisor ------------------------------------------------------------------------------

export interface SaveCalls {
  /** PUT /partners/:id/production (through the step-up guard): the new version. */
  readonly limits: (body: ProductionLimitsBody) => Promise<ProductionLimits>
  /** PUT /production/brands/:id/supervisor: the new version. */
  readonly supervisor: (body: { supervisorId: string | null; backupId: string | null; version: number }) => Promise<{ version: number }>
}

export type SaveOutcome =
  | { readonly state: 'saved'; readonly limits: boolean; readonly supervisor: boolean }
  | { readonly state: 'failed'; readonly part: 'limits' | 'supervisor'; readonly limitsSaved: boolean; readonly error: unknown }

/**
 * One Apply over both routes, which share the portal settings' version: the limits first (a fresh code when asked), then the
 * supervisor with the version the limits' answer gave. A refused supervisor after saved limits says both (nothing is undone).
 */
export async function saveLimits(saved: ProductionLimitsView, draft: LimitsDraft, calls: SaveCalls, rights: { readonly manage: boolean; readonly supervise: boolean }): Promise<SaveOutcome> {
  const limits = rights.manage ? limitsBody(saved, draft) : null
  const supervisor = rights.supervise ? supervisorBody(saved, draft) : null
  let version = saved.version
  if (limits) {
    try {
      version = (await calls.limits(limits)).production.version
    } catch (error) {
      return { state: 'failed', part: 'limits', limitsSaved: false, error }
    }
  }
  if (supervisor) {
    try {
      await calls.supervisor({ ...supervisor, version })
    } catch (error) {
      return { state: 'failed', part: 'supervisor', limitsSaved: limits !== null, error }
    }
  }
  return { state: 'saved', limits: limits !== null, supervisor: supervisor !== null }
}

// ---- held -------------------------------------------------------------------------------------------------------------------

/** Why the limits are held: no partners.production.manage over this customer (the read's `mayManage`). */
export const limitsHeld = (read: Pick<ProductionLimits, 'mayManage'>): string | null => (read.mayManage ? null : 'right.productionManage')

/** Why the supervisor slots are held: no production.brand.manage, or the pick list refused (not over every company). */
export function supervisorHeld(supervise: boolean, pick: PickState): { readonly key: string; readonly ns: 'portal-access' | 'production-supervisor' } | null {
  if (!supervise) return { key: 'held.noRight', ns: 'production-supervisor' }
  if (pick.status === 'held') return { key: pick.key, ns: pick.ns }
  return null
}

/** "Open My production as …": the preview right; held while the card has unsaved changes (the preview shows what is saved). */
export function productionPreviewHeld(can: { readonly preview: boolean }, dirty: boolean): string | null {
  if (!can.preview) return 'right.preview'
  if (dirty) return 'limits.preview.saveFirst'
  return null
}

/** Where "Open My production as …" opens: the customer's portal, My production. */
export const productionPreviewAddress = (partyCode: string): string => `/p/${encodeURIComponent(partyCode)}/production`

// ---- the freeze points ------------------------------------------------------------------------------------------------------

export type FreezeState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly list: FreezeList } | { readonly status: 'error'; readonly key: string }

export interface FreezeRow {
  readonly field: OrderFreezeField
  readonly words: Words
  /** The company's active rules of the field, by stage. */
  readonly company: readonly FreezeRule[]
  /** The customer's own active rules of the field, by stage (they replace the company's for this customer). */
  readonly own: readonly FreezeRule[]
  readonly set: 'CUSTOMER' | 'COMPANY'
}

const byStage = (rules: readonly FreezeRule[]) => [...rules].sort((a, b) => stageRank(a.frozenFrom) - stageRank(b.frozenFrom))

/** One row per field: the company's rules beside the customer's own (another customer's never: the API sends none). */
export function freezeRows(list: FreezeList): FreezeRow[] {
  return list.fields.map((entry) => ({
    field: entry.field,
    words: entry.words,
    company: byStage(list.rules.filter((rule) => rule.partyId === null && rule.active && rule.field === entry.field)),
    own: byStage(list.rules.filter((rule) => rule.partyId !== null && rule.partyId === list.partyId && rule.active && rule.field === entry.field)),
    set: entry.set,
  }))
}

export interface FreezeDraft {
  readonly field: OrderFreezeField
  readonly frozenFrom: OrderFreezeStage
  readonly action: OrderFreezeAction
  readonly note: string
}

export const blankFreezeDraft = (field: OrderFreezeField): FreezeDraft => ({ field, frozenFrom: 'CUT', action: 'CHANGE_REQUEST', note: '' })

/** What a new rule of the customer's own would break, before Save: a twin at the stage, a looser rule after a block, the note. */
export function freezeDraftProblem(row: FreezeRow, draft: FreezeDraft): string | null {
  if (row.own.some((rule) => rule.frozenFrom === draft.frozenFrom)) return 'limits.freeze.problem.twin'
  const after = [...row.own.map((rule) => ({ field: rule.field, frozenFrom: rule.frozenFrom, action: rule.action, active: true })), { field: draft.field, frozenFrom: draft.frozenFrom, action: draft.action, active: true }]
  if (looseningProblem(after, draft.field)) return 'limits.freeze.problem.loosens'
  const note = draft.note.trim()
  if (note.length > FREEZE_LIMITS.note || /[\r\n]/.test(note)) return 'limits.freeze.problem.note'
  return null
}

export const freezeBody = (scope: { readonly companyId: string; readonly partyId: string }, draft: FreezeDraft): FreezeRuleDraftBody => ({
  companyId: scope.companyId,
  partyId: scope.partyId,
  field: draft.field,
  frozenFrom: draft.frozenFrom,
  action: draft.action,
  note: draft.note.trim() === '' ? null : draft.note.trim(),
})

/** A refused freeze write, as a key of `portal-access` (the API's English: a twin, a loosening, else the kind). */
export function freezeProblemOf(error: unknown): string {
  if (isApiError(error)) {
    if (/has an active rule for the .* already/.test(error.message)) return 'limits.freeze.problem.twin'
    if (/cannot be opened again|cannot open them again/.test(error.message)) return 'limits.freeze.problem.loosens'
    if (error.issues.some((issue) => /note/.test(issuePath(issue)))) return 'limits.freeze.problem.note'
  }
  return partnerProblem(error)
}

/** The freeze dialog: one field of the customer, its rules, a new rule's draft, busy and a refusal. */
export interface FreezeDialog {
  readonly field: OrderFreezeField
  readonly draft: FreezeDraft
  readonly busy: boolean
  readonly problem: string | null
}

// ---- the card's view model --------------------------------------------------------------------------------------------------

export interface LimitsModel {
  /** The card's read: reading, read, or refused (a key of portal-access; the rest of the tab stays usable). */
  readonly state: 'loading' | 'ready' | 'error'
  readonly read: ProductionLimits | null
  readonly problem: string | null
  /** production.brand.manage (the supervisor's slots; else held in words). */
  readonly supervise: boolean
  readonly pick: PickState
  readonly freeze: FreezeState
  readonly freezeDialog: FreezeDialog | null
  /** The company the freeze points are read at (the customer's own, else the one this page works in). */
  readonly companyName: string | null
  readonly busy: boolean
  /** A refused Apply (the limits or the supervisor), with whether the limits were saved before it. */
  readonly saveProblem: { readonly key: string; readonly ns: 'portal-access' | 'production-supervisor'; readonly limitsSaved: boolean } | null
  /** Design cases: the draft the card starts with. */
  readonly draft?: LimitsDraft
}

export interface LimitsActions {
  readonly onApply?: (draft: LimitsDraft) => Promise<boolean>
  readonly onRetry?: () => void
  readonly onRetryPick?: () => void
  readonly onRetryFreeze?: () => void
  readonly onPreviewProduction?: () => void
  readonly onFreezeDialog?: (field: OrderFreezeField | null) => void
  readonly onFreezeDraft?: (draft: FreezeDraft) => void
  readonly onFreezeAdd?: () => void
  readonly onFreezeReset?: (rules: readonly FreezeRule[]) => void
  readonly onDismissProblem?: () => void
}

/** The card is drawn for a customer (or a brand) only; never for a supplier, a workshop or an adviser. */
export const limitsApply = (side: 'customers' | 'suppliers', kinds: readonly string[]): boolean => side === 'customers' && kinds.includes('CUSTOMER')

/** The four share levels, in the card's order (each adds to the one before). */
export const LEVELS = PRODUCTION_SHARE_LEVELS
