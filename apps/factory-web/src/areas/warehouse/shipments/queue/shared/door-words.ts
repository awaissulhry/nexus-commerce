'use client'

import { useT } from '../../../../../lib/i18n/provider'
import { DEPTH_NAMESPACES, DEPTH_NS, type Words } from './depth'

/**
 * F-OS-203 (order SHIPMENTS tab; 18-lead-settles L6, L11) — the words of the dialogs Warehouse and the order's Shipments tab share
 * (Move, Merge, take an order off with its reason, travels without a DDT, receive the garments back, expected arrival, hand over at a
 * time): Warehouse's own words where they exist (`warehouse-shipments-depth`), the lane's new ones in their own namespace
 * (`order-shipments`: keys under `move.`, `door.` and the acts' names `ships.act.`). One `say` for both, by the key's first part.
 */

/** The new words' namespace (L11) and the catalogues a shared dialog draws with. */
export const DOOR_NS = 'order-shipments'
export const DOOR_NAMESPACES = [...DEPTH_NAMESPACES, DOOR_NS] as const

const OWN = /^(?:move\.|door\.|ships\.act\.)/

export function useDoorWords() {
  const depth = useT(DEPTH_NS)
  const own = useT(DOOR_NS)
  const t = (key: string, params?: Record<string, string | number>): string => (OWN.test(key) ? own(key, params) : depth(key, params))
  const say = (value: Words | null | undefined): string | null => (value ? t(value.key, value.params) : null)
  return { t, say }
}
