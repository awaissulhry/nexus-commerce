import { PRODUCTION_STRATEGIES, STRATEGY_ITEM_KINDS, STRATEGY_LIMITS, type ProductionStrategy } from '@nexus/factory-domain/planning/strategy/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Translate } from '../../../lib/i18n/messages'
import type { StrategyBulk, StrategyItem, StrategyRow, StrategySet } from './api'

/**
 * Planning › Long range › Master schedule & S&OP (SCR-202; design planning.mps, a workspace list), its W2b part, pure: the
 * production strategy per item (PLN-061) — the address (site, search, kind, strategy, set or default), the every-colour row a
 * cell saves (and its version), a cell's mark while it saves, a saved answer put back in the list, the bulk change's review
 * (what changes, what is already so) and its Undo (each `from` at the row's new version), the refusals in our words. The rest of
 * the page (master schedule, season calendar and feasibility, the monthly S&OP) is W3 and Later: not drawn. No money.
 */

export const STRATEGIES = PRODUCTION_STRATEGIES
export const ITEM_KINDS = STRATEGY_ITEM_KINDS
export const PAGE = 100
export const BULK_MAX = STRATEGY_LIMITS.bulk
export const REASON_MAX = STRATEGY_LIMITS.reason

export interface MpsControls {
  site: string | null
  q: string
  kind: (typeof STRATEGY_ITEM_KINDS)[number] | null
  strategy: ProductionStrategy | null
  /** 'set': a person set it; 'default': never set (make to order by default). */
  set: 'set' | 'default' | null
}

const isStrategy = (value: string | null): value is ProductionStrategy => (PRODUCTION_STRATEGIES as readonly string[]).includes(value ?? '')

export function controlsOf(params: { get(name: string): string | null } | null | undefined): MpsControls {
  const get = (name: string) => params?.get(name) ?? null
  const kind = get('kind')
  const strategy = get('strategy')
  const set = get('set')
  return {
    site: get('site'),
    q: get('q') ?? '',
    kind: (STRATEGY_ITEM_KINDS as readonly string[]).includes(kind ?? '') ? (kind as MpsControls['kind']) : null,
    strategy: isStrategy(strategy) ? strategy : null,
    set: set === 'set' || set === 'default' ? set : null,
  }
}

export function queryOf(controls: MpsControls): string {
  const query = new URLSearchParams()
  if (controls.site) query.set('site', controls.site)
  if (controls.q) query.set('q', controls.q)
  if (controls.kind) query.set('kind', controls.kind)
  if (controls.strategy) query.set('strategy', controls.strategy)
  if (controls.set) query.set('set', controls.set)
  return query.toString()
}

export const filtered = (controls: MpsControls): boolean => !!(controls.q || controls.kind || controls.strategy || controls.set)

/** The item's every-colour row (the cell saves it), or none (the item is made to order by its defaults). */
export const everyColourRow = (item: Pick<StrategyItem, 'rows'>): StrategyRow | null => item.rows.find((row) => row.colour === null) ?? null

/** The colours set apart from the item's own strategy ("Black: make to stock"). */
export const colourRows = (item: Pick<StrategyItem, 'rows' | 'strategy'>): StrategyRow[] => item.rows.filter((row) => row.colour !== null)

/** The body of one cell's save: the version exactly when the every-colour row exists. */
export function cellBody(item: StrategyItem, siteId: string, strategy: ProductionStrategy): { siteId: string; strategy: ProductionStrategy; version?: number } {
  const row = everyColourRow(item)
  return { siteId, strategy, ...(row ? { version: row.version } : {}) }
}

/** A cell's answer put back in its item: the new row (or none), the strategy, set, the last change. */
export function withSaved(item: StrategyItem, saved: Pick<StrategySet, 'row' | 'change'>, strategy: ProductionStrategy): StrategyItem {
  if (saved.change === 'UNCHANGED' && saved.row === null) return item
  const row = saved.row
  if (!row) return { ...item, strategy }
  const rows = [row, ...item.rows.filter((entry) => entry.colour !== null)]
  return { ...item, rows, strategy: row.strategy, set: row.stored !== null, lastChange: row.lastChange ?? item.lastChange }
}

/** The mark of a cell while and after it saves (design CellSaveMark), or its refusal in words. */
export type CellMark = { readonly state: 'saving' } | { readonly state: 'saved' } | { readonly state: 'refused'; readonly problem: string }

/** What a cell may not do, in words (a key of the catalogue), or null. */
export function cellHeld(can: MpsCan): string | null {
  return can.manage ? null : 'held.noManage'
}

export interface MpsCan {
  /** planning.view: the page. */
  readonly view: boolean
  /** planning.strategy.manage: a cell, the bulk change. */
  readonly manage: boolean
}

export const mpsCan = (permissions: readonly string[]): MpsCan => ({ view: permissions.includes('planning.view'), manage: permissions.includes('planning.strategy.manage') })

// ---- the bulk change ---------------------------------------------------------------------------------------------------------

export interface BulkLine {
  readonly item: StrategyItem
  /** The strategy it has now (as just read again). */
  readonly now: ProductionStrategy
  readonly next: ProductionStrategy
}

/** The review: the items that change and those already so (left out of the save). */
export function bulkLines(items: readonly StrategyItem[], next: ProductionStrategy): { changing: BulkLine[]; already: StrategyItem[] } {
  const changing: BulkLine[] = []
  const already: StrategyItem[] = []
  for (const item of items) {
    if (item.strategy === next) already.push(item)
    else changing.push({ item, now: item.strategy, next })
  }
  return { changing, already }
}

/** The bulk save's body: each item that changes, with its every-colour row's version when it has one. */
export function bulkBody(siteId: string, lines: readonly BulkLine[], reason: string): { siteId: string; reason?: string; items: { itemId: string; strategy: ProductionStrategy; version?: number }[] } {
  const trimmed = reason.trim()
  return {
    siteId,
    ...(trimmed ? { reason: trimmed } : {}),
    items: lines.map((line) => {
      const row = everyColourRow(line.item)
      return { itemId: line.item.item.id, strategy: line.next, ...(row ? { version: row.version } : {}) }
    }),
  }
}

/** The Undo of a bulk change: each changed item back to its `from`, at the row's new version. */
export function undoBody(siteId: string, answer: StrategyBulk): { siteId: string; items: { itemId: string; strategy: ProductionStrategy; version?: number }[] } | null {
  const items = answer.changes.filter((change) => change.change !== 'UNCHANGED').map((change) => ({ itemId: change.itemId, strategy: change.from, ...(change.row ? { version: change.row.version } : {}) }))
  return items.length > 0 ? { siteId, items } : null
}

/** Why the reason cannot be sent (a key), or null: optional, at most 500 characters. */
export const reasonProblem = (reason: string): string | null => (reason.trim().length > REASON_MAX ? 'bulk.reasonLong' : null)

// ---- refusals -------------------------------------------------------------------------------------------------------------------

/** A refused save in our words (a key of the catalogue). */
export function refusalOf(error: unknown): string {
  if (!isApiError(error)) return 'refusal.failed'
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict') return 'refusal.changed'
  if (error.kind === 'invalid') {
    if (paths.some((path) => path.endsWith('itemColourId'))) return 'refusal.colour'
    if (paths.some((path) => path.endsWith('itemId'))) return 'refusal.item'
    if (paths.some((path) => path.includes('reason'))) return 'refusal.reason'
    if (paths.some((path) => path === 'body/items' || path === 'body.items')) return 'refusal.twice'
    return 'refusal.invalid'
  }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'refusal.forbidden'
  if (error.kind === 'not_found') return 'refusal.gone'
  if (error.kind === 'unavailable') return 'refusal.offline'
  return 'refusal.failed'
}

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'error.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'error.forbidden'
  if (error.kind === 'unavailable') return 'error.offline'
  if (error.kind === 'not_found') return 'error.gone'
  return 'error.failed'
}

/** The item in words: "SEED-JKT-02-BLK-52 · Seed jacket black 52". */
export const itemWords = (item: Pick<StrategyItem, 'item'>): string => `${item.item.code} · ${item.item.name}`

/** What the item is: "SEED-JKT-02 · Black · 52", or "Component". */
export function itemSub(item: Pick<StrategyItem, 'sku' | 'item'>, t: Translate): string {
  if (item.sku) return `${item.sku.style.code} · ${item.sku.colourway.name} · ${item.sku.size}`
  return t(`kind.${item.item.kind}`)
}
