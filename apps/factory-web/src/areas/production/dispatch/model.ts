import type { LoadBarWords, PlanningBoardWords, PlanningBucket, PlanningCard, PlanningLane, PlanningMark, PlanningPlace } from '@nexus/ui/patterns/planning-board/index'
import { DISPATCH_REFUSALS, REST_CARD } from '@nexus/factory-domain/production/dispatch/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatDate, formatNumber, type FormatPlace } from '../../../lib/i18n/format'
import type { Translate } from '../../../lib/i18n/messages'
import type { Phrase } from '../_shared/model'
import type { DispatchBoard, DispatchCard, DispatchLine, LaneOperator, LineLoadFigures, MoveBody, PickedOperator, SkillLevel, StationLane } from './api'

/**
 * Production › Dispatch's rules, without a screen (B-W2b-56; SCR-138; design production.dispatch): the page's address, what
 * a person may do, the API board → the DS PlanningBoard's lanes and cards (`layout="columns"`: stations as columns, Not
 * assigned as the tray, the one day as the only bucket), the app's held drops, what a move asks of the API, the load and
 * every refusal in our words (never the API's English: `words`, `sourceWords` and the check's message are dropped by the
 * schemas). A person's name stands beside a station or a card only, and only where the board brings one (office, a site
 * whose floor records name workers); no figure, filter, group or total by person (Statuto dei Lavoratori art. 4; Owner W1).
 */

export const DISPATCH_NAMESPACE = 'dispatch'
export const BUCKET_ID = 'day'
/** A word asked for before a warned assignment is kept. */
export const REASON_MIN = 3

const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- what a person may do --------------------------------------------------------------------------------------------------

export interface DispatchCan {
  readonly view: boolean
  readonly manage: boolean
  readonly workOrders: boolean
}

export function dispatchCanOf(permissions: readonly string[]): DispatchCan {
  const held = new Set(permissions)
  return { view: held.has('production.dispatch.view'), manage: held.has('production.dispatch.manage'), workOrders: held.has('workorders.view') }
}

// ---- the address -----------------------------------------------------------------------------------------------------------

export interface DispatchAddress {
  /** The site when the top bar says All sites (else the top bar's). */
  readonly site: string | null
  /** The line the board is narrowed to (null: every line). */
  readonly line: string | null
  /** The day (null: the site's today). */
  readonly date: string | null
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function addressOf(params: { get: (name: string) => string | null } | null | undefined): DispatchAddress {
  const date = params?.get('date') ?? null
  return { site: params?.get('site') || null, line: params?.get('line') || null, date: date && DAY.test(date) ? date : null }
}

export function addressText(address: DispatchAddress): string {
  const terms = new URLSearchParams()
  if (address.site) terms.set('site', address.site)
  if (address.line) terms.set('line', address.line)
  if (address.date) terms.set('date', address.date)
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** The print window: the lines in view (one paper each) or one station, for the day on the board. */
export function printHrefOf(prefix: string, target: { readonly lines?: readonly string[]; readonly station?: string }, day: string): string {
  const terms = new URLSearchParams()
  for (const line of target.lines ?? []) terms.append('line', line)
  if (target.station) terms.set('station', target.station)
  terms.set('date', day)
  return `${prefix}/production/dispatch/print?${terms.toString()}`
}

/** What a print window prints: the lines (one paper each), or one station. */
export function printAddressOf(params: { getAll: (name: string) => string[]; get: (name: string) => string | null } | null | undefined): { readonly lines: readonly string[]; readonly station: string | null; readonly date: string | null } {
  const date = params?.get('date') ?? null
  return { lines: params?.getAll('line') ?? [], station: params?.get('station') || null, date: date && DAY.test(date) ? date : null }
}

// ---- the board's places ----------------------------------------------------------------------------------------------------

export const stationsOf = (board: DispatchBoard): StationLane[] => [...board.lines.flatMap((line) => line.stations), ...board.otherStations]

export const stationOf = (board: DispatchBoard, stationId: string | null): StationLane | null => (stationId ? (stationsOf(board).find((station) => station.id === stationId) ?? null) : null)

export const lineOf = (board: DispatchBoard, lineId: string | null): DispatchLine | null => (lineId ? (board.lines.find((line) => line.id === lineId) ?? null) : null)

export const allCardsOf = (board: DispatchBoard): DispatchCard[] => [...board.notAssigned, ...stationsOf(board).flatMap((station) => station.cards)]

/** A station's short name on the board: "L1 › SEW-01"; a station with no line by its own code. */
export function stationLabel(board: DispatchBoard, station: Pick<StationLane, 'code' | 'lineId'>): string {
  const line = lineOf(board, station.lineId)
  return line ? `${line.code} › ${station.code}` : station.code
}

export const levelKey = (level: SkillLevel): string => `level.${level}`

/** "Giulia · Expert" (the level for the operation asked; a trainee says so). */
export function operatorWords(operator: Pick<LaneOperator, 'name' | 'level' | 'trainee'>, t: Translate): string {
  const level = operator.level ? t(levelKey(operator.level)) : null
  const parts = [operator.name, level, operator.trainee ? t('operator.trainee') : null].filter(Boolean)
  return parts.join(' · ')
}

/** Where someone assigned stands, in a word: only what the board brought (the gate open, a person who runs the board). */
export function presencePhrase(operator: Pick<LaneOperator, 'presence'>): { readonly words: Phrase; readonly tone: 'warning' | 'neutral' | 'info' } | null {
  switch (operator.presence) {
    case 'NOT_IN':
      return { words: phrase('presence.NOT_IN'), tone: 'warning' }
    case 'OFF':
      return { words: phrase('presence.OFF'), tone: 'warning' }
    case 'LATER':
      return { words: phrase('presence.LATER'), tone: 'neutral' }
    case 'ON_BREAK':
      return { words: phrase('presence.ON_BREAK'), tone: 'info' }
    default:
      return null
  }
}

// ---- load against minutes ------------------------------------------------------------------------------------------------

/** "Queued 2,410 min · available 2,160 min · 250 min over": said again from the figures, in the page's language. */
export function loadPhrase(load: LineLoadFigures, locale: FormatPlace['locale']): Phrase {
  const number = (value: number) => formatNumber(value, locale)
  const params = { queued: number(load.queuedMinutes), available: number(load.availableMinutes) }
  return load.overMinutes > 0 ? phrase('load.over', { ...params, minutes: number(load.overMinutes) }) : phrase('load.spare', { ...params, minutes: number(load.spareMinutes) })
}

/**
 * Why a line's available minutes come from the planned people, from the facts on the board (the API's order: the gate, the
 * day, too few to show, the shift not begun); null: from the clock.
 */
export function plannedWhy(board: Pick<DispatchBoard, 'attendance' | 'day' | 'today'>, load: Pick<LineLoadFigures, 'source' | 'people'>): 'ATTENDANCE_OFF' | 'NOT_TODAY' | 'TOO_FEW' | 'BEFORE_THE_SHIFT' | null {
  if (load.source !== 'PLANNED') return null
  if (!board.attendance.open) return 'ATTENDANCE_OFF'
  if (board.day !== board.today) return 'NOT_TODAY'
  if (load.people === null) return 'TOO_FEW'
  return 'BEFORE_THE_SHIFT'
}

/** The design's "absent: a number": a line's count, today, with the gate open, once the group is big enough to show. */
export function absentOf(board: Pick<DispatchBoard, 'attendance' | 'day' | 'today'>, load: Pick<LineLoadFigures, 'absent'>): number | null {
  return board.attendance.open && board.day === board.today ? load.absent : null
}

// ---- the DS board --------------------------------------------------------------------------------------------------------

export interface PlacedCard {
  /** The board's own id of the card: it stays through a move, which is what lets Undo find the card (see `boardIdsOf`). */
  readonly boardId: string
  readonly card: DispatchCard
}

/**
 * The API's card id names its place, so a moved card comes back with a new one; the DS board keeps its undo list by card id.
 * `aliases` (the card's id now → the id the board knows it by, kept by the page after each move) keep the board's id. Two
 * cards never share an id: an alias wins once, and a card's own id already taken gets a suffix.
 */
export function boardIdsOf(cards: readonly DispatchCard[], aliases: ReadonlyMap<string, string>): PlacedCard[] {
  const used = new Set<string>()
  const ids = new Array<string | null>(cards.length).fill(null)
  cards.forEach((card, index) => {
    const alias = aliases.get(card.id)
    if (alias && !used.has(alias)) {
      used.add(alias)
      ids[index] = alias
    }
  })
  cards.forEach((card, index) => {
    if (ids[index] !== null) return
    let id = card.id
    for (let n = 2; used.has(id); n += 1) id = `${card.id}#${n}`
    used.add(id)
    ids[index] = id
  })
  return cards.map((card, index) => ({ boardId: ids[index]!, card }))
}

export interface Words {
  readonly t: Translate
  readonly locale: FormatPlace['locale']
  readonly timeZone: string
}

export const dayWords = (day: string, words: Pick<Words, 'locale'>): string => formatDate(`${day}T12:00:00Z`, { locale: words.locale, timeZone: 'UTC' })

export function bundleWords(card: Pick<DispatchCard, 'bundles' | 'whole'>, t: Translate): string | null {
  if (card.bundles.length === 0) return card.whole ? t('card.noBundles') : null
  return t('card.bundles', { count: card.bundles.length })
}

/** What the board says of a card: an order has a card per operation, so the operation's number goes with the order's. */
export const cardLabel = (card: Pick<DispatchCard, 'workOrder' | 'operation'>, t: Translate): string => t('card.label', { number: card.workOrder.number, seq: card.operation.seq })

function marksOf(card: DispatchCard, words: Words): PlanningMark[] {
  const { t } = words
  const marks: PlanningMark[] = []
  if (card.workOrder.rush) marks.push({ label: t('mark.rush'), tone: 'danger' })
  if (card.state === 'NOT_RELEASED') marks.push({ label: t('mark.draft'), tone: 'neutral' })
  if (card.state === 'ON_HOLD') marks.push({ label: t('mark.onHold'), tone: 'warning' })
  if (card.state === 'WAITING_FOR_PREVIOUS' && card.previous) {
    const params = { seq: card.previous.seq }
    if (card.sequence.state === 'HELD') marks.push({ label: t('mark.sequenceHeld', params), tone: 'danger' })
    else if (card.sequence.state === 'WARN') marks.push({ label: t('mark.sequenceWarn', params), tone: 'warning' })
    else marks.push({ label: t('mark.waiting', params), tone: 'neutral' })
  }
  if (card.material?.state === 'IN_STOCK') marks.push({ label: t('mark.material.IN_STOCK'), tone: 'success' })
  if (card.material?.state === 'ON_THE_WAY') marks.push({ label: card.material.date ? t('mark.material.expected', { date: dayWords(card.material.date, words) }) : t('mark.material.ON_THE_WAY'), tone: 'warning' })
  if (card.material?.state === 'MISSING') marks.push({ label: t('mark.material.MISSING'), tone: 'danger' })
  if (card.reassign) marks.push({ label: t('mark.reassign'), tone: 'warning' })
  return marks
}

/** The people this work names (a station's own operators stand on its lane, not on every card). */
export const namedOnCard = (card: Pick<DispatchCard, 'operators'>): LaneOperator[] => card.operators.filter((operator) => operator.kind !== 'STATION_OPERATOR')

function planningCard(entry: PlacedCard, laneIds: ReadonlySet<string>, board: DispatchBoard, words: Words): PlanningCard {
  const { card } = entry
  const { t } = words
  const details = [card.operation.name, card.workOrder.style.name, bundleWords(card, t), t('card.pieces', { count: card.pieces }), card.workOrder.dueDate ? t('card.due', { date: dayWords(card.workOrder.dueDate, words) }) : null]
  const named = namedOnCard(card)
  const minutes = Number(card.minutes)
  return {
    id: entry.boardId,
    label: cardLabel(card, t),
    detail: details.filter(Boolean).join(' · '),
    minutes,
    // Held and draft work is drawn and books nothing (the line's load counts released work only).
    load: card.counted ? [minutes] : [0],
    laneId: card.stationId && laneIds.has(card.stationId) ? card.stationId : null,
    bucketId: BUCKET_ID,
    late: card.workOrder.dueDate !== null && card.workOrder.dueDate < board.day,
    marks: marksOf(card, words),
    ...(named.length > 0 ? { note: named.map((operator) => operatorWords(operator, t)).join(', ') } : {}),
  }
}

function stationHead(board: DispatchBoard, station: StationLane, t: Translate): string {
  if (!board.rules.namesWorkers) return station.name
  const who = station.operators.length > 0 ? station.operators.map((operator) => operatorWords(operator, t)).join(', ') : t('lane.noOperator')
  return `${station.name} · ${who}`
}

export interface DrawnBoard {
  readonly buckets: readonly PlanningBucket[]
  readonly lanes: readonly PlanningLane[]
  readonly cards: readonly PlanningCard[]
  /** Every card on the board, under the board's own id. */
  readonly byId: ReadonlyMap<string, DispatchCard>
  /** What the design calls "no work" (nothing queued in the view). */
  readonly empty: boolean
}

/** The stations in view: one line's, or every line's and those with no line. */
export function stationsInView(board: DispatchBoard, line: string | null): StationLane[] {
  const chosen = line ? lineOf(board, line) : null
  return chosen ? chosen.stations : stationsOf(board)
}

/** The API board → the DS's lanes (columns), its one bucket and its cards (Not assigned = the tray). */
export function drawBoard(board: DispatchBoard, address: Pick<DispatchAddress, 'line'>, aliases: ReadonlyMap<string, string>, words: Words): DrawnBoard {
  const shown = stationsInView(board, address.line)
  const laneIds = new Set(shown.map((station) => station.id))
  // A station has no capacity of its own: `null` makes its column say its queue, with the words of `stationLoadWords`.
  const lanes = shown.map((station): PlanningLane => ({ id: station.id, label: stationLabel(board, station), detail: stationHead(board, station, words.t), capacity: { [BUCKET_ID]: null } }))
  const notAssigned = address.line ? board.notAssigned.filter((card) => card.lineId === address.line) : board.notAssigned
  const placed = boardIdsOf([...notAssigned, ...shown.flatMap((station) => station.cards)], aliases)
  return {
    buckets: [{ id: BUCKET_ID, label: dayWords(board.day, words), today: board.day === board.today }],
    lanes,
    cards: placed.map((entry) => planningCard(entry, laneIds, board, words)),
    byId: new Map(placed.map((entry) => [entry.boardId, entry.card])),
    empty: placed.length === 0,
  }
}

/** The board's own words for dispatch over the shared board kit: the tray is "Not assigned". */
export function dispatchBoardWords(t: Translate): Partial<PlanningBoardWords> {
  return {
    tray: t('kit.tray'),
    trayEmpty: t('kit.trayEmpty'),
    empty: t('kit.empty'),
    lanes: t('kit.lanes'),
    instructions: t('kit.instructions'),
    targetTray: t('kit.targetTray'),
    moveLane: t('kit.moveLane'),
  }
}

/** A station's column in the DS LoadBar: its queue in standard minutes (no percent: a station has no capacity of its own). */
export function stationLoadWords(t: Translate): Partial<LoadBarWords> {
  return { none: t('kit.queue'), booked: t('kit.queueMinutes'), sentenceNone: t('kit.queueSentence') }
}

// ---- what a drop may do --------------------------------------------------------------------------------------------------

/** The app's own check of a card at a place (the API checks again): a draft, a station that does not do the work. */
export function dropHeldOf(board: DispatchBoard, card: DispatchCard | undefined, to: PlanningPlace): Phrase | null {
  if (!card) return null
  if (!card.movable) return phrase('held.draft')
  if (to.laneId === null) return null
  const station = stationOf(board, to.laneId)
  if (station && station.workCentreId !== card.operation.workCentreId) return phrase('held.workCentre', { station: station.code })
  return null
}

/** Nothing moves here now, and why: the day is over, the person only looks, the page is offline. */
export function boardHeld(board: Pick<DispatchBoard, 'past' | 'mayManage'>, offline: boolean): Phrase | null {
  if (!board.mayManage) return phrase('held.readOnly')
  if (board.past) return phrase('held.past')
  if (offline) return phrase('held.offline')
  return null
}

/** What a move onto a place asks of the API: the whole card, to a station or back to Not assigned. */
export function moveBodyOf(card: DispatchCard, day: string, to: PlanningPlace): MoveBody {
  return { date: day, workOrderOperationId: card.operation.id, from: card.key, to: to.laneId === null ? { unplaced: true } : { stationId: to.laneId } }
}

/** After a move the board reads again: which card is the one that moved (its key now). */
export const movedCard = (board: DispatchBoard, operationId: string, key: string): DispatchCard | null => allCardsOf(board).find((card) => card.operation.id === operationId && card.key === key) ?? null

// ---- the Move bundles dialog ---------------------------------------------------------------------------------------------

export interface MoveTarget {
  /** `station:<id>` or `line:<id>`. */
  readonly value: string
  readonly label: Phrase
}

/** Where a card's bundles can go: the lines with a station for its work (their first free one), and those stations. */
export function moveTargets(board: DispatchBoard, card: DispatchCard): MoveTarget[] {
  const doing = stationsOf(board).filter((station) => station.workCentreId === card.operation.workCentreId)
  const lines = board.lines.filter((line) => doing.some((station) => station.lineId === line.id))
  return [...lines.map((line): MoveTarget => ({ value: `line:${line.id}`, label: phrase('move.toLine', { line: `${line.code} · ${line.name}` }) })), ...doing.filter((station) => station.id !== card.stationId).map((station): MoveTarget => ({ value: `station:${station.id}`, label: phrase('move.toStation', { station: stationLabel(board, station), name: station.name }) }))]
}

export function moveBundlesBody(card: DispatchCard, day: string, target: string, bundleIds: readonly string[]): MoveBody {
  const [kind, id] = target.split(':') as [string, string]
  return { date: day, workOrderOperationId: card.operation.id, from: card.key, bundleIds: [...bundleIds], to: kind === 'line' ? { lineId: id } : { stationId: id } }
}

export function moveBundlesHeld(card: DispatchCard, picked: readonly string[], target: string | null): Phrase | null {
  if (card.bundles.length === 0) return phrase('held.noBundles')
  if (picked.length === 0) return phrase('held.pickBundles')
  if (!target) return phrase('held.pickPlace')
  return null
}

// ---- the order of a lane ------------------------------------------------------------------------------------------------

export interface LaneStep {
  /** The body that puts the card one place earlier or later; null: it cannot go there. */
  readonly body: MoveBody | null
  readonly held: Phrase | null
}

/** One place earlier or later in the station's queue. Rush work stays first (the API's order). */
export function laneStep(board: DispatchBoard, card: DispatchCard, direction: -1 | 1): LaneStep {
  const station = stationOf(board, card.stationId)
  if (!station) return { body: null, held: phrase('held.noLane') }
  const at = station.cards.findIndex((entry) => entry.id === card.id)
  const neighbour = station.cards[at + direction]
  if (at < 0 || !neighbour) return { body: null, held: phrase(direction < 0 ? 'held.first' : 'held.last') }
  if (neighbour.workOrder.rush !== card.workOrder.rush) return { body: null, held: phrase('held.rushFirst') }
  return { body: { date: board.day, workOrderOperationId: card.operation.id, from: card.key, to: { stationId: station.id }, position: direction < 0 ? at : at + 2 }, held: null }
}

// ---- Assign operator --------------------------------------------------------------------------------------------------

/** What the check says about a person, in our words (the API's sentence stays with the API). */
export function checkPhrase(person: Pick<PickedOperator, 'decision' | 'overridable'>): Phrase | null {
  if (person.decision === 'ALLOW') return null
  if (person.decision === 'WARN') return phrase('assign.check.warn')
  return phrase(person.overridable ? 'assign.check.notQualified' : 'assign.check.notAuthorised')
}

/** The picker's line for a person: name, level, where they stand (no figure of any kind). */
export function pickerLabel(person: PickedOperator, t: Translate, forOperation = true): string {
  const parts = [person.name, ...(person.level ? [t(levelKey(person.level))] : forOperation ? [t('assign.noLevel')] : [])]
  if (person.trainee) parts.push(t('operator.trainee'))
  if (person.onBreak) parts.push(t('presence.ON_BREAK'))
  if (person.decision === 'WARN') parts.push(t('assign.mark.warn'))
  if (person.decision === 'HOLD') parts.push(t('assign.mark.hold'))
  return parts.join(' · ')
}

export function assignHeld(person: PickedOperator | null, reason: string, needsReason: boolean): Phrase | null {
  if (!person) return phrase('held.pickPerson')
  if (person.decision === 'HOLD') return checkPhrase(person)
  if ((person.decision === 'WARN' || needsReason) && reason.trim().length < REASON_MIN) return phrase('held.reason')
  return null
}

// ---- refusals ----------------------------------------------------------------------------------------------------------

const REFUSALS: ReadonlySet<string> = new Set([...Object.keys(DISPATCH_REFUSALS), 'NOT_QUALIFIED', 'NOT_AUTHORISED', 'OVERRIDE_REASON_NEEDED'])

export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  return error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))?.split('/')[1] ?? null
}

/** The site's rule lets this go on with a reason: the page asks and sends it again. */
export const needsReason = (error: unknown): boolean => refusalCode(error) === 'OVERRIDE_REASON_NEEDED'

/** A refused write, as words: the rule's own by its code, else what kind of failure it was. */
export function refusalOf(error: unknown): Phrase {
  const code = refusalCode(error)
  if (code && REFUSALS.has(code)) return phrase(`refusal.${code}`)
  if (!isApiError(error)) return phrase('error.write')
  switch (error.kind) {
    case 'conflict':
      return phrase('error.changed')
    case 'forbidden':
    case 'step_up':
      return phrase('error.forbidden')
    case 'unavailable':
      return phrase('error.offline')
    default:
      return phrase('error.write')
  }
}

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'error.read'
  if (error.kind === 'forbidden') return 'error.forbidden'
  if (error.kind === 'not_found') return 'error.noSite'
  if (error.kind === 'unavailable') return 'error.offline'
  return 'error.read'
}

/** The live messages that change the board. */
export function touchesBoard(type: string, siteId: unknown, boardSite: string | null): boolean {
  const own = siteId === undefined || siteId === null || siteId === boardSite
  if (type === 'dispatch.assignment_changed' || type === 'attendance.clock_event' || type === 'clock.out' || type === 'planning.schedule_published') return own
  return type === 'production.scan_recorded' || type.startsWith('workorder.') || type.startsWith('work_order.')
}

/** What has no place yet: the card a move names as REST. */
export const isRest = (card: Pick<DispatchCard, 'key'>): boolean => card.key === REST_CARD
