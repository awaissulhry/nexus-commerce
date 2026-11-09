import { AREA_UOMS, type AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { SHADE_RULES, type ShadeRule } from '@nexus/factory-domain/inventory/reservations/shade'
import { CUTTING_REASON_MAX, cuttingRulesChangeProblems } from '@nexus/factory-domain/production/settings/cutting-rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { CuttingRules, CuttingRulesBody, LeatherTolerance } from './api'

/**
 * The Cutting card of Floor rules & codes (B-W2b-219), pure: the form's draft, what Apply sends and why it is held, the
 * leather area tolerance's draft, and the API's refusals in this card's words (keys of `production-cutting-rules`, prefix
 * `cr.`). The rules act from now on; what was reserved, issued, cut or tagged keeps what it was.
 */

export const CUTTING_NAMESPACES = ['production-cutting-rules', 'ds-words'] as const
export { AREA_UOMS, SHADE_RULES }

export interface CuttingDraft {
  shadeRule: ShadeRule
  hidePhotoRequired: boolean
  /** As typed (the decimal mark of the person's language turned into a dot when sent). */
  minimumArea: string
  minimumUom: AreaUom
  reason: string
}

/** The area as the form shows it (no trailing zeros: "10", "0.25"). */
export const areaText = (area: string): string => new Dec(area).toString()

export const cuttingDraftOf = (rules: Pick<CuttingRules, 'rules'>): CuttingDraft => ({
  shadeRule: rules.rules.shadeRule,
  hidePhotoRequired: rules.rules.hidePhotoRequired,
  minimumArea: areaText(rules.rules.minimumRemnant.area),
  minimumUom: rules.rules.minimumRemnant.uom,
  reason: '',
})

/** The typed area as the API takes it (a dot, no spaces), or null when it is not a number. */
export function areaOf(typed: string): string | null {
  const text = typed.trim().replace(',', '.')
  return /^\d{1,7}(\.\d{1,4})?$/.test(text) ? text : null
}

const sameMinimum = (rules: CuttingRules['rules'], area: string | null, uom: AreaUom): boolean => area !== null && uom === rules.minimumRemnant.uom && new Dec(area).eq(rules.minimumRemnant.area)

/** What Apply sends (only what changed) and how many changes the bar counts. */
export function cuttingChange(rules: Pick<CuttingRules, 'rules' | 'version'>, draft: CuttingDraft, version: number | null = rules.version): { body: CuttingRulesBody; count: number } {
  const body: CuttingRulesBody = {}
  if (draft.shadeRule !== rules.rules.shadeRule) body.shadeRule = draft.shadeRule
  if (draft.hidePhotoRequired !== rules.rules.hidePhotoRequired) body.hidePhotoRequired = draft.hidePhotoRequired
  const area = areaOf(draft.minimumArea)
  if (!sameMinimum(rules.rules, area, draft.minimumUom)) {
    body.minimumRemnantArea = area ?? draft.minimumArea.trim()
    body.minimumRemnantUom = draft.minimumUom
  }
  const count = (body.shadeRule ? 1 : 0) + (body.hidePhotoRequired !== undefined ? 1 : 0) + (body.minimumRemnantUom ? 1 : 0)
  if (count > 0 && draft.reason.trim()) body.reason = draft.reason.trim()
  if (count > 0 && version !== null) body.version = version
  return { body, count }
}

/** Why Apply is held (a key of `production-cutting-rules`), or null. */
export function cuttingHeld(draft: CuttingDraft, busy: boolean): string | null {
  const area = areaOf(draft.minimumArea)
  if (area === null || new Dec(area).lte(0)) return 'cr.held.area'
  if (cuttingRulesChangeProblems({ minimumRemnantArea: area, minimumRemnantUom: draft.minimumUom }).length > 0) return 'cr.held.tooLarge'
  if (draft.reason.trim().length > CUTTING_REASON_MAX) return 'cr.held.reasonLong'
  return busy ? 'cr.busy' : null
}

// ---- the leather area tolerance ---------------------------------------------------------------------------------------------

export interface ToleranceDraft {
  /** On: the company keeps its own percent; off: it follows every company's (else 2 %). */
  own: boolean
  percent: string
}

export const toleranceDraftOf = (tolerance: LeatherTolerance): ToleranceDraft => ({ own: tolerance.company?.percent != null, percent: tolerance.company?.percent != null ? areaText(tolerance.company.percent) : areaText(tolerance.percent) })

/** The typed percent as the API takes it, or null when it is not 0 to 100 with up to two decimals. */
export function percentOf(typed: string): string | null {
  const text = typed.trim().replace(',', '.')
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text) || new Dec(text).gt(100)) return null
  return text
}

/** What Save sends, or null when nothing changes. */
export function toleranceChange(tolerance: LeatherTolerance, draft: ToleranceDraft): { companyId: string; percent: string | null; version?: number } | null {
  if (!tolerance.companyId) return null
  const now = tolerance.company?.percent ?? null
  const next = draft.own ? percentOf(draft.percent) : null
  if (draft.own && next === null) return { companyId: tolerance.companyId, percent: draft.percent.trim(), ...(tolerance.company ? { version: tolerance.company.version } : {}) }
  if ((now === null && next === null) || (now !== null && next !== null && new Dec(now).eq(next))) return null
  return { companyId: tolerance.companyId, percent: next, ...(tolerance.company ? { version: tolerance.company.version } : {}) }
}

/** Why Save is held, or null. */
export function toleranceHeld(draft: ToleranceDraft, busy: boolean): string | null {
  if (draft.own && percentOf(draft.percent) === null) return 'cr.tolerance.held'
  return busy ? 'cr.busy' : null
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

/** The API's refusal in this card's words. */
export function cuttingProblem(error: unknown): { key: string; conflict?: boolean } {
  if (!isApiError(error)) return { key: 'cr.problem.write' }
  if (error.issues.some((issue) => issuePath(issue).includes('minimumRemnant'))) return { key: 'cr.held.tooLarge' }
  if (error.issues.some((issue) => issuePath(issue).includes('percent'))) return { key: 'cr.tolerance.held' }
  if (error.kind === 'conflict') return { key: 'cr.problem.changed', conflict: true }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'cr.problem.forbidden' }
  if (error.kind === 'not_found') return { key: 'cr.problem.gone' }
  if (error.kind === 'invalid') return { key: 'cr.problem.invalid' }
  if (error.kind === 'unavailable') return { key: 'cr.problem.offline' }
  return { key: 'cr.problem.write' }
}

/** A read failed, in this card's words. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'cr.problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'cr.problem.forbidden'
  if (error.kind === 'unavailable') return 'cr.problem.offline'
  if (error.kind === 'not_found') return 'cr.problem.gone'
  return 'cr.problem.read'
}
