import { SIZE_CURVE_LIMITS } from '@nexus/factory-domain/sales/size-curves/rules'
import type { Words } from '../../quotes/record/lines-depth/model'
import type { SizeCurve } from './api'

/**
 * Sales settings › Size curves (design sales.settings sec:ssettings.curves, SAL-269), pure: the curves a scale shows, a curve
 * as its dialog edits it (name, scale, whose, a percent per size), the live total in hundredths of a percent (exact, never a
 * float sum), what stops a save (the API says the same first: sharesProblems — total exactly 100, each > 0 and ≤ 100 with
 * at most 4 decimals), and the shares as the API takes them.
 */

export { SIZE_CURVE_LIMITS }

export type CurveStatusFilter = 'ACTIVE' | 'ARCHIVED' | 'ALL'

export const curvesShown = (curves: readonly SizeCurve[], scaleId: string, status: CurveStatusFilter): SizeCurve[] => curves.filter((curve) => curve.sizeScale.id === scaleId && (status === 'ALL' || curve.status === status))

/** The scales that have curves (the filter's choices), in the order first met. */
export function scalesOf(curves: readonly SizeCurve[]): Array<SizeCurve['sizeScale']> {
  const seen = new Map<string, SizeCurve['sizeScale']>()
  for (const curve of curves) if (!seen.has(curve.sizeScale.id)) seen.set(curve.sizeScale.id, curve.sizeScale)
  return [...seen.values()]
}

export interface CurveDraft {
  name: string
  scaleId: string
  /** '' = every company. */
  companyId: string
  /** Size code → percent as typed ("40", "12,5"). */
  shares: Record<string, string>
}

const SHARE = /^\d{1,3}([.,]\d{1,4})?$/

/** A typed share in ten-thousandths of a percent (exact), or null when it is not one; '' = 0. */
export function shareUnits(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  if (!SHARE.test(trimmed)) return null
  const [whole, decimals = ''] = trimmed.replace(',', '.').split('.')
  return Number(whole) * 10_000 + Number(decimals.padEnd(4, '0'))
}

/** The live total in percent (4 decimals at most), or null while a share is not a number. */
export function totalOf(draft: Pick<CurveDraft, 'shares'>): number | null {
  let sum = 0
  for (const text of Object.values(draft.shares)) {
    const units = shareUnits(text)
    if (units === null) return null
    sum += units
  }
  return sum / 10_000
}

/** What stops the curve from being saved, in words (Save is held until the total is exactly 100 %). */
export function curveProblems(draft: CurveDraft): Words[] {
  const problems: Words[] = []
  if (draft.name.trim() === '') problems.push({ key: 'curve.problem.name' })
  if (draft.name.trim().length > SIZE_CURVE_LIMITS.name) problems.push({ key: 'curve.problem.nameLong', params: { max: SIZE_CURVE_LIMITS.name } })
  if (!draft.scaleId) problems.push({ key: 'curve.problem.scale' })
  const bad = Object.entries(draft.shares).find(([, text]) => { const units = shareUnits(text); return units === null || units > 1_000_000 })
  if (bad) problems.push({ key: 'curve.problem.share', params: { size: bad[0] } })
  const total = totalOf(draft)
  if (!bad && total !== null && Object.values(draft.shares).every((text) => (shareUnits(text) ?? 0) === 0)) problems.push({ key: 'curve.problem.none' })
  else if (!bad && total !== null && Math.round(total * 10_000) !== 1_000_000) problems.push({ key: 'curve.problem.total', params: { total: String(total) } })
  return problems
}

/** The shares as the API takes them: the sizes with a share, in the scale's order, written with a point. */
export function sharesBody(draft: Pick<CurveDraft, 'shares'>, order: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    order.flatMap((size) => {
      const units = shareUnits(draft.shares[size] ?? '')
      return units && units > 0 ? [[size, (draft.shares[size] ?? '').trim().replace(',', '.')]] : []
    }),
  )
}

export const draftOfCurve = (curve: SizeCurve): CurveDraft => ({ name: curve.name, scaleId: curve.sizeScale.id, companyId: curve.companyId ?? '', shares: Object.fromEntries(Object.entries(curve.shares).map(([size, share]) => [size, String(Number(share))])) })

/** The ticked curves a move reaches: in the right state. */
export const movableCurves = (curves: readonly SizeCurve[], ids: readonly string[], to: 'archive' | 'restore'): SizeCurve[] => curves.filter((curve) => ids.includes(curve.id) && curve.status === (to === 'archive' ? 'ACTIVE' : 'ARCHIVED'))
