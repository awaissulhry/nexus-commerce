/**
 * The board (kanban) view of a list — its rules, pure (gap D19). The same rows as the table, as cards in one column per
 * status ("lane"): Open → Contained → Decided → Closed (nonconformances), New → Investigating → … (holds). A card moves
 * to another lane by drag, by keyboard (Space or M, ← →, Enter) or by its "Move to…" menu; every way runs the same
 * checks, in this order, and says the first that fails in words:
 *   1. the board's own reason (read-only for this person, offline)  → `heldReason`
 *   2. the card's own reason (closed, waiting for a signature)        → `card.held`
 *   3. the same lane                                                  → `sameLane`
 *   4. the target lane's reason (no permission, a result-only lane)  → `lane.held`
 *   5. the app's rule for this card in that lane ("3 of 40 garments not decided") → `moveHeld(card, laneId)`
 * A move that passes is handed to the app (`onMove`), which saves it and passes the cards back; nothing is optimistic.
 * The order inside a lane is the list's sort: the board never reorders a lane.
 */

export type BoardTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export type BoardVia = 'pointer' | 'keyboard' | 'menu'

export interface BoardLane {
  id: string
  /** The status as the list names it ("Contained"). */
  label: string
  /** A short line under the name, in the app's words ("Oldest 12 days"). */
  detail?: string | null
  /** How many rows of the list are in this lane (the server's count). Left out: the cards drawn. */
  total?: number | null
  /** Why nothing may be dropped here (no permission for this step; a lane that only a dialog reaches). */
  held?: string | null
  /** The lane head's accent (a word and the count carry the meaning; the colour only repeats it). */
  tone?: BoardTone
}

export interface BoardCardField {
  label: string
  value: string
}

export interface BoardMark {
  label: string
  tone?: BoardTone
}

export interface BoardCard {
  id: string
  laneId: string
  /** The record's number, the card's name ("NCR-0012"). */
  label: string
  /** One line under the number ("Seam opens at the armour pocket"). */
  title?: string | null
  /** The list's columns that the card shows ("Severity" · "Major"). */
  fields?: readonly BoardCardField[]
  /** Short tags in words ("Customer complaint", "Late"). */
  marks?: readonly BoardMark[]
  /** Why this card cannot move at all (closed; waiting for the signature). Drawn on the card and said. */
  held?: string | null
  /** The record's address: Open is then a real link (⌘-click opens a new tab). */
  href?: string
}

export interface BoardMove {
  cardId: string
  from: string
  to: string
  via: BoardVia
}

export interface BoardViewWords {
  instructions: string
  countOne: string
  countOther: string
  laneEmpty: string
  laneShown: string
  more: string
  moveTo: string
  moveToCard: string
  moveHere: string
  open: string
  openCard: string
  pick: string
  target: string
  targetHeld: string
  targetSame: string
  edge: string
  upDown: string
  moved: string
  notMoved: string
  refused: string
  cancelled: string
  sameLane: string
  readOnly: string
  held: string
  saving: string
  cardIn: string
  dropHere: string
  dropHeld: string
}

/** English defaults; every word comes in through the `words` prop (the factory passes its catalogue). */
export const BOARD_VIEW_WORDS: BoardViewWords = {
  instructions: 'To move a card, focus it and press Space or M, choose a column with the left and right arrows, then press Enter. Escape cancels. Enter opens the card; the Move to menu lists every column.',
  countOne: '{count} card',
  countOther: '{count} cards',
  laneEmpty: 'Nothing here',
  laneShown: 'Showing {shown} of {total}',
  more: 'Show more',
  moveTo: 'Move to…',
  moveToCard: 'Move {card} to…',
  moveHere: 'Move to {lane}',
  open: 'Open',
  openCard: 'Open {card}',
  pick: 'Moving {card} from {lane}. Left and right arrows choose a column, Enter drops, Escape cancels.',
  target: '{lane}. Enter drops it here.',
  targetHeld: '{lane}: held. {reason}',
  targetSame: '{lane}: where it is now.',
  edge: 'No further column that way.',
  upDown: 'Use the left and right arrows to choose a column.',
  moved: '{card} moved to {lane}.',
  notMoved: '{card} was not moved. It stays in {lane}.',
  refused: '{card} stays in {lane}. {reason}',
  cancelled: 'Move cancelled. {card} stays in {lane}.',
  sameLane: 'Choose another column.',
  readOnly: 'This board is read-only.',
  held: 'Held',
  saving: 'Saving',
  cardIn: '{card} in {lane}',
  dropHere: 'Drop here',
  dropHeld: 'Cannot drop here: {reason}',
}

/** `{name}` → its value; a placeholder with no value stays as written, so a missing one shows. */
export function fillWords(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

/** "1 card" / "4 cards" with the page's number format. */
export function countWords(count: number, words: Pick<BoardViewWords, 'countOne' | 'countOther'>, locale?: string): string {
  const shown = new Intl.NumberFormat(locale ?? 'en-GB').format(count)
  return fillWords(count === 1 ? words.countOne : words.countOther, { count: shown })
}

/** The cards of each lane, in the order given (the list's sort). A card whose lane is not on the board is not drawn. */
export function cardsByLane(cards: readonly BoardCard[], lanes: readonly BoardLane[]): Map<string, BoardCard[]> {
  const out = new Map<string, BoardCard[]>(lanes.map((lane) => [lane.id, []]))
  for (const card of cards) out.get(card.laneId)?.push(card)
  return out
}

/** The count a lane head shows: the server's total when known, else the cards drawn. */
export function laneCount(lane: BoardLane, drawn: number): number {
  return typeof lane.total === 'number' && Number.isFinite(lane.total) && lane.total >= drawn ? lane.total : drawn
}

export interface MoveCheck {
  card: BoardCard
  to: string
  lanes: readonly BoardLane[]
  words: Pick<BoardViewWords, 'sameLane'>
  heldReason?: string | null
  /** The app's own rule, already asked (`moveHeld(card, to)`). */
  appHeld?: string | null
}

/** Why this card may not go to that lane, in words — or null when the move may be made. Checks in the order above. */
export function moveHeldReason({ card, to, lanes, words, heldReason, appHeld }: MoveCheck): string | null {
  if (heldReason) return heldReason
  if (card.held) return card.held
  if (card.laneId === to) return words.sameLane
  const lane = lanes.find((item) => item.id === to)
  if (!lane) return words.sameLane
  if (lane.held) return lane.held
  return appHeld || null
}

/** Why a card cannot even be picked up (the board's or its own reason), or null. */
export function pickHeldReason(card: BoardCard, heldReason?: string | null): string | null {
  return heldReason || card.held || null
}

export type BoardArrow = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export const isBoardArrow = (key: string): key is BoardArrow =>
  key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'

/**
 * A keyboard move under way: ← → choose the lane (held lanes are reached and say why, so a person learns where a card
 * may not go), ↑ ↓ say to use ← →; Home / End the first and last lane. `dir` = the reading direction (arrows swap in
 * right-to-left). `edge` when there is no lane that way.
 */
export function laneStep(lanes: readonly BoardLane[], from: string, key: BoardArrow, dir: 'ltr' | 'rtl' = 'ltr'): { to: string; edge: false } | { edge: true; why: 'edge' | 'upDown' } {
  if (key === 'ArrowUp' || key === 'ArrowDown') return { edge: true, why: 'upDown' }
  if (!lanes.length) return { edge: true, why: 'edge' }
  if (key === 'Home') return { to: lanes[0]!.id, edge: false }
  if (key === 'End') return { to: lanes[lanes.length - 1]!.id, edge: false }
  const at = lanes.findIndex((lane) => lane.id === from)
  const forward = (key === 'ArrowRight') === (dir === 'ltr')
  const next = at + (forward ? 1 : -1)
  if (at < 0 || next < 0 || next >= lanes.length) return { edge: true, why: 'edge' }
  return { to: lanes[next]!.id, edge: false }
}

/**
 * Focus between cards when nothing moves (one roving tab stop for the whole board): ↑ ↓ inside a lane, ← → to the
 * card at the same height in the next lane with cards (or its last), Home / End the lane's first and last card.
 */
export function nextCardFocus(byLane: ReadonlyMap<string, readonly BoardCard[]>, lanes: readonly BoardLane[], from: string, key: BoardArrow, dir: 'ltr' | 'rtl' = 'ltr'): string | null {
  const laneAt = lanes.findIndex((lane) => (byLane.get(lane.id) ?? []).some((card) => card.id === from))
  if (laneAt < 0) return null
  const own = byLane.get(lanes[laneAt]!.id) ?? []
  const at = own.findIndex((card) => card.id === from)
  if (key === 'ArrowUp') return own[at - 1]?.id ?? null
  if (key === 'ArrowDown') return own[at + 1]?.id ?? null
  if (key === 'Home') return own[0]?.id ?? null
  if (key === 'End') return own[own.length - 1]?.id ?? null
  const forward = (key === 'ArrowRight') === (dir === 'ltr')
  for (let next = laneAt + (forward ? 1 : -1); next >= 0 && next < lanes.length; next += forward ? 1 : -1) {
    const list = byLane.get(lanes[next]!.id) ?? []
    if (list.length) return (list[Math.min(at, list.length - 1)] ?? list[list.length - 1])!.id
  }
  return null
}

/** The one Tab stop: the card that last had the focus if it is still drawn, else the first card. */
export function boardTabStop(byLane: ReadonlyMap<string, readonly BoardCard[]>, lanes: readonly BoardLane[], focused: string | null): string | null {
  const drawn = lanes.flatMap((lane) => byLane.get(lane.id) ?? [])
  return drawn.find((card) => card.id === focused)?.id ?? drawn[0]?.id ?? null
}

/** The card as a screen reader hears it: its number, title, lane, fields, marks and why it cannot move. */
export function cardName(card: BoardCard, lane: BoardLane | undefined, words: Pick<BoardViewWords, 'cardIn' | 'held'>): string {
  const parts = [fillWords(words.cardIn, { card: card.label, lane: lane?.label ?? '' })]
  if (card.title) parts.push(card.title)
  for (const field of card.fields ?? []) parts.push(`${field.label}: ${field.value}`)
  for (const mark of card.marks ?? []) parts.push(mark.label)
  if (card.held) parts.push(`${words.held}: ${card.held}`)
  return parts.join('. ')
}

/** The words for a keyboard move's target lane: where it is now, held with the reason, or where it drops. */
export function targetWords(check: MoveCheck, lane: BoardLane | undefined, words: Pick<BoardViewWords, 'target' | 'targetHeld' | 'targetSame' | 'sameLane'>): string {
  const name = lane?.label ?? ''
  if (check.card.laneId === check.to) return fillWords(words.targetSame, { lane: name })
  const reason = moveHeldReason(check)
  return reason ? fillWords(words.targetHeld, { lane: name, reason }) : fillWords(words.target, { lane: name })
}

/** The Move to… menu: every other lane, each with the reason it is held (kept in the menu, reachable, inert). */
export function moveMenu(card: BoardCard, lanes: readonly BoardLane[], words: Pick<BoardViewWords, 'sameLane'>, heldReason: string | null | undefined, appHeld: (laneId: string) => string | null | undefined): { laneId: string; label: string; held: string | null }[] {
  return lanes
    .filter((lane) => lane.id !== card.laneId)
    .map((lane) => ({ laneId: lane.id, label: lane.label, held: moveHeldReason({ card, to: lane.id, lanes, words, heldReason, appHeld: appHeld(lane.id) }) }))
}
