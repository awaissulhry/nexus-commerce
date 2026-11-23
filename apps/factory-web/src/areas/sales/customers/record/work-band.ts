import { ORDER_PHASES, PHASE_STATUSES } from '@nexus/factory-domain/production-brand/stages'
import type { OrderBoard, OrderPhase, OrderStatus } from '../../orders/api'
import type { ExtraTerms, RowView } from '../../orders/model'
import { STRIP_GROUPS, tileOf, tilesShown, type Read, type StripTile, type TileRead, type WorkCan, type WorkReads } from './use-customer-work'

/**
 * F-CW-101 (customer Work tab plan §1; 10-design §2; lead settles S2, S3, S16, S24, S32) — the Work tab's band, pure: the bigger
 * picture (every order of ONE customer in exactly one of seven groups, each a count and a door), the two exact whys of "Not sent to
 * the factory", and what waits (today's six facts as chips: the same reads, the same doors and windows). Every number is one
 * customer's, from a walled API read (use-customer-work.ts): never a filter in the browser, never a number typed here.
 *
 * The groups come from the board's `byPhase` (the API's ONE rule, the domain's orderPhaseOf). An older answer without it: six groups
 * by state (the domain's PHASE_STATUSES) — "In production" whole, no "Production not started", no whys; a group of one state opens
 * that state, a group of two states is a count with no door (never a held door, never a guess).
 */

/** How a group's door opens: the phase term; one state's own term (an older answer); none (a count only). */
export type GroupDoor = { readonly kind: 'phase'; readonly phase: OrderPhase } | { readonly kind: 'status'; readonly status: OrderStatus } | null

export interface BandGroup {
  readonly phase: OrderPhase
  /** null: the board is being read, or could not be read ("—", never 0). */
  readonly count: number | null
  readonly door: GroupDoor
}

export interface BandPicture {
  readonly groups: readonly BandGroup[]
  /** All orders of the customer (every state): what the groups add up to; null while read. */
  readonly total: number | null
  readonly state: 'reading' | 'ready' | 'failed'
}

/** The groups in their order while nothing is read: the pipeline keeps its shape (seven places, "—" in each). */
const unread = (state: 'reading' | 'failed'): BandPicture => ({ groups: ORDER_PHASES.map((phase) => ({ phase, count: null, door: { kind: 'phase', phase } })), total: null, state })

/** The bigger picture from the board read (the strip's own read: no second read). */
export function bandOf(board: Read<OrderBoard>): BandPicture {
  if (board.status === 'failed') return unread('failed')
  if (board.status !== 'ready') return unread('reading')
  const value = board.value
  const total = value.byStatus.reduce((sum, entry) => sum + entry.count, 0)
  const byPhase = value.byPhase
  if (byPhase) {
    return { groups: ORDER_PHASES.map((phase) => ({ phase, count: byPhase.find((entry) => entry.phase === phase)?.count ?? 0, door: { kind: 'phase', phase } })), total, state: 'ready' }
  }
  // An older answer: by state. NOT_STARTED shares its one state with IN_PRODUCTION (the stage splits them): left out, never guessed.
  const ofStatus = (status: OrderStatus): number => value.byStatus.find((entry) => entry.status === status)?.count ?? 0
  const groups = ORDER_PHASES.filter((phase) => phase !== 'NOT_STARTED').map((phase): BandGroup => {
    const statuses = PHASE_STATUSES[phase] as readonly OrderStatus[]
    return { phase, count: statuses.reduce((sum, status) => sum + ofStatus(status), 0), door: statuses.length === 1 ? { kind: 'status', status: statuses[0]! } : null }
  })
  return { groups, total, state: 'ready' }
}

/** The two exact whys inside "Not sent to the factory" (each only when > 0; none: no line). An older answer has none. */
export function whysOf(board: Read<OrderBoard>): ReadonlyArray<{ readonly why: 'yes' | 'deposit'; readonly count: number }> {
  if (board.status !== 'ready' || !board.value.notSent) return []
  const { waitsForYes, waitsForDeposit } = board.value.notSent
  return [...(waitsForYes > 0 ? [{ why: 'yes' as const, count: waitsForYes }] : []), ...(waitsForDeposit > 0 ? [{ why: 'deposit' as const, count: waitsForDeposit }] : [])]
}

/** The group the sheet shows now (its door is pressed): the phase term alone beside All orders; a state's own view for an older answer. */
export function groupShown(group: BandGroup, view: { readonly rows: RowView; readonly waiting: 'us' | null; readonly extra: ExtraTerms | null | undefined; readonly drafts: boolean }): boolean {
  if (view.drafts || view.waiting || !group.door) return false
  if (group.door.kind === 'phase') return view.rows === 'all' && view.extra?.phase === group.door.phase
  return view.rows === group.door.status && !view.extra?.phase
}

// ---- line 2: what waits (today's six facts, as chips) ----

/** "—" while reading, the count, "100+" past a capped read, "!" when its read failed (the chip's click reads it again). */
export const valueOf = (read: TileRead): string => (read.status === 'ready' ? `${read.count}${read.more ? '+' : ''}` : read.status === 'failed' ? '!' : '—')

export interface BandChip {
  readonly tile: StripTile
  /** Today's three groups (Waiting on us · Waiting on <customer> · Tasks): the name is the chip's tooltip, a thin rule parts them. */
  readonly group: keyof typeof STRIP_GROUPS
  /** The first chip of its group (after the first group: a thin rule before it). */
  readonly first: boolean
  readonly read: TileRead
  readonly value: string
  /** Late > 0 reads as danger, every other count > 0 as a warning; 0, reading and failed are quiet (told by the number, never colour alone). */
  readonly tone: 'danger' | 'warning' | 'quiet'
}

/** The chips a reader gets, in today's order: a chip without its right is left out (no empty "0" chip). */
export function chipsOf(can: WorkCan, reads: WorkReads): BandChip[] {
  const shown = tilesShown(can)
  const out: BandChip[] = []
  for (const group of Object.keys(STRIP_GROUPS) as Array<keyof typeof STRIP_GROUPS>) {
    const tiles = STRIP_GROUPS[group].filter((tile) => shown.includes(tile))
    tiles.forEach((tile, index) => {
      const read = tileOf(tile, reads)
      const some = read.status === 'ready' && (read.count > 0 || read.more)
      out.push({ tile, group, first: index === 0, read, value: valueOf(read), tone: some ? (tile === 'late' ? 'danger' : 'warning') : 'quiet' })
    })
  }
  return out
}
