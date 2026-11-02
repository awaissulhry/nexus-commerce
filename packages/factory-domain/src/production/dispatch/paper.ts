import { businessDate, type BusinessDate } from '../../core/time'
import { clockText } from '../scans/rules'
import { sumMinutes } from './load'
import { MATERIAL_STATES, type MaterialState } from './material'

/**
 * The printed dispatch list (B-W2b-49; MES-032 "Prints the station or line list for the shift"; design production.dispatch
 * new tab "Dispatch list per station or line (print)": paper for the line at shift start), pure: what a line's or a
 * station's paper says, it or en, with an empty column to tick by hand. Per station and operation: the operator's name
 * beside a station only where the site names workers, never a figure per person; no money, no customer.
 */

export const PAPER_LANGUAGES = ['it', 'en'] as const
export type PaperLanguage = (typeof PAPER_LANGUAGES)[number]

export interface PaperCard {
  readonly order: number
  readonly rush: boolean
  readonly workOrder: string
  readonly style: string
  readonly operation: { readonly seq: number; readonly name: string }
  readonly bundles: readonly string[]
  readonly pieces: number
  readonly minutes: string
  readonly dueDate: BusinessDate | null
  readonly material: MaterialState | null
  readonly held: boolean
}

export interface PaperSection {
  readonly station: { readonly code: string; readonly name: string } | null
  readonly operators: readonly string[]
  readonly cards: readonly PaperCard[]
}

export interface PaperFacts {
  readonly site: { readonly code: string; readonly name: string }
  readonly target: { readonly kind: 'LINE' | 'STATION'; readonly code: string; readonly name: string }
  readonly day: BusinessDate
  readonly shift: string | null
  readonly version: number | null
  readonly printedAt: Date
  readonly timeZone: string
  readonly sections: readonly PaperSection[]
}

const WORDS = {
  it: {
    title: 'Lista di lavoro',
    line: 'Linea',
    station: 'Postazione',
    day: 'Giorno',
    shift: 'Turno',
    plan: 'Piano',
    printed: 'Stampata',
    noStation: 'Senza postazione',
    operators: 'Operatori',
    columns: ['N.', 'Ordine di lavoro', 'Modello', 'Operazione', 'Mazzi', 'Pezzi', 'Min', 'Consegna', 'Materiale', 'Fatto'],
    rush: 'URGENTE',
    held: 'In attesa',
    total: 'Totale',
    empty: 'Nessun lavoro in coda per questo turno.',
    foot: 'Lista di carta: gli ordini possono cambiare. Il lavoro conta solo con la scansione del mazzo.',
    material: { IN_STOCK: 'Pronto', ON_THE_WAY: 'In arrivo', MISSING: 'Manca', NOT_KNOWN: '—' },
    page: 'Pagina {page} di {pages}',
  },
  en: {
    title: 'Dispatch list',
    line: 'Line',
    station: 'Station',
    day: 'Day',
    shift: 'Shift',
    plan: 'Plan',
    printed: 'Printed',
    noStation: 'No station',
    operators: 'Operators',
    columns: ['No.', 'Work order', 'Style', 'Operation', 'Bundles', 'Pieces', 'Min', 'Due', 'Material', 'Done'],
    rush: 'RUSH',
    held: 'On hold',
    total: 'Total',
    empty: 'Nothing queued for this shift.',
    foot: 'Paper list: the order may change. Work counts only when the bundle is scanned.',
    material: { IN_STOCK: 'Ready', ON_THE_WAY: 'On the way', MISSING: 'Missing', NOT_KNOWN: '—' },
    page: 'Page {page} of {pages}',
  },
} as const satisfies Record<PaperLanguage, Record<string, unknown>>

export interface DispatchPaperRow {
  readonly rush: boolean
  readonly cells: readonly string[]
}

export interface DispatchPaperSection {
  readonly title: string
  readonly operators: string | null
  readonly rows: readonly DispatchPaperRow[]
  /** The section's last line: its pieces and minutes. */
  readonly footer: string
}

export interface DispatchPaper {
  readonly language: PaperLanguage
  readonly title: string
  readonly heading: string
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly columns: readonly string[]
  readonly sections: readonly DispatchPaperSection[]
  readonly empty: string | null
  readonly foot: string
  readonly pageLabel: string
  readonly fileName: string
}

const pieces = (value: number): string => value.toLocaleString('en-GB')

export function dispatchPaper(facts: PaperFacts, language: PaperLanguage = 'it'): DispatchPaper {
  const words = WORDS[language]
  const heading = `${facts.target.kind === 'LINE' ? words.line : words.station} ${facts.target.code} · ${facts.target.name}`
  const sections = facts.sections
    .filter((section) => section.cards.length > 0)
    .map((section): DispatchPaperSection => {
      const count = section.cards.reduce((sum, card) => sum + card.pieces, 0)
      const minutes = sumMinutes(section.cards.map((card) => card.minutes))
      return {
        title: section.station ? `${section.station.code} · ${section.station.name}` : words.noStation,
        operators: section.operators.length > 0 ? `${words.operators}: ${section.operators.join(', ')}` : null,
        rows: section.cards.map((card) => ({
          rush: card.rush,
          cells: [
            String(card.order),
            card.rush ? `${card.workOrder} ${words.rush}` : card.workOrder,
            card.style,
            `Op ${card.operation.seq} ${card.operation.name}`,
            card.bundles.length > 0 ? card.bundles.join(', ') : '—',
            pieces(card.pieces),
            card.minutes,
            card.dueDate ?? '—',
            card.held ? words.held : card.material && (MATERIAL_STATES as readonly string[]).includes(card.material) ? words.material[card.material] : '—',
            '',
          ],
        })),
        footer: `${words.total}: ${pieces(count)} · ${minutes} min`,
      }
    })
  const printed = `${businessDate(facts.printedAt, facts.timeZone)} ${clockText(facts.printedAt, facts.timeZone)}`
  return {
    language,
    title: words.title,
    heading,
    facts: [
      { label: words.day, value: facts.day },
      { label: words.shift, value: facts.shift ?? '—' },
      { label: words.plan, value: facts.version === null ? '—' : `v${facts.version}` },
      { label: words.printed, value: printed },
    ],
    columns: words.columns,
    sections,
    empty: sections.length === 0 ? words.empty : null,
    foot: words.foot,
    pageLabel: words.page,
    fileName: `${words.title} ${facts.target.code} ${facts.day}.pdf`,
  }
}
