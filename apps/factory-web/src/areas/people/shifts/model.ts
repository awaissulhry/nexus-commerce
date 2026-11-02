import { daysFrom, eachDay, plusDays } from '@nexus/factory-domain/calendars/dates'
import { mondayOf, OFF_KEY, overtimeActionRefusal, SHIFT_LIMITS, type OvertimeAction, type OvertimeStatus } from '@nexus/factory-domain/people/shifts/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { CellWrite, FooterDay, LimitWarning, OvertimeInCell, OvertimeListed, OvertimeRequest, PlanPreview, Ref, Roster, RosterCell, RosterRow, RosterValue, ShiftChoice, ShiftSet, ShiftWindow } from './api'

/**
 * The pure rules of People › Shifts (B-W2b-60; MES-218, MES-222; design people.shifts): what this person may do (from the
 * session; the API checks each again), the page's address and its range, the roster as sheet rows (site › line › team ›
 * person, a foot row per line), a cell in short words, what a keystroke, the fill handle or Set shift writes (a cell a
 * person may not change is left out with its reason), undo that puts a cell back only while it holds what our edit wrote,
 * warnings in our own words from their rule and figures, overtime verbs held in words, the CSV and the paper.
 *
 * No figure about one person's work: planned hours appear only inside a cell's warning; the foot rows count the plan per
 * line and shift. Names stay inside the sheet and inside one request.
 */

export type Words = { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface ShiftsCan {
  /** people.shifts.view: the page. */
  view: boolean
  /** people.shifts.manage: every roster here. */
  manage: boolean
  /** people.shifts.team: the teams this person leads. */
  team: boolean
  /** people.overtime.manage: ask, record an answer, cancel. */
  overtime: boolean
  /** people.overtime.approve. */
  approve: boolean
  /** people.employees.manage: Assign's "Default shift" (Employee › Job & team, the one edit path). */
  defaultShift: boolean
  /** people.view or people.team.view: a name opens the employee record. */
  employees: boolean
  /** planning.view: "Shift patterns" opens Planning › Settings. */
  planning: boolean
}

export function shiftsCan(permissions: readonly string[]): ShiftsCan {
  const held = new Set(permissions)
  return {
    view: held.has('people.shifts.view'),
    manage: held.has('people.shifts.manage'),
    team: held.has('people.shifts.team'),
    overtime: held.has('people.overtime.manage'),
    approve: held.has('people.overtime.approve'),
    defaultShift: held.has('people.employees.manage'),
    employees: held.has('people.view') || held.has('people.team.view'),
    planning: held.has('planning.view'),
  }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

export const SPANS = ['week', 'month'] as const
export type Span = (typeof SPANS)[number]

export interface ShiftsAddress {
  span: Span
  /** The range's first day (any day of the week or month); a custom range also has `to`. */
  from: string | null
  to: string | null
  lineId: string | null
  teamId: string | null
  /** ?open=<id>: an overtime request. */
  open: string | null
  /** ?overtime=1: Request overtime (the palette, `o`). */
  isNew: boolean
}

export interface DayRange {
  from: string
  to: string
  /** The range is a whole week or a whole month of the address's span; false: picked by hand. */
  custom: boolean
}

const isDay = (value: string | null | undefined): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))

export function shiftsAddressOf(params: URLSearchParams | null): ShiftsAddress {
  const from = params?.get('from') ?? null
  const to = params?.get('to') ?? null
  return {
    span: params?.get('span') === 'month' ? 'month' : 'week',
    from: isDay(from) ? from : null,
    to: isDay(to) ? to : null,
    lineId: params?.get('line') || null,
    teamId: params?.get('team') || null,
    open: params?.get('open') || null,
    isNew: params?.get('overtime') === '1',
  }
}

/** The terms of a state (defaults left out); other terms (`print`, `mode`) are kept. */
export function shiftsAddressText(address: ShiftsAddress, keep?: URLSearchParams | null): string {
  const terms = new URLSearchParams()
  for (const [name, value] of keep?.entries() ?? []) if (!['span', 'from', 'to', 'line', 'team', 'open', 'overtime'].includes(name)) terms.set(name, value)
  if (address.span !== 'week') terms.set('span', address.span)
  if (address.from) terms.set('from', address.from)
  if (address.to) terms.set('to', address.to)
  if (address.lineId) terms.set('line', address.lineId)
  if (address.teamId) terms.set('team', address.teamId)
  if (address.open) terms.set('open', address.open)
  if (address.isNew) terms.set('overtime', '1')
  const text = terms.toString()
  return text ? `?${text}` : ''
}

const lastOfMonth = (date: string): string => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).toISOString().slice(0, 10)

/** The days the address shows: a week from its Monday, a month, or a range picked by hand (at most 42 days, the API's limit). */
export function rangeOf(address: Pick<ShiftsAddress, 'span' | 'from' | 'to'>, today: string): DayRange {
  if (address.from && address.to && address.to >= address.from) {
    const last = plusDays(address.from, SHIFT_LIMITS.rangeDays - 1)
    return { from: address.from, to: address.to > last ? last : address.to, custom: true }
  }
  const anchor = address.from ?? today
  if (address.span === 'month') {
    const first = `${anchor.slice(0, 7)}-01`
    return { from: first, to: lastOfMonth(first), custom: false }
  }
  const monday = mondayOf(anchor)
  return { from: monday, to: plusDays(monday, 6), custom: false }
}

/** `[` / `]`: the range before or after. */
export function movedRange(address: Pick<ShiftsAddress, 'span'>, range: DayRange, step: -1 | 1): Pick<ShiftsAddress, 'from' | 'to'> {
  if (range.custom) {
    const length = daysFrom(range.from, range.to) + 1
    return { from: plusDays(range.from, step * length), to: plusDays(range.to, step * length) }
  }
  if (address.span === 'month') {
    const year = Number(range.from.slice(0, 4))
    const month = Number(range.from.slice(5, 7)) - 1 + step
    return { from: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10), to: null }
  }
  return { from: plusDays(range.from, step * 7), to: null }
}

/** Calendar dates are written as they are: never moved by a time zone. */
export const dayInstant = (date: string): string => `${date}T12:00:00Z`
export const dayOfInstant = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
export const localDate = (date: string): Date => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))

/** The date picker's preset: the week of today, or some days later. */
export function weekFrom(today: string, days: number): { start: Date; end: Date } {
  const monday = mondayOf(plusDays(today, days))
  return { start: localDate(monday), end: localDate(plusDays(monday, 6)) }
}

const dateFormats = new Map<string, Intl.DateTimeFormat>()
function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let format = dateFormats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { ...options, timeZone: 'UTC' })
    dateFormats.set(key, format)
  }
  return format
}

/** "3 Nov". */
export const dayShort = (date: string, locale: string): string => dateFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(dayInstant(date)))
/** "Mon". */
export const weekdayShort = (date: string, locale: string): string => dateFormat(locale, { weekday: 'short' }).format(new Date(dayInstant(date)))
/** "Mon 3 Nov". */
export const dayLong = (date: string, locale: string): string => `${weekdayShort(date, locale)} ${dayShort(date, locale)}`
/** "27 Oct – 2 Nov". */
export const rangeText = (range: Pick<DayRange, 'from' | 'to'>, locale: string): string => `${dayShort(range.from, locale)} – ${dayShort(range.to, locale)}`

/** The week Copy last week fills: the one in view (a month or a long range: its first whole week) and the week it copies. */
export function copyWeeks(range: Pick<DayRange, 'from'>): { week: string; source: { from: string; to: string }; target: { from: string; to: string } } {
  const monday = mondayOf(range.from)
  const week = monday < range.from ? plusDays(monday, 7) : monday
  return { week, source: { from: plusDays(week, -7), to: plusDays(week, -1) }, target: { from: week, to: plusDays(week, 6) } }
}

// ---- a shift in words --------------------------------------------------------------------------------------------------------

const two = (value: number): string => String(value).padStart(2, '0')

/** "06:00"; a night shift's end past midnight reads as the clock does. */
export const clockFull = (minute: number): string => `${two(Math.floor(minute / 60) % 24)}:${two(minute % 60)}`
/** "06", "06:30". */
export const clockShort = (minute: number): string => (minute % 60 === 0 ? two(Math.floor(minute / 60) % 24) : clockFull(minute))
/** "06–14". */
export const windowClock = (window: Pick<ShiftWindow, 'startMinute' | 'endMinute'>): string => `${clockShort(window.startMinute)}–${clockShort(window.endMinute)}`

/** "9 h", "9 h 30 min", "45 min" (the same words in both languages). */
export function hoursWords(minutes: number): string {
  const whole = Math.floor(minutes / 60)
  const rest = Math.round(minutes - whole * 60)
  if (whole === 0) return `${rest} min`
  return rest === 0 ? `${whole} h` : `${whole} h ${rest} min`
}

/** The letter of a shift in a narrow cell: its choice's key, else its name's first letter, else a dot. */
export function shiftLetter(window: Pick<ShiftWindow, 'label' | 'startMinute' | 'endMinute'>, choices: readonly ShiftChoice[]): string {
  const choice = choices.find((entry) => entry.label === window.label && entry.startMinute === window.startMinute && entry.endMinute === window.endMinute)
  return choice?.key ?? window.label?.trim().charAt(0).toUpperCase() ?? '•'
}

/** A choice's name for a menu: "Morning 06–14". */
export const choiceText = (choice: Pick<ShiftChoice, 'label' | 'startMinute' | 'endMinute'>): string => `${choice.label ? `${choice.label} ` : ''}${windowClock(choice)}`

/** A value in words; a key of the page's catalogue when it has no name of its own. */
export function valueWords(value: RosterValue | null): Words | string {
  if (value === null) return { key: 'cell.none' }
  if (value.kind === 'OFF' || !value.shift) return { key: 'cell.off' }
  return choiceText(value.shift)
}

// ---- the sheet's rows --------------------------------------------------------------------------------------------------------

export interface LineRow {
  readonly kind: 'line'
  readonly id: string
  readonly site: Ref
  readonly line: Ref | null
  readonly people: number
}

export interface TeamRow {
  readonly kind: 'team'
  readonly id: string
  readonly team: Ref
  readonly people: number
}

export interface PersonRow {
  readonly kind: 'person'
  readonly id: string
  readonly row: RosterRow
  readonly cells: Readonly<Record<string, RosterCell>>
}

export interface FootRow {
  readonly kind: 'foot'
  readonly id: string
  readonly line: Ref | null
  readonly days: Readonly<Record<string, FooterDay>>
}

export type SheetRow = LineRow | TeamRow | PersonRow | FootRow

const lineKey = (siteId: string, lineId: string | null): string => `${siteId}:${lineId ?? 'none'}`

/** Site › line › team › person as the API sorted them, with a foot row (people per shift) closing each line. */
export function sheetRowsOf(roster: Pick<Roster, 'rows' | 'footer'>): SheetRow[] {
  const out: SheetRow[] = []
  const footer = new Map<string, Record<string, FooterDay>>()
  for (const day of roster.footer) {
    const key = lineKey(day.siteId, day.lineId)
    footer.set(key, { ...(footer.get(key) ?? {}), [day.date]: day })
  }
  const lines = new Map<string, RosterRow[]>()
  for (const row of roster.rows) {
    const key = lineKey(row.site.id, row.line?.id ?? null)
    lines.set(key, [...(lines.get(key) ?? []), row])
  }
  for (const [key, people] of lines) {
    const first = people[0]!
    out.push({ kind: 'line', id: `line:${key}`, site: first.site, line: first.line, people: people.length })
    let team: string | null = null
    for (const row of people) {
      const teamId = row.team?.id ?? null
      if (row.team && teamId !== team) out.push({ kind: 'team', id: `team:${key}:${row.team.id}`, team: row.team, people: people.filter((person) => person.team?.id === teamId).length })
      team = teamId
      out.push({ kind: 'person', id: row.employeeId, row, cells: Object.fromEntries(row.cells.map((cell) => [cell.date, cell])) })
    }
    out.push({ kind: 'foot', id: `foot:${key}`, line: first.line, days: footer.get(key) ?? {} })
  }
  return out
}

export const personRows = (rows: readonly SheetRow[]): PersonRow[] => rows.filter((row): row is PersonRow => row.kind === 'person')

/** The lines and teams people of this read are on, for the filters (kept across reads: a narrowed read must not shrink them). */
export function filterOptions(rows: readonly RosterRow[], known: { lines: readonly Ref[]; teams: readonly (Ref & { lineId: string | null })[] }): { lines: Ref[]; teams: (Ref & { lineId: string | null })[] } {
  const lines = new Map(known.lines.map((line) => [line.id, line]))
  const teams = new Map(known.teams.map((team) => [team.id, team]))
  for (const row of rows) {
    if (row.line) lines.set(row.line.id, row.line)
    if (row.team) teams.set(row.team.id, { ...row.team, lineId: row.line?.id ?? null })
  }
  const byCode = (a: Ref, b: Ref) => a.code.localeCompare(b.code)
  return { lines: [...lines.values()].sort(byCode), teams: [...teams.values()].sort(byCode) }
}

// ---- what a key, the fill handle or Set shift writes ------------------------------------------------------------------------

export interface CellRef {
  readonly employeeId: string
  readonly date: string
}

export const cellId = (employeeId: string, date: string): string => `${employeeId}::${date}`

export function setOfChoice(choice: ShiftChoice): ShiftSet {
  return { kind: 'WORK', patternId: choice.patternId, label: choice.label, startMinute: choice.startMinute }
}

/** What writes this value again: from its pattern, or as a typed window when it has none. */
export function setOfValue(value: RosterValue | null): ShiftSet | null {
  if (value === null) return null
  if (value.kind === 'OFF' || !value.shift) return { kind: 'OFF' }
  if (value.patternId) return { kind: 'WORK', patternId: value.patternId, label: value.shift.label, startMinute: value.shift.startMinute }
  return { kind: 'WORK', patternId: null, label: value.shift.label, startMinute: value.shift.startMinute, endMinute: value.shift.endMinute, breakMinutes: value.shift.breakMinutes }
}

/** A letter typed in a cell: O a day off, a choice's key that shift; undefined: not a shift's letter. */
export function setOfKey(key: string, choices: readonly ShiftChoice[]): ShiftSet | undefined {
  const letter = key.toUpperCase()
  if (letter === OFF_KEY) return { kind: 'OFF' }
  const choice = choices.find((entry) => entry.key === letter)
  return choice ? setOfChoice(choice) : undefined
}

export const OPTION_OFF = 'off'
export const OPTION_DEFAULT = 'default'
export const optionOf = (choice: Pick<ShiftChoice, 'patternId' | 'label' | 'startMinute'>): string => `${choice.patternId}|${choice.label ?? ''}|${choice.startMinute}`

/** An option of the cell's list, or null = back to the default; undefined: not an option. */
export function setOfOption(option: string, choices: readonly ShiftChoice[]): ShiftSet | null | undefined {
  if (option === OPTION_OFF) return { kind: 'OFF' }
  if (option === OPTION_DEFAULT) return null
  const choice = choices.find((entry) => optionOf(entry) === option)
  return choice ? setOfChoice(choice) : undefined
}

/** The cell's option in the list (a phone's select): its shift, a day off, or the default. */
export function optionOfCell(cell: Pick<RosterCell, 'source' | 'value'>): string {
  if (cell.source !== 'ROSTER' || !cell.value) return OPTION_DEFAULT
  if (cell.value.kind === 'OFF' || !cell.value.shift) return OPTION_OFF
  return cell.value.patternId ? optionOf({ patternId: cell.value.patternId, label: cell.value.shift.label, startMinute: cell.value.shift.startMinute }) : OPTION_DEFAULT
}

/**
 * What the grid hands an edit: the list's option, the source cell of the fill handle (its value, the default shift's too:
 * a faint Morning filled across days writes Morning), or pasted text (a letter, or a cell's words).
 */
export function setOfEdit(value: unknown, choices: readonly ShiftChoice[]): ShiftSet | null | undefined {
  if (value && typeof value === 'object' && 'source' in value) return setOfValue((value as RosterCell).value)
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const option = setOfOption(text, choices)
  if (option !== undefined) return option
  if (text.length === 1) return setOfKey(text, choices)
  const named = choices.find((choice) => choiceText(choice).toLowerCase() === text.toLowerCase())
  return named ? setOfChoice(named) : undefined
}

const sameWindow = (shift: ShiftWindow | null, set: Extract<ShiftSet, { kind: 'WORK' }>): boolean =>
  !!shift && shift.label === set.label && shift.startMinute === set.startMinute && (set.patternId !== null || (shift.endMinute === set.endMinute && shift.breakMinutes === set.breakMinutes))

/** The cell already says it: a roster row with this value, or the default when asked to go back to it. */
export function holds(cell: Pick<RosterCell, 'source' | 'value'>, set: ShiftSet | null): boolean {
  if (set === null) return cell.source !== 'ROSTER'
  if (cell.source !== 'ROSTER' || !cell.value) return false
  if (set.kind === 'OFF') return cell.value.kind === 'OFF'
  return cell.value.kind === 'WORK' && sameWindow(cell.value.shift, set)
}

/** What a cell holds as our edit would write it (a default shift: null). */
export const setOfCell = (cell: Pick<RosterCell, 'source' | 'value'>): ShiftSet | null => (cell.source === 'ROSTER' ? setOfValue(cell.value) : null)

/** Why this cell may not take this value, as a key of `held.`; null: it may. */
export function cellHeld(row: Pick<RosterRow, 'canEdit'>, cell: Pick<RosterCell, 'issue'>, set: ShiftSet | null): string | null {
  if (!row.canEdit) return 'held.noEdit'
  if (set?.kind === 'WORK' && cell.issue === 'NOT_EMPLOYED') return 'held.notEmployed'
  if (set?.kind === 'WORK' && cell.issue === 'AFTER_LAST_DAY') return 'held.afterLastDay'
  return null
}

export interface PlannedCell extends CellRef {
  readonly before: ShiftSet | null
  readonly after: ShiftSet | null
}

export interface CellPlan {
  readonly changes: readonly PlannedCell[]
  /** Cells left out, each with why. */
  readonly held: ReadonlyArray<CellRef & { readonly why: string }>
}

export type SheetIndex = ReadonlyMap<string, PersonRow>
export const sheetIndex = (rows: readonly SheetRow[]): SheetIndex => new Map(personRows(rows).map((row) => [row.row.employeeId, row]))

/** The cells that change: nobody's cell is written twice, a cell that already says it is left alone. */
export function planOf(index: SheetIndex, targets: readonly CellRef[], setFor: ShiftSet | null | ((target: CellRef) => ShiftSet | null | undefined)): CellPlan {
  const seen = new Set<string>()
  const changes: PlannedCell[] = []
  const held: Array<CellRef & { why: string }> = []
  for (const target of targets) {
    const id = cellId(target.employeeId, target.date)
    if (seen.has(id)) continue
    seen.add(id)
    const person = index.get(target.employeeId)
    const cell = person?.cells[target.date]
    if (!person || !cell) continue
    const set = typeof setFor === 'function' ? setFor(target) : setFor
    if (set === undefined) continue
    const why = cellHeld(person.row, cell, set)
    if (why) held.push({ ...target, why })
    else if (!holds(cell, set)) changes.push({ ...target, before: setOfCell(cell), after: set })
  }
  return { changes, held }
}

/** The write of planned cells, with the version each cell has NOW. */
export function writesOf(changes: readonly PlannedCell[], index: SheetIndex): CellWrite[] {
  return changes.map((change) => ({ employeeId: change.employeeId, date: change.date, version: index.get(change.employeeId)?.cells[change.date]?.entry?.version ?? null, set: change.after }))
}

/** A write of many cells goes in pieces of the API's limit. */
export function piecesOf<T>(items: readonly T[], size: number = SHIFT_LIMITS.cells): T[][] {
  const pieces: T[][] = []
  for (let at = 0; at < items.length; at += size) pieces.push(items.slice(at, at + size))
  return pieces
}

/**
 * ⌘Z / ⌘⇧Z: a batch back (or forward), only for the cells that still hold what our edit wrote; a cell someone changed
 * since stays as it is and is counted.
 */
export function replayOf(batch: readonly PlannedCell[], direction: 'undo' | 'redo', index: SheetIndex): { changes: PlannedCell[]; kept: number } {
  const changes: PlannedCell[] = []
  let kept = 0
  for (const change of batch) {
    const cell = index.get(change.employeeId)?.cells[change.date]
    const expected = direction === 'undo' ? change.after : change.before
    const wanted = direction === 'undo' ? change.before : change.after
    if (!cell || !holds(cell, expected)) kept++
    else changes.push({ employeeId: change.employeeId, date: change.date, before: expected, after: wanted })
  }
  return { changes, kept }
}

/** A preview's cells as an edit, so ⌘Z puts an assignment or a copied week back too. */
export function plannedOfPreview(preview: Pick<PlanPreview, 'changes'>): PlannedCell[] {
  return preview.changes.map((change) => ({
    employeeId: change.employeeId,
    date: change.date,
    before: change.fromSource === 'ROSTER' ? setOfValue(change.from) : null,
    after: change.toSource === 'ROSTER' ? setOfValue(change.to) : null,
  }))
}

/** A write of ours, until its live echo comes back (the event names its first and last day, not its author). */
export interface OwnWrite {
  readonly from: string
  readonly to: string
  readonly at: number
}

export function ownWriteOf(cells: readonly CellRef[], at: number): OwnWrite | null {
  const dates = cells.map((cell) => cell.date).sort()
  return dates.length > 0 ? { from: dates[0]!, to: dates.at(-1)!, at } : null
}

/** A live change that echoes a write of ours is taken off the list; any other is somebody else's. */
export function echoOf(own: readonly OwnWrite[], from: string | null, to: string | null, now: number, within: number): { own: OwnWrite[]; mine: boolean } {
  const fresh = own.filter((entry) => now - entry.at <= within)
  const at = fresh.findIndex((entry) => entry.from === from && entry.to === to)
  return at < 0 ? { own: fresh, mine: false } : { own: fresh.filter((_, index) => index !== at), mine: true }
}

/** The people and days of the cells selected (for Assign and Set shift). */
export function pickOf(cells: readonly CellRef[]): { employeeIds: string[]; from: string | null; to: string | null } {
  const dates = [...new Set(cells.map((cell) => cell.date))].sort()
  return { employeeIds: [...new Set(cells.map((cell) => cell.employeeId))], from: dates[0] ?? null, to: dates.at(-1) ?? null }
}

/** The cells a selected range covers: rows that are people, columns that are days. */
export function cellsOfRange(rows: readonly SheetRow[], range: { readonly startRow: number; readonly endRow: number; readonly dates: readonly string[] }): CellRef[] {
  const first = Math.min(range.startRow, range.endRow)
  const last = Math.max(range.startRow, range.endRow)
  const out: CellRef[] = []
  for (let at = first; at <= last; at++) {
    const row = rows[at]
    if (row?.kind !== 'person') continue
    for (const date of range.dates) out.push({ employeeId: row.row.employeeId, date })
  }
  return out
}

// ---- publish -----------------------------------------------------------------------------------------------------------------

export interface DraftSummary {
  /** Cells changed and not published yet: the workers do not see them. */
  drafts: number
  /** Of those, how many a limit that blocks holds. */
  blocked: number
}

export function draftsOf(rows: readonly RosterRow[]): DraftSummary {
  let drafts = 0
  let blocked = 0
  for (const row of rows) {
    if (!row.canEdit) continue
    for (const cell of row.cells) {
      if (cell.entry?.status !== 'DRAFT') continue
      drafts++
      if (cell.warnings.some((warning) => warning.level === 'BLOCK')) blocked++
    }
  }
  return { drafts, blocked }
}

// ---- warnings in our words ---------------------------------------------------------------------------------------------------

const number = (values: LimitWarning['values'], name: string): number => {
  const value = values[name]
  return typeof value === 'number' ? value : 0
}
const text = (values: LimitWarning['values'], name: string): string => {
  const value = values[name]
  return value === undefined ? '' : String(value)
}

/** A warning in the page's language: from its rule and figures, never the API's English. */
export function warningWords(warning: Pick<LimitWarning, 'rule' | 'values'>, locale: string): Words {
  const { values } = warning
  const limit = hoursWords(number(values, 'limitMinutes'))
  switch (warning.rule) {
    case 'DAILY_REST':
      if ('spanMinutes' in values) return { key: 'warn.DAILY_REST.span', params: { span: hoursWords(number(values, 'spanMinutes')), from: text(values, 'from'), to: text(values, 'to'), limit } }
      return { key: 'warn.DAILY_REST.rest', params: { rest: hoursWords(number(values, 'restMinutes')), from: text(values, 'from'), day: dayShort(text(values, 'fromDate'), locale), to: text(values, 'to'), limit } }
    case 'BREAK_AFTER':
      return { key: 'warn.BREAK_AFTER', params: { work: hoursWords(number(values, 'workMinutes')), from: text(values, 'from'), to: text(values, 'to'), pause: hoursWords(number(values, 'breakMinutes')), needed: hoursWords(number(values, 'neededMinutes')), limit } }
    case 'WEEKLY_AVERAGE':
      return {
        key: 'warn.WEEKLY_AVERAGE',
        params: { week: hoursWords(number(values, 'weekMinutes')), day: dayShort(text(values, 'week'), locale), average: hoursWords(number(values, 'averageMinutes')), weeks: number(values, 'weeks'), limit, months: number(values, 'referenceMonths') },
      }
    case 'OVERTIME_YEARLY_CAP':
      return { key: 'warn.OVERTIME_YEARLY_CAP', params: { year: text(values, 'year'), planned: hoursWords(number(values, 'plannedMinutes')), limit } }
  }
}

export type CellTone = 'none' | 'warn' | 'block'

/** The tone of warnings: the worst one. */
export const toneOf = (warnings: readonly Pick<LimitWarning, 'level'>[]): CellTone => (warnings.some((warning) => warning.level === 'BLOCK') ? 'block' : warnings.length > 0 ? 'warn' : 'none')

// ---- overtime ----------------------------------------------------------------------------------------------------------------

export const STAGE_TONE: Readonly<Record<OvertimeStatus, 'neutral' | 'info' | 'success' | 'warning'>> = { DRAFT: 'neutral', ASKED: 'info', AGREED: 'warning', APPROVED: 'success', DONE: 'success', CANCELLED: 'neutral' }

/** The overtime a cell shows ('+2 h'): what is asked or agreed, a declined answer left out. */
export function overtimeOfCell(items: readonly OvertimeInCell[]): { minutes: number; approved: boolean } | null {
  const shown = items.filter((item) => item.answer !== 'DECLINED' && item.stage !== 'CANCELLED')
  if (shown.length === 0) return null
  return { minutes: shown.reduce((sum, item) => sum + item.minutes, 0), approved: shown.every((item) => item.stage === 'APPROVED' || item.stage === 'DONE') }
}

type RequestFacts = Pick<OvertimeRequest, 'status' | 'counts'>

/** Why this verb is held on this request, as a key; null: it may run. The rule is the domain's, the words are ours. */
export function overtimeHeld(action: OvertimeAction, request: RequestFacts): string | null {
  const refused = overtimeActionRefusal(action, { status: request.status, asked: request.counts.asked, agreed: request.counts.agreed })
  if (refused === null) return null
  const { status } = request
  if (status === 'DONE') return 'held.requestDone'
  if (status === 'CANCELLED') return 'held.requestCancelled'
  if (status === 'APPROVED') return action === 'APPROVE' ? 'held.alreadyApproved' : 'held.requestApproved'
  if (action === 'EDIT') return 'held.alreadyAsked'
  if (action === 'ASK') return status === 'DRAFT' ? 'held.noPeople' : 'held.alreadyAsked'
  if (action === 'ANSWER') return 'held.notAsked'
  if (action === 'APPROVE') return status === 'DRAFT' ? 'held.notAsked' : 'held.nobodyAgreed'
  return 'held.requestClosed'
}

/** A list row may be selected when some bulk verb applies to it (ask a draft, approve what somebody agreed to). */
export const requestSelectable = (request: RequestFacts & { readonly stage: OvertimeStatus }): boolean => overtimeHeld('ASK', request) === null || overtimeHeld('APPROVE', request) === null

/** The selected rows' bulk verbs: what each may run. */
export function bulkOfRequests(requests: readonly OvertimeListed[], can: Pick<ShiftsCan, 'overtime' | 'approve'>): { ask: OvertimeListed[]; approve: OvertimeListed[] } {
  return {
    ask: can.overtime ? requests.filter((request) => overtimeHeld('ASK', request) === null) : [],
    approve: can.approve ? requests.filter((request) => overtimeHeld('APPROVE', request) === null) : [],
  }
}

/** The list's limit column: people a limit warns or holds (never whose). */
export const checksWords = (checks: OvertimeListed['checks']): Words | null =>
  checks.block > 0 ? { key: 'ot.checks.block', params: { count: checks.block } } : checks.warn > 0 ? { key: 'ot.checks.warn', params: { count: checks.warn } } : null

/** A time typed as "18:30" → minutes, null (blank), or undefined (not a time). */
export function minuteOfClock(value: string): number | null | undefined {
  const typed = value.trim()
  if (!typed) return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(typed)
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------

/** Every refusal of the shifts API the page says in words (`refusal.<CODE>`). */
export const SHIFT_REFUSALS = [
  'LIMIT_BLOCKED',
  'MONTH_CLOSED',
  'NOT_EMPLOYED',
  'AFTER_LAST_DAY',
  'OTHER_SITE',
  'NOT_ASKED',
  'ANSWERED',
  'ANSWERED_IN_OFFICE',
  'DAY_PASSED',
  'LAST_YES',
  'LINE_NOT_OF_SITE',
  'STALE',
  'NOT_EDIT',
  'NOT_ASK',
  'NOT_ADD_PEOPLE',
  'NOT_REMOVE_PEOPLE',
  'NOT_ANSWER',
  'NOT_APPROVE',
  'NOT_CANCEL',
] as const

export function refusalOf(error: unknown): (typeof SHIFT_REFUSALS)[number] | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!path.startsWith('refusal/')) continue
    const code = path.slice('refusal/'.length)
    if ((SHIFT_REFUSALS as readonly string[]).includes(code)) return code as (typeof SHIFT_REFUSALS)[number]
  }
  return null
}

/** The cells a blocking limit held (`limits/<employeeId>/<date>`). */
export function heldCells(error: unknown): CellRef[] {
  if (!isApiError(error)) return []
  return error.issues.flatMap((issue) => {
    const match = /^limits\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/.exec(issuePath(issue))
    return match ? [{ employeeId: match[1]!, date: match[2]! }] : []
  })
}

/** The words of a failed call: a refusal by its code, else the kind of failure. */
export function problemOf(error: unknown): Words {
  const refusal = refusalOf(error)
  if (refusal) return { key: `refusal.${refusal}` }
  if (!isApiError(error)) return { key: 'problem.unavailable' }
  switch (error.kind) {
    case 'signed_out':
      return { key: 'problem.signedOut' }
    case 'forbidden':
      return { key: 'problem.forbidden' }
    case 'step_up':
      return { key: 'problem.stepUp' }
    case 'not_found':
      return { key: 'problem.notFound' }
    case 'conflict':
      return { key: 'problem.conflict' }
    case 'rate_limited':
      return { key: 'problem.rateLimited' }
    case 'invalid':
      return { key: 'problem.invalid' }
    default:
      return { key: 'problem.unavailable' }
  }
}

/** A failed read in one message key. */
export const readProblem = (error: unknown): string => (isApiError(error) && error.kind === 'forbidden' ? 'problem.forbidden' : isApiError(error) && error.kind === 'invalid' ? 'problem.tooMany' : 'problem.unavailable')

// ---- CSV and paper -----------------------------------------------------------------------------------------------------------

/** One person's day on paper or in the CSV: the shift or the day off, nothing else (no absence, no overtime, no warning). */
export function paperCell(cell: RosterCell | undefined, off: string): string {
  if (!cell?.value) return ''
  if (cell.value.kind === 'OFF' || !cell.value.shift) return off
  return choiceText(cell.value.shift)
}

export interface PaperLine {
  readonly key: string
  readonly site: Ref
  readonly line: Ref | null
  readonly people: readonly PersonRow[]
  readonly foot: Readonly<Record<string, FooterDay>>
}

/** A page per line for the notice board. */
export function paperLines(rows: readonly SheetRow[]): PaperLine[] {
  const out: Array<{ key: string; site: Ref; line: Ref | null; people: PersonRow[]; foot: Record<string, FooterDay> }> = []
  for (const row of rows) {
    if (row.kind === 'line') out.push({ key: row.id, site: row.site, line: row.line, people: [], foot: {} })
    else if (row.kind === 'person') out.at(-1)?.people.push(row)
    else if (row.kind === 'foot' && out.length > 0) out[out.length - 1]!.foot = { ...row.days }
  }
  return out
}

export const datesOf = (range: Pick<DayRange, 'from' | 'to'>): string[] => eachDay(range.from, range.to)

/** The CSV of the view: line, team, person, a column per day. Names as the sheet shows them; no figure about anyone's work. */
export function rosterCsvRows(rows: readonly SheetRow[], dates: readonly string[], off: string): string[][] {
  return personRows(rows).map(({ row, cells }) => [row.site.code, row.line?.code ?? '', row.team?.code ?? '', row.name, ...dates.map((date) => paperCell(cells[date], off))])
}
