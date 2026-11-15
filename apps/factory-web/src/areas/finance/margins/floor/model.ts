import { z } from 'zod'
import type { Locale } from '../../../../lib/i18n/locales'
import { pctText } from '../../costing/model'

/**
 * Margins in depth (B-W2b-416; FIN-050; design finance.margins "Orders below the floor (W2b)", the orders grid's "floor flag
 * (W2b)"; follow-up KA3:01): the pure rules of the margin floor on SCR-155 — the shape the API sends (mirrors
 * factory-domain costing/profitability/contracts floorView), the flag in words and tone, where the floor comes from, and
 * the tile that filters the orders below it. The floor and its flag are the margin grain: absent for a person without it,
 * and nothing is drawn then. No person is named (a role's floor names the role).
 */

export const DEPTH_NAMESPACE = 'finance-margins-depth'

/** Mirrors factory-domain costing/profitability/floor FLOOR_BASES and FLOOR_SOURCES (floor.vitest.test.ts holds them equal). */
export const FLOOR_BASES = ['ESTIMATE', 'FINAL'] as const
export const FLOOR_SOURCES = ['ROLE', 'COMPANY'] as const

export const floorSchema = z.object({
  pct: z.string(),
  from: z.enum(FLOOR_SOURCES),
  role: z.string().nullable(),
  basis: z.enum(FLOOR_BASES).nullable(),
  quotedBelow: z.boolean(),
})
export type Floor = z.infer<typeof floorSchema>

export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}

export interface FloorFacts {
  readonly belowFloor?: boolean | null
  readonly floor?: Floor | null
}

/** The flag in a cell: below (danger), at or above (success), or not known yet (a cost cannot be told). */
export function flagOf(row: FloorFacts): { readonly key: string; readonly tone: 'danger' | 'success' | 'neutral' } {
  if (row.belowFloor === true) return { key: 'flag.below', tone: 'danger' }
  if (row.belowFloor === false) return { key: 'flag.above', tone: 'success' }
  return { key: 'flag.unknown', tone: 'neutral' }
}

/** The floor in words: "Floor 25.0 % (Sales role)" or "Floor 20.0 % (the company's)". */
export function floorPhrase(floor: Floor, locale: Locale): Phrase {
  const pct = pctText(floor.pct, locale)
  return floor.from === 'ROLE' && floor.role ? { key: 'floor.role', params: { pct, role: floor.role } } : { key: 'floor.company', params: { pct } }
}

/** What the flag is judged on, in words (null basis: the margin is not known yet). */
export const basisKey = (floor: Floor): string => (floor.basis === null ? 'basis.unknown' : `basis.${floor.basis}`)

/** The difference between the margin it is judged on and its floor, in points (negative: under it); null without both. */
export function pointsToFloor(row: { readonly final: boolean; readonly estimateMarginPct?: string | null; readonly actualMarginPct?: string | null; readonly floor?: Floor | null }): number | null {
  const floor = row.floor
  if (!floor) return null
  const pct = row.final ? row.actualMarginPct : row.estimateMarginPct
  if (pct === null || pct === undefined) return null
  const a = Number(pct)
  const b = Number(floor.pct)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) * 10) / 10 : null
}

/** The tile "Orders below the floor" (design: 0 when none, '—' when unknown; a filter of the list). */
export function floorTileOf(tiles: { readonly belowFloor?: number | null } | null, active: boolean): { readonly value: string; readonly hintKey: string; readonly active: boolean } {
  const count = tiles?.belowFloor
  if (typeof count !== 'number') return { value: '—', hintKey: 'tile.unknown', active }
  return { value: String(count), hintKey: active ? 'tile.active' : count === 0 ? 'tile.none' : 'tile.hint', active }
}

/** The address's `floor` part: only the orders below it, or every order. */
export const FLOOR_FILTERS = ['below'] as const
export type FloorFilter = (typeof FLOOR_FILTERS)[number]
export const floorFilterOf = (value: string | null | undefined): FloorFilter | null => (value === 'below' ? 'below' : null)
