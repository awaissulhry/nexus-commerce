import type { Deliveries, DeliveryRow } from './api'

/**
 * The order's "Delivered (from carrier)" card (B-W2b-398; LOG-065, LOG-067), pure: its state, the words of each shipment's
 * arrival (catalogue `shipping-delivery`, keys `dv.*`), why a proof's download is held.
 */

export interface DeliveriesModel {
  readonly state: 'loading' | 'ready' | 'error'
  readonly read: Deliveries | null
  readonly prefix: string
  /** The shipment whose proof is being fetched. */
  readonly downloading: string | null
  readonly problem: string | null
  readonly offline: boolean
}

export interface DeliveriesActions {
  readonly onRetry?: () => void
  readonly onDownload?: (shipmentId: string) => void
  readonly onDismiss?: () => void
}

export const initialDeliveries = (prefix: string): DeliveriesModel => ({ state: 'loading', read: null, prefix, downloading: null, problem: null, offline: false })

/** How the shipment came to be delivered, as a key: from the carrier, typed by a person, on its way, came back. */
export function arrivalKey(row: DeliveryRow): string {
  if (row.status === 'RETURNED') return 'dv.arrival.returned'
  if (row.status !== 'DELIVERED') return 'dv.arrival.travelling'
  return row.deliveredVia === 'TYPED' ? 'dv.arrival.typed' : 'dv.arrival.carrier'
}

/** Why the proof's download is held, or null. */
export function downloadHeldKey(model: Pick<DeliveriesModel, 'downloading' | 'offline'>, row: DeliveryRow): string | null {
  if (!row.pod?.image) return 'dv.held.noImage'
  if (!row.mayOpen) return 'dv.held.right'
  if (model.offline) return 'dv.held.offline'
  if (model.downloading !== null) return 'dv.held.busy'
  return null
}
