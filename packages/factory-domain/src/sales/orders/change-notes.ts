/**
 * B-SA-052 / B-SA-053 / B-SA-054 (sales page plan P8, P8', R2, R7, R8, R9; 13-backend B7; 14-change-flow §4.1, §5; review WP-1,
 * WP-2, C-6, C-7) — the words of ONE change of a sales order, pure. apps/factory-api modules/sales/orders/change-notes.ts (the
 * worker handler `sales.orderChangeNotes`, the ONE writer of these lines) reads the records and hands them here:
 *
 *   the system line   an office note on the order's thread (author SYSTEM, audience OFFICE, never for the floor), in the
 *                     company's language: a headline (what the bell quotes), what the customer asked, what is done, what comes
 *                     next, who was told; a closing line when the last "Still to do" row of a change closes
 *   the floor note    "For your work" on each open work order whose work changes (B-SA-053), in the site's first floor language:
 *                     floor words, the customer's CODE (never its name; none at all on a work order of several customers), never
 *                     a person, never a price, at most FLOOR_NOTE_MAX characters. Its kind is read, never stored: STOP while the
 *                     work order is on hold (the hold already refuses its scans), else CHECK (opened before the next Start)
 *   the workshop      "Order changed — check quantities" on each open subcontract order (B-SA-054, the partner notice's words:
 *                     portal/notifications/messages `portal.job.order_changed`)
 *
 * THE WALL (Owner rule 2026-11-16, R7): a message is static text — a work order of several customers (made before the one-customer
 * rule) is "a work order" for every reader (`WorkOrderLabel.number` null); a reader who reaches every customer reads its number
 * from the order's Still to do at read time. No price, no amount, no customer name on the floor, no person on the floor, and
 * nothing that says who READ anything (R2: no "seen", no "shown / not yet", no "offline since").
 */

export type NoteLocale = 'it' | 'en'

interface Words {
  readonly it: string
  readonly en: string
}

/** The longest floor note (the tablet's FLOOR_MESSAGES.text: the rest would stay in the office). */
export const FLOOR_NOTE_MAX = 1000
/** The longest system line (a thread note's own limit is larger; a line this long is cut with "…"). */
export const SYSTEM_LINE_MAX = 4000

/** The kinds a floor note of an order change reads as (derived at read time, never stored). */
export const FLOOR_NOTE_KINDS = ['STOP', 'CHECK'] as const
export type FloorNoteKind = (typeof FLOOR_NOTE_KINDS)[number]

/** STOP while the work order is on hold (the hold refuses the next scan), else CHECK (opened before the next Start). */
export const floorNoteKindOf = (workOrderStatus: string): FloorNoteKind => (workOrderStatus === 'ON_HOLD' ? 'STOP' : 'CHECK')

// ---- labels ------------------------------------------------------------------------------------------------------------------

/** A work order as a note may name it: its number only when it is of this order's own customer; null: "a work order". */
export interface WorkOrderLabel {
  readonly number: string | null
}

const A_WORK_ORDER: Words = { en: 'a work order', it: 'un ordine di lavoro' }
const woName = (label: WorkOrderLabel, locale: NoteLocale): string => label.number ?? A_WORK_ORDER[locale]

/** Several work orders in one list: the named ones, then "a work order" / "2 work orders" for the others (never their numbers). */
export function workOrderList(labels: readonly WorkOrderLabel[], locale: NoteLocale): string {
  const named = [...new Set(labels.flatMap((label) => (label.number ? [label.number] : [])))].sort()
  const others = labels.filter((label) => !label.number).length
  const rest = others === 0 ? [] : others === 1 ? [A_WORK_ORDER[locale]] : [locale === 'it' ? `${others} ordini di lavoro` : `${others} work orders`]
  return [...named, ...rest].join(', ')
}

/** A size and its pieces, old → new. */
export interface CellFigure {
  readonly size: string
  readonly from: number
  readonly to: number
}

const cellsText = (cells: readonly CellFigure[]): string => cells.map((cell) => `${cell.size} ${cell.from} → ${cell.to}`).join(' · ')

// ---- times (the company's or the site's time zone) ----------------------------------------------------------------------------

/** hh:mm in the time zone. */
export function clockOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '00'
  return `${part('hour')}:${part('minute')}`
}

/** dd/mm in the time zone. */
export function dayOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit' }).formatToParts(instant)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '00'
  return `${part('day')}/${part('month')}`
}

/** A business date (yyyy-mm-dd) as dd/mm/yyyy. */
export const dateText = (date: string): string => {
  const [year, month, day] = date.split('-')
  return year && month && day ? `${day}/${month}/${year}` : date
}

// ---- the system line --------------------------------------------------------------------------------------------------------

/** How the line starts (its first line is what the followers' bell quotes as "what changed"). */
export type LineHead =
  | { readonly kind: 'ACCEPTED'; readonly by: string | null }
  | { readonly kind: 'REFUSED'; readonly by: string | null }
  | { readonly kind: 'WITHDRAWN'; readonly customer: string }
  /** The office's own change (no request): an amendment, lines closed or reopened, a cancel, a new promise, a hold, an ECO. */
  | { readonly kind: 'CHANGED'; readonly by: string | null }
  /** A work-order change applied or left as is by production (a step of an earlier change). */
  | { readonly kind: 'WORK_ORDER'; readonly by: string | null }

/** What the customer asked (a request's line), in the request's own terms. */
export type AskWhat =
  | { readonly kind: 'SIZES'; readonly lines: readonly { readonly seq: number; readonly cells: readonly CellFigure[] }[] }
  | { readonly kind: 'DATE'; readonly date: string }
  | { readonly kind: 'ADDRESS' }
  | { readonly kind: 'COLOURWAY'; readonly seqs: readonly number[] }
  | { readonly kind: 'CANCEL'; readonly seqs: readonly number[] | null }
  | { readonly kind: 'DESIGN'; readonly seqs: readonly number[] }
  | { readonly kind: 'RUSH' | 'HOLD' | 'RESUME' | 'SPLIT_SHIPMENT' | 'SAMPLE_ROUND' }

export interface Asked {
  readonly customer: string
  readonly at: Date
  readonly what: AskWhat
}

/** What the command did to the order. */
export type DoneItem =
  | { readonly kind: 'AMENDED'; readonly revision: number }
  | { readonly kind: 'SIZES'; readonly lines: readonly { readonly seq: number; readonly cells: readonly CellFigure[] }[] }
  | { readonly kind: 'CANCELLED' }
  | { readonly kind: 'LINES_CLOSED'; readonly seqs: readonly number[] }
  | { readonly kind: 'LINES_REOPENED'; readonly seqs: readonly number[] }
  | { readonly kind: 'PROMISE'; readonly from: string | null; readonly to: string }
  // B-SA-053b: `cells` are the work order's own cells AFTER the apply (from → what it makes now: Lower to the order never goes below
  // what is cut), and `extra` the pieces it keeps beyond the order's figure with their outcome (office only; never on the floor).
  | { readonly kind: 'WORK_ORDER_CHANGED'; readonly workOrder: WorkOrderLabel; readonly cells: readonly CellFigure[]; readonly extra?: ExtraKept | null }
  | { readonly kind: 'WORK_ORDER_NEW'; readonly workOrder: WorkOrderLabel }
  | { readonly kind: 'LEFT_AS_IS'; readonly workOrder: WorkOrderLabel; readonly why: string | null }
  | { readonly kind: 'PAUSED'; readonly workOrders: readonly WorkOrderLabel[] }
  | { readonly kind: 'RESUMED'; readonly workOrders: readonly WorkOrderLabel[] }
  | { readonly kind: 'RELEASED'; readonly changeOrder: string; readonly workOrders: readonly WorkOrderLabel[] }

// ---- B-SA-053b: the extra pieces a lowered work order keeps (cut beyond the order's new figure) and what happens to them, as the
// accepter named it (null: an office close or cancel that named none).
export interface ExtraKept {
  readonly count: number
  readonly outcome: 'CHARGE' | 'LEFTOVER' | 'SCRAP' | null
}

/** "2 extra pieces kept as the customer's leftover" — the outcome's own words (order-apply CHANGE_WORDS.extraOutcome's). */
function extraText(extra: ExtraKept, locale: NoteLocale): string {
  const it = locale === 'it'
  const pieces = it ? `${extra.count} ${extra.count === 1 ? 'pezzo in più' : 'pezzi in più'}` : `${extra.count} extra ${extra.count === 1 ? 'piece' : 'pieces'}`
  switch (extra.outcome) {
    case 'CHARGE':
      return it ? `${pieces} ${extra.count === 1 ? 'tenuto e addebitato' : 'tenuti e addebitati'} al cliente` : `${pieces} kept and charged to the customer`
    case 'LEFTOVER':
      return it ? `${pieces} ${extra.count === 1 ? 'tenuto' : 'tenuti'} come rimanenza del cliente` : `${pieces} kept as the customer's leftover`
    case 'SCRAP':
      return it ? `${pieces} da scartare, con la loro approvazione` : `${pieces} to scrap, with their approval`
    default:
      return it ? `${pieces} ${extra.count === 1 ? 'tenuto' : 'tenuti'}` : `${pieces} kept`
  }
}
// ---- end B-SA-053b

/** What comes next (a step of this change still open). */
export type NextItem =
  | { readonly kind: 'WORK_ORDER'; readonly workOrder: WorkOrderLabel }
  | { readonly kind: 'NEW_WORK_ORDER' }
  | { readonly kind: 'STYLE'; readonly number: string }

/** Who was told (never who read): office people, the floor of these work orders, the outside workshops of these work orders. */
export interface Told {
  readonly people: number
  readonly floor: readonly WorkOrderLabel[]
  readonly workshops: readonly WorkOrderLabel[]
}

export interface SystemLine {
  readonly head: LineHead
  readonly at: Date
  readonly asked?: Asked | null
  readonly done: readonly DoneItem[]
  readonly next: readonly NextItem[]
  readonly told: Told | null
  /** The refusal's words to the customer, as typed (the office reads them; never a price — the send check). */
  readonly answer?: string | null
  /** The change whose last step this command closed: "Change of {date} {time} carried out: nothing left to do." */
  readonly closing?: { readonly at: Date } | null
}

const LINE = {
  accepted: (name: string, time: string): Words => ({ en: `Change accepted · ${name} · ${time}`, it: `Modifica accettata · ${name} · ${time}` }),
  refused: (name: string, time: string): Words => ({ en: `Refused · ${name} · ${time}`, it: `Rifiutata · ${name} · ${time}` }),
  withdrawn: (customer: string, time: string): Words => ({ en: `Withdrawn by ${customer} · ${time}`, it: `Ritirata da ${customer} · ${time}` }),
  // B-SA-052: the office's own change and production's step (words of the line's "Done", "Ordine modificato").
  changed: (name: string, time: string): Words => ({ en: `Order changed · ${name} · ${time}`, it: `Ordine modificato · ${name} · ${time}` }),
  workOrder: (name: string, time: string): Words => ({ en: `Work order changed · ${name} · ${time}`, it: `Ordine di lavoro cambiato · ${name} · ${time}` }),
  asked: (customer: string, time: string, what: string): Words => ({ en: `${customer} asked (portal, ${time}): ${what}.`, it: `${customer} ha chiesto (portale, ${time}): ${what}.` }),
  done: (list: string): Words => ({ en: `Done: ${list}.`, it: `Fatto: ${list}.` }),
  next: (list: string): Words => ({ en: `Next: ${list}.`, it: `Prossimi: ${list}.` }),
  told: (count: number, floor: string, workshop: string): Words => ({
    en: `Told: ${count} ${count === 1 ? 'person' : 'people'} in the office${floor ? ` · the floor of ${floor}` : ''}${workshop ? ` · the workshop of ${workshop}` : ''}`,
    it: `Avvisati: ${count} ${count === 1 ? 'persona' : 'persone'} in ufficio${floor ? ` · il reparto di ${floor}` : ''}${workshop ? ` · il terzista di ${workshop}` : ''}`,
  }),
  closing: (date: string, time: string): Words => ({ en: `Change of ${date} ${time} carried out: nothing left to do.`, it: `Modifica del ${date} ${time} eseguita: non resta nulla da fare.` }),
  someone: { en: 'someone in the office', it: "qualcuno dell'ufficio" } as Words,
} as const

const SEQ = (seqs: readonly number[], locale: NoteLocale): string => (seqs.length === 1 ? `${locale === 'it' ? 'riga' : 'line'} ${seqs[0]}` : `${locale === 'it' ? 'righe' : 'lines'} ${seqs.join(', ')}`)

const ASK_KIND: Readonly<Record<'RUSH' | 'HOLD' | 'RESUME' | 'SPLIT_SHIPMENT' | 'SAMPLE_ROUND', Words>> = Object.freeze({
  // The catalogue's words of the asks (sales/change-requests/rules ORDER_REQUEST_KIND_WORDS).
  RUSH: { it: 'Urgente – richiesto', en: 'Urgent – asked' },
  HOLD: { it: 'Richiesta di pausa', en: 'Pause request' },
  RESUME: { it: 'Richiesta di ripresa', en: 'Resume request' },
  SPLIT_SHIPMENT: { it: 'Richiesta di spedire ciò che è pronto', en: 'Request to ship what is ready' },
  SAMPLE_ROUND: { it: 'Richiesta di un altro campione', en: 'Request for another sample' },
})

function askText(what: AskWhat, locale: NoteLocale): string {
  switch (what.kind) {
    case 'SIZES':
      return what.lines.map((line) => `${SEQ([line.seq], locale)} · ${cellsText(line.cells)}`).join(' · ')
    case 'DATE':
      return locale === 'it' ? `nuova data ${dateText(what.date)}` : `new date ${dateText(what.date)}`
    case 'ADDRESS':
      return locale === 'it' ? 'indirizzo di consegna' : 'delivery address'
    case 'COLOURWAY':
      return locale === 'it' ? `colore di ${SEQ(what.seqs, locale)}` : `colourway of ${SEQ(what.seqs, locale)}`
    case 'CANCEL':
      return what.seqs === null ? (locale === 'it' ? "annullare l'ordine" : 'cancel the order') : locale === 'it' ? `annullare ${SEQ(what.seqs, locale)}` : `cancel ${SEQ(what.seqs, locale)}`
    case 'DESIGN':
      return locale === 'it' ? `modifica del design di ${SEQ(what.seqs, locale)}` : `design change of ${SEQ(what.seqs, locale)}`
    default:
      return ASK_KIND[what.kind][locale]
  }
}

function doneText(item: DoneItem, locale: NoteLocale): string {
  const it = locale === 'it'
  switch (item.kind) {
    case 'AMENDED':
      return it ? `ordine modificato (revisione ${item.revision})` : `order amended (revision ${item.revision})`
    case 'SIZES':
      return item.lines.map((line) => `${SEQ([line.seq], locale)} · ${cellsText(line.cells)}`).join(' · ')
    case 'CANCELLED':
      return it ? 'ordine annullato' : 'order cancelled'
    case 'LINES_CLOSED':
      return it ? `${SEQ(item.seqs, locale)} ${item.seqs.length === 1 ? 'chiusa' : 'chiuse'}` : `${SEQ(item.seqs, locale)} closed`
    case 'LINES_REOPENED':
      return it ? `${SEQ(item.seqs, locale)} ${item.seqs.length === 1 ? 'riaperta' : 'riaperte'}` : `${SEQ(item.seqs, locale)} reopened`
    case 'PROMISE':
      return it ? `data promessa ${item.from ? `${dateText(item.from)} → ` : ''}${dateText(item.to)}` : `promise date ${item.from ? `${dateText(item.from)} → ` : ''}${dateText(item.to)}`
    case 'WORK_ORDER_CHANGED': {
      // B-SA-053b: the work order's new cells, then the extra pieces it keeps and their outcome.
      const kept = item.extra && item.extra.count > 0 ? ` · ${extraText(item.extra, locale)}` : ''
      return it ? `${woName(item.workOrder, locale)} cambiato: ${cellsText(item.cells)}${kept}` : `${woName(item.workOrder, locale)} changed: ${cellsText(item.cells)}${kept}`
    }
    case 'WORK_ORDER_NEW':
      return it ? `fatto ${woName(item.workOrder, locale)} in più` : `${woName(item.workOrder, locale)} made for the rest`
    case 'LEFT_AS_IS':
      // The catalogue's words (sales/change-requests/apply-plan APPLY_WORDS.leftAsIs: "Lasciato così").
      return it ? `${woName(item.workOrder, locale)} lasciato così${item.why ? ` (${item.why})` : ''}` : `${woName(item.workOrder, locale)} left as is${item.why ? ` (${item.why})` : ''}`
    case 'PAUSED':
      return it ? `${workOrderList(item.workOrders, locale)} in pausa` : `${workOrderList(item.workOrders, locale)} paused`
    case 'RESUMED':
      return it ? `tolta la pausa di ${workOrderList(item.workOrders, locale)}` : `the pause of ${workOrderList(item.workOrders, locale)} is lifted`
    case 'RELEASED':
      return it ? `${item.changeOrder} rilasciata${item.workOrders.length > 0 ? ` per ${workOrderList(item.workOrders, locale)}` : ''}` : `${item.changeOrder} released${item.workOrders.length > 0 ? ` for ${workOrderList(item.workOrders, locale)}` : ''}`
  }
}

function nextText(item: NextItem, locale: NoteLocale): string {
  const it = locale === 'it'
  switch (item.kind) {
    case 'WORK_ORDER':
      return it ? `${woName(item.workOrder, locale)} (inviato alla pianificazione)` : `${woName(item.workOrder, locale)} (sent to planning)`
    case 'NEW_WORK_ORDER':
      return it ? 'un nuovo ordine di lavoro (inviato alla pianificazione)' : 'a new work order (sent to planning)'
    case 'STYLE':
      return it ? `${item.number} (prodotto)` : `${item.number} (product)`
  }
}

const headOf = (head: LineHead, time: string, locale: NoteLocale): string => {
  const name = (by: string | null) => by ?? LINE.someone[locale]
  switch (head.kind) {
    case 'ACCEPTED':
      return LINE.accepted(name(head.by), time)[locale]
    case 'REFUSED':
      return LINE.refused(name(head.by), time)[locale]
    case 'WITHDRAWN':
      return LINE.withdrawn(head.customer, time)[locale]
    case 'CHANGED':
      return LINE.changed(name(head.by), time)[locale]
    case 'WORK_ORDER':
      return LINE.workOrder(name(head.by), time)[locale]
  }
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

/** The system line in one language (the company's), lines joined by new lines; its first line is the headline the bell quotes. */
export function systemLineOf(line: SystemLine, locale: NoteLocale, timeZone: string): string {
  const out = [headOf(line.head, clockOf(line.at, timeZone), locale)]
  if (line.asked) out.push(LINE.asked(line.asked.customer, clockOf(line.asked.at, timeZone), askText(line.asked.what, locale))[locale])
  // The refusal's words, only when they hold no price (they reached the customer through the send check; the line never carries one).
  if (line.answer && line.answer.trim() !== '' && noPriceIn(line.answer)) out.push(`“${line.answer.trim()}”`)
  if (line.done.length > 0) out.push(LINE.done(line.done.map((item) => doneText(item, locale)).join(' · '))[locale])
  if (line.next.length > 0) out.push(LINE.next(line.next.map((item) => nextText(item, locale)).join(' · '))[locale])
  if (line.told) out.push(LINE.told(line.told.people, workOrderList(line.told.floor, locale), workOrderList(line.told.workshops, locale))[locale])
  if (line.closing) out.push(LINE.closing(dayOf(line.closing.at, timeZone), clockOf(line.closing.at, timeZone))[locale])
  return cut(out.join('\n'), SYSTEM_LINE_MAX)
}

/** The closing line alone (a command whose only news is that the last step of a change is done). */
export const closingLineOf = (at: Date, locale: NoteLocale, timeZone: string): string => LINE.closing(dayOf(at, timeZone), clockOf(at, timeZone))[locale]

// ---- the floor note (B-SA-053) -----------------------------------------------------------------------------------------------

/** The kinds of what changes for a work order (production.floor_note_posted `changes`). */
export const FLOOR_CHANGE_KINDS = ['SIZES', 'LINES_CLOSED', 'APPLIED', 'LEFT_AS_IS', 'PAUSED', 'RESUMED', 'RUSH', 'DESIGN'] as const
export type FloorChangeKind = (typeof FLOOR_CHANGE_KINDS)[number]
/** B-SA-054: the floor-note changes a workshop is told of (its job's quantities may change). */
export const WORKSHOP_CHANGES: readonly FloorChangeKind[] = Object.freeze(['SIZES', 'LINES_CLOSED', 'APPLIED'])

/** What changes for one open work order, in floor terms. */
export type FloorChange =
  /** Sizes of the order now (the work order's own cells of the changed lines); `waitSizes`: not cut yet — wait before cutting. */
  | { readonly kind: 'SIZES'; readonly cells: readonly CellFigure[]; readonly waitSizes: readonly string[] }
  /** Lines of the order closed or cancelled: no new bundles of them. */
  | { readonly kind: 'LINES_CLOSED'; readonly seqs: readonly number[] }
  /** Production applied the work-order change: cut these figures — the work order's own cells after the apply (B-SA-053b). */
  | { readonly kind: 'APPLIED'; readonly cells: readonly { readonly size: string; readonly quantity: number }[] }
  /** Production left the work order as it was: cut as planned. */
  | { readonly kind: 'LEFT_AS_IS' }
  | { readonly kind: 'PAUSED' }
  | { readonly kind: 'RESUMED' }
  | { readonly kind: 'RUSH' }
  /** A design change is coming (an accepted DESIGN request: its product change request, the revision the work order makes). */
  | { readonly kind: 'DESIGN'; readonly changeRequest: string | null; readonly revision: number | null }

export interface FloorNote {
  /** The work order's own number (the floor reads its own work orders by number). */
  readonly workOrder: string
  /** The order's customer CODE, only when the work order is of that customer alone; null: none named (a mixed work order). */
  readonly customerCode: string | null
  readonly changes: readonly FloorChange[]
}

const FLOOR = {
  sizes: (wo: string, code: string | null, cells: string): Words => ({
    en: `Order change on ${wo}${code ? ` (${code})` : ''}: ${cells}.`,
    it: `Modifica d'ordine su ${wo}${code ? ` (${code})` : ''}: ${cells}.`,
  }),
  cell: (cell: CellFigure): Words => ({ en: `size ${cell.size} now ${cell.to} (was ${cell.from})`, it: `taglia ${cell.size} ora ${cell.to} (erano ${cell.from})` }),
  wait: (sizes: string): Words => ({ en: `Wait for the new work-order numbers before cutting ${sizes}.`, it: `Aspetta i nuovi numeri dell'ordine di lavoro prima di tagliare ${sizes}.` }),
  // B-SA-053: lines closed or cancelled (new words; the STOP words' "Ask your team leader").
  closed: (wo: string, code: string | null, seqs: readonly number[]): Words => ({
    en: `Order change on ${wo}${code ? ` (${code})` : ''}: ${seqs.length === 1 ? `line ${seqs[0]} is` : `lines ${seqs.join(', ')} are`} closed. Do not start new bundles of ${seqs.length === 1 ? 'it' : 'them'}. Ask your team leader.`,
    it: `Modifica d'ordine su ${wo}${code ? ` (${code})` : ''}: ${seqs.length === 1 ? `la riga ${seqs[0]} è chiusa` : `le righe ${seqs.join(', ')} sono chiuse`}. Non iniziare nuovi fasci. Chiedi al tuo capoturno.`,
  }),
  applied: (wo: string, list: string): Words => ({ en: `${wo} changed: cut ${list}.`, it: `${wo} cambiato: taglia ${list}.` }),
  // B-SA-053: production left it as it was (new words: the floor was told to wait at Accept).
  leftAsIs: (wo: string): Words => ({ en: `${wo}: no change after all, cut as planned.`, it: `${wo}: nessuna modifica, taglia come previsto.` }),
  paused: { en: 'Paused by the office. Do not start new bundles. Ask your team leader.', it: "Fermato dall'ufficio. Non iniziare nuovi fasci. Chiedi al tuo capoturno." } as Words,
  resumed: { en: 'Work goes on: the pause is lifted.', it: 'Si riprende: la pausa è tolta.' } as Words,
  rush: (wo: string): Words => ({ en: `Rush: ${wo} goes first.`, it: `Urgente: ${wo} va per primo.` }),
  design: (cr: string | null, revision: number | null): Words => ({
    en: `Design change coming${cr ? ` (${cr})` : ''}: keep to ${revision !== null ? `revision ${revision}` : 'the revision you have'} until the office decides.`,
    it: `In arrivo una modifica del design${cr ? ` (${cr})` : ''}: segui ${revision !== null ? `la revisione ${revision}` : 'la revisione che hai'} finché l'ufficio non decide.`,
  }),
} as const

function floorChangeText(note: FloorNote, change: FloorChange, locale: NoteLocale): string {
  switch (change.kind) {
    case 'SIZES': {
      const head = FLOOR.sizes(note.workOrder, note.customerCode, change.cells.map((cell) => FLOOR.cell(cell)[locale]).join(', '))[locale]
      return change.waitSizes.length > 0 ? `${head} ${FLOOR.wait(change.waitSizes.join(', '))[locale]}` : head
    }
    case 'LINES_CLOSED':
      return FLOOR.closed(note.workOrder, note.customerCode, change.seqs)[locale]
    case 'APPLIED':
      return FLOOR.applied(note.workOrder, change.cells.map((cell) => `${cell.size} ${cell.quantity}`).join(', '))[locale]
    case 'LEFT_AS_IS':
      return FLOOR.leftAsIs(note.workOrder)[locale]
    case 'PAUSED':
      return FLOOR.paused[locale]
    case 'RESUMED':
      return FLOOR.resumed[locale]
    case 'RUSH':
      return FLOOR.rush(note.workOrder)[locale]
    case 'DESIGN':
      return FLOOR.design(change.changeRequest, change.revision)[locale]
  }
}

/** The floor note in one language (the site's first floor language), at most FLOOR_NOTE_MAX characters. */
export function floorNoteOf(note: FloorNote, locale: NoteLocale): string {
  return cut(note.changes.map((change) => floorChangeText(note, change, locale)).join('\n'), FLOOR_NOTE_MAX)
}

// ---- the words a note must never hold (the unit tests and the PG tests scan with it) -------------------------------------------

/** Money in a text: a currency sign or code beside a figure, or "price" / "prezzo" (a note never carries a price). */
export const PRICE_PATTERN = /[€$£]|\b(?:EUR|USD|GBP)\b|\bprice\b|\bprezz[oi]\b|\bimport[oi]\b/iu

/** A text scan: true when the words carry no price (B-SA-052, B-SA-053). */
export const noPriceIn = (text: string): boolean => !PRICE_PATTERN.test(text)
