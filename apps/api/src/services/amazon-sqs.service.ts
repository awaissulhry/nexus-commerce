import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
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
import { credentialNotificationType } from './cx/amazon-secret-rotation.service.js'

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
 * RT.16 — ACCOUNT_STATUS_CHANGED notification. The critical alert.
 * Fires when Amazon flags account health: warnings, suspensions,
 * policy violations. Without push the operator only discovers this
 * by logging into Seller Central manually.
 */
export interface AccountStatusChangedNotification {
  accountStatus: string  // HEALTHY | AT_RISK | DEACTIVATED | ...
  marketplaceId: string
  // Optional human-readable summary from Amazon when present —
  // sometimes carries the breach reason.
  message?: string
}

/**
 * RT.15 — FEED_PROCESSING_FINISHED notification. Fires when one of
 * our JSON_LISTINGS_FEED submissions hits a terminal state (DONE /
 * CANCELLED / FATAL). Lets the images-feed worker update the
 * AmazonImageFeedJob row in ~30s instead of waiting for the next
 * polling tick.
 */
export interface FeedProcessingFinishedNotification {
  feedId: string
  feedType: string
  processingStatus: string  // DONE | CANCELLED | FATAL
  resultFeedDocumentId?: string
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
 * P3.2 — LISTINGS_ITEM_ISSUES_CHANGE notification (payload version 2023-12-13).
 *
 * Amazon pushes the issues it currently holds for ONE SKU when they change. It is the
 * fastest route a rejection has to a listing — the alternative is a feed poll that backs
 * off, or a listings sync sweep.
 *
 * 🔶 SHAPE, not REAL. No LISTINGS_ITEM_ISSUES_CHANGE message has ever arrived here —
 * the subscription is still behind `NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES` (PROGRESS section
 * 5 item 9). The field names come from Amazon's documented envelope, and the parser
 * accepts both the PascalCase and camelCase spellings for every one of them, as the
 * other five notification parsers in this file already do. The first real message is
 * worth reading — the ledger stores the payload.
 */
export interface ListingsItemIssuesChangedNotification {
  sellerId: string
  asin: string
  sku: string
  marketplaceId: string
  issues: Array<{ code: string; message: string; severity: string; attributeNames: string[] }>
  /** Amazon's own EventTime — the as-of for the issue rows. */
  eventTime: string | null
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
  /** P3.2 — present on LISTINGS_ITEM_ISSUES_CHANGE messages. */
  listingsItemIssuesNotification?: ListingsItemIssuesChangedNotification
  /** RT.15 — present on FEED_PROCESSING_FINISHED messages. */
  feedProcessingFinishedNotification?: FeedProcessingFinishedNotification
  /** RT.16 — present on ACCOUNT_STATUS_CHANGED messages. */
  accountStatusChangedNotification?: AccountStatusChangedNotification
  receiptHandle: string
  /** SQS Message.MessageId — used as WebhookEvent.externalId for dedup. */
  messageId: string
  /** Raw parsed SNS/notification payload for WebhookEvent.payload storage. */
  rawPayload: unknown
  /** The raw NotificationType string from the envelope. */
  notificationType: string
  /**
   * P0.6 — why this message cannot be handled (unknown type, missing payload, unparseable body).
   * The poller records it in the inbound ledger with this reason and only then deletes it; before
   * P0.6 the parser deleted these messages itself, before any ledger row existed.
   */
  unhandled?: string
  /**
   * P6.1 — an app-credential notification (a new client SECRET, or its expiry date) that arrived on
   * this queue. The raw body is kept in memory only, for the rotation handler; `rawPayload` is
   * redacted, so the secret never reaches the ledger.
   */
  credentialBody?: string
}

/** A message we keep a record of but cannot act on. */
function unhandledMessage(msg: Message, rawPayload: unknown, notificationType: string, reason: string): SqsOrderMessage {
  return { receiptHandle: msg.ReceiptHandle!, messageId: msg.MessageId ?? '', rawPayload, notificationType, unhandled: reason }
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
export async function pollSqsMessages(maxMessages = 10, waitSeconds = 1): Promise<SqsOrderMessage[]> {
  const queueUrl = process.env.AMAZON_SQS_QUEUE_URL
  if (!queueUrl) return []

  const client = buildClient()
  if (!client) return []

  let raw: Message[] = []
  try {
    const response = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: Math.min(maxMessages, 10),
      // RT.3 — long-poll capable: SQS returns a message the moment it arrives
      // during the wait window, so delivery→ingest is effectively instant.
      WaitTimeSeconds: Math.max(1, Math.min(waitSeconds, 20)),
    }))
    raw = response.Messages ?? []
  } catch (err) {
    logger.warn('[SQS] poll failed', { error: err instanceof Error ? err.message : String(err) })
    return []
  }

  const results: SqsOrderMessage[] = []
  for (const msg of raw) {
    if (!msg.Body || !msg.ReceiptHandle) continue
    const credentialType = credentialNotificationType(msg.Body)
    if (credentialType) {
      results.push({
        receiptHandle: msg.ReceiptHandle,
        messageId: msg.MessageId ?? '',
        notificationType: credentialType,
        rawPayload: { notificationType: credentialType, redacted: 'An app-credential notification; its body is never stored.' },
        credentialBody: msg.Body,
      })
      continue
    }
    try {
      // SP-API wraps the notification in an SNS envelope when delivered
      // via SQS. Body may be: raw notification JSON OR SNS JSON with a
      // "Message" string field that contains the real JSON.
      const outer = JSON.parse(msg.Body)
      const inner = outer.Message ? JSON.parse(outer.Message) : outer

      const notifType = inner.NotificationType ?? inner.notificationType

      // RT.16 — account-health change. Critical alert path.
      if (notifType === 'ACCOUNT_STATUS_CHANGED') {
        const root =
          inner.Payload?.AccountStatusChangedNotification ??
          inner.Payload?.AccountStatusChanged
        if (!root) {
          results.push(unhandledMessage(msg, inner, notifType, `The ${notifType} notification has no payload Nexus can read.`))
          continue
        }
        results.push({
          accountStatusChangedNotification: {
            accountStatus: String(
              root.AccountStatus ?? root.accountStatus ?? root.Status ?? 'UNKNOWN',
            ),
            marketplaceId: root.MarketplaceId ?? root.marketplaceId ?? '',
            message: root.Message ?? root.message,
          },
          receiptHandle: msg.ReceiptHandle,
          messageId: msg.MessageId ?? '',
          rawPayload: inner,
          notificationType: notifType,
        })
        continue
      }

      // P3.2 — the listing's issues changed. Routes to ListingIssue in the poller.
      if (notifType === 'LISTINGS_ITEM_ISSUES_CHANGE') {
        const root =
          inner.Payload?.ListingsItemIssuesChangeNotification ??
          inner.Payload?.ListingsItemIssuesChange ??
          inner.Payload?.listingsItemIssuesChangeNotification
        if (!root) {
          results.push(unhandledMessage(msg, inner, notifType, `The ${notifType} notification has no payload Nexus can read.`))
          continue
        }
        const rawIssues: any[] = Array.isArray(root.Issues ?? root.issues) ? (root.Issues ?? root.issues) : []
        results.push({
          listingsItemIssuesNotification: {
            sellerId: String(root.SellerId ?? root.sellerId ?? ''),
            asin: String(root.Asin ?? root.asin ?? ''),
            sku: String(root.Sku ?? root.sku ?? root.SellerSku ?? root.sellerSku ?? ''),
            marketplaceId: String(root.MarketplaceId ?? root.marketplaceId ?? ''),
            issues: rawIssues.map((i) => ({
              code: String(i?.Code ?? i?.code ?? ''),
              message: String(i?.Message ?? i?.message ?? ''),
              severity: String(i?.Severity ?? i?.severity ?? 'ERROR'),
              // Amazon documents the plural; a single AttributeName is accepted too
              // because three of its other envelopes spell it that way.
              attributeNames: Array.isArray(i?.AttributeNames ?? i?.attributeNames)
                ? (i.AttributeNames ?? i.attributeNames).map(String)
                : (i?.AttributeName ?? i?.attributeName) ? [String(i.AttributeName ?? i.attributeName)] : [],
            })),
            eventTime: root.EventTime ?? root.eventTime ?? inner.EventTime ?? null,
          },
          receiptHandle: msg.ReceiptHandle,
          messageId: msg.MessageId ?? '',
          rawPayload: inner,
          notificationType: notifType,
        })
        continue
      }

      // RT.15 — feed processing finished. Routes to
      // AmazonImageFeedJob update + SSE event in the poller.
      if (notifType === 'FEED_PROCESSING_FINISHED') {
        const root =
          inner.Payload?.FeedProcessingFinishedNotification ??
          inner.Payload?.FeedProcessingFinished
        if (!root) {
          results.push(unhandledMessage(msg, inner, notifType, `The ${notifType} notification has no payload Nexus can read.`))
          continue
        }
        results.push({
          feedProcessingFinishedNotification: {
            feedId: root.FeedId ?? root.feedId ?? '',
            feedType: root.FeedType ?? root.feedType ?? '',
            processingStatus:
              root.ProcessingStatus ?? root.processingStatus ?? 'UNKNOWN',
            resultFeedDocumentId:
              root.ResultFeedDocumentId ?? root.resultFeedDocumentId,
          },
          receiptHandle: msg.ReceiptHandle,
          messageId: msg.MessageId ?? '',
          rawPayload: inner,
          notificationType: notifType,
        })
        continue
      }

      // RT.14 — listing status change (search-suppression detection).
      if (notifType === 'LISTINGS_ITEM_STATUS_CHANGE') {
        const root =
          inner.Payload?.ListingsItemStatusChangeNotification ??
          inner.Payload?.ListingsItemStatusChange
        if (!root) {
          results.push(unhandledMessage(msg, inner, notifType, `The ${notifType} notification has no payload Nexus can read.`))
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
          results.push(unhandledMessage(msg, inner, notifType, `The ${notifType} notification has no payload Nexus can read.`))
          continue
        }
        const summary = root.Summary ?? root.summary ?? {}
        const buyBoxPrices: any[] = Array.isArray(summary.BuyBoxPrices)
          ? summary.BuyBoxPrices
          : []
        const offers: any[] = Array.isArray(root.Offers) ? root.Offers : []

        const buyBoxOfferRaw = offers.find((o: any) => o.IsBuyBoxWinner === true)
        const ourSellerId =
          root.SellerId ?? root.sellerId ?? (process.env.NEXUS_WORKSPACES_ENABLED !== '1' ? await getAmazonSellerId() : undefined)
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
          results.push(unhandledMessage(msg, inner, notifType, `The ${notifType} notification has no payload Nexus can read.`))
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
          results.push(unhandledMessage(msg, inner, notifType, `The ${notifType} notification has no payload Nexus can read.`))
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
        // P0.6 — recorded, then acked (was: deleted silently, no row).
        results.push(unhandledMessage(msg, inner, String(notifType ?? 'UNKNOWN'), `Nexus has no handler for ${String(notifType ?? 'an untyped')} notifications.`))
        continue
      }

      const payload =
        notifType === 'ORDER_STATUS_CHANGE'
          ? inner.Payload?.OrderStatusChangeNotification
          : inner.Payload?.OrderChangeNotification
      if (!payload) {
        results.push(unhandledMessage(msg, inner, notifType, `The ${notifType} notification has no payload Nexus can read.`))
        continue
      }

      // P2.2 — ORDER_CHANGE nests the order's own details under `Summary`. Everything
      // below `AmazonOrderId` and `SellerId` was being read one level too high, so it
      // came back undefined every single time. Measured over the 1,413 real ORDER_CHANGE
      // payloads this workspace has stored:
      //
      //   orderStatus     undefined  1413 / 1413
      //   marketplaceId   empty      1413 / 1413
      //   fulfillmentType 'MFN'      1413 / 1413   — the truth was AFN 1071, MFN 342
      //
      // The `?? payload.X` fallbacks keep the retired ORDER_STATUS_CHANGE shape working,
      // which is flat, and would also survive Amazon flattening ORDER_CHANGE again. They
      // are second on purpose: `Summary` is where a live ORDER_CHANGE actually puts these.
      const summary = payload.Summary ?? {}
      results.push({
        notification: {
          amazonOrderId: payload.AmazonOrderId,
          orderStatus: summary.OrderStatus ?? payload.OrderStatus,
          fulfillmentType:
            summary.FulfillmentType ?? payload.FulfillmentType ?? summary.OrderType ?? payload.OrderType ?? 'MFN',
          marketplaceId: summary.MarketplaceId ?? payload.MarketplaceId ?? '',
          sellerId: payload.SellerId ?? '',
          purchaseDate: summary.PurchaseDate ?? payload.PurchaseDate,
        },
        receiptHandle: msg.ReceiptHandle,
        messageId: msg.MessageId ?? '',
        rawPayload: inner,
        notificationType: notifType,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn('[SQS] message parse error — recorded, then acked', { body: msg.Body?.slice(0, 200), error })
      results.push(unhandledMessage(msg, { unparsedBody: msg.Body.slice(0, 64_000) }, 'UNPARSEABLE', `The message body could not be read: ${error}`))
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
