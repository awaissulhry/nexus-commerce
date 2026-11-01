import { CALL_KINDS, CALL_LIMITS, type CallKind } from '@nexus/factory-domain/production/calls/rules'
import { MAX_STUCK_BUNDLE_HOURS, MIN_STUCK_BUNDLE_HOURS } from '@nexus/factory-domain/production/bundles/where'
import { OFF_STANDARD_LIMITS, type OffStandardKind, type PayRule } from '@nexus/factory-domain/production/offstandard/rules'
import { MAX_SCRAP_APPROVAL_LIMIT, type BundleCodeMode, type FloorRuleMode } from '@nexus/factory-domain/production/settings/floor-rules'
import { REASON_CODE } from '@nexus/factory-domain/production/scans/reasons'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { BundleRules, FloorRules, FloorRulesBody, FullLists, HelpCode, OffCode, OffCodeEdit, Route, RouteEdit } from './w2b-api'

/**
 * The W2b sections of Floor rules & codes (B-W2b-58; design production.settings fr-rules, fr-bundle, fr-offstd, fr-calls,
 * fr-reasons), pure: each form's draft, what Apply sends and why it is held; a grid cell typed → the one field it changes
 * (or why it is refused before anything is sent); the API's refusals in this page's words (keys of `floor-rules`, prefix
 * `fr.`). Pay rules are rules (no money); routing names teams, never who is in them.
 */

export const LIMITS = Object.freeze({ scrap: MAX_SCRAP_APPROVAL_LIMIT, stuckMin: MIN_STUCK_BUNDLE_HOURS, stuckMax: MAX_STUCK_BUNDLE_HOURS, escalate: CALL_LIMITS.escalateMinutes, label: OFF_STANDARD_LIMITS.label, reason: 2000 })

// ---- Floor rules per site ---------------------------------------------------------------------------------------------------

export interface ChecksDraft {
  skippedOperationRule: FloorRuleMode
  quantityGuard: FloorRuleMode
  /** Scrap above the limit waits for the team leader (MES-128). */
  limitOn: boolean
  limit: number | ''
  reason: string
}

export const checksDraftOf = (rules: Pick<FloorRules, 'checks'>): ChecksDraft => ({
  skippedOperationRule: rules.checks.skippedOperationRule,
  quantityGuard: rules.checks.quantityGuard,
  limitOn: rules.checks.scrapApprovalLimit !== null,
  limit: rules.checks.scrapApprovalLimit ?? 10,
  reason: '',
})

/** What Apply sends (only what changed) and how many changes the bar counts. */
export function checksChange(rules: Pick<FloorRules, 'checks' | 'version'>, draft: ChecksDraft): { body: FloorRulesBody; count: number } {
  const body: FloorRulesBody = {}
  if (draft.skippedOperationRule !== rules.checks.skippedOperationRule) body.skippedOperationRule = draft.skippedOperationRule
  if (draft.quantityGuard !== rules.checks.quantityGuard) body.quantityGuard = draft.quantityGuard
  const limit = draft.limitOn ? (draft.limit === '' ? null : draft.limit) : null
  if (limit !== rules.checks.scrapApprovalLimit || (draft.limitOn && draft.limit === '')) body.scrapApprovalLimit = limit
  const count = Object.keys(body).length
  if (count > 0 && draft.reason.trim()) body.reason = draft.reason.trim()
  if (count > 0 && rules.version !== null) body.version = rules.version
  return { body, count }
}

/** Why Apply is held (a key of `floor-rules`), or null. */
export function checksHeld(draft: ChecksDraft, busy: boolean): string | null {
  if (draft.limitOn && (draft.limit === '' || !Number.isInteger(draft.limit) || draft.limit < 1 || draft.limit > LIMITS.scrap)) return 'fr.checks.limitRange'
  if (draft.reason.trim().length > LIMITS.reason) return 'fr.checks.reasonLong'
  return busy ? 'fr.busy' : null
}

// ---- Bundle codes -----------------------------------------------------------------------------------------------------------

export interface CouponsDraft {
  mode: BundleCodeMode
  stuckHours: number | ''
}

export const couponsDraftOf = (rules: Pick<BundleRules, 'bundleCodeMode' | 'stuckBundleHours'>): CouponsDraft => ({ mode: rules.bundleCodeMode, stuckHours: rules.stuckBundleHours })

export function couponsChange(rules: Pick<BundleRules, 'bundleCodeMode' | 'stuckBundleHours' | 'version'>, draft: CouponsDraft): { body: { bundleCodeMode?: BundleCodeMode; stuckBundleHours?: number; version?: number }; count: number } {
  const body: { bundleCodeMode?: BundleCodeMode; stuckBundleHours?: number; version?: number } = {}
  if (draft.mode !== rules.bundleCodeMode) body.bundleCodeMode = draft.mode
  if (draft.stuckHours !== '' && draft.stuckHours !== rules.stuckBundleHours) body.stuckBundleHours = draft.stuckHours
  const count = Object.keys(body).length + (draft.stuckHours === '' ? 1 : 0)
  if (count > 0 && rules.version !== null) body.version = rules.version
  return { body, count }
}

export function couponsHeld(draft: CouponsDraft, busy: boolean): string | null {
  if (draft.stuckHours === '' || !Number.isInteger(draft.stuckHours) || draft.stuckHours < LIMITS.stuckMin || draft.stuckHours > LIMITS.stuckMax) return 'fr.coupons.stuckRange'
  return busy ? 'fr.busy' : null
}

// ---- The full reason lists --------------------------------------------------------------------------------------------------

/** How many codes of the full floor lists are missing, and per list. */
export function fullMissing(lists: FullLists | null): { total: number; lists: Array<{ list: string; count: number }> } {
  const entries = (lists?.lists ?? []).filter((entry) => entry.fullMissing.length > 0).map((entry) => ({ list: entry.list, count: entry.fullMissing.length }))
  return { total: entries.reduce((sum, entry) => sum + entry.count, 0), lists: entries }
}

// ---- grids: one cell saved at a time ------------------------------------------------------------------------------------------

export type MarkState = 'saving' | 'saved' | 'refused' | 'unknown'
export interface Mark {
  state: MarkState
  /** Why it was refused or is not known, a key of `floor-rules`. */
  problem?: string
}
export const markKey = (id: string, field: string): string => `${id}:${field}`

/** A word cell of an off-standard code typed → its edit, or why it is refused before anything is sent. */
export function offWordEdit(row: OffCode, field: 'labelIt' | 'labelEn' | `lang:${string}`, typed: unknown): { edit: OffCodeEdit } | { problem: string } | null {
  const text = typeof typed === 'string' ? typed.trim() : ''
  if (field.startsWith('lang:')) {
    const language = field.slice(5)
    const before = row.labelI18n[language] ?? ''
    if (text === before) return null
    if (text.length > LIMITS.label) return { problem: 'fr.cells.tooLong' }
    return { edit: { labelI18n: { [language]: text === '' ? null : text } } }
  }
  const key = field as 'labelIt' | 'labelEn'
  if (text === row[key]) return null
  if (text === '') return { problem: key === 'labelIt' ? 'fr.cells.needIt' : 'fr.cells.needEn' }
  if (text.length > LIMITS.label) return { problem: 'fr.cells.tooLong' }
  return { edit: { [key]: text } }
}

/** A row with an edit put in (shown at once, before the answer). */
export function offWithEdit(row: OffCode, edit: OffCodeEdit): OffCode {
  const labelI18n = { ...row.labelI18n }
  for (const [language, words] of Object.entries(edit.labelI18n ?? {})) {
    if (words === null) delete labelI18n[language]
    else labelI18n[language] = words
  }
  return { ...row, ...('labelIt' in edit && edit.labelIt !== undefined ? { labelIt: edit.labelIt } : {}), ...('labelEn' in edit && edit.labelEn !== undefined ? { labelEn: edit.labelEn } : {}), labelI18n, ...(edit.payRule ? { payRule: edit.payRule } : {}), ...(edit.needsApproval !== undefined ? { needsApproval: edit.needsApproval } : {}), ...(edit.active !== undefined ? { active: edit.active } : {}) }
}

/** The routing's escalation cell typed: blank = never; else 1–240 whole minutes. */
export function escalationEdit(row: Route, typed: unknown): { edit: RouteEdit } | { problem: string } | null {
  const text = typeof typed === 'number' ? String(typed) : typeof typed === 'string' ? typed.trim() : ''
  const value = text === '' ? null : Number(text)
  if (value === row.escalateAfterMinutes) return null
  if (value !== null && (!Number.isInteger(value) || value < LIMITS.escalate.min || value > LIMITS.escalate.max)) return { problem: 'fr.route.escalateRange' }
  return { edit: { escalateAfterMinutes: value } }
}

/** A route with an edit put in (the team and waiting code follow the lists the page read). */
export function routeWithEdit(row: Route, edit: RouteEdit, teams: readonly { id: string; code: string; name: string }[], codes: readonly OffCode[]): Route {
  let next: Route = { ...row }
  if (edit.escalateAfterMinutes !== undefined) next = { ...next, escalateAfterMinutes: edit.escalateAfterMinutes }
  if (edit.active !== undefined) next = { ...next, active: edit.active }
  if (edit.responderTeamId !== undefined) {
    const team = teams.find((entry) => entry.id === edit.responderTeamId)
    next = { ...next, responder: team ? { kind: 'TEAM', team: { id: team.id, code: team.code, name: team.name, active: true }, members: row.responder.members } : { kind: 'TEAM_LEADERS', team: null, members: row.responder.members } }
  }
  if (edit.offStandardCodeId !== undefined) {
    const code = codes.find((entry) => entry.id === edit.offStandardCodeId)
    next = { ...next, waitingCode: code ? { id: code.id, code: code.code, labelIt: code.labelIt, labelEn: code.labelEn, active: code.active } : null }
  }
  return next
}

/** A refused cell or form write in words: the rule's refusal (`refusal/<CODE>`), a version moved, no right, offline. */
export function w2bProblem(error: unknown): { key: string; unknown: boolean; conflict?: boolean } {
  if (!isApiError(error)) return { key: 'fr.problem.write', unknown: true }
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) {
      const code = path.slice('refusal/'.length)
      return { key: REFUSALS.has(code) ? `fr.refusal.${code}` : 'fr.problem.invalid', unknown: false }
    }
  }
  if (error.kind === 'conflict') return { key: 'fr.problem.changed', unknown: false, conflict: true }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'fr.problem.forbidden', unknown: false }
  if (error.kind === 'not_found') return { key: 'fr.problem.gone', unknown: false }
  if (error.kind === 'invalid') return { key: 'fr.problem.invalid', unknown: false }
  if (error.kind === 'unavailable') return { key: 'fr.problem.offline', unknown: true }
  return { key: 'fr.problem.write', unknown: true }
}

const REFUSALS = new Set(['KIND_FIXED', 'BOOKED_BY_CALLS', 'CODE_TAKEN', 'CODE_NOT_LISTED', 'TEAM_NOT_ACTIVE', 'WAITING_CODE'])

// ---- new rows -----------------------------------------------------------------------------------------------------------------

export interface OffDraft {
  code: string
  kind: OffStandardKind
  payRule: PayRule
  needsApproval: boolean
  labelIt: string
  labelEn: string
}

export const EMPTY_OFF_DRAFT: OffDraft = Object.freeze({ code: '', kind: 'OFF_STANDARD', payRule: 'AVERAGE', needsApproval: true, labelIt: '', labelEn: '' }) as OffDraft

/** A typed code as the API keeps it (upper case, words joined by underscores). */
export const typedCode = (text: string): string => text.toUpperCase().replace(/[\s-]+/g, '_').slice(0, 40)

export function offDraftHeld(draft: OffDraft, taken: readonly string[], busy: boolean): string | null {
  if (!REASON_CODE.test(draft.code)) return 'fr.off.new.codeShape'
  if (taken.includes(draft.code)) return 'fr.off.new.codeTaken'
  if (!draft.labelIt.trim()) return 'fr.cells.needIt'
  if (!draft.labelEn.trim()) return 'fr.cells.needEn'
  if (draft.labelIt.trim().length > LIMITS.label || draft.labelEn.trim().length > LIMITS.label) return 'fr.cells.tooLong'
  return busy ? 'fr.busy' : null
}

export interface RouteDraft {
  /** A code of the help-call reason list not yet a type of the site. */
  code: string
  kind: CallKind
  teamId: string
  escalate: number | ''
}

export const EMPTY_ROUTE_DRAFT: RouteDraft = Object.freeze({ code: '', kind: 'OTHER', teamId: '', escalate: '' }) as RouteDraft

/** The help-call codes a new type may take: active codes of the list not yet a type of the site. */
export const freeHelpCodes = (codes: readonly HelpCode[], routes: readonly Route[]): HelpCode[] => codes.filter((code) => !routes.some((route) => route.code === code.code))

export function routeDraftHeld(draft: RouteDraft, free: readonly HelpCode[], busy: boolean): string | null {
  if (!draft.code || !free.some((code) => code.code === draft.code)) return 'fr.route.new.pickCode'
  if (!(CALL_KINDS as readonly string[]).includes(draft.kind)) return 'fr.route.new.pickKind'
  if (draft.escalate !== '' && (!Number.isInteger(draft.escalate) || draft.escalate < LIMITS.escalate.min || draft.escalate > LIMITS.escalate.max)) return 'fr.route.escalateRange'
  return busy ? 'fr.busy' : null
}

/** A sensible kind for a help-call code (MACHINE_STOP → MACHINE); the person may change it before Add. */
export function kindOfCode(code: string): CallKind {
  const upper = code.toUpperCase()
  if (upper.includes('MACHINE') || upper.includes('NEEDLE')) return 'MACHINE'
  if (upper.includes('MATERIAL') || upper.includes('THREAD') || upper.includes('RECUT')) return 'MATERIAL'
  if (upper.includes('QUALITY')) return 'QUALITY'
  if (upper.includes('LEADER') || upper.includes('SUPERVISOR')) return 'SUPERVISOR'
  if (upper.includes('MAINT')) return 'MAINTENANCE'
  return 'OTHER'
}
