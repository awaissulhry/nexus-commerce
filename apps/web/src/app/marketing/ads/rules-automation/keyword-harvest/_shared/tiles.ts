/**
 * Keyword Harvest page — the tile strip (2026-10-11, wave 2). Pure, tested in Node.
 *
 * Each view reports its numbers after every read (`onTotals`); the page draws four tiles from them, and a tile that can
 * filter sets `?show=<id>`, handed back to its view as `show`. One label never shows two different numbers (audit M1):
 * every label belongs to one view and one field, counted with the same predicate the view filters with.
 *
 *   Terms    Ready · Waiting for you · Harvested · 30 d · Worse   (CandidateTotals, the server's totals of the read)
 *   Rules    the tiles the view reports (`{ tiles }`, lane HRULES)
 *   Sources  the tiles the view reports (`{ tiles }`, lane HRULES)
 *
 * A tile with nothing to show is not a button; "—" until the view has read.
 */
import type { CandidateTotals, ViewTile } from './types'

export const HARVEST_VIEWS = ['terms', 'rules', 'sources'] as const
export type HarvestView = (typeof HARVEST_VIEWS)[number]
export const isHarvestView = (v: unknown): v is HarvestView => typeof v === 'string' && (HARVEST_VIEWS as readonly string[]).includes(v)
export const VIEW_LABEL: Readonly<Record<HarvestView, string>> = { terms: 'Terms', rules: 'Rules', sources: 'Sources' }

/** A tile as the page draws it: the view's tile, or a placeholder ("—") before the first read. */
export interface TileSpec { id: string; label: string; value: number | null; tone: ViewTile['tone']; filters: boolean; hint?: string }

/** "Harvested" in ONE window everywhere: the ledger's 60 days (the Sources view's too; re-audit NICE). */
export const HARVESTED_DAYS = 60
export const TERMS_TILE_LABEL = { ready: 'Ready', waiting: 'Waiting for you', harvested: `Harvested · ${HARVESTED_DAYS} d`, worse: 'Worse' } as const

/** The Terms view's tiles, from the server's totals of its read (null: not read yet). */
export function termsTiles(t: CandidateTotals | null): TileSpec[] {
  const tile = (id: keyof typeof TERMS_TILE_LABEL, value: number | null, tone: ViewTile['tone']): TileSpec => ({ id, label: TERMS_TILE_LABEL[id], value, tone, filters: !!value })
  // Waiting for you = what can be approved now; out-of-date asks (only rejectable) are said beside it (re-audit N-S1).
  const stale = t?.waitingStale ?? 0
  const waiting = tile('waiting', t ? Math.max(0, t.waiting - stale) : null, 'warning')
  return [
    tile('ready', t ? t.ready : null, 'success'),
    stale ? { ...waiting, hint: `${stale} out of date` } : waiting,
    tile('harvested', t?.harvestedWindow ?? null, 'primary'),
    tile('worse', t ? t.worse : null, 'danger'),
  ]
}

/** The accent dot of a tile (DS tokens). A tile with nothing in it is quiet. */
export function tileAccent(t: Pick<TileSpec, 'tone' | 'value'>): string {
  if (!t.value) return 'var(--nds-border-strong)'
  switch (t.tone) {
    case 'success': return 'var(--nds-success)'
    case 'warning': return 'var(--nds-warning)'
    case 'danger': return 'var(--nds-danger)'
    default: return 'var(--nds-primary)'
  }
}

/** A tile's click: the same tile again clears the filter; a tile that does not filter does nothing (undefined). */
export function nextShow(current: string | null, tile: Pick<TileSpec, 'id' | 'filters'>): string | null | undefined {
  if (!tile.filters) return current === tile.id ? null : undefined
  return current === tile.id ? null : tile.id
}

/** A view's tiles before its first report (or when its read failed): its own labels, "—", nothing to click (S13). */
export function placeholderTiles(labels: Readonly<Record<string, string>>): TileSpec[] {
  return Object.entries(labels).map(([id, label]) => ({ id, label, value: null, tone: 'primary', filters: false }))
}
