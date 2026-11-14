import { events as shippingEvents } from '@nexus/factory-domain/shipping/events'
import { processFiles, type FilesRuntime } from '../../../platform/files/service'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { processCarrier, type CarrierRuntime } from '../labels/carrier'
import { fetchCarrierPod } from './pod'

/**
 * The worker's handler of a delivery for its proof (B-W2b-398; LOG-065): shipment.status_changed → DELIVERED asks the
 * carrier for the proof of delivery (pod.ts fetchCarrierPod: never a TEST label, never a shipment not carried by
 * Sendcloud). A carrier that did not answer is asked again by the queue; one that has no proof leaves it to a person.
 */

export const CARRIER_POD_HANDLER = 'shipping.carrierPod'

const statusChanged = shippingEvents.find((event) => event.type === 'shipment.status_changed')!.payload

class PodIncomplete extends Error {
  override name = 'PodIncomplete'
}

export function carrierPodHandler(runtime: { readonly carrier?: () => CarrierRuntime; readonly files?: () => FilesRuntime } = {}): EventHandler {
  const carrier = runtime.carrier ?? processCarrier
  const files = runtime.files ?? processFiles
  return defineHandler({
    name: CARRIER_POD_HANDLER,
    events: ['shipment.status_changed'],
    attempts: 5,
    async handle(event, tools) {
      const payload = statusChanged.parse(event.payload)
      if (payload.to !== 'DELIVERED') return
      const outcome = await fetchCarrierPod({ carrier: carrier(), files: files() }, tools.caller, payload.shipmentId, event.eventId)
      if (outcome.set.length === 0 && outcome.problem !== null) throw new PodIncomplete(`The carrier did not give the proof of delivery: ${outcome.problem}`)
    },
  })
}
