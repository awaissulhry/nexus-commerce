import { statusOfSendcloudId } from '@nexus/factory-domain/shipping/labels/tracking'
import { parseStatusChange, statusChangeKey } from '../../../adapters/sendcloud/webhook'
import type { InboundProcessor } from '../../../platform/inbound/providers'
import { recordTracking } from './tracking'

/**
 * Sendcloud's tracking webhooks (B-W1-48; LOG-025, LOG-059), the inbound ledger's processor for provider SENDCLOUD
 * (platform/inbound/providers.ts): the receipt was verified and stored first; this runs once, inside the processing
 * command, in the receipt's tenant. A "parcel status changed" body names the parcel by its tracking number: the parcel
 * of a shipment labelled with THIS account (a voided label's number names no parcel any more). Its status, mapped to the
 * factory's list, is recorded once (./tracking.ts: the shipment locked, news, the move). Anything else (another action,
 * a status that is not a tracking fact, a parcel the factory does not know) is processed as nothing.
 */
export function sendcloudTrackingProcessor(): InboundProcessor {
  return {
    async process(receipt, tools) {
      const change = parseStatusChange(receipt.body)
      if (!change) return
      const status = statusOfSendcloudId(change.statusId, change.statusMessage)
      if (status === null) return
      const parcel = await tools.tx.parcel.findFirst({ where: { trackingNumber: change.trackingNumber, shipment: { integrationAccountId: receipt.accountId } }, select: { id: true, shipmentId: true } })
      if (!parcel) return
      await recordTracking(
        tools,
        parcel.shipmentId,
        [
          {
            parcelId: parcel.id,
            status,
            carrierStatusCode: String(change.statusId),
            description: change.statusMessage,
            location: null,
            occurredAt: new Date(change.timestampMs),
            externalEventId: statusChangeKey(change),
          },
        ],
        'WEBHOOK',
      )
    },
  }
}
