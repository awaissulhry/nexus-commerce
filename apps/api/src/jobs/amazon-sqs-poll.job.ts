/**
 * IS.2 — Real-time Amazon order detection via SP-API Notifications + SQS.
 *
 * Runs every 30 seconds (two ticks per cron minute using setInterval inside
 * the cron handler). When Amazon places or updates a FBM order it pushes an
 * ORDER_CHANGE notification to the configured SQS queue; this job drains
 * that queue so the stock cascade fires in ~30–90 seconds rather than waiting
 * for the 15-min polling cron.
 *
 * Gate: NEXUS_ENABLE_AMAZON_SQS_POLL=1 AND AMAZON_SQS_QUEUE_URL set.
 *
 * For setup instructions see docs/IS-SETUP.md.
 */

import cron from 'node-cron'
import { isSqsConfigured, pollSqsMessages, deleteSqsMessage } from '../services/amazon-sqs.service.js'
import { amazonOrdersService } from '../services/amazon-orders.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import prisma from '../db.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let running = false

async function runSqsPoll(): Promise<void> {
  if (running) return   // skip if previous tick is still in flight
  if (!isSqsConfigured()) return
  if (!amazonOrdersService.isConfigured()) return

  running = true
  try {
    await recordCronRun('amazon-sqs-poll', async () => {
      const messages = await pollSqsMessages(10)
      if (messages.length === 0) return 'no messages'

      let processed = 0
      let skipped = 0

      for (const msg of messages) {
        // P3.4 — Persist to WebhookEvent so the message appears in
        // /sync-logs/webhooks and can be replayed. Upsert on (channel, externalId)
        // so polling the same message twice (before ack) is idempotent.
        //
        // RT.3 — capture the SP-API EventTime (when Amazon emitted the
        // notification) so /api/admin/push-latency can compute the
        // (ingestedAt - providerTimestamp) percentile per source.
        let webhookEventId: string | null = null
        if (msg.messageId) {
          const raw = msg.rawPayload as any
          const eventTimeRaw =
            raw?.EventTime ?? raw?.eventTime ?? raw?.Payload?.EventTime ?? null
          const providerTimestamp =
            typeof eventTimeRaw === 'string' && !Number.isNaN(Date.parse(eventTimeRaw))
              ? new Date(eventTimeRaw)
              : null
          try {
            const we = await prisma.webhookEvent.upsert({
              where: { channel_externalId: { channel: 'AMAZON', externalId: msg.messageId } },
              create: {
                channel: 'AMAZON',
                eventType: msg.notificationType,
                externalId: msg.messageId,
                payload: msg.rawPayload as any,
                isProcessed: false,
                providerTimestamp,
              },
              update: {},  // don't overwrite if already persisted
              select: { id: true },
            })
            webhookEventId = we.id
          } catch {
            // Non-fatal — proceed with processing regardless
          }
        }

        // RT.16 — CRITICAL: account-health change. Always emits the
        // SSE event regardless of resolved/unresolved status so the
        // global banner can reflect the latest state. UI decides
        // whether to render based on the accountStatus value
        // (HEALTHY → hide banner, anything else → show).
        if (msg.accountStatusChangedNotification) {
          const note = msg.accountStatusChangedNotification
          const { publishOrderEvent } = await import(
            '../services/order-events.service.js'
          )
          publishOrderEvent({
            type: 'account.health.changed',
            accountStatus: note.accountStatus,
            marketplaceId: note.marketplaceId,
            message: note.message,
            ts: Date.now(),
          })
          // Log at error level so it shows up in any error monitor
          // alongside crashes — account health is THE critical signal.
          logger.error('[SQS poll] account status changed', {
            accountStatus: note.accountStatus,
            marketplaceId: note.marketplaceId,
            message: note.message,
          })
          await deleteSqsMessage(msg.receiptHandle)
          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { isProcessed: true, processedAt: new Date() },
            }).catch(() => {})
          }
          processed++
          continue
        }

        // RT.15 — feed processing finished. Resolves the matching
        // AmazonImageFeedJob row (if any) by feedId and fires the
        // feed.processing.finished SSE event so the images-tab UI
        // can stop polling that job and refresh from the push.
        if (msg.feedProcessingFinishedNotification) {
          const note = msg.feedProcessingFinishedNotification
          try {
            const job = note.feedId
              ? await prisma.amazonImageFeedJob.findFirst({
                  where: { feedId: note.feedId },
                  select: { id: true, productId: true, status: true },
                })
              : null
            if (job) {
              const terminal =
                note.processingStatus === 'DONE' ||
                note.processingStatus === 'CANCELLED' ||
                note.processingStatus === 'FATAL'
              if (terminal) {
                // Finalize from the push: poll Amazon, fetch the processing report,
                // and flip DRAFT → PUBLISHED/ERROR — so the job resolves without
                // anyone keeping the images tab open to drive the FE poll.
                const { pollAndUpdateFeedJob } = await import(
                  '../services/images/amazon-image-feed.service.js'
                )
                await pollAndUpdateFeedJob(job.id).catch(() => {})
              } else if (job.status !== note.processingStatus) {
                await prisma.amazonImageFeedJob.update({
                  where: { id: job.id },
                  data: { status: note.processingStatus, completedAt: null },
                })
              }
            }
            const { publishOrderEvent } = await import(
              '../services/order-events.service.js'
            )
            publishOrderEvent({
              type: 'feed.processing.finished',
              feedId: note.feedId,
              processingStatus: note.processingStatus,
              jobId: job?.id ?? null,
              productId: job?.productId ?? null,
              ts: Date.now(),
            })
            logger.info('[SQS poll] feed processing finished', {
              feedId: note.feedId,
              status: note.processingStatus,
              jobId: job?.id,
            })
          } catch (err) {
            logger.warn('[SQS poll] feed-finished handler failed', {
              feedId: note.feedId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          await deleteSqsMessage(msg.receiptHandle)
          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { isProcessed: true, processedAt: new Date() },
            }).catch(() => {})
          }
          processed++
          continue
        }

        // RT.14 — listing status change. Fires `listing.suppressed`
        // SSE event when a listing transitions to a suppressed /
        // non-buyable state so the operator can investigate within
        // minutes instead of waiting for the next listings sweep.
        if (msg.listingsItemStatusNotification) {
          const note = msg.listingsItemStatusNotification
          if (note.isSuppressed && note.asin) {
            const { publishOrderEvent } = await import(
              '../services/order-events.service.js'
            )
            publishOrderEvent({
              type: 'listing.suppressed',
              asin: note.asin,
              sku: note.sku,
              marketplaceId: note.marketplaceId,
              status: note.status,
              ts: Date.now(),
            })
            logger.warn('[SQS poll] listing suppressed', {
              asin: note.asin,
              sku: note.sku,
              status: note.status,
            })
          }
          await deleteSqsMessage(msg.receiptHandle)
          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { isProcessed: true, processedAt: new Date() },
            }).catch(() => {})
          }
          processed++
          continue
        }

        // RT.13 — Buy Box / competing-offer change. Fires the
        // competitive.buyBoxLost SSE event when our seller is no
        // longer the buy-box winner so the global competitive
        // banner can ping the operator. Alert only — auto-reprice
        // lives in CE-series.
        if (msg.anyOfferChangedNotification) {
          const note = msg.anyOfferChangedNotification
          const ourSellerId =
            process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
          const winnerIsUs =
            note.buyBoxWinner !== null &&
            ourSellerId !== '' &&
            note.buyBoxWinner.sellerId === ourSellerId

          if (!winnerIsUs && note.asin) {
            // We don't fire on "we never had it" — that's just life,
            // not a regression. We only ping when we have a current
            // offer (so we WERE in the running) but lost.
            if (note.ourOffer) {
              const { publishOrderEvent } = await import(
                '../services/order-events.service.js'
              )
              publishOrderEvent({
                type: 'competitive.buyBoxLost',
                asin: note.asin,
                marketplaceId: note.marketplaceId,
                ourPrice: note.ourOffer.price ?? null,
                winnerPrice: note.buyBoxWinner?.price ?? null,
                currency: note.buyBoxWinner?.currency ?? note.ourOffer.currency ?? 'EUR',
                winnerSellerId: note.buyBoxWinner?.sellerId ?? null,
                winnerFulfillmentType: note.buyBoxWinner?.fulfillmentType ?? null,
                ts: Date.now(),
              })
              logger.info('[SQS poll] buy box lost', {
                asin: note.asin,
                ourPrice: note.ourOffer.price,
                winnerPrice: note.buyBoxWinner?.price,
              })
            }
          }
          await deleteSqsMessage(msg.receiptHandle)
          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { isProcessed: true, processedAt: new Date() },
            }).catch(() => {})
          }
          processed++
          continue
        }

        // RT.9 — FBA inventory availability change. Each per-SKU
        // delta becomes one ChannelStockEvent row; the recorder is
        // idempotent on (channel, channelEventId) so retries collapse
        // safely. Drift surfaces on /fulfillment/stock/channel-drift
        // in ~30s instead of waiting for the CS ingester sweep.
        if (msg.inventoryNotification) {
          let recordedCount = 0
          let recordedErrors = 0
          try {
            const { recordChannelStockEvent } = await import(
              '../services/channel-stock-event.service.js'
            )
            for (const change of msg.inventoryNotification.changes) {
              if (!change.sku) continue
              try {
                // Composite channelEventId so the same SKU pushed
                // twice in a window collapses on the unique constraint.
                const channelEventId = `${msg.messageId}:${change.sku}`
                await recordChannelStockEvent({
                  channel: 'AMAZON',
                  channelEventId,
                  sku: change.sku,
                  channelReportedQty: Math.max(0, change.fulfillableQty),
                  rawPayload: change,
                })
                recordedCount++
              } catch (innerErr) {
                recordedErrors++
                logger.warn('[SQS poll] FBA inventory delta record failed', {
                  sku: change.sku,
                  error: innerErr instanceof Error ? innerErr.message : String(innerErr),
                })
              }
            }
            await deleteSqsMessage(msg.receiptHandle)
            if (webhookEventId) {
              await prisma.webhookEvent.update({
                where: { id: webhookEventId },
                data: {
                  isProcessed: true,
                  processedAt: new Date(),
                  error: recordedErrors > 0 ? `${recordedErrors} sku(s) failed` : null,
                },
              }).catch(() => {})
            }
            processed++
            logger.info('[SQS poll] processed FBA_INVENTORY_AVAILABILITY_CHANGES', {
              recordedCount,
              recordedErrors,
            })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            logger.warn('[SQS poll] FBA inventory handler failed', { error: errMsg })
            if (webhookEventId) {
              await prisma.webhookEvent.update({
                where: { id: webhookEventId },
                data: { error: errMsg.slice(0, 2000) },
              }).catch(() => {})
            }
            // Don't delete — let SQS retry.
          }
          continue
        }

        // RT.6 — FBA Outbound (Multi-Channel Fulfillment) shipment
        // status path. Calls syncMCFStatus inline so MCF status updates
        // land in ~30s instead of waiting for the 15-min cron tick.
        // FCF.5 — shares the centralised resolveMcfAdapter: the real
        // SP-API adapter when AMAZON_MCF_LIVE=1, else the stub (which
        // throws "not configured" and is acked below).
        if (msg.mcfNotification) {
          const { sellerFulfillmentOrderId, status } = msg.mcfNotification
          try {
            if (sellerFulfillmentOrderId) {
              const { syncMCFStatus, resolveMcfAdapter } = await import(
                '../services/amazon-mcf.service.js'
              )
              await syncMCFStatus(resolveMcfAdapter(), sellerFulfillmentOrderId)
            }
            await deleteSqsMessage(msg.receiptHandle)
            if (webhookEventId) {
              await prisma.webhookEvent.update({
                where: { id: webhookEventId },
                data: { isProcessed: true, processedAt: new Date() },
              }).catch(() => {})
            }
            processed++
            logger.info('[SQS poll] processed FBA_OUTBOUND_SHIPMENT_STATUS', {
              sellerFulfillmentOrderId,
              status,
            })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            // unconfiguredAdapter throws by design — log + ack so we
            // don't loop. Production adapter will replace this.
            const isUnconfigured = /not configured|unconfigured/i.test(errMsg)
            if (isUnconfigured) {
              await deleteSqsMessage(msg.receiptHandle)
              if (webhookEventId) {
                await prisma.webhookEvent.update({
                  where: { id: webhookEventId },
                  data: {
                    isProcessed: true,
                    processedAt: new Date(),
                    error: 'MCF adapter not configured — see AMAZON_MCF_LIVE',
                  },
                }).catch(() => {})
              }
              skipped++
              logger.info('[SQS poll] MCF adapter unconfigured — acked', {
                sellerFulfillmentOrderId,
              })
            } else {
              logger.warn('[SQS poll] MCF status sync failed', {
                sellerFulfillmentOrderId,
                error: errMsg,
              })
              if (webhookEventId) {
                await prisma.webhookEvent.update({
                  where: { id: webhookEventId },
                  data: { error: errMsg.slice(0, 2000) },
                }).catch(() => {})
              }
              // Don't delete — let SQS retry (visibility timeout will expire)
            }
          }
          continue
        }

        if (!msg.notification) {
          // Defensive — unknown notification shape. Persisted to
          // WebhookEvent for forensics; ack so we don't loop.
          await deleteSqsMessage(msg.receiptHandle)
          skipped++
          continue
        }
        const { amazonOrderId, orderStatus, fulfillmentType } = msg.notification

        // FBA orders are managed by Amazon's warehouse — no stock action needed here.
        if (fulfillmentType === 'AFN') {
          await deleteSqsMessage(msg.receiptHandle)
          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { isProcessed: true, processedAt: new Date() },
            }).catch(() => {})
          }
          skipped++
          continue
        }

        try {
          // syncNewOrders with a very short window covers this specific order
          // (SP-API returns it by LastUpdatedAfter). Idempotent — the service
          // upserts on (channel, channelOrderId).
          const since = new Date(Date.now() - 5 * 60 * 1000) // last 5 min
          await amazonOrdersService.syncNewOrders(since, { limit: 50 })

          // GS-RT.4 — if the DB row for this specific order is still at
          // `totalPrice=0` after the ListOrders pass, fall through to a
          // direct getOrder call. SP-API ListOrders sometimes returns a
          // partial snapshot for orders that JUST transitioned out of
          // PENDING — getOrder always has the canonical OrderTotal once
          // Amazon releases it. Without this, the only path to recover
          // the price is the 15-min backfill cron (GS-RT.2).
          if (amazonOrderId) {
            const row = await prisma.order.findUnique({
              where: {
                channel_channelOrderId: {
                  channel: 'AMAZON',
                  channelOrderId: amazonOrderId,
                },
              },
              select: { id: true, totalPrice: true },
            })
            if (row && Number(row.totalPrice) === 0) {
              try {
                // GS-RT.4 — target THIS order specifically via the
                // channelOrderIds filter (added to backfillZeroTotals
                // for this push path). Without the filter we'd risk
                // re-fetching some other older €0 row whose
                // purchaseDate is earlier, missing the operationally
                // important transition that just landed.
                const repair = await amazonOrdersService.backfillZeroTotals({
                  limit: 1,
                  includePending: true,
                  channelOrderIds: [amazonOrderId],
                })
                if (repair.repaired > 0) {
                  logger.info('[SQS poll] GS-RT.4 backfill repaired €0 row', {
                    amazonOrderId,
                    repaired: repair.repaired,
                  })
                }
              } catch (repairErr) {
                logger.warn('[SQS poll] GS-RT.4 backfill nudge failed', {
                  amazonOrderId,
                  error: repairErr instanceof Error ? repairErr.message : String(repairErr),
                })
                // Non-fatal — the regular syncNewOrders flow already
                // succeeded; the order status updated. Price will
                // catch up via GS-RT.2 cron in <=15 min.
              }
            }
          }

          processed++
          logger.info('[SQS poll] processed ORDER_CHANGE', { amazonOrderId, orderStatus })

          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { isProcessed: true, processedAt: new Date() },
            }).catch(() => {})
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          logger.warn('[SQS poll] order sync failed', { amazonOrderId, error: errMsg })

          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { error: errMsg.slice(0, 2000) },
            }).catch(() => {})
          }
          // Don't delete — let SQS retry (visibility timeout will expire)
          continue
        }

        await deleteSqsMessage(msg.receiptHandle)
      }

      return `messages=${messages.length} processed=${processed} skipped=${skipped}`
    })
  } finally {
    running = false
  }
}

export function startAmazonSqsPollCron(): void {
  if (!process.env.NEXUS_ENABLE_AMAZON_SQS_POLL || process.env.NEXUS_ENABLE_AMAZON_SQS_POLL !== '1') return
  if (!isSqsConfigured()) {
    logger.info('amazon-sqs-poll: AMAZON_SQS_QUEUE_URL not configured — skipping')
    return
  }
  if (scheduledTask) {
    logger.warn('amazon-sqs-poll: already started')
    return
  }

  // Every minute in cron; we run the poll twice per tick (at 0s and 30s)
  // using a setTimeout so effective interval is ~30 seconds.
  scheduledTask = cron.schedule('* * * * *', () => {
    void runSqsPoll()
    setTimeout(() => { void runSqsPoll() }, 30_000)
  })

  logger.info('amazon-sqs-poll: started (every ~30s)')
}

export function stopAmazonSqsPollCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
