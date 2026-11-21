import type { Order } from '../../api'
import type { Dates } from '../overview/api'

/**
 * F-PT-203 (order PRODUCTION tab, 10-design §5 Block C; bugs B7, B9, B10) — the dates by line, without a screen: Line · Asked ·
 * Promised · Ready · On time? — "4 d short" when the plan's forecast ends after the line's promise, "3 d spare" before it (B7: never
 * "days left"); the line's own day or the order's ("(the order's)"); the worst first; a charge line (FEE) has no date and is left out,
 * counted in one note (B9); a line's sizes that end on different days fold under it ("48–52 3 Dec · 54–56 11 Dec"). The forecast
 * withheld (no planning.promise.view): one line of words, never a bare "—" per row (B10).
 */

export interface DayOf {
  readonly date: string
  /** The line's own day (false: the order's). */
  readonly own: boolean
}

export interface ByLineRow {
  readonly lineId: string
  readonly seq: number
  readonly label: string
  readonly asked: DayOf | null
  readonly promised: DayOf | null
  /** The plan's forecast for the line; null: the forecast is withheld or the line is not in it. */
  readonly ready: { readonly finish: string | null; readonly slack: number | null; readonly risk: string | null; readonly source: string } | null
  /** Its sizes grouped by the day they end, when they end on more than one day (else empty). */
  readonly sizes: readonly { readonly sizes: string; readonly finish: string | null }[]
}

export interface ByLine {
  readonly rows: readonly ByLineRow[]
  /** Charge lines (FEE): no date, left out of the table. */
  readonly charges: number
  /** The forecast is not shown to this reader (planning.promise.view). */
  readonly withheld: boolean
}

/** "48–52" for three or more sizes in a row, "48, 50" for two, the size alone for one. */
const sizesText = (sizes: readonly string[]): string => (sizes.length >= 3 ? `${sizes[0]}–${sizes[sizes.length - 1]}` : sizes.join(', '))

export function byLineOf(order: Pick<Order, 'lines' | 'requestedDate' | 'promiseDate'>, dates: Pick<Dates, 'forecast'> | null | undefined, withheld: boolean): ByLine {
  const forecast = withheld ? null : (dates?.forecast ?? null)
  const goods = order.lines.filter((line) => line.kind !== 'FEE')
  const rows = goods.map((line): ByLineRow => {
    const own = forecast?.find((entry) => entry.lineId === line.id) ?? null
    const groups: { sizes: string[]; finish: string | null }[] = []
    for (const size of own?.sizes ?? []) {
      const last = groups[groups.length - 1]
      if (last && last.finish === size.finish) last.sizes.push(size.size ?? '—')
      else groups.push({ sizes: [size.size ?? '—'], finish: size.finish })
    }
    return {
      lineId: line.id,
      seq: line.seq,
      label: [line.style?.code ?? null, line.colourway?.name || line.colourway?.code || null].filter(Boolean).join(' · ') || '—',
      asked: line.requestedDate ? { date: line.requestedDate, own: true } : order.requestedDate ? { date: order.requestedDate, own: false } : null,
      promised: line.promiseDate ? { date: line.promiseDate, own: true } : order.promiseDate ? { date: order.promiseDate, own: false } : null,
      ready: own ? { finish: own.finish, slack: own.slackDays, risk: own.risk, source: own.source } : null,
      sizes: groups.length > 1 ? groups.map((group) => ({ sizes: sizesText(group.sizes), finish: group.finish })) : [],
    }
  })
  // The worst first: the least slack (most short), then a line the plan does not date, then by line.
  const rank = (row: ByLineRow): number => (row.ready?.slack ?? (row.ready && row.ready.finish === null ? -1e6 : 1e6))
  return { rows: [...rows].sort((a, b) => rank(a) - rank(b) || a.seq - b.seq), charges: order.lines.length - goods.length, withheld: withheld || !dates || dates.forecast === null }
}

/** "4 d short" (danger) / "3 d spare" (success) / on the day (success); null: nothing to say. */
export type OnTime = { readonly kind: 'short'; readonly days: number } | { readonly kind: 'spare'; readonly days: number } | null

export const onTimeOf = (row: Pick<ByLineRow, 'ready'>): OnTime => (row.ready?.slack === null || row.ready?.slack === undefined ? null : row.ready.slack < 0 ? { kind: 'short', days: -row.ready.slack } : { kind: 'spare', days: row.ready.slack })
