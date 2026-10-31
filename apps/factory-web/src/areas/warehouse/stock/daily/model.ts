import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Demand, ReservedKey, Uom } from '../../../_shared/stock/api'
import { decimalValue, phrase, writeProblem, type Phrase } from '../../../_shared/stock/model'
import type { PickerReason } from '../../../_shared/reasons/api'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { typedDecimal } from '../adjust/model'
import type { HoldPreview, HoldRow, WriteOffLine } from './api'

/**
 * The warehouse's every-day rules (B-W2a-64), pure, shared by Stock (SCR-060), Movements (SCR-064), Hides (SCR-200) and
 * Lots & traceability (SCR-201): stock as of a date (the instant a day and a time mean in the site's zone), what a
 * reservation holds per grid row, why a row is held (a quality hold's reason in words, never "free to use"), the reach
 * of a hold, the write-off's draft and what holds its button, and the API's refusals in our words (keys of
 * `warehouse-daily`). Words live in `messages/<locale>/warehouse-daily.json`.
 */

export const DAILY_NAMESPACE = 'warehouse-daily'

// ---- stock as of a date ----------------------------------------------------------------------------------------------------

/** "End of day" (design st-asof: DateField + time, end of day by default): the last minute of the day. */
export const END_OF_DAY = '23:59'

/** The wall clock of an instant in a zone: its day (YYYY-MM-DD) and time (HH:MM). */
export function wallOf(at: number, timeZone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ''
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * The instant "as of <day> <time>" means in the site's zone: the LAST millisecond of that minute (so "30 Sep 23:59"
 * takes every move of the day). Summer and winter time included (two passes on the guess). Null for a day or time that
 * is not one.
 */
export function asOfInstant(day: string, time: string, timeZone: string): string | null {
  if (!DAY.test(day) || !TIME.test(time)) return null
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const check = new Date(Date.UTC(year, month - 1, date))
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  const wanted = Date.UTC(year, month - 1, date, hour, minute)
  let guess = wanted
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallOf(guess, timeZone)
    const [sy, sm, sd] = seen.day.split('-').map(Number) as [number, number, number]
    const [sh, smin] = seen.time.split(':').map(Number) as [number, number]
    guess += wanted - Date.UTC(sy, sm - 1, sd, sh, smin)
  }
  return new Date(guess + 59_999).toISOString()
}

/** The day and the minute an as-of instant shows (the band's pill, the notice). */
export const asOfWall = (instant: string, timeZone: string) => wallOf(Date.parse(instant), timeZone)

/** Why "Show stock as of this date" is held (a key of warehouse-daily), or null: a real day, a time, not in the future. */
export function asOfHeldKey(day: string, time: string, now: number, timeZone: string): string | null {
  if (!day) return 'asof.held.day'
  const instant = asOfInstant(day, time || END_OF_DAY, timeZone)
  if (!instant) return 'asof.held.invalid'
  if (Date.parse(instant) - 59_999 > now) return 'asof.held.future'
  return null
}

// ---- reservations on the stock grid ----------------------------------------------------------------------------------------

/** A grid row the way reservations are spread over it: its stock key at one place, its own hide reservations, its free stock. */
export interface ReservableLine {
  readonly id: string
  readonly siteId: string
  readonly itemId: string
  readonly colourId: string | null
  readonly lotId: string | null
  readonly locationCode: string
  readonly onHand: number
  readonly held: number
  /** What hides' own HIDE reservations hold of the row (the API's rows.reserved, summed). */
  readonly hideReserved: number
}

const keyOf = (siteId: string, itemId: string, colourId: string | null) => `${siteId}|${itemId}|${colourId ?? '-'}`
const round = (value: number) => Math.round(value * 10_000) / 10_000

/**
 * What reservations hold of each grid row (design st-grid "Reserved"; B-W2a-11: lot and any-lot reservations hold a
 * SITE's stock, not a place — "place them per lot row"): a row keeps its hides' own reservations; the reservations of a
 * lot (less what its hides' already hold) fill that lot's rows at the site in place order, as far as each row's free
 * stock goes; any-lot reservations then fill the item and colour's rows. What does not fit is the key's `over` (more
 * reserved than there is: the page says so, the figures never hide it).
 */
export function spreadReservations(lines: readonly ReservableLine[], reservations: readonly ReservedKey[]): { reserved: Map<string, number>; over: Map<string, number> } {
  const reserved = new Map<string, number>(lines.map((line) => [line.id, line.hideReserved]))
  const free = (line: ReservableLine) => Math.max(0, line.onHand - line.held - (reserved.get(line.id) ?? 0))
  const over = new Map<string, number>()
  const byPlace = (a: ReservableLine, b: ReservableLine) => a.locationCode.localeCompare(b.locationCode)
  const fill = (rows: readonly ReservableLine[], amount: number) => {
    let left = amount
    for (const row of [...rows].sort(byPlace)) {
      if (left <= 0) break
      const take = Math.min(left, free(row))
      if (take > 0) {
        reserved.set(row.id, round((reserved.get(row.id) ?? 0) + take))
        left = round(left - take)
      }
    }
    return left
  }
  const lotFirst = [...reservations].sort((a, b) => (a.lotId === null ? 1 : 0) - (b.lotId === null ? 1 : 0))
  for (const entry of lotFirst) {
    const key = keyOf(entry.siteId, entry.itemId, entry.itemColourId)
    const rows = lines.filter((line) => line.siteId === entry.siteId && line.itemId === entry.itemId && line.colourId === entry.itemColourId && (entry.lotId === null || line.lotId === entry.lotId))
    // The API's lot figure includes its hides' own reservations, which the rows already carry.
    const already = entry.lotId === null ? 0 : rows.reduce((sum, row) => sum + row.hideReserved, 0)
    const amount = round((decimalValue(entry.reserved) ?? 0) - already)
    const left = amount > 0 ? fill(rows, amount) : 0
    if (left > 0) over.set(key, round((over.get(key) ?? 0) + left))
  }
  return { reserved, over }
}

/** On hand − held − reserved (may be below 0 when over-reserved: drawn as such, never as free stock). */
export const availableOf = (onHand: number, held: number, reserved: number) => round(onHand - held - reserved)

// ---- why a row is held -----------------------------------------------------------------------------------------------------

export interface HoldFact {
  readonly holdId: string
  readonly reasonCode: string
  readonly placedAt: string
  readonly subjectType: 'Lot' | 'Hide'
}

/** The ACTIVE quality holds of lots and hides by the held record's id (one per record: the oldest). */
export function holdsBySubject(holds: readonly HoldRow[]): Map<string, HoldFact> {
  const result = new Map<string, HoldFact>()
  const oldest = [...holds].filter((hold) => hold.status === 'ACTIVE' && (hold.subjectType === 'Lot' || hold.subjectType === 'Hide')).sort((a, b) => a.placedAt.localeCompare(b.placedAt))
  for (const hold of oldest)
    for (const subject of hold.subjects) if (!result.has(subject.id)) result.set(subject.id, { holdId: hold.id, reasonCode: hold.reasonCode, placedAt: hold.placedAt, subjectType: hold.subjectType as 'Lot' | 'Hide' })
  return result
}

/** A HOLD (or WRITE_OFF) reason's words in the person's language; its code when the list does not know it. */
export const reasonLabel = (reasons: readonly PickerReason[], code: string, locale: string): string => {
  const reason = reasons.find((entry) => entry.code === code)
  if (!reason) return code
  return locale === 'en' ? reason.labelEn : locale === 'it' ? reason.labelIt : (reason.labelI18n[locale] ?? reason.labelEn)
}

/** The hold that holds a row: the hide's own, else its lot's. */
export const holdOfRow = (holds: ReadonlyMap<string, HoldFact>, row: { lotId: string | null; hideId: string | null }): HoldFact | null =>
  (row.hideId ? holds.get(row.hideId) : undefined) ?? (row.lotId ? holds.get(row.lotId) : undefined) ?? null

// ---- demands ---------------------------------------------------------------------------------------------------------------

/** What a demand reads as ("WO-00031", "SO-2026-0004 · 10"). */
export const demandLabel = (demand: Demand): string => (demand.type === 'WorkOrder' ? demand.number : `${demand.orderNumber} · ${demand.seq}`)
/** Where a demand opens (a record type of record-links). */
export const demandRecord = (demand: Demand): { type: 'WorkOrder' | 'SalesOrder'; id: string } => (demand.type === 'WorkOrder' ? { type: 'WorkOrder', id: demand.id } : { type: 'SalesOrder', id: demand.orderId })

// ---- putting lots (or hides) on hold ---------------------------------------------------------------------------------------

export interface HoldDraft {
  readonly reasonCode: string
  readonly reasonNote: string
  readonly askQuarantine: boolean
  readonly quarantineLocationId: string | null
}
export const blankHold = (): HoldDraft => ({ reasonCode: '', reasonNote: '', askQuarantine: false, quarantineLocationId: null })

/** A subject the preview says cannot be held, in our words (its state; the API's English never drawn). */
export function subjectProblemKey(subject: HoldPreview['subjects'][number]): string | null {
  if (!subject.problem) return null
  if (subject.state === 'REJECTED') return 'hold.problem.rejected'
  if (subject.state === 'CONSUMED') return 'hold.problem.consumed'
  if (subject.state === 'SCRAPPED') return 'hold.problem.scrapped'
  if (subject.id === null) return 'hold.problem.notFound'
  return 'hold.problem.other'
}

/** Why "Put on hold" is held (a key), or null. */
export function holdHeldKey(draft: HoldDraft, reasons: readonly PickerReason[], preview: HoldPreview | null, busy: boolean): string | null {
  if (busy) return 'hold.held.busy'
  if (!preview) return 'hold.held.preview'
  if (preview.subjects.some((subject) => subject.problem)) return 'hold.held.problem'
  if (!draft.reasonCode) return 'hold.held.reason'
  const reason = reasons.find((entry) => entry.code === draft.reasonCode)
  if (reason?.needsDetail && !draft.reasonNote.trim()) return 'hold.held.note'
  if (draft.reasonNote.length > 500) return 'hold.held.long'
  if (draft.askQuarantine && !draft.quarantineLocationId) return 'hold.held.place'
  return null
}

/** A refused hold in our words. */
export function holdProblem(error: unknown): Phrase {
  return writeProblem(error, (paths, fault) => {
    if (fault.kind === 'forbidden') return phrase('hold.problem.forbidden')
    if (paths.some((path) => path.includes('subjectIds'))) return phrase('hold.problem.subjects')
    if (paths.some((path) => path.includes('reasonCode'))) return phrase('hold.problem.reasonCode')
    if (paths.some((path) => path.includes('reasonNote'))) return phrase('hold.problem.reasonNote')
    if (paths.some((path) => path.includes('quarantine'))) return phrase('hold.problem.place')
    return null
  })
}

// ---- reserving to a work order ---------------------------------------------------------------------------------------------

export const RESERVE_REFUSALS = ['HIDE_NOT_IN_STOCK', 'HIDE_RESERVED', 'LOT_HELD', 'NOT_AVAILABLE', 'LOT_NOT_AVAILABLE'] as const

/** The line a refusal names, and its code (`body/lines/<i>/refusal/<CODE>`). */
export function refusalsOf(error: unknown): { index: number; code: string }[] {
  if (!isApiError(error)) return []
  return error.issues.flatMap((issue) => {
    const match = /^body\/lines\/(\d+)\/refusal\/([A-Z_]+)$/.exec(issuePath(issue))
    return match ? [{ index: Number(match[1]), code: match[2]! }] : []
  })
}

/** A refused reservation in our words: the first line's refusal by its code, the demand's state, or the kind. */
export function reserveProblem(error: unknown): Phrase {
  const refusal = refusalsOf(error)[0]
  if (refusal && (RESERVE_REFUSALS as readonly string[]).includes(refusal.code)) return phrase(`reserve.refusal.${refusal.code}`, { count: refusalsOf(error).length })
  return writeProblem(error, (paths, fault) => {
    if (fault.kind === 'forbidden') return phrase('reserve.problem.forbidden')
    if (paths.some((path) => path.includes('workOrderId'))) return phrase('reserve.problem.workOrder')
    if (fault.kind === 'conflict' && paths.length === 0) return phrase('reserve.problem.notOpen')
    return null
  })
}

/** Why "Reserve N hides" is held (a key), or null: busy, none free, no work order picked. */
export function reserveHeldKey(model: { readonly hides: readonly { why: Phrase | null }[]; readonly workOrderId: string | null; readonly posting: boolean }): string | null {
  if (model.posting) return 'reserve.held.busy'
  if (!model.hides.some((hide) => hide.why === null)) return 'reserve.held.none'
  if (!model.workOrderId) return 'reserve.held.workOrder'
  return null
}

// ---- writing off -----------------------------------------------------------------------------------------------------------

/** What is written off: one stock key at one place (Movements), or hides whole (Hides › Scrap N hides). */
export type WriteOffTarget =
  | {
      readonly kind: 'quantity'
      readonly siteId: string
      readonly item: { id: string; code: string; name: string; baseUom: Uom }
      readonly colour: { id: string; code: string } | null
      readonly lot: { id: string; code: string } | null
      readonly location: { id: string; code: string; name: string }
      /** On hand at that place (base unit). */
      readonly onHand: string
      /** Per base unit with the cost grain (the lot's, else the standard), for the value leaving stock. */
      readonly unitCost?: string | null
      readonly currency?: string | null
      /** A quality hold on the lot (the button is held with its words). */
      readonly hold?: HoldFact | null
    }
  | {
      readonly kind: 'hides'
      readonly siteId: string
      readonly hides: readonly { id: string; code: string; lotId: string; area: string; uom: Uom; hold?: HoldFact | null; reservedFor?: string | null }[]
      /** The value leaving stock with the cost grain (minor units), when known. */
      readonly value?: { amount: number; currency: string } | null
    }

export interface WriteOffDraft {
  readonly reasonCode: string
  readonly note: string
  readonly reference: string
  readonly quantity: string
  /** The photo taken or chosen (sent after the write-off is posted: its record is the write-off). */
  readonly photo: CapturedPhoto | null
  /** The camera step is open. */
  readonly photoStep: boolean
  readonly openNcr: boolean
  /** How serious the NCR's problem is (the NCR needs it: the lot or hide does not say). */
  readonly ncrSeverity: NcrSeverity | ''
}
export const NCR_SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const
export type NcrSeverity = (typeof NCR_SEVERITIES)[number]
export const blankWriteOff = (): WriteOffDraft => ({ reasonCode: '', note: '', reference: '', quantity: '', photo: null, photoStep: false, openNcr: false, ncrSeverity: '' })

/** A typed quantity ("1,5", "1.5", "1 234,5") → a number; null when it is not one. */
export function typedNumber(text: string): number | null {
  const plain = typedDecimal(text)
  return plain === null ? null : Number(plain)
}

/** The quantity as the API takes it (four decimals at most), or null. */
export function quantityText(text: string): string | null {
  const value = typedNumber(text)
  return value === null || value <= 0 ? null : String(Math.round(value * 10_000) / 10_000)
}

/** Why "Write off" is held (a key with its values), or null. */
export function writeOffHeld(target: WriteOffTarget, draft: WriteOffDraft, reasons: readonly PickerReason[], busy: boolean): Phrase | null {
  if (busy) return phrase('wo.held.busy')
  if (target.kind === 'hides') {
    if (target.hides.length === 0) return phrase('wo.held.noHides')
    const held = target.hides.find((hide) => hide.hold)
    if (held) return phrase('wo.held.onHold', { code: held.code })
    const reserved = target.hides.find((hide) => hide.reservedFor)
    if (reserved) return phrase('wo.held.reserved', { code: reserved.code, demand: reserved.reservedFor! })
  } else {
    if (target.hold) return phrase('wo.held.lotOnHold', { code: target.lot?.code ?? '' })
    const value = typedNumber(draft.quantity)
    if (value === null || value <= 0) return phrase('wo.held.quantity')
    if (value > (decimalValue(target.onHand) ?? 0) + 0.00005) return phrase('wo.held.tooMuch', { quantity: target.onHand })
  }
  if (!draft.reasonCode) return phrase('wo.held.reason')
  const reason = reasons.find((entry) => entry.code === draft.reasonCode)
  if (reason?.needsDetail && !draft.note.trim()) return phrase('wo.held.note')
  if (draft.note.length > 500) return phrase('wo.held.long')
  if (draft.openNcr && !draft.ncrSeverity) return phrase('wo.held.severity')
  return null
}

/** The write-off's lines for the API. */
export function writeOffLines(target: WriteOffTarget, draft: WriteOffDraft): WriteOffLine[] {
  if (target.kind === 'hides') return target.hides.map((hide) => ({ hideId: hide.id }))
  return [{ itemId: target.item.id, itemColourId: target.colour?.id ?? null, lotId: target.lot?.id ?? null, fromLocationId: target.location.id, quantity: quantityText(draft.quantity) ?? '0' }]
}

/** The value leaving stock before it is posted (cost grain): the hides' known value, or quantity × unit cost. */
export function valueLeaving(target: WriteOffTarget, draft: WriteOffDraft): { amount: number; currency: string } | null {
  if (target.kind === 'hides') return target.value ?? null
  const cost = decimalValue(target.unitCost)
  const value = typedNumber(draft.quantity)
  if (cost === null || value === null || !target.currency) return null
  return { amount: Math.round(cost * value * 100), currency: target.currency }
}

/** A refused write-off in our words: a quality hold, a reserved hide, the stock gone, the reason, or the kind. */
export function writeOffProblem(error: unknown): Phrase {
  const refusal = refusalsOf(error)[0]
  if (refusal?.code === 'QUALITY_HOLD') return phrase('wo.problem.onHold')
  return writeProblem(error, (paths, fault) => {
    if (fault.kind === 'forbidden') return phrase('wo.problem.forbidden')
    if (paths.some((path) => /^body\/lines\/\d+\/hideId$/.test(path)) && fault.kind === 'conflict') return phrase('wo.problem.reserved')
    if (paths.some((path) => path === 'body/reasonCode')) return phrase('wo.problem.reasonCode')
    if (paths.some((path) => path === 'body/note')) return phrase('wo.problem.note')
    if (fault.kind === 'conflict' && paths.length === 0) return phrase('wo.problem.notInStock')
    return null
  })
}
