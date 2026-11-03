import type { AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { isApiError } from '../../../../lib/api/errors'
import { decimalValue, phrase, type Phrase } from '../../../_shared/stock/model'
import type { WorkOrderOption } from '../../stock/daily/api'
import type { Read } from '../../stock/daily/dialog-model'
import { refusalsOf, reserveProblem } from '../../stock/daily/model'
import type { ArticleGrade, FindAnswer, FindQuery, FoundHide as FoundHideType } from './api'

/**
 * Find hides for a job (B-W2b-131; SCM-257, SCM-206; design warehouse.hides pop-up hd-find), pure: what the dialog asks
 * the API, the hides as ONE list (the proposed shade lot first, its hides as proposed; then the other lots with the shade
 * warning; then the out-of-shade hides), what the hides chosen cover against the need, whether they mix shades (the shade
 * rule refuses it unless a person with inventory.shade.override gives the reason), why "Reserve N hides" is held, and a
 * refused reservation in our words.
 */

export type FindMode = 'workOrder' | 'article'

/** An article and colour with hides in stock at the site (the grade mix per article). */
export interface ArticleOption {
  key: string
  itemId: string
  itemColourId: string | null
  label: string
  hides: number
  left: string
  uom: AreaUom
}

export interface FindDraft {
  mode: FindMode
  /** The work order: the input (by a work order) and the reservation's demand (both modes). */
  workOrderId: string | null
  /** By an article: its key (`item|colour`). */
  articleKey: string | null
  shadeGroupId: string | null
  minGradeId: string | null
  /** The area needed as typed ("44" or "44,5"); empty: the work order's need, or none. */
  area: string
  uom: AreaUom | null
}

export interface FindCan {
  reserve: boolean
  override: boolean
  workOrders: boolean
  grades: boolean
}

export interface FindDialogModel {
  siteId: string | null
  /** Sites to pick from when the page shows every site (the API asks one without a work order). */
  sites: readonly { id: string; code: string; name: string }[]
  draft: FindDraft
  articles: Read<ArticleOption[]>
  /** The article's grades (product.materials.view); null without the right. */
  grades: Read<ArticleGrade[]> | null
  workOrderQuery: string
  workOrders: Read<WorkOrderOption[]>
  /** Null: not searched yet. */
  result: Read<FindAnswer> | null
  chosen: readonly string[]
  note: string
  overrideReason: string
  can: FindCan
  posting: boolean
  problem: Phrase | null
  done: { count: number; workOrder: string } | null
}

export interface FindDialogActions {
  onDraft?: (draft: FindDraft) => void
  onSite?: (siteId: string | null) => void
  onWorkOrderQuery?: (query: string) => void
  onFind?: () => void
  onChosen?: (hideIds: readonly string[]) => void
  onNote?: (note: string) => void
  onOverrideReason?: (reason: string) => void
  onReserve?: () => void
  onRetry?: () => void
  onClose?: () => void
}

export const emptyDraft = (mode: FindMode = 'workOrder'): FindDraft => ({ mode, workOrderId: null, articleKey: null, shadeGroupId: null, minGradeId: null, area: '', uom: null })

/** "44,5" or "44.5" → "44.5"; null when it is no positive number with at most four decimals. */
export function areaTyped(text: string): string | null {
  const plain = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(plain)) return null
  return decimalValue(plain)! > 0 ? plain : null
}

/** The unit the area is typed in: the one picked, else the article's (by article, or the leather found), else m². */
export function shownUnit(draft: FindDraft, articles: readonly ArticleOption[] | null, answer: FindAnswer | null): AreaUom {
  if (draft.uom) return draft.uom
  const article = draft.articleKey ? articles?.find((option) => option.key === draft.articleKey) : null
  if (article) return article.uom
  const base = answer?.item.baseUom
  return base === 'FT2' || base === 'DM2' || base === 'M2' ? base : 'M2'
}

/** What the dialog asks the API; null while it lacks what the mode needs (or the typed area is no number). */
export function findQueryOf(draft: FindDraft, siteId: string | null, articles: readonly ArticleOption[] | null, answer: FindAnswer | null = null): FindQuery | null {
  const area = draft.area.trim() === '' ? null : areaTyped(draft.area)
  if (draft.area.trim() !== '' && area === null) return null
  const article = draft.articleKey ? (articles?.find((option) => option.key === draft.articleKey) ?? null) : null
  const uom = area ? shownUnit(draft, articles, answer) : null
  if (draft.mode === 'workOrder') {
    if (!draft.workOrderId) return null
    return { siteId: null, workOrderId: draft.workOrderId, itemId: article?.itemId ?? null, itemColourId: article?.itemColourId ?? null, shadeGroupId: draft.shadeGroupId, minGradeId: draft.minGradeId, area, uom }
  }
  if (!article) return null
  return { siteId, workOrderId: null, itemId: article.itemId, itemColourId: article.itemColourId, shadeGroupId: draft.shadeGroupId, minGradeId: draft.minGradeId, area, uom }
}

/** A failed find in words (a key of warehouse-hides): a work order that cuts several leathers asks which one. */
export function findReadProblem(error: unknown, fallback: string): string {
  if (isApiError(error) && error.kind === 'invalid' && error.issues.some((issue) => JSON.stringify(issue).includes('query/itemId'))) return 'find.problem.whichLeather'
  return `stock:${fallback}`
}

/** Why Find is held (a key of warehouse-hides), or null. */
export function findHeldKey(model: Pick<FindDialogModel, 'draft' | 'siteId' | 'sites' | 'articles'>): string | null {
  if (model.draft.mode === 'workOrder' && !model.draft.workOrderId) return 'find.held.pickWorkOrder'
  if (model.draft.mode === 'article' && !model.draft.articleKey) return 'find.held.pickArticle'
  if (model.draft.mode === 'article' && !model.siteId && model.sites.length > 1) return 'find.held.pickSite'
  if (model.draft.area.trim() !== '' && areaTyped(model.draft.area) === null) return 'find.held.area'
  return null
}

/** A hide as the list shows it: its lot's place in the answer. */
export interface FindRow extends FoundHideType {
  lotKey: string
  /** In the lot the API proposes. */
  proposedLot: boolean
  /** Its lot would mix shades in the order. */
  shadeWarning: boolean
  /** Its lot is the order's own (it holds or reserved hides of it). */
  ordersOwn: boolean
  /** Listed apart: the out-of-shade group. */
  apart: boolean
}

/** Every hide in one list: the proposed lot first (its hides as the API ordered them), the other lots, the out-of-shade ones. */
export function rowsOf(answer: FindAnswer): FindRow[] {
  const proposed = answer.proposal?.lotKey ?? null
  const lots = [...answer.lots].sort((a, b) => Number(b.key === proposed) - Number(a.key === proposed))
  const rows: FindRow[] = []
  for (const lot of lots) for (const hide of lot.hides) rows.push({ ...hide, lotKey: lot.key, proposedLot: lot.key === proposed, shadeWarning: lot.shadeWarning, ordersOwn: lot.ordersOwn, apart: false })
  for (const hide of answer.outOfShade) rows.push({ ...hide, lotKey: `out:${hide.hideId}`, proposedLot: false, shadeWarning: true, ordersOwn: false, apart: true })
  return rows
}

/** The hides chosen at first: the proposal's. */
export const proposedIds = (answer: FindAnswer): string[] => [...(answer.proposal?.hideIds ?? [])]

/** What the chosen hides add up to (base unit) against the need: count, area, covers (null without a need). */
export function chosenFigure(answer: FindAnswer, chosen: readonly string[]): { count: number; area: number; need: number | null; covers: boolean | null; short: number | null } {
  const wanted = new Set(chosen)
  const rows = rowsOf(answer).filter((row) => wanted.has(row.hideId))
  const area = rows.reduce((sum, row) => sum + (decimalValue(row.left) ?? 0), 0)
  const need = decimalValue(answer.need.baseArea)
  return { count: rows.length, area, need, covers: need === null ? null : area >= need, short: need === null || area >= need ? null : need - area }
}

/** The chosen hides mix shade lots (or take an out-of-shade one, or a lot the order is not cut from): the rule asks a reason. */
export function mixesShades(answer: FindAnswer, chosen: readonly string[]): boolean {
  if (answer.rule === 'OFF') return false
  const wanted = new Set(chosen)
  const rows = rowsOf(answer).filter((row) => wanted.has(row.hideId))
  if (rows.some((row) => row.apart || row.outOfShade)) return true
  if (answer.rule !== 'ORDER') return false
  if (new Set(rows.map((row) => row.lotKey)).size > 1) return true
  return rows.some((row) => row.shadeWarning)
}

/** Why "Reserve N hides" is held (a key of warehouse-hides), or null. */
export function reserveHeldKey(model: Pick<FindDialogModel, 'can' | 'result' | 'chosen' | 'draft' | 'posting' | 'overrideReason'>): string | null {
  if (!model.can.reserve) return 'find.held.noReserve'
  if (model.posting) return 'find.held.busy'
  const answer = model.result?.value ?? null
  if (!answer) return 'find.held.findFirst'
  if (model.chosen.length === 0) return 'find.held.none'
  if (!model.draft.workOrderId) return 'find.held.workOrder'
  if (mixesShades(answer, model.chosen)) {
    if (!model.can.override) return 'find.held.shadeMix'
    if (model.overrideReason.trim().length < 3) return 'find.held.overrideReason'
  }
  return null
}

/** A refused reservation in our words: a shade refusal names its hides; the others as the every-day Reserve dialog says them. */
export function findProblem(error: unknown, chosen: readonly string[], answer: FindAnswer | null): Phrase {
  const refusals = refusalsOf(error)
  const shade = refusals.filter((refusal) => refusal.code === 'SHADE_LOT' || refusal.code === 'OUT_OF_SHADE')
  if (shade.length > 0) {
    const rows = answer ? rowsOf(answer) : []
    const codes = shade.map((refusal) => rows.find((row) => row.hideId === chosen[refusal.index])?.hideCode ?? `#${refusal.index + 1}`)
    return phrase(`find.refusal.${shade[0]!.code}`, { count: codes.length, hides: codes.join(', ') })
  }
  if (isApiError(error) && error.kind === 'forbidden' && error.issues.some((issue) => JSON.stringify(issue).includes('shadeOverride'))) return phrase('find.refusal.override')
  const own = reserveProblem(error)
  return { key: `daily:${own.key}`, params: own.params }
}
