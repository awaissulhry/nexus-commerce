import { words, type Read, type Words } from '../queue/shared/depth'
import type { PickupRow } from '../pickup/api'
import type { DispatchAbilities } from '../pickup/dispatch'
import type { PickupDialogActions, PickupDialogModel } from '../pickup/model'
import type { EndOfDayActions, EndOfDayModel, HandOverModel, HandOverPick } from './model'

/**
 * What B-W2b-412 adds to the shipments list (SCR-066 with SCR-590; SCR-655): the band's End of day and ⋯ Book a pickup, the
 * pickups of the day on the carriers' cut-off cards, Book pickup and Mark handed over on the selection row, and their pop-ups.
 * Pure: the list view draws it, `useDispatch` fills it.
 */

/** A picked row, as every grid of the list knows it. */
export interface DispatchPick extends HandOverPick {
  readonly siteId?: string
  readonly carrierCode?: string | null
}

export interface DispatchListModel {
  /** The site the queue shows (pickups and the day's close are a site's). */
  readonly siteId: string | null
  /** Today's pickups of that site (null: no site yet). */
  readonly pickups: Read<readonly PickupRow[]> | null
  readonly pickup: PickupDialogModel | null
  readonly endOfDay: EndOfDayModel | null
  readonly handOver: HandOverModel | null
  readonly can: DispatchAbilities
}

export interface DispatchListActions {
  /** Book a pickup: for the picked rows (the selection row), or by hand (⋯, none picked). */
  onPickup?: (picked: readonly DispatchPick[]) => void
  pickup?: PickupDialogActions
  onEndOfDay?: () => void
  endOfDay?: EndOfDayActions
  onHandOver?: (picked: readonly DispatchPick[]) => void
  onHandOverGo?: () => void
  onHandOverClose?: () => void
}

/** The picked rows a pickup takes: open shipments a carrier collects (the API leaves out the rest, with why). */
export const pickupable = (picked: readonly DispatchPick[]): DispatchPick[] => picked.filter((row) => (row.status === 'DRAFT' || row.status === 'PACKED') && row.transportBy === 'CARRIER')

/** Why Book pickup is held on the selection row or in ⋯ (null: it may be pressed). */
export function pickupHeld(model: Pick<DispatchListModel, 'siteId' | 'can'>, picked: readonly DispatchPick[] | null): Words | null {
  if (!model.can.bookPickups) return words('pickup.held.noRight')
  if (!model.siteId && !(picked ?? []).some((row) => row.siteId)) return words('pickup.held.noSite')
  if (picked && pickupable(picked).length === 0) return words('pickup.held.noneCarrier')
  return null
}

/** Why End of day is held in the band (null: it may be opened). */
export function endOfDayHeld(model: Pick<DispatchListModel, 'siteId' | 'can'>): Words | null {
  if (!model.can.view) return words('eod.held.noView')
  if (!model.siteId) return words('pickup.held.noSite')
  return null
}

/** The site a pickup is booked for: the queue's, when one of the picked is there, else the first picked row's. */
export function pickupSite(siteId: string | null, picked: readonly DispatchPick[]): string | null {
  if (picked.length === 0) return siteId
  if (siteId && picked.some((row) => !row.siteId || row.siteId === siteId)) return siteId
  return picked.find((row) => row.siteId)?.siteId ?? siteId
}
