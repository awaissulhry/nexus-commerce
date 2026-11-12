import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import type { LocationKind } from '../locations/rules'
import { kindWords, LOCATION_KIND_PROFILES } from './kinds'

/**
 * A blocked location (B-W2b-289; SCM-181; design warehouse.locations pop "Block location": reason (count, damage,
 * clean-up) · until date), pure. A blocked place takes no move in or out but a count's own COUNT moves, until it is
 * unblocked or until the end of its until-day (Europe/Rome): the database refuses every other move
 * (…_warehouse_depth_w2b_guards StockMove_warehouse_check), and the ledger's postMoves says so first in the same words
 * (factory-domain inventory/warehouse/refusals). A block is when, why (COUNT, DAMAGE, CLEAN_UP; OTHER in words), by whom
 * and until which day, all set at once; unblocking clears all five.
 *
 * A count blocks its locations while it runs (the counts' start, submit, send-back and cancel; apps/factory-api
 * modules/inventory/locations-depth blocks.ts): a count of a place (no item, lot or kind narrowing it) blocks that place
 * and every place inside it with reason COUNT and its mark in the words ("Count CNT-2026-0003 is running here."), skips
 * a place blocked already, and unblocks only the places it blocked once it is no longer COUNTING. A count narrowed to an
 * item, a lot or a kind blocks nothing (its frozen lines hold that item's moves, SCM-226), and nor does a count of the
 * whole site (it would stop every move of the factory: the site's counters stop them by hand, or count place by place).
 */

export const BLOCK_REASONS = ['COUNT', 'DAMAGE', 'CLEAN_UP', 'OTHER'] as const
export type BlockReason = (typeof BLOCK_REASONS)[number]

/** The longest words of a block (the database's limit). */
export const BLOCK_NOTE_MAX = 500

/** A location's block as stored (all null: not blocked). */
export interface StoredBlock {
  readonly blockedAt: Date | null
  readonly blockReason: BlockReason | null
  readonly blockNote: string | null
  /** A business date (YYYY-MM-DD) or null. */
  readonly blockedUntil: BusinessDate | null
}

/** True while the block holds on `today` (Europe/Rome): blocked, and no until-day or one not passed. */
export const blockHolds = (block: StoredBlock, today: BusinessDate): boolean => block.blockedAt !== null && (block.blockedUntil === null || block.blockedUntil >= today)

/** The mark a count's block carries in its words: the count releases only the places that carry its own. */
export const countBlockNote = (countNumber: string): string => `Count ${countNumber} is running here.`

/** True when the block is the count's own (reason COUNT and its mark). */
export const isCountsBlock = (block: Pick<StoredBlock, 'blockReason' | 'blockNote'>, countNumber: string): boolean => block.blockReason === 'COUNT' && block.blockNote === countBlockNote(countNumber)

/** True when the block is any running count's (reason COUNT with a count's mark): a person does not lift it. */
export const isACountsBlock = (block: Pick<StoredBlock, 'blockReason' | 'blockNote'>): boolean => block.blockReason === 'COUNT' && /^Count \S+ is running here\.$/.test(block.blockNote ?? '')

export interface BlockAsk {
  readonly reason: BlockReason
  readonly note?: string | null | undefined
  readonly until?: BusinessDate | null | undefined
}

/**
 * Why a person may not block (or change the block of) this place now (paths `reason`, `note`, `until`, `location`): an
 * active place of a kind that may be blocked; OTHER says why in words; words up to 500 characters; an until-day not
 * before today; a running count's block is the count's own.
 */
export function blockProblems(place: { readonly code: string; readonly kind: LocationKind; readonly status: string } & Pick<StoredBlock, 'blockReason' | 'blockNote'>, ask: BlockAsk, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  if (place.status !== 'ACTIVE') problems.push({ path: 'location', message: `Location ${place.code} is archived: it takes no stock and is not blocked.` })
  else if (!LOCATION_KIND_PROFILES[place.kind].blockable) problems.push({ path: 'location', message: `Location ${place.code} is a ${kindWords(place.kind)}: its moves are its orders' own, it is not blocked.` })
  if (isACountsBlock(place)) problems.push({ path: 'location', message: `${place.blockNote} The count unblocks it when its counting ends.` })
  const note = ask.note?.trim() ?? ''
  if (ask.reason === 'OTHER' && note === '') problems.push({ path: 'note', message: 'Say why in words (the reason is Other).' })
  if (note.length > BLOCK_NOTE_MAX) problems.push({ path: 'note', message: `At most ${BLOCK_NOTE_MAX} characters.` })
  if (ask.reason === 'COUNT' && /^Count \S+ is running here\.$/.test(note)) problems.push({ path: 'note', message: 'These words are a running count\'s own: write others.' })
  if (ask.until !== undefined && ask.until !== null && ask.until < today) problems.push({ path: 'until', message: `The until-day is not before today (${today}).` })
  return problems
}

/** Why a person may not unblock this place now (path `location`), or []. */
export function unblockProblems(place: { readonly code: string } & StoredBlock): Issue[] {
  if (place.blockedAt === null) return [{ path: 'location', message: `Location ${place.code} is not blocked.` }]
  if (isACountsBlock(place)) return [{ path: 'location', message: `${place.blockNote} The count unblocks it when its counting ends.` }]
  return []
}

/** A place of a count's scope as the count's block reads it. */
export interface CountPlace extends StoredBlock {
  readonly id: string
  readonly kind: LocationKind
  readonly status: string
}

/** True when a count of this scope blocks its places (a place, nothing narrowing it). */
export const countBlocksPlaces = (scope: { readonly locationId: string | null; readonly itemId: string | null; readonly lotId: string | null; readonly itemKind: string | null }): boolean =>
  scope.locationId !== null && scope.itemId === null && scope.lotId === null && scope.itemKind === null

/** The places a starting count blocks: active, blockable, not blocked on `today` already. */
export const placesToBlock = (places: readonly CountPlace[], today: BusinessDate): CountPlace[] =>
  places.filter((place) => place.status === 'ACTIVE' && LOCATION_KIND_PROFILES[place.kind].blockable && !blockHolds(place, today))

/** The places an ending count unblocks: those carrying its own block. */
export const placesToRelease = (places: readonly CountPlace[], countNumber: string): CountPlace[] => places.filter((place) => place.blockedAt !== null && isCountsBlock(place, countNumber))
