import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import type { HideRow, LocationView, Uom } from '../../../_shared/stock/api'
import { decimalValue, phrase, writeProblem, type Phrase } from '../../../_shared/stock/model'
import type { Read } from '../../stock/daily/dialog-model'

/**
 * Move N hides (B-W2b-131; design warehouse.hides hd-grid selection row "Move…", W2b), pure and its one call: each hide
 * chosen goes whole (what the site's ledger holds of it) from the place that holds it to the place picked, as ONE transfer
 * move per hide (`POST /inventory/transfers`, inventory.transfer; a transfer moves stock between places of the site, never
 * in or out of its stock). A hide with nothing at a place of the site (at the cutting table, used, scrapped) or already at
 * the place picked is left out with why.
 */

export interface MoveHide {
  id: string
  code: string
  itemId: string
  siteId: string
  from: { id: string; code: string; name: string } | null
  /** What moves: its on hand (base unit). */
  quantity: string
  uom: Uom
  /** Why it cannot move as it is (a key of warehouse-hides), or null. */
  why: Phrase | null
}

export interface MoveDialogModel {
  siteId: string
  hides: MoveHide[]
  places: Read<LocationView[]>
  toLocationId: string | null
  note: string
  posting: boolean
  /** Per hide once sent: moved, or refused in words. */
  results: Readonly<Record<string, { moved: true } | { moved: false; problem: Phrase }>> | null
  problem: Phrase | null
}

export interface MoveDialogActions {
  onPlace?: (locationId: string | null) => void
  onNote?: (note: string) => void
  onMove?: () => void
  onRetryPlaces?: () => void
  onClose?: () => void
}

/** The hides chosen as the dialog moves them: each free to move, or left out with why. */
export function moveHides(rows: readonly HideRow[]): MoveHide[] {
  return rows.map((row) => {
    const onHand = decimalValue(row.onHand) ?? 0
    const why =
      row.state === 'CONSUMED' || row.state === 'SCRAPPED' || row.state === 'RETURNED'
        ? phrase('move.why.gone')
        : onHand <= 0
          ? phrase('move.why.notHere')
          : !row.location
            ? phrase('move.why.noPlace')
            : null
    return { id: row.id, code: row.code, itemId: row.item.id, siteId: row.siteId, from: row.location, quantity: row.onHand, uom: row.item.baseUom, why }
  })
}

/** The hides that move to the place picked (free, and not there already). */
export const movable = (model: Pick<MoveDialogModel, 'hides' | 'toLocationId'>): MoveHide[] => model.hides.filter((hide) => hide.why === null && hide.from?.id !== model.toLocationId)

/** Why "Move N hides…" on the selection is held (a key of warehouse-hides), or null. */
export function moveSelectionHeld(rows: readonly Pick<HideRow, 'siteId'>[], canTransfer: boolean): string | null {
  if (!canTransfer) return 'move.held.noRight'
  if (rows.length === 0) return 'move.held.pick'
  if (new Set(rows.map((row) => row.siteId)).size > 1) return 'move.held.oneSite'
  return null
}

/** Why the dialog's Move is held (a key of warehouse-hides), or null. */
export function moveHeldKey(model: Pick<MoveDialogModel, 'hides' | 'toLocationId' | 'posting' | 'results'>): string | null {
  if (model.posting) return 'move.held.busy'
  if (model.results) return 'move.held.done'
  if (!model.toLocationId) return 'move.held.place'
  if (movable(model).length === 0) return 'move.held.none'
  return null
}

/** The places a hide may go to: the site's active places (a work order's stock is issued, never moved). */
export const placesOf = (locations: readonly LocationView[]): LocationView[] => locations.filter((location) => location.status === 'ACTIVE')

/** A refused transfer in our words (a key of `stock`, prefixed for warehouse-hides' words). */
export function moveProblem(error: unknown): Phrase {
  const own = writeProblem(error)
  return { key: `stock:${own.key}`, params: own.params }
}

const moveSchema = z.object({ move: z.object({ id: z.string() }).passthrough() })

/** One hide whole from its place to another place of the site: a TRANSFER move. */
export const transferHide = (api: ApiClient, body: { siteId: string; itemId: string; hideId: string; fromLocationId: string; toLocationId: string; quantity: string; note: string }, idempotencyKey: string) =>
  api.post('/inventory/transfers', {
    body: { siteId: body.siteId, itemId: body.itemId, hideId: body.hideId, fromLocationId: body.fromLocationId, toLocationId: body.toLocationId, quantity: body.quantity, note: body.note.trim() || null },
    schema: moveSchema,
    idempotencyKey,
  })
