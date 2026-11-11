import { isApiError, issuePath } from '../../../../../../lib/api/errors'
import type { DepthPart } from '../model'
import type { MarketChoice, StyleMarketsView } from './api'

/**
 * The Overview's "Markets" (B-W2b-283, FU1:01; design products.styles rec:Style › Overview "Markets: a pick of the company's
 * market profiles"), pure: what the card and its pick draw, why a change is held, the refusals in our words (keys of
 * `products-followups-w2b4`). The API is the judge (modules/product/markets): this only says beforehand what it will say.
 */

export const NS = 'products-followups-w2b4'

export interface MarketsModel {
  readonly styleCode: string
  readonly part: DepthPart<StyleMarketsView>
  readonly online: boolean
  readonly busy: boolean
  /** The pick while it is open: the codes ticked, in any order. */
  readonly pick: { readonly codes: readonly string[] } | null
  /** A refusal said above the pick's buttons. */
  readonly problem: string | null
  readonly notice: { readonly key: string; readonly tone: 'success' | 'danger' | 'info'; readonly params?: Readonly<Record<string, string | number>> } | null
}

export interface MarketsActions {
  onOpen?: () => void
  onToggle?: (code: string) => void
  onEvery?: () => void
  onSave?: () => void
  onClose?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/** The edit refusals the API may answer for a style's details (factory-domain lifecycle editRefusal, DETAILS) and its own. */
export const REFUSAL_CODES = ['EDIT_BLOCKED', 'STYLE_ARCHIVED'] as const
export const refusalKey = (code: string): string => ((REFUSAL_CODES as readonly string[]).includes(code) ? `markets.refusal.${code}` : 'markets.refusal.other')

/** Why "Change…" is held (null: it opens). */
export function marketsHeld(model: Pick<MarketsModel, 'part' | 'online' | 'busy'>): string | null {
  if (model.part.status !== 'ready') return model.part.status === 'error' ? 'markets.held.failed' : 'markets.held.reading'
  const view = model.part.value
  if (!view.mayChange) return 'markets.held.noRight'
  if (view.refusal) return refusalKey(view.refusal.code)
  if (!model.online) return 'markets.held.offline'
  if (model.busy) return 'markets.held.busy'
  return null
}

/** The pick's list: what it offers, then every market the style names that it no longer offers. */
export const pickChoices = (view: StyleMarketsView): MarketChoice[] => [...view.markets.filter((market) => market.offered), ...view.markets.filter((market) => !market.offered)]

/** The ticks differ from the style's list (as a set). */
export function pickChanged(view: StyleMarketsView, codes: readonly string[]): boolean {
  const now = new Set(view.marketCodes)
  return codes.length !== now.size || codes.some((code) => !now.has(code))
}

/** Why Save is held (null: it saves). */
export function saveHeld(model: MarketsModel): string | null {
  const held = marketsHeld(model)
  if (held) return held
  if (!model.pick || model.part.status !== 'ready') return 'markets.held.reading'
  return pickChanged(model.part.value, model.pick.codes) ? null : 'markets.held.same'
}

/** The codes to send, in the markets' order (the ones no longer offered keep their place after them). */
export function codesToSend(view: StyleMarketsView, codes: readonly string[]): string[] {
  const order = pickChoices(view).map((market) => market.code)
  return [...new Set(codes)].sort((a, b) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)) || a.localeCompare(b, 'en'))
}

/** A market's name in the reader's language ("Germania"), else its name. */
export const marketName = (market: Pick<MarketChoice, 'name' | 'nameI18n'>, locale: string): string => market.nameI18n[locale] ?? market.name

/** What a market's mark says beside its name (keys), in order: switched off, archived, another company's. */
export function marketMarks(market: MarketChoice, styleCompanyId: string | null): string[] {
  return [
    ...(!market.switchedOn ? ['markets.mark.off'] : []),
    ...(market.status === 'ARCHIVED' ? ['markets.mark.archived'] : []),
    ...(market.status === 'ACTIVE' && !market.offered && market.companyId !== null && market.companyId !== styleCompanyId ? ['markets.mark.otherCompany'] : []),
  ]
}

/** A refused write in our words, and whether the markets are read again. */
export function marketsProblem(error: unknown): { key: string; reload: boolean } {
  if (!isApiError(error)) return { key: 'markets.problem.failed', reload: false }
  const paths = error.issues.map(issuePath)
  const refusal = paths.find((path) => path.startsWith('refusal/'))
  if (refusal) return { key: refusalKey(refusal.slice('refusal/'.length)), reload: true }
  if (error.kind === 'conflict') {
    if (error.code === 'version_conflict' || paths.some((path) => path.split(/[./]/).includes('version'))) return { key: 'markets.problem.moved', reload: true }
    return { key: 'markets.problem.changed', reload: true }
  }
  if (error.kind === 'invalid') return { key: paths.some((path) => path.startsWith('body/marketCodes')) ? 'markets.problem.market' : 'markets.problem.invalid', reload: true }
  if (error.kind === 'forbidden') return { key: 'markets.problem.forbidden', reload: false }
  if (error.kind === 'unavailable') return { key: 'markets.problem.offline', reload: false }
  if (error.kind === 'not_found') return { key: 'markets.problem.gone', reload: true }
  return { key: 'markets.problem.failed', reload: false }
}

/** A read that failed, in our words. */
export function readProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'forbidden') return 'markets.problem.readForbidden'
  if (isApiError(error) && error.kind === 'unavailable') return 'markets.problem.offline'
  return 'markets.problem.readFailed'
}

/** Every key the card may say for a code (the catalogue test reads it). */
export const MARKETS_CODE_KEYS: readonly string[] = [...REFUSAL_CODES.map((code) => `markets.refusal.${code}`), 'markets.refusal.other']
