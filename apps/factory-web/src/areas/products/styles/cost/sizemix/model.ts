import type { z } from 'zod'
import type { sizeWeightsView } from '@nexus/factory-domain/costing/size-weights/contracts'
import type { VersionRow } from '../versions/api'
import type { CostSheetAbilities, Phrase } from '../versions/model'

/**
 * The style's size mix on the Cost tab (B-W2b-GB02, G054; B-W2b-430 gap 4 "editing a style's size mix is not on screen";
 * FIN-016; design products.styles › Cost "Cost by size"), pure: the style's mixes (every season's, and a season's own), the
 * mix the edit dialog holds (a weight per size, blank = not in the mix), its problems, the body of PUT /costing/size-weights,
 * why the edit waits, and when the draft in view should read the mix again (a version keeps the mix it was made with until
 * it is told to). A weight is no money. Words: the `cost-sheets` catalogue (`mix.*`).
 */

export type SizeWeightsView = z.infer<typeof sizeWeightsView>
export type WeightSet = SizeWeightsView['sets'][number]

/** Which mix is edited: every season's ('') or a season's own (its id). */
export interface MixDraft {
  readonly seasonId: string
  /** size → weight as typed ('' = not in the mix). */
  readonly weights: Readonly<Record<string, string>>
}

/** The set of a season ('' = every season), or null. */
export const setOf = (view: Pick<SizeWeightsView, 'sets'>, seasonId: string): WeightSet | null => view.sets.find((set) => (set.seasonId ?? '') === seasonId) ?? null

/** The dialog starts from the set's weights (trailing zeros dropped), every size of the range listed. */
export function mixDraft(view: Pick<SizeWeightsView, 'sets' | 'style'>, seasonId: string): MixDraft {
  const set = setOf(view, seasonId)
  return { seasonId, weights: Object.fromEntries(view.style.sizes.map((size) => [size, set?.weights[size] ? String(Number(set.weights[size])) : ''])) }
}

/** A weight typed: above 0, at most 5 digits and 4 decimals ("2,5" or "2.5"), or null. */
export function typedWeight(text: string): string | null {
  const value = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d{1,5}(\.\d{1,4})?$/.test(value)) return null
  return Number(value) > 0 ? value : null
}

/** The sizes whose weight is not a figure above 0 (message key per size), and whether the mix is empty (it clears it). */
export function mixProblems(draft: MixDraft): { readonly sizes: Readonly<Record<string, string>>; readonly empty: boolean } {
  const sizes: Record<string, string> = {}
  let any = false
  for (const [size, text] of Object.entries(draft.weights)) {
    if (text.trim() === '') continue
    any = true
    if (typedWeight(text) === null) sizes[size] = 'mix.problem.weight'
  }
  return { sizes, empty: !any }
}

/** The shares of the typed mix (percent, 1 decimal), for the dialog's preview. */
export function mixShares(draft: MixDraft): { size: string; sharePct: string }[] {
  const typed = Object.entries(draft.weights).flatMap(([size, text]) => {
    const weight = typedWeight(text)
    return weight === null ? [] : [{ size, weight: Number(weight) }]
  })
  const total = typed.reduce((sum, entry) => sum + entry.weight, 0)
  return total === 0 ? [] : typed.map((entry) => ({ size: entry.size, sharePct: ((entry.weight * 100) / total).toFixed(1) }))
}

/** The body of PUT /costing/size-weights (empty weights: the mix cleared). */
export function mixBody(styleId: string, draft: MixDraft) {
  const weights: Record<string, string> = {}
  for (const [size, text] of Object.entries(draft.weights)) {
    const weight = typedWeight(text)
    if (weight !== null) weights[size] = weight
  }
  return { styleId, seasonId: draft.seasonId === '' ? null : draft.seasonId, weights }
}

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** Why editing the mix waits, or null: the right to keep sheets (every company's style without a season: a role over every company). */
export function mixHeld(can: CostSheetAbilities, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('verHeld.noManage')
  if (busy) return phrase('verHeld.busy')
  return null
}

/** Why "Read the size mix again" on the version in view waits, or null: a draft the person may change. */
export function refreshHeld(can: CostSheetAbilities, row: VersionRow | null, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('verHeld.noManage')
  if (!row || row.state !== 'DRAFT') return phrase('mix.held.notDraft')
  if (busy) return phrase('verHeld.busy')
  return null
}

/** The seasons a mix may be kept for: the version in view's (when it has one) and the seasons of the sets kept. */
export function seasonChoices(view: Pick<SizeWeightsView, 'sets'>, inView: Pick<VersionRow, 'season'> | null): { id: string; code: string }[] {
  const seen = new Map<string, string>()
  if (inView?.season) seen.set(inView.season.id, inView.season.code)
  for (const set of view.sets) if (set.seasonId && set.season) seen.set(set.seasonId, set.season.code)
  return [...seen].map(([id, code]) => ({ id, code })).sort((a, b) => a.code.localeCompare(b.code))
}
