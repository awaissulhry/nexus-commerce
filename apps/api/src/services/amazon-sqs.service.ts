/**
 * IS.2 — Amazon SP-API Notifications via SQS.
 *
 * Reads ORDER_CHANGE messages from an AWS SQS standard queue that Amazon
 * pushes to via the Notifications API. The queue URL is configured via
 * AMAZON_SQS_QUEUE_URL. AWS credentials come from the standard SDK chain
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or instance profile).
 *
 * One-time setup: call POST /api/admin/setup-amazon-notifications after
 * configuring the env vars. That endpoint creates the SP-API destination +
 * subscription so Amazon knows where to push.
 *
 * See docs/IS-SETUP.md for the full AWS + SP-API setup walkthrough.
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs'
import { logger } from '../utils/logger.js'

export interface OrderChangeNotification {
  amazonOrderId: string
  orderStatus: string
  fulfillmentType: string   // 'MFN' | 'AFN'
  marketplaceId: string
  sellerId: string
  purchaseDate?: string
}

/**
 * RT.6 — FBA Outbound (Multi-Channel Fulfillment) shipment status
 * notification. Amazon pushes one of these whenever an MCF shipment
 * transitions (NEW → RECEIVED → PROCESSING → COMPLETE / CANCELLED /
 * UNFULFILLABLE) so we can call syncMCFStatus() in ~30s instead of
 * waiting for the 15-min cron tick.
 */
export interface FbaOutboundShipmentNotification {
  sellerFulfillmentOrderId: string
  status: string
  // Amazon may include the linked AmazonOrderId for direct MCF
  // (Amazon-domestic) shipments. Null for true cross-channel MCF.
  amazonOrderId?: string
}

/**
 * RT.9 — FBA inventory availability change notification. Fires when
 * FBA stock moves (inbound received, return restock, removal, lost,
 * destroyed). Closes the polling gap on the CS-series ingester for
 * Amazon stock — drift surfaces in ~30s instead of next sweep.
 *
 * Amazon's payload carries an array of per-SKU deltas; each becomes
 * one ChannelStockEvent row so the operator can triage from
 * /fulfillment/stock/channel-drift.
 */
export interface FbaInventoryNotification {
  changes: Array<{
    sku: string
    fnsku?: string
    asin?: string
    fulfillableQty: number
    inboundShippedQty?: number
    inboundReceivingQty?: number
    inboundWorkingQty?: number
  }>
}

/**
 * RT.14 — LISTINGS_ITEM_STATUS_CHANGE notification. Fires when a
 * listing's status changes (BUYABLE / DISCOVERABLE / etc.). Lets us
 * detect search-suppression within minutes instead of waiting for
 * the next listings sync sweep.
 */
export interface ListingsItemStatusChangedNotification {
  sellerId: string
  asin: string
  sku: string
  marketplaceId: string
  // Amazon enum — common values: BUYABLE, DISCOVERABLE, NONBUYABLE,
  // SUPPRESSED. We surface the raw string + a derived flag.
  status: string
  isSuppressed: boolean
}

/**
 * RT.13 — ANY_OFFER_CHANGED notification. Fires when Buy Box winner
 * or competing offer price changes. Lets us alert on Buy Box loss in
 * ~30s instead of waiting for the periodic ANY_OFFER_CHANGED REST
 * poll (which we don't do today either).
 *
 * Payload normalised to the minimum we need for the alert path:
 * which ASIN, who has the Buy Box now, at what price. The full
 * envelope (all competing offers, summary stats) stays in
 * rawPayload for forensics + the future repricer engine.
 */
export interface AnyOfferChangedNotification {
  asin: string
  marketplaceId: string
  itemCondition: string
  // Best buy-box offer details — null when no buy box exists for
  // this ASIN (e.g. only used-condition offers).
  buyBoxWinner: {
    sellerId: string
    price?: number
    currency?: string
    fulfillmentType?: string
  } | null
  // Our own offer, if present. Null when we don't have a live offer
  // on this ASIN (e.g. listing suppressed or out of stock).
  ourOffer: {
    sellerId: string
    price?: number
    currency?: string
  } | null
}

export interface SqsOrderMessage {
  /** Present on ORDER_CHANGE / ORDER_STATUS_CHANGE messages. */
  notification?: OrderChangeNotification
  /** RT.6 — present on FBA_OUTBOUND_SHIPMENT_STATUS messages. */
  mcfNotification?: FbaOutboundShipmentNotification
  /** RT.9 — present on FBA_INVENTORY_AVAILABILITY_CHANGES messages. */
  inventoryNotification?: FbaInventoryNotification
  /** RT.13 — present on ANY_OFFER_CHANGED messages. */
  anyOfferChangedNotification?: AnyOfferChangedNotification
  /** RT.14 — present on LISTINGS_ITEM_STATUS_CHANGE messages. */
  listingsItemStatusNotification?: ListingsItemStatusChangedNotification
  receiptHandle: string
  /** SQS Message.MessageId — used as WebhookEvent.externalId for dedup. */
  messageId: string
  /** Raw parsed SNS/notification payload for WebhookEvent.payload storage. */
  rawPayload: unknown
  /** The raw NotificationType string from the envelope. */
  notificationType: string
}

function buildClient(): SQSClient | null {
  if (
    !process.env.AWS_ACCESS_KEY_ID ||
    !process.env.AWS_SECRET_ACCESS_KEY
  ) {
    return null
  }
  return new SQSClient({ region: process.env.AWS_REGION ?? 'eu-west-1' })
}

export function isSqsConfigured(): boolean {
  return !!(process.env.AMAZON_SQS_QUEUE_URL && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
}

/**
 * Poll up to `maxMessages` ORDER_CHANGE notifications from SQS.
 * Returns parsed messages; caller must call deleteMessage() after processing.
 */
export async function pollSqsMessages(maxMessages = 10): Promise<SqsOrderMessage[]> {
  const queueUrl = process.env.AMAZON_SQS_QUEUE_URL
  if (!queueUrl) return []

  const client = buildClient()
  if (!client) return []

  let raw: Message[] = []
  try {
    const response = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: Math.min(maxMessages, 10),
      WaitTimeSeconds: 1,   // short-poll; cron fires frequently
    }))
    raw = response.Messages ?? []
  } catch (err) {
    logger.warn('[SQS] poll failed', { error: err instanceof Error ? err.message : String(err) })
    return []
  }

  const results: SqsOrderMessage[] = []
  for (const msg of raw) {
    if (!msg.Body || !msg.ReceiptHandle) continue
    try {
      // SP-API wraps the notification in an SNS envelope when delivered
      // via SQS. Body may be: raw notification JSON OR SNS JSON with a
      // "Message" string field that contains the real JSON.
      const outer = JSON.parse(msg.Body)
      const inner = outer.Message ? JSON.parse(outer.Message) : outer

      const notifType = inner.NotificationType ?? inner.notificationType

      // RT.14 — listing status change (search-suppression detection).
      if (notifType === 'LISTINGS_ITEM_STATUS_CHANGE') {
        const root =
          inner.Payload?.ListingsItemStatusChangeNotification ??
          inner.Payload?.ListingsItemStatusChange
        if (!root) {
          await deleteSqsMessage(msg.ReceiptHandle)
          continue
        }
        const status =
          root.Status ?? root.status ?? root.ItemStatus?.[0] ?? 'UNKNOWN'
        const statusUpper = String(status).toUpperCase()
        // SUPPRESSED is the explicit hard suppression; DISCOVERABLE
        // means listed but not search-surfaced (soft suppression).
        const isSuppressed =
          statusUpper.includes('SUPPRESSED') ||
          statusUpper === 'NONBUYABLE' ||
          statusUpper === 'DISCOVERABLE'
        results.push({
          listingsItemStatusNotification: {
            sellerId: root.SellerId ?? root.sellerId ?? '',
            asin: root.Asin ?? root.asin ?? root.ASIN ?? '',
            sku: root.Sku ?? root.sku ?? root.SellerSku ?? '',
            marketplaceId: root.MarketplaceId ?? root.marketplaceId ?? '',
            status: String(status),
            isSuppressed,
          },
          receiptHandle: msg.ReceiptHandle,
          messageId: msg.MessageId ?? '',
          rawPayload: inner,
          notificationType: notifType,
        })
        continue
      }

      // RT.13 — Buy Box / competing-offer change. Normalised here;
      // poller fires `competitive.buyBoxLost` when our seller drops
      // out of the buy box.
      if (notifType === 'ANY_OFFER_CHANGED') {
        const root =
          inner.Payload?.AnyOfferChangedNotification ?? inner.Payload?.AnyOfferChanged
        if (!root) {
          await deleteSqsMessage(msg.ReceiptHandle)
          continue
        }
        const summary = root.Summary ?? root.summary ?? {}
        const buyBoxPrices: any[] = Array.isArray(summary.BuyBoxPrices)
          ? summary.BuyBoxPrices
          : []
        const offers: any[] = Array.isArray(root.Offers) ? root.Offers : []

        const buyBoxOfferRaw = offers.find((o: any) => o.IsBuyBoxWinner === true)
        const ourSellerId =
          process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
        const ourOfferRaw = ourSellerId
          ? offers.find((o: any) => o.SellerId === ourSellerId)
          : null

        const bbPrice = buyBoxPrices[0]
        const offerSummary: AnyOfferChangedNotification = {
          asin: root.OfferChangeTrigger?.ASIN ?? root.OfferChangeTrigger?.Asin ?? '',
          marketplaceId: root.OfferChangeTrigger?.MarketplaceId ?? '',
          itemCondition: root.OfferChangeTrigger?.ItemCondition ?? 'New',
          buyBoxWinner: buyBoxOfferRaw
            ? {
                sellerId: buyBoxOfferRaw.SellerId ?? '',
                price: Number(
                  buyBoxOfferRaw.ListingPrice?.Amount ?? bbPrice?.ListingPrice?.Amount ?? 0,
                ),
                currency:
                  buyBoxOfferRaw.ListingPrice?.CurrencyCode ??
                  bbPrice?.ListingPrice?.CurrencyCode ??
                  'EUR',
                fulfillmentType:
                  buyBoxOfferRaw.IsFulfilledByAmazon === true ? 'AFN' : 'MFN',
              }
            : null,
          ourOffer: ourOfferRaw
            ? {
                sellerId: ourOfferRaw.SellerId,
                price: Number(ourOfferRaw.ListingPrice?.Amount ?? 0),
                currency: ourOfferRaw.ListingPrice?.CurrencyCode ?? 'EUR',
              }
            : null,
        }

        results.push({
          anyOfferChangedNotification: offerSummary,
          receiptHandle: msg.ReceiptHandle,
          messageId: msg.MessageId ?? '',
          rawPayload: inner,
          notificationType: notifType,
        })
        continue
      }

      // RT.9 — FBA inventory availability changes. Payload carries an
      // array of per-SKU deltas; each downstream becomes one
      // ChannelStockEvent row for operator triage.
      if (notifType === 'FBA_INVENTORY_AVAILABILITY_CHANGES') {
        const root =
          inner.Payload?.FBAInventoryAvailabilityChanges ??
          inner.Payload?.FBAInventoryAvailabilityChangesNotification
        const items: any[] = Array.isArray(root?.Items)
          ? root.Items
          : Array.isArray(root?.InventoryAvailability)
            ? root.InventoryAvailability
            : []
        if (items.length === 0) {
          await deleteSqsMessage(msg.ReceiptHandle)
          continue
        }
        results.push({
          inventoryNotification: {
            changes: items.map((it: any) => ({
              sku: it.SellerSku ?? it.sellerSku ?? it.Sku ?? it.sku ?? '',
              fnsku: it.FnSku ?? it.fnsku,
              asin: it.Asin ?? it.asin,
              fulfillableQty: Number(
                it.FulfillableQuantity ?? it.fulfillableQuantity ?? it.Available ?? 0,
              ),
              inboundShippedQty: it.InboundShippedQuantity ?? it.inboundShippedQuantity,
              inboundReceivingQty: it.InboundReceivingQuantity ?? it.inboundReceivingQuantity,
              inboundWorkingQty: it.InboundWorkingQuantity ?? it.inboundWorkingQuantity,
            })),
          },
          receiptHandle: msg.ReceiptHandle,
          messageId: msg.MessageId ?? '',
          rawPayload: inner,
          notificationType: notifType,
        })
        continue
      }

      // RT.6 — Multi-Channel Fulfillment shipment status notification.
      // Payload shape: inner.Payload.FBAOutboundShipmentStatus with
      // SellerFulfillmentOrderId + Status + (optional) AmazonOrderId.
      // Routes to syncMCFStatus() in the poller.
      if (notifType === 'FBA_OUTBOUND_SHIPMENT_STATUS') {
        const payload =
          inner.Payload?.FBAOutboundShipmentStatus ??
          inner.Payload?.FBAOutboundShipmentStatusNotification
        if (!payload) {
          await deleteSqsMessage(msg.ReceiptHandle)
          continue
        }
        results.push({
          mcfNotification: {
            sellerFulfillmentOrderId:
              payload.SellerFulfillmentOrderId ?? payload.sellerFulfillmentOrderId ?? '',
            status: payload.Status ?? payload.status ?? '',
            amazonOrderId: payload.AmazonOrderId ?? payload.amazonOrderId,
          },
          receiptHandle: msg.ReceiptHandle,
          messageId: msg.MessageId ?? '',
          rawPayload: inner,
          notificationType: notifType,
        })
        continue
      }

      // RT.5 — accept both ORDER_CHANGE (legacy) AND ORDER_STATUS_CHANGE
      // (Amazon's replacement notification type). During the parallel-
      // run window both arrive in the same SQS queue. The payload
      // envelope shape differs slightly:
      //   ORDER_CHANGE          → inner.Payload.OrderChangeNotification
      //   ORDER_STATUS_CHANGE   → inner.Payload.OrderStatusChangeNotification
      // — we normalise to the same SqsOrderMessage downstream so the
      // poller doesn't need a per-type code path.
      if (notifType !== 'ORDER_CHANGE' && notifType !== 'ORDER_STATUS_CHANGE') {
        // Silently ack everything else (test events, etc.)
        await deleteSqsMessage(msg.ReceiptHandle)
        continue
      }

      const payload =
        notifType === 'ORDER_STATUS_CHANGE'
          ? inner.Payload?.OrderStatusChangeNotification
          : inner.Payload?.OrderChangeNotification
      if (!payload) continue

      results.push({
        notification: {
          amazonOrderId: payload.AmazonOrderId,
          orderStatus: payload.OrderStatus,
          fulfillmentType: payload.FulfillmentType ?? payload.OrderType ?? 'MFN',
          marketplaceId: payload.MarketplaceId ?? '',
          sellerId: payload.SellerId ?? '',
          purchaseDate: payload.PurchaseDate,
        },
        receiptHandle: msg.ReceiptHandle,
        messageId: msg.MessageId ?? '',
        rawPayload: inner,
        notificationType: notifType,
      })
    } catch (err) {
      logger.warn('[SQS] message parse error — deleting', {
        body: msg.Body?.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      })
      await deleteSqsMessage(msg.ReceiptHandle)
    }
  }

  return results
}

export async function deleteSqsMessage(receiptHandle: string): Promise<void> {
  const queueUrl = process.env.AMAZON_SQS_QUEUE_URL
  if (!queueUrl) return

  const client = buildClient()
  if (!client) return

  try {
    await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }))
  } catch (err) {
    logger.warn('[SQS] delete failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
