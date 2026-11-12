import { businessDate, type BusinessDate } from '../../core/time'
import { clockText } from '../../production/scans/rules'
import { Dec } from '../../tax/decimal'
import type { FloorState } from './floor-status'

/**
 * Day sheets per line (B-W2b-329; PLN-154 "Printed line schedules"; design planning.board ⋯ "Print day sheets per line (PDF)",
 * pop "Print day sheets": lines, date, language → "Open PDF (new tab)", new tab "Day sheet per line (PDF): a document to print
 * for each line leader"), pure: what one line's (or work centre's) sheet for one day says, it or en. One sheet per lane: the
 * bars that reach into the day in start order, each with its times, work order, style, operation, garments, standard minutes,
 * due date and its state on the floor now; the lane's load that day; and an empty column to tick by hand. Which plan it is
 * stands at the top: the published version the floor works to that day (the default), or the working plan, marked as not
 * published. Per line, work centre and work order: no person, no customer, no money.
 */

export const SHEET_LANGUAGES = ['it', 'en'] as const
export type SheetLanguage = (typeof SHEET_LANGUAGES)[number]

export const DAY_SHEET_LIMITS = Object.freeze({ lanes: 30 })

export interface SheetRow {
  readonly startAt: Date
  readonly endAt: Date
  readonly rush: boolean
  readonly workOrder: string
  readonly style: string
  /** null: a whole-order part on the lane. */
  readonly operation: { readonly seq: number; readonly name: string } | null
  readonly pieces: number
  /** Standard minutes, one decimal. */
  readonly minutes: string
  readonly dueDate: BusinessDate | null
  readonly floor: { readonly state: FloorState; readonly done: number; readonly of: number } | null
  readonly pinned: boolean
  readonly note: string | null
}

export interface SheetLane {
  readonly kind: 'LINE' | 'WORK_CENTRE'
  readonly code: string
  readonly name: string
  /** The lane's day: available and booked standard minutes and the load (null: no working time known). */
  readonly load: { readonly availableMinutes: string; readonly bookedMinutes: string; readonly loadPct: string | null; readonly overMinutes: string } | null
  readonly rows: readonly SheetRow[]
}

export interface SheetFacts {
  readonly site: { readonly code: string; readonly name: string }
  readonly day: BusinessDate
  /** PUBLISHED: the version printed; WORKING: the working plan (and the version the floor works to, if any). */
  readonly plan: { readonly kind: 'PUBLISHED'; readonly number: number; readonly publishedAt: Date } | { readonly kind: 'WORKING'; readonly floorNumber: number | null }
  readonly printedAt: Date
  readonly timeZone: string
  readonly lanes: readonly SheetLane[]
}

const WORDS = {
  it: {
    title: 'Foglio di giornata',
    line: 'Linea',
    centre: 'Centro di lavoro',
    day: 'Giorno',
    plan: 'Piano',
    printed: 'Stampato',
    site: 'Stabilimento',
    published: 'v{number}, pubblicato il {at}',
    working: 'Piano di lavoro, non pubblicato',
    workingBanner: 'Piano di lavoro non ancora pubblicato al reparto: il reparto lavora con {floor}.',
    workingBannerNone: 'Piano di lavoro non ancora pubblicato al reparto.',
    columns: ['Inizio', 'Fine', 'Ordine di lavoro', 'Modello', 'Operazione', 'Pezzi', 'Min', 'Consegna', 'Stato', 'Fatto'],
    part: 'Parte dell’ordine',
    rush: 'URGENTE',
    pinned: 'fissato',
    note: 'Nota',
    floor: { NOT_STARTED: 'Non iniziato', RUNNING: 'In corso', PAUSED: 'In pausa', DONE: 'Fatto' },
    total: 'Totale: {pieces} pezzi · {minutes} min',
    load: 'carico {pct}% ({booked} / {available} min)',
    over: '+{over} min oltre',
    noLoad: 'orario di lavoro non noto',
    empty: 'Niente in programma su questa linea in questo giorno.',
    foot: 'Foglio dal tabellone di pianificazione: il piano può cambiare. Il lavoro conta solo con la scansione del mazzo.',
    page: 'Pagina {page} di {pages}',
  },
  en: {
    title: 'Day sheet',
    line: 'Line',
    centre: 'Work centre',
    day: 'Day',
    plan: 'Plan',
    printed: 'Printed',
    site: 'Site',
    published: 'v{number}, published {at}',
    working: 'Working plan, not published',
    workingBanner: 'Working plan not yet published to the floor: the floor works to {floor}.',
    workingBannerNone: 'Working plan not yet published to the floor.',
    columns: ['Start', 'End', 'Work order', 'Style', 'Operation', 'Pieces', 'Min', 'Due', 'Status', 'Done'],
    part: 'Part of the order',
    rush: 'RUSH',
    pinned: 'pinned',
    note: 'Note',
    floor: { NOT_STARTED: 'Not started', RUNNING: 'Running', PAUSED: 'Paused', DONE: 'Done' },
    total: 'Total: {pieces} pieces · {minutes} min',
    load: 'load {pct}% ({booked} / {available} min)',
    over: '+{over} min over',
    noLoad: 'working time not known',
    empty: 'Nothing planned on this line on this day.',
    foot: 'Sheet from the planning board: the plan may change. Work counts only when the bundle is scanned.',
    page: 'Page {page} of {pages}',
  },
} as const satisfies Record<SheetLanguage, Record<string, unknown>>

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))

export interface DaySheetRow {
  readonly rush: boolean
  readonly pinned: boolean
  readonly cells: readonly string[]
}

export interface DaySheet {
  readonly heading: string
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  /** WORKING: "not yet published" in words; else null. */
  readonly banner: string | null
  readonly rows: readonly DaySheetRow[]
  readonly empty: string | null
  /** The sheet's last line: its pieces and minutes, and the lane's load that day. */
  readonly footer: string
}

export interface DaySheetPaper {
  readonly language: SheetLanguage
  readonly title: string
  readonly columns: readonly string[]
  readonly sheets: readonly DaySheet[]
  readonly foot: string
  readonly pageLabel: string
  readonly fileName: string
}

/** Standard minutes summed: "340.5". */
const sumMinutes = (values: readonly string[]): string => values.reduce((sum, value) => sum.plus(value), new Dec(0)).toFixed(1)

const pieces = (value: number): string => String(value)

/** A time on the sheet: the clock on the sheet's day, else its day too ("16 Nov 22:00" → "2026-11-16 22:00"). */
function timeOn(at: Date, day: BusinessDate, timeZone: string): string {
  const date = businessDate(at, timeZone)
  return date === day ? clockText(at, timeZone) : `${date} ${clockText(at, timeZone)}`
}

export function daySheetPaper(facts: SheetFacts, language: SheetLanguage = 'it'): DaySheetPaper {
  const words = WORDS[language]
  const tz = facts.timeZone
  const printed = `${businessDate(facts.printedAt, tz)} ${clockText(facts.printedAt, tz)}`
  const planValue = facts.plan.kind === 'PUBLISHED' ? fill(words.published, { number: facts.plan.number, at: `${businessDate(facts.plan.publishedAt, tz)} ${clockText(facts.plan.publishedAt, tz)}` }) : words.working
  const banner = facts.plan.kind === 'WORKING' ? (facts.plan.floorNumber === null ? words.workingBannerNone : fill(words.workingBanner, { floor: `v${facts.plan.floorNumber}` })) : null
  const sheets = facts.lanes.map((lane): DaySheet => {
    const rows = [...lane.rows].sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.workOrder.localeCompare(b.workOrder))
    const total = fill(words.total, { pieces: pieces(rows.reduce((sum, row) => sum + row.pieces, 0)), minutes: sumMinutes(rows.map((row) => row.minutes)) })
    const load = lane.load
      ? [fill(words.load, { pct: lane.load.loadPct ?? '—', booked: lane.load.bookedMinutes, available: lane.load.availableMinutes }), Number(lane.load.overMinutes) > 0 ? fill(words.over, { over: lane.load.overMinutes }) : null].filter((part): part is string => part !== null).join(' · ')
      : words.noLoad
    return {
      heading: `${lane.kind === 'LINE' ? words.line : words.centre} ${lane.code} · ${lane.name}`,
      facts: [
        { label: words.site, value: `${facts.site.code} · ${facts.site.name}` },
        { label: words.day, value: facts.day },
        { label: words.plan, value: planValue },
        { label: words.printed, value: printed },
      ],
      banner,
      rows: rows.map((row) => ({
        rush: row.rush,
        pinned: row.pinned,
        cells: [
          timeOn(row.startAt, facts.day, tz),
          timeOn(row.endAt, facts.day, tz),
          row.rush ? `${row.workOrder} ${words.rush}` : row.workOrder,
          row.style,
          [row.operation ? `Op ${row.operation.seq} ${row.operation.name}` : words.part, row.pinned ? `(${words.pinned})` : null, row.note ? `${words.note}: ${row.note}` : null].filter((part): part is string => part !== null).join(' '),
          pieces(row.pieces),
          row.minutes,
          row.dueDate ?? '—',
          row.floor ? (row.floor.state === 'DONE' || row.floor.state === 'NOT_STARTED' ? words.floor[row.floor.state] : `${words.floor[row.floor.state]} ${row.floor.done}/${row.floor.of}`) : '—',
          '',
        ],
      })),
      empty: rows.length === 0 ? words.empty : null,
      footer: `${total} · ${load}`,
    }
  })
  const lanesPart = facts.lanes.length === 1 ? ` ${facts.lanes[0]!.code}` : ''
  return {
    language,
    title: words.title,
    columns: words.columns,
    sheets,
    foot: words.foot,
    pageLabel: words.page,
    fileName: `${words.title}${lanesPart} ${facts.day}.pdf`,
  }
}
