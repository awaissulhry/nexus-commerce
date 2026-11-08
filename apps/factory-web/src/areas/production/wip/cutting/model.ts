import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { quantityText } from '../../_shared/model'
import type { Cutboard, CutboardOrder, LeatherDay } from './api'

/**
 * Floor now's Cutting room (B-W2b-130; SCR-073 fn-cutting; MES-163), pure: who reads it, which live changes re-read it, where its
 * numbers and rows open, and its tiles as message keys with their parameters (the `production-cutboard` catalogue; the view
 * translates them). Garments, counts, areas and lengths only: never a cutter (Statuto dei Lavoratori art. 4).
 */

export const CUTBOARD_NAMESPACE = 'production-cutboard'
/** A burst of cuts at the tables is one read at most every 5 seconds. */
export const CUTBOARD_LIVE_MS = 5_000

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

/** production.cutting.view: the section (the API refuses it otherwise); the Cutting page opens once built. */
export function cuttingRoomCan(permissions: readonly string[]): { readonly view: boolean } {
  return { view: permissions.includes('production.cutting.view') }
}

const LIVE_PREFIXES = ['cut_order.', 'cut_ticket.', 'lay.', 'cut_consumption.']
const LIVE_TYPES = new Set(['production.cut_logged', 'production.cut_reversed'])

/** Whether a live change touches the cutting room: cut orders, tickets, lays, fabric used, the cut log. */
export const cutboardLiveTouches = (change: { readonly type: string }): boolean => LIVE_TYPES.has(change.type) || LIVE_PREFIXES.some((prefix) => change.type.startsWith(prefix))

/** Production › Cutting room › Cutting, once built (never a link that opens nothing). */
export const cuttingPageHref = (prefix: string): string | null => (OFFICE_PAGES.has('/production/cutting') ? `${prefix}/production/cutting` : null)

/** A cut order's record: its own page once built (B-W2b-129), else its panels. */
export const cutOrderHref = (prefix: string, row: Pick<CutboardOrder, 'id' | 'number' | 'companyId' | 'siteId'>): string =>
  `${prefix}${recordAddress({ type: 'CutOrder', id: row.id, label: row.number, companyId: row.companyId, siteId: row.siteId }, OFFICE_PAGES)}`

/** A work order's Cutting tab (its cut log and cut against plan). */
export const workOrderCuttingHref = (prefix: string, workOrderId: string): string => `${prefix}/production/work-orders/${encodeURIComponent(workOrderId)}?tab=cutting`

export const materialText = (row: { readonly item: { readonly code: string }; readonly colour: { readonly code: string } | null }): string => (row.colour ? `${row.item.code} · ${row.colour.code}` : row.item.code)

/** A percent string in the language: "82,5 %"; '—' when unknown. */
export function pctWords(pct: string | number | null, locale: string): string {
  if (pct === null) return '—'
  const text = String(pct)
  return `${locale === 'it' ? text.replace('.', ',') : text} %`
}

/** A signed percent: "+4,2 %", "−1,5 %"; '—' when unknown. */
export function signedPct(pct: string | null, locale: string): string {
  if (pct === null) return '—'
  const negative = pct.startsWith('-')
  const body = negative ? pct.slice(1) : pct
  return `${negative ? '−' : '+'}${locale === 'it' ? body.replace('.', ',') : body} %`
}

export interface BoardTile {
  readonly id: 'waiting' | 'cutting' | 'plan' | 'hides' | 'yield' | 'fabric' | 'late'
  readonly label: Phrase
  readonly value: string
  readonly hint: Phrase | null
  /** Said with a word, never by colour alone. */
  readonly tone: 'neutral' | 'warning' | 'danger'
}

/** The leather of the day as one figure when one area unit was cut; several units: their rows (never added across). */
export const oneUnit = (rows: readonly LeatherDay[]): LeatherDay | null => (rows.length === 1 ? rows[0]! : null)

/** The board's tiles: waiting, cutting now, cut against plan, hides and yield, fabric, late. */
export function boardTiles(board: Cutboard, locale: string): BoardTile[] {
  const q = (value: string) => quantityText(value, locale)
  const leather = oneUnit(board.leather)
  const ahead = board.plan.cutThatDay - board.plan.cut
  const tiles: BoardTile[] = [
    {
      id: 'waiting',
      label: phrase('tile.waiting'),
      value: String(board.tiles.planned + board.tiles.released),
      hint: phrase('tile.waitingHint', { released: board.tiles.released, planned: board.tiles.planned }),
      tone: 'neutral',
    },
    { id: 'cutting', label: phrase('tile.cutting'), value: String(board.tiles.inProgress), hint: phrase('tile.cuttingHint', { count: board.lays.atTable }), tone: 'neutral' },
    {
      id: 'plan',
      label: phrase(board.day === board.today ? 'tile.planToday' : 'tile.planDay'),
      value: board.plan.planned === 0 ? String(board.plan.cutThatDay) : `${board.plan.cut} / ${board.plan.planned}`,
      hint:
        board.plan.planned === 0
          ? phrase('tile.planNone', { count: board.plan.cutThatDay })
          : ahead > 0
            ? phrase('tile.planAhead', { pct: pctWords(board.plan.pct, locale), count: ahead })
            : phrase(board.plan.pct !== null && board.plan.pct >= 100 ? 'tile.planMet' : 'tile.planBehind', { pct: pctWords(board.plan.pct, locale) }),
      tone: board.plan.planned > 0 && (board.plan.pct ?? 0) < 100 ? 'warning' : 'neutral',
    },
    {
      id: 'hides',
      label: phrase('tile.hides'),
      value: String(board.hides),
      hint: board.hides === 0 ? phrase('tile.hidesNone') : leather ? phrase('tile.hidesHint', { area: q(leather.used), uom: leather.uom, count: board.cut.leatherPieces }) : phrase('tile.hidesUnits', { count: board.cut.leatherPieces }),
      tone: 'neutral',
    },
    {
      id: 'yield',
      label: phrase('tile.yield'),
      value: leather ? pctWords(leather.yieldPct, locale) : '—',
      hint:
        board.leather.length === 0
          ? phrase('tile.yieldNone')
          : leather
            ? leather.yieldPct === null
              ? phrase('tile.yieldUnknown')
              : phrase('tile.yieldPlan', { planned: pctWords(leather.plannedPct, locale), variance: signedPct(leather.variancePct, locale) })
            : phrase('tile.yieldSeeBelow'),
      tone: leather?.variancePct && leather.variancePct.startsWith('-') ? 'warning' : 'neutral',
    },
    {
      id: 'fabric',
      label: phrase('tile.fabric'),
      value: board.fabric.confirmed === 0 ? '—' : `${q(board.fabric.used)} m`,
      hint:
        board.fabric.lays === 0
          ? phrase('tile.fabricNone')
          : phrase(board.fabric.lays > board.fabric.confirmed ? 'tile.fabricHintWaiting' : 'tile.fabricHint', {
              difference: signedPct(board.fabric.differencePct, locale),
              count: board.fabric.lays - board.fabric.confirmed,
            }),
      tone: board.lays.waitingFabric > 0 ? 'warning' : 'neutral',
    },
  ]
  if (board.tiles.late > 0) tiles.push({ id: 'late', label: phrase('tile.late'), value: String(board.tiles.late), hint: phrase('tile.lateHint'), tone: 'danger' })
  return tiles
}

/** A row's progress in words: a fabric order's lays, else its state. */
export function progressPhrase(row: CutboardOrder): Phrase {
  if (row.kind === 'FABRIC' && row.lays) return phrase('row.lays', { cut: row.lays.cut, of: row.lays.of })
  return phrase(`status.${row.status}`)
}
