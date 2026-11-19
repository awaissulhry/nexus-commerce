'use client'

import { createElement, type ReactNode } from 'react'
import type { Order } from '../api'
// B-W2b-398: the Shipments tab's card "Delivered (from carrier)".
import { Deliveries } from './shipments/delivered/Deliveries'

/**
 * F-OP-134 (N-5): the Shipments tab's container side — B-W2b-398: the card "Delivered (from carrier)" (its own container: it reads
 * the carrier's deliveries of the order). Mounted by the container (OrderRecord.tsx), which hands it to the view as a plain prop; a
 * view never imports it. The hooks a shipment's acts need (the hand-booked carrier's tracking, a new shipment) are mounted here.
 */
export function useShipmentsActs(input: { readonly order: Order | null; readonly prefix: string }): { delivered: ReactNode } {
  const { order, prefix } = input
  return { delivered: order ? createElement(Deliveries, { orderId: order.id, prefix }) : null }
}
