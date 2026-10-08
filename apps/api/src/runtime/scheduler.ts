import './registrations.js'
// Schedule registration lives outside the HTTP process. Job bodies and feature flags
// remain unchanged; the clustered wrapper owns workspace leases.
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { getAmazonPublishMode } from '../services/amazon-publish-gate.service.js'
import { getEbayPublishMode } from '../services/ebay-publish-gate.service.js'
import { getShopifyPublishMode } from '../services/shopify-publish-gate.service.js'
import { startReadinessReconcileCron } from '../jobs/readiness-reconcile.job.js'
import { startReadinessPendingCron } from '../jobs/readiness-pending.job.js'
import { startContentDriftCron } from '../jobs/content-drift.job.js'
import { visitActiveWorkspaces } from '../lib/workspace-sweep.js'
import { startTaxonomyRefreshCron } from "../jobs/taxonomy-refresh.job.js";
import { startAdsRunWatchdogCron } from "../jobs/claude-ads-run-watchdog.job.js";
import { startPlatformHealthWatchdogCron } from "../jobs/platform-health-watchdog.job.js";
import { startCxHeartbeatCron } from "../jobs/cx-heartbeat.job.js";
import { startDlqMonitorCron } from "../jobs/dlq-monitor.job.js";
import { ensureAmazonNotificationSubscription } from "../services/amazon-notifications-boot.service.js";
import { startAmazonNotificationReconcileCron } from "../jobs/amazon-notification-reconcile.job.js";
import { startEbayNotificationReconcileCron } from "../jobs/ebay-notification-reconcile.job.js";
import { startAmsSubscriptionCheckCron } from "../jobs/ams-subscription-check.job.js";
import { startWizardCleanupCron } from "../jobs/wizard-cleanup.job.js";
import { startOrphanBulkJobCleanupCron } from "../jobs/bulk-job-orphan-cleanup.job.js";
import { startFbaFlipGuardCron } from "../jobs/fba-flip-guard.job.js";
import { startFbaDriftDetectorCron } from "../jobs/fba-drift-detector.job.js";
import { startFulfilmentConversionConfirmCron } from "../jobs/fulfilment-conversion-confirm.job.js";
import { startReadCacheReconcileCron } from "../jobs/read-cache-reconcile.job.js";
import { startScheduledBulkActionCron } from "../jobs/scheduled-bulk-action.job.js";
import { startBulkAutomationTickCron } from "../jobs/bulk-automation-tick.job.js";
import { startScheduledImportCron } from "../jobs/scheduled-import.job.js";
import { startScheduledExportCron } from "../jobs/scheduled-export.job.js";
import { startSalesReportIngestCron } from "../jobs/sales-report-ingest.job.js";
import { startDataKioskCrons } from "../jobs/data-kiosk.job.js";
import { startForecastCron } from "../jobs/forecast.job.js";
import { startDashboardDigestCron } from "../jobs/dashboard-digest.job.js";
import { startAdsReportScheduleCron } from "../jobs/ads-report-schedule.job.js";
import { startPricingCron } from "../jobs/pricing-refresh.job.js";
import { startRepricerCron } from "../jobs/repricer.job.js";
import { startCatalogRefreshCron } from "../jobs/catalog-refresh.job.js";
import { startSchemaRefreshCron } from "../jobs/schema-refresh.job.js";
import { startEbayReturnsPollCron } from "../jobs/ebay-returns-poll.job.js";
import { startAmazonReturnsPollCron } from "../jobs/amazon-returns-poll.job.js";
import { startFlatFileFeedPollCron } from "../jobs/amazon-flat-file-feed-poll.job.js";
import { startPublicationSettleCron } from "../jobs/studio-publication-settle.job.js";
import { startPublicationBatchResumeCron } from "../jobs/publication-batch-resume.job.js";
import { startSuppressionIssueCron } from '../jobs/listing-issue-suppression.job.js'
import { startChannelAlertsCron } from '../jobs/channel-alerts.job.js'
import { startEbayFeedPollCron } from "../jobs/ebay-feed-poll.job.js";
import { startAttrHydrateCron } from "../jobs/amazon-attr-hydrate.job.js";
import { startRefundRetryCron } from "../jobs/refund-retry.job.js";
import { startRefundDeadlineTrackerCron } from "../jobs/refund-deadline-tracker.job.js";
import { startAmazonOrdersCron } from "../jobs/amazon-orders-sync.job.js";
import { startAmazonZeroTotalsBackfillCron } from "../jobs/amazon-zero-totals-backfill.job.js";
import { startSalesDriftDetectorCron } from "../jobs/sales-drift-detector.job.js";
import { startLatencyWatchdogCron } from "../jobs/latency-watchdog.job.js";
import { startAmazonOrderItemsRetryCron } from "../jobs/amazon-order-items-retry.job.js";
import { startEbayOrdersCron } from "../jobs/ebay-orders-sync.job.js";
import { startEbayStatusReconcileCron } from "../jobs/ebay-status-reconcile.job.js";
import { startEbayLabelGuardCron } from "../jobs/ebay-label-guard.job.js";
import { startEbayImageReadbackCron } from "../jobs/ebay-image-readback.job.js";
import { startImageReadbackSweepCron } from "../jobs/image-readback-sweep.job.js";
import { startAmazonFinancialSyncCron } from "../jobs/amazon-financial-sync.job.js";
import { startEbayFinancialSyncCron } from "../jobs/ebay-financial-sync.job.js";
import { startAmazonInventoryCron } from "../jobs/amazon-inventory-sync.job.js";
import { startReservationSweepCron } from "../jobs/reservation-sweep.job.js";
import { startReservationReconcileCron } from "../jobs/reservation-reconcile.job.js";
import { startOutboundQueueJanitorCron } from "../jobs/outbound-queue-janitor.job.js";
import { startEbayItemStatusReconcileCron } from "../jobs/ebay-item-status-reconcile.job.js";
import { startAmazonQtyReadbackCron } from "../jobs/amazon-qty-readback.job.js";
import { startAmazonAsinFillCron } from "../jobs/amazon-asin-fill.job.js";
import { startIdentityChannelSweepCron } from "../jobs/identity-channel-sweep.job.js";
import { startEbayReadbackCron } from "../jobs/ebay-readback.job.js";
import { startShopifyQtyReadbackCron } from "../jobs/shopify-qty-readback.job.js";
import { startAdsRegionReconcileCron } from "../jobs/p45b-ads-region-reconcile.job.js";
import { startEtsyContentRefreshCron } from "../jobs/etsy-content-refresh.job.js";
import { startEtsyReceiptsPollCron } from "../jobs/etsy-receipts-poll.job.js";
import { startEbayAdsSyncCrons } from "../jobs/ebay-ads-sync.job.js";
import { startReconcileCron } from "../jobs/reconcile-cron.job.js";
import { startLateShipmentFlagCron } from "../jobs/late-shipment-flag.job.js";
import { startTrackingPushbackCron } from "../jobs/tracking-pushback.job.js";
import { startCarrierServiceSyncCron } from "../jobs/carrier-service-sync.job.js";
import { startPickupDispatchCron } from "../jobs/pickup-dispatch.job.js";
import { startCarrierMetricsCron } from "../jobs/carrier-metrics.job.js";
import { startOutboundLateRiskCron } from "../jobs/outbound-late-risk.job.js";
import { startSavedViewAlertsCron } from "../jobs/saved-view-alerts.job.js";
import { startSyncDriftDetectionCron } from "../jobs/sync-drift-detection.job.js";
import { startStockPushHealCron } from "../jobs/stock-push-heal.job.js";
import { startFbaStatusPollCron } from "../jobs/fba-status-poll.job.js";
import { startFbaInboundResumeCron } from "../jobs/fba-inbound-resume.job.js";
import { startForecastAccuracyCron } from "../jobs/forecast-accuracy.job.js";
import { startAutoPoCron } from "../jobs/auto-po-replenishment.job.js";
import { startLeadTimeStatsCron } from "../jobs/lead-time-stats.job.js";
import { startStockoutDetectorCron } from "../jobs/stockout-detector.job.js";
import { startAssortmentCopyCron } from "../jobs/assortment-copy.job.js";
import { startListingEndTimesCron } from "../jobs/listing-end-times.job.js";
import { startAssortmentRepair } from "../jobs/assortment-sync.job.js";
import { startAbcClassificationCron } from "../jobs/abc-classification.job.js";
import { startChannelContractCron } from "../jobs/channel-contract.job.js";
import { startListingQualityKeeperCron } from "../jobs/listing-quality-keeper.job.js";
import { startPricingWatchdogCron } from "../jobs/pricing-watchdog.job.js";
import { startCycleCountSchedulerCron } from "../jobs/cycle-count-scheduler.job.js";
import { startYearEndSnapshotCron } from "../jobs/year-end-snapshot.job.js";
import { startLotExpiryAlertCron } from "../jobs/lot-expiry-alert.job.js";
import { startCertExpiryAlertCron } from "../jobs/cert-expiry-alert.job.js";
import { startShopifyLinkedAutomationCron } from '../jobs/shopify-linked-automation.job.js';
import { startScheduledChangesCron } from "../jobs/scheduled-changes.job.js";
import { startPurgeSoftDeletedCron } from "../jobs/purge-soft-deleted-products.job.js";
import { startRetentionSweepCron } from "../jobs/data-retention-sweep.job.js";
import { startAmazonMCFStatusCron } from "../jobs/amazon-mcf-status.job.js";
import { startFbaPanEuSyncCron } from "../jobs/fba-pan-eu-sync.job.js";
import { startFbaRestockCron } from "../jobs/fba-restock-ingestion.job.js";
import { startAutomationRuleEvaluatorCron } from "../jobs/automation-rule-evaluator.job.js";
import { seedPromptTemplateDefaults } from "../services/ai/prompt-template.service.js";
import { startScheduledWizardPublishCron } from "../jobs/scheduled-wizard-publish.job.js";
import { startScheduledImagePublishCron } from "../jobs/scheduled-image-publish.job.js";
import { startImagePublishReconcileCron } from "../jobs/image-publish-reconcile.job.js";
import { startScheduledPoCron } from "../jobs/scheduled-po.job.js";
import { startObservabilityRetentionCron } from "../jobs/observability-retention.job.js";
import { startAlertEvaluatorCron } from "../jobs/alert-evaluator.job.js";
import { startRepricingEvaluatorCron } from "../jobs/repricing-evaluator.job.js";
import { envEnabled } from "../utils/env-flag.js";
import { cronStartupState, markCronStep } from "../jobs/cron-startup-state.js";
import { registerStatusSection } from "../lib/runtime-status/process-snapshot.js";

export async function startScheduler(): Promise<void> {
  // GET /api/advertising/cron-status reports how far the ads-cron block got from this process's snapshot.
  registerStatusSection('cronStartup', () => ({ ...cronStartupState }));

  // NN.14 / OO.1 — daily cron for abandoned wizard cleanup. Now
  // gated behind NEXUS_ENABLE_WIZARD_CLEANUP=1 so the destructive
  // path is opt-in. The cron only deletes DRAFT wizards whose
  // expiresAt is in the past (NULL expiresAt rows from before the
  // migration are excluded by the < operator), but until the
  // operator explicitly opts in we keep it dormant.
  if (process.env.NEXUS_ENABLE_WIZARD_CLEANUP === '1') {
    startWizardCleanupCron();
  }

  // L.4.0 — observability retention. Trims OutboundApiCallLog +
  // CronRun to a 90-day rolling window so the high-volume tables
  // don't grow unbounded. Default-ON; opt out with
  // NEXUS_DISABLE_OBSERVABILITY_RETENTION=1 (e.g. during forensics).
  startObservabilityRetentionCron();

  // FBA-flip guard (every 10 min). Standing detector: alerts if a merchant
  // QUANTITY_UPDATE ever succeeds for an FBA SKU (the FBA→FBM flip). Pure
  // detection; opt out with NEXUS_ENABLE_FBA_FLIP_GUARD=0.
  startFbaFlipGuardCron();

  // FBA→FBM drift detector (daily 05:00 UTC). Reads Amazon's REAL
  // fulfillment-channel (merchant listings report) per market and alerts if a
  // SKU we expect FBA shows as FBM — catches flips from ANY source (Seller
  // Central, other tools), not just Nexus. Opt out: NEXUS_ENABLE_FBA_DRIFT_DETECTOR=0.
  startFbaDriftDetectorCron();

  // Amazon fulfilment conversion (2026-10-07) — every 15 min, only while an FBA ⇄ FBM change Nexus sent is waiting for
  // Amazon's merchant listings report (< 24 h): confirms it, or says it is still old / not in the report. Read-only on
  // Amazon. Opt out: NEXUS_ENABLE_FULFILMENT_CONFIRM=0.
  startFulfilmentConversionConfirmCron();

  // ES.4 — ProductReadCache reconcile (every 15 min). Worker-independent
  // backstop that heals any drift between Product truth and the /products
  // LIST projection (missing rows → "products disappeared", stale totalStock
  // → "import didn't apply"). Opt out: NEXUS_ENABLE_READCACHE_RECONCILE=0.
  startReadCacheReconcileCron();
  startReadinessReconcileCron();
  // P2 (docs/attributes/PLAN.md §4.7) — rebuild readiness that a big bulk edit left pending (every minute, 45 s budget).
  startReadinessPendingCron();
  // A-39 (R-41) — Step 3.5b: nightly, rotating Amazon content read → ChannelDrift (NEXUS_ENABLE_CONTENT_DRIFT=0 to disable).
  startContentDriftCron();

  // W1.3 — orphan bulk-job cleanup (hourly). Auto-cancels PENDING /
  // QUEUED BulkActionJob rows that never got POST /:id/process'd
  // within an hour. Default-ON; the audit found a 3-day-old PENDING
  // job sitting on the active-jobs strip and confusing operators.
  startOrphanBulkJobCleanupCron();

  // W6.2 — scheduled bulk-action tick. Fires every minute, fans
  // out due ScheduledBulkAction rows into real BulkActionJob runs
  // via BulkActionService.createJob.
  startScheduledBulkActionCron();

  // W8.4 — scheduled-import tick. 5-min cron fans out due
  // ScheduledImport rows into real ImportJob runs via the
  // import-wizard service. No-op when no schedules are due.
  startScheduledImportCron();

  // W9.4 — scheduled-export tick. 5-min cron fans out due
  // ScheduledExport rows into real ExportJob runs + delivery.
  // Email delivery logs a Notification row (real SMTP send is
  // gated behind NEXUS_ENABLE_OUTBOUND_EMAILS, so dev never
  // accidentally fires real mail). No-op when no schedules due.
  startScheduledExportCron();

  // W7.1 — bulk-ops automation actions are registered by ./registrations.js.

  // W7.2 — bulk-ops automation cron tick. Fires the
  // `bulk_cron_tick` trigger every 15 min so scheduled hygiene
  // rules (auto-pause on failure burst, periodic re-syncs, etc.)
  // can run on a deterministic clock. No-op when no rules exist.
  startBulkAutomationTickCron();

  // W5.4 — seed built-in BulkActionTemplate rows. Idempotent —
  // keyed by (userId='__builtin', name) so re-running on every
  // boot picks up seed list changes without duplicating rows, and
  // deletes the built-ins named in RETIRED_BUILTIN_TEMPLATES.
  // Best-effort: a failure (e.g., DB up but the migration hasn't
  // landed yet on this replica) logs and continues.
  try {
    const { seedBulkActionTemplates } = await import(
      '../services/bulk-action-template-seeds.js'
    );
    const result = { created: 0, updated: 0, retired: 0 };
    await visitActiveWorkspaces(async () => {
      const count = await seedBulkActionTemplates(prisma);
      result.created += count.created; result.updated += count.updated; result.retired += count.retired;
    });
    logger.info(
      `[boot] bulk-action-template seeds: ${result.created} created, ${result.updated} updated, ${result.retired} retired`,
    );
  } catch (err) {
    logger.warn(
      `[boot] bulk-action-template seeds skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // L.16.0 — alert evaluator. Polls every minute against AlertRule
  // and fires AlertEvent + dispatches notifications when conditions
  // cross thresholds. Default-ON.
  startAlertEvaluatorCron();
  // RRL.7 — seed the default reliability alert rules (review-pipeline
  // starvation + a cron silently stopping) so the operator is actively
  // notified, not just via logs/the dashboard banner. Idempotent.
  void import('../services/alert-evaluator.service.js')
    .then(({ seedDefaultAlertRules }) => visitActiveWorkspaces(async () => { await seedDefaultAlertRules() }))
    .catch((e) => logger.warn('[startup] seedDefaultAlertRules failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) }));

  // W4.10 — Repricing evaluator cron (every 5 min). Walks every
  // enabled RepricingRule, builds market context from the latest
  // BuyBoxHistory + matching ChannelListing, calls
  // repricingEngineService.evaluate. It applies (applyToProduct) only
  // with NEXUS_REPRICER_LIVE=1, and then through the channel price door.
  startRepricingEvaluatorCron();

  // F.3 — Nightly Amazon Sales & Traffic ingest. Gated behind an env
  // flag so dev/test environments without SP-API credentials don't
  // try to run it. POST /api/fulfillment/sales-reports/ingest is the
  // manual trigger when the cron is off.
  if (process.env.NEXUS_ENABLE_SALES_REPORT_CRON === '1') {
    startSalesReportIngestCron();
  }

  // Phase 2 — Data Kiosk economics (per-SKU-day net proceeds after fees and
  // ad spend). Two crons: a daily create, and a 10-minute resumable poll,
  // because an economics query can take well over 11 minutes to complete.
  if (process.env.NEXUS_ENABLE_DATA_KIOSK_CRON === '1') {
    startDataKioskCrons();
  }

  // F.4 — Nightly forecast regeneration. Gated separately from sales-
  // report ingest so the forecast can run on OrderItem-derived data
  // even before SP-API access is configured. Manual trigger:
  // POST /api/fulfillment/forecast/run.
  if (process.env.NEXUS_ENABLE_FORECAST_CRON === '1') {
    startForecastCron();
  }

  // DO.40 — hourly dashboard digest dispatcher. Reads
  // ScheduledReport rows due at the current Europe/Rome hour and
  // emails the digest via Resend. Gated by both this cron toggle
  // AND NEXUS_ENABLE_OUTBOUND_EMAILS in the transport so dryRun
  // is the safe default in dev.
  if (process.env.NEXUS_ENABLE_DASHBOARD_DIGEST_CRON === '1') {
    startDashboardDigestCron();
    // RPT.6 — scheduled delivery of saved ads reports (own gate; dry-run unless
    // NEXUS_ENABLE_OUTBOUND_EMAILS is also set).
    startAdsReportScheduleCron();
  }

  // G.1 + G.2 — Nightly FX refresh + snapshot recompute. Gated
  // separately so dev environments don't hit the pricing layer
  // before they're ready.
  if (process.env.NEXUS_ENABLE_PRICING_CRON === '1') {
    startPricingCron();
    // G.1 — Always-on repricer. Inherits the global pricing-cron
    // gate; its own NEXUS_REPRICER_LIVE controls dry-run vs real
    // channel writes.
    startRepricerCron();
  }

  // Nightly Amazon catalog refresh. Mirrors GET /api/amazon/products
  // upsert + parent/child hierarchy logic on a 03:00 UTC schedule
  // (one hour after sales-report cron, to avoid SP-API throttle
  // collision). Gated behind NEXUS_ENABLE_CATALOG_SYNC_CRON=1.
  if (process.env.NEXUS_ENABLE_CATALOG_SYNC_CRON === '1') {
    startCatalogRefreshCron();
  }

  // ALA Phase 5 / attributes P4 — daily channel-rule refresh for Amazon, eBay and Etsy (04:00 UTC).
  // On by default since P4; NEXUS_ENABLE_SCHEMA_REFRESH_CRON=0 turns it off.
  startSchemaRefreshCron();
  startTaxonomyRefreshCron();

  // ADS AUTONOMY W4-2 — the daily Claude ads run's watchdog: hourly, per business; a business with no expected report
  // time and no started run does nothing. On by default; NEXUS_ENABLE_ADS_RUN_WATCHDOG_CRON=0 turns it off.
  startAdsRunWatchdogCron();
  // Platform health watchdog (2026-10-07) — daily 06:20 UTC: crons, feeds, ad writes, approvals, automation, queues.
  startPlatformHealthWatchdogCron();

  // Proactive eBay access-token refresh sweep. The reactive refresh
  // in EbayAuthService.getValidToken handles per-call refresh, but
  // when no sync runs for >2 hours the token expires silently.
  // Default-ON because a missing env flag silently breaking eBay is
  // exactly the failure mode this cron exists to prevent. The sweep
  // is a no-op when there are no active connections, so the
  // default-ON behaviour is safe in fresh / dev environments.
  // Set NEXUS_ENABLE_EBAY_TOKEN_REFRESH_CRON=0 to opt out.
  if (process.env.NEXUS_ENABLE_EBAY_TOKEN_REFRESH_CRON !== '0') {
    // CX.1 — one heartbeat for every channel replaces the eBay-only refresh sweep.
    startCxHeartbeatCron();
  }

  // R4.2 — eBay returns poller. Default-OFF because it makes a
  // live API call against api.ebay.com per active connection
  // and we don't want a fresh dev clone to spam someone's seller
  // account. Operators flip NEXUS_ENABLE_EBAY_RETURNS_POLL=1 on
  // production once they've confirmed eBay credentials work.
  startEbayReturnsPollCron();

  // R4.3 — Amazon returns report poller. Pulls FBM (merchant
  // returns) + FBA (Amazon-managed returns mirror) reports every
  // hour. Default-OFF for the same reason as the eBay poller:
  // requires real SP-API credentials and we don't want a fresh
  // dev clone burning the operator's report quota. Flip
  // NEXUS_ENABLE_AMAZON_RETURNS_POLL=1 to enable on production.
  startAmazonReturnsPollCron();

  // FFS.3 — reconcile in-flight flat-file feeds so status advances + the
  // per-SKU report is captured even with no tab open. Runs by default
  // (self-guards on Amazon creds + only polls due in-flight jobs); schedule
  // overridable via NEXUS_FLAT_FILE_FEED_POLL_SCHEDULE.
  startFlatFileFeedPollCron();

  // Sheet publish parity, step 2 — product sheet publications settle by themselves (Amazon feed report, eBay
  // read-back, the 30-minute receipt deadline), so a destination is never left blocked by a result nobody read.
  // Only publications sent after this step are swept. Off with NEXUS_PUBLICATION_SETTLE=0.
  startPublicationSettleCron();
  startPublicationBatchResumeCron();

  // P3.2 — mirror Amazon suppression onto each listing's issue list, and RESOLVE
  // the listings that came off suppression. Hourly; self-guards on Amazon creds.
  // Without it a suppressed listing reads as healthy on the flat-file grid, whose
  // health chip reads ListingIssue rather than AmazonSuppression.
  markCronStep('suppression-issues')
  startSuppressionIssueCron();

  // P3.4 — the four measurable channel problems become notices the owning
  // profile's OWNERS receive. Before this they went to an alert service whose
  // in-app channel is a console.log and whose email channel is off in production,
  // so P0.5's secret-expiry alerts reached nobody.
  markCronStep('channel-alerts')
  startChannelAlertsCron();

  // H.5 — eBay feed-mode push poller. Resolves SUBMITTED EbayPushJob rows
  // by checking eBay Sell Feed API every 2 min. Fires ebay_push.status_changed SSE.
  markCronStep('ebay-feed-poll')
  startEbayFeedPollCron()

  // F.3 — periodic attribute hydration: pull full Amazon attributes for sparse
  // listings (blank required fields in the flat-file editor) and store ONLY
  // platformAttributes.attributes. Bounded per tick; self-guards on creds.
  startAttrHydrateCron();
  startShopifyLinkedAutomationCron();

  // R5.3 — failed-refund retry queue. Hourly sweep that re-runs
  // the channel publisher against Returns stuck in CHANNEL_FAILED.
  // Default-OFF — operators flip NEXUS_ENABLE_REFUND_RETRY=1 once
  // the live channel adapters are confirmed (eBay OAuth alive,
  // Shopify NEXUS_ENABLE_SHOPIFY_REFUND=true). Running with stub
  // adapters would silently clear CHANNEL_FAILED via NOT_IMPLEMEN-
  // TED responses — masking real issues.
  startRefundRetryCron();

  // R6.2 — refund-deadline tracker. Scans Returns approaching
  // their channel-specific 14-day refund deadline (Italian
  // consumer law); fires Notifications for the configured ops
  // user. Default-OFF; flip NEXUS_ENABLE_REFUND_DEADLINE_TRACKER=1
  // and set NEXUS_REFUND_DEADLINE_NOTIFY_USER_ID once we have an
  // ops account.
  startRefundDeadlineTrackerCron();

  // Incremental Amazon orders polling — runs every 15 min, picks up
  // new orders + status transitions on existing ones. Cursor derived
  // from MAX(Order.purchaseDate) per the auto-detect rule in the
  // service. Manual trigger: POST /api/amazon/orders/sync.
  // Gated behind NEXUS_ENABLE_AMAZON_ORDERS_CRON=1.
  if (process.env.NEXUS_ENABLE_AMAZON_ORDERS_CRON === '1') {
    startAmazonOrdersCron();
  }

  // GS-RT.2 — Periodic re-fetch of `totalPrice=0` Amazon orders.
  // Safety net for the SP-API ListOrders withholding behavior on
  // PENDING orders: if SA.2's eager getOrder failed at intake OR
  // Amazon STILL withholds OrderTotal at ORDER_CHANGE-time re-poll,
  // this cron recovers the price the moment Amazon releases it.
  // Gated behind NEXUS_ENABLE_AMAZON_ZERO_BACKFILL_CRON=1.
  if (process.env.NEXUS_ENABLE_AMAZON_ZERO_BACKFILL_CRON === '1') {
    startAmazonZeroTotalsBackfillCron();
  }

  // DA-RT.5 — Sales drift detector. Nightly compares Order.totalPrice
  // sum vs DailySalesAggregate.grossRevenue per (day, marketplace);
  // publishes sales.drift.detected on tolerance breach so operator
  // notification machinery surfaces accumulating drift before it
  // compounds across multiple periods/markets/months.
  // Gated behind NEXUS_ENABLE_SALES_DRIFT_DETECTOR=1 (default OFF
  // during rollout — verify it's not noisy first).
  if (process.env.NEXUS_ENABLE_SALES_DRIFT_DETECTOR === '1') {
    startSalesDriftDetectorCron();
  }

  // P4 — latency/realtime watchdog. Hourly (default 30 * * * *).
  // Emits sync.latency.breach per channel whose p95 exceeds
  // NEXUS_LATENCY_P95_BREACH_MS (default 60s) and
  // sync.realtime.degraded when the dispatch path is cron-only or
  // eBay notifications are inactive. Read-only + emit-only.
  // Default-ON; disable via NEXUS_LATENCY_WATCHDOG=0.
  startLatencyWatchdogCron();

  // DA-RT.9 — OrderItem.price upstream retry. Re-fetches
  // getOrderItems for items that landed with price=0 (Amazon
  // withheld ItemPrice at ingest), repairs them, triggers a
  // batched zero-totals backfill so totalPrice + DailySalesAggregate
  // catch up via the GS-RT.7 → DA-RT.6 chain. Gated
  // NEXUS_ENABLE_AMAZON_ORDER_ITEMS_RETRY=1 (default OFF).
  if (process.env.NEXUS_ENABLE_AMAZON_ORDER_ITEMS_RETRY === '1') {
    startAmazonOrderItemsRetryCron();
  }

  // O.2 — Incremental eBay orders polling. Mirror of the Amazon
  // cron: enumerates active eBay ChannelConnections, fans out
  // ebayOrdersService.syncEbayOrders per connection. 15-min cadence.
  // Until O.2, eBay was the only revenue channel without an
  // automated cadence (Amazon=cron, Shopify=webhook), so orders
  // could silently age. Manual trigger remains:
  // POST /api/sync/ebay/orders.
  // Gated behind NEXUS_ENABLE_EBAY_ORDERS_CRON=1.
  if (process.env.NEXUS_ENABLE_EBAY_ORDERS_CRON === '1') {
    startEbayOrdersCron();
  }

  // B4 — eBay listing status-reconcile. Daily 02:00 UTC. Detects listings
  // that ended, got suspended, or were relisted on eBay's side without
  // Nexus knowing, and corrects ChannelListing.listingStatus accordingly.
  // Gated behind NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON=1 (default OFF).
  if (process.env.NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON === '1') {
    startEbayStatusReconcileCron();
  }

  // Incident #42 — the label guard was nested under the status-reconcile
  // gate above (default OFF, unset on prod) so its own default-ON gate was
  // never even evaluated: ZERO CronRun rows since ship. It self-gates
  // (NEXUS_ENABLE_EBAY_LABEL_GUARD_CRON, default ON with NEXUS_EBAY_REAL_API)
  // and must register unconditionally.
  startEbayLabelGuardCron();

  // Real-time half of the eBay image read-back: keep the "Live on eBay" strip
  // fresh without a manual Refresh. Self-gates (default ON with
  // NEXUS_EBAY_REAL_API), read-only vs eBay + idempotent — register uncond.
  startEbayImageReadbackCron();
  startImageReadbackSweepCron();

  // IS.2 — Real-time Amazon order detection via SQS (~30-90 second latency).
  // Runs every 30s when NEXUS_ENABLE_AMAZON_SQS_POLL=1 and AMAZON_SQS_QUEUE_URL is set.

  // P6.1 — automatic Amazon app-secret rotation. Off until the Owner registers the
  // credential queue with Amazon and sets AMAZON_APP_CREDENTIAL_QUEUE_URL.

  // RT.2 — Amazon SQS dead-letter-queue depth monitor (5min). Fires
  // sync.dlq.threshold on the order-events bus whenever DLQ depth
  // ≥ NEXUS_DLQ_THRESHOLD. No-op when AMAZON_SQS_DLQ_URL is unset.
  startDlqMonitorCron();

  // IS.2 — Ensure SP-API ORDER_CHANGE subscription exists on every boot.
  // Idempotent: skips if subscription already active. Fire-and-forget;
  // a failure here is logged but never crashes the server.
  ensureAmazonNotificationSubscription();

  // P2.2 — and again every night. The boot call above was the ONLY thing keeping
  // the subscriptions alive, so the gap between two deploys was a gap in which
  // nobody checked — and this failure is silent: notifications just stop arriving,
  // which looks like a quiet day. Idempotent; heals a subscription pointed at a
  // foreign destination. Opt out via NEXUS_ENABLE_AMAZON_NOTIFICATION_RECONCILE=0.
  startAmazonNotificationReconcileCron();

  // P2.3 — the same for eBay, which had NO destination and NO subscription at all,
  // so no genuine eBay notification had ever arrived. OFF by default: it schedules
  // nothing unless NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP is exactly 1 AND
  // NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS names each topic the Owner armed (v1:
  // AUTHORIZATION_REVOCATION). Any other value, including the old switch alone,
  // means no reconcile and no eBay call. It also needs EBAY_NOTIFICATION_ENDPOINT_URL
  // and a valid EBAY_NOTIFICATION_VERIFICATION_TOKEN.
  startEbayNotificationReconcileCron();

  // P2.7 — check the Amazon Marketing Stream subscriptions per profile and dataset.
  // Nothing checked them, and the failure is silent: a subscription that was never
  // created, or that Amazon dropped, produces no error — just an hour of
  // advertising data that never arrives. Reports only; it creates nothing.
  // Opt out via NEXUS_ENABLE_AMS_SUBSCRIPTION_CHECK=0.
  startAmsSubscriptionCheckCron();

  // Amazon financial events — daily 02:00 UTC, pulls yesterday's
  // /finances/v0/financialEvents and writes FinancialTransaction rows.
  // Idempotent. Gated behind NEXUS_ENABLE_AMAZON_FINANCIAL_CRON=1.
  if (process.env.NEXUS_ENABLE_AMAZON_FINANCIAL_CRON === '1') {
    startAmazonFinancialSyncCron();
  }

  // eBay financial events — daily 03:30 UTC, pulls yesterday's
  // Sell Finances transactions → FinancialTransaction rows.
  // Gated behind NEXUS_ENABLE_EBAY_FINANCIAL_CRON=1.
  if (process.env.NEXUS_ENABLE_EBAY_FINANCIAL_CRON === '1') {
    startEbayFinancialSyncCron();
  }

  // FBA inventory polling — every 15 min, full SP-API
  // getInventorySummaries sweep, writes fulfillableQuantity into
  // Product.totalStock. SKUs absent from the response are NOT zeroed
  // (MFN inventory ledger preservation — see service comment).
  // Manual trigger: POST /api/amazon/inventory/sync.
  // Gated behind NEXUS_ENABLE_AMAZON_INVENTORY_CRON=1.
  if (process.env.NEXUS_ENABLE_AMAZON_INVENTORY_CRON === '1') {
    startAmazonInventoryCron();
  }

  // Daily Amazon settlement reports sync (03:30 UTC) — lists +
  // downloads any new published settlements. Idempotent.
  // Gated behind NEXUS_ENABLE_AMAZON_SETTLEMENT_CRON=1.
  if (process.env.NEXUS_ENABLE_AMAZON_SETTLEMENT_CRON === '1') {
    const { startAmazonSettlementCron } = await import('../jobs/amazon-settlement-sync.job.js');
    startAmazonSettlementCron();
  }

  // Daily Amazon A+ Content metadata sync (04:00 UTC) — pulls all
  // /aplus/2020-11-01/contentDocuments and upserts metadata.
  // Gated behind NEXUS_ENABLE_AMAZON_APLUS_CRON=1.
  if (process.env.NEXUS_ENABLE_AMAZON_APLUS_CRON === '1') {
    const { startAmazonAplusCron } = await import('../jobs/amazon-aplus-sync.job.js');
    startAmazonAplusCron();
  }

  // Reservation TTL sweep — every 5 min, releases expired
  // PENDING_ORDER reservations so available = quantity - reserved
  // doesn't stay locked after a cancelled order. Default-ON; opt out
  // via NEXUS_ENABLE_RESERVATION_SWEEP_CRON=0.
  if (process.env.NEXUS_ENABLE_RESERVATION_SWEEP_CRON !== '0') {
    startReservationSweepCron();
  }
  startReservationReconcileCron();
  // RT.0 — OutboundSyncQueue janitor: reclaims crashed IN_PROGRESS rows,
  // expires stale PENDING, dead-letters invisible terminal failures.
  // Default-ON; opt out via NEXUS_QUEUE_JANITOR=0.
  startOutboundQueueJanitorCron();
  // RT.4 — daily Trading GetItem lifecycle reconcile: ends memberships of
  // listings that ended on eBay without a push ever hitting them.
  // Default-ON; opt out via NEXUS_EBAY_ITEM_RECONCILE=0.
  startEbayItemStatusReconcileCron();
  // P0c — Amazon quantity READ-BACK reconcile (closed loop: Amazon's actual
  // vs intended; the check that would have caught the 403 era in hours).
  // Default-ON; opt out via NEXUS_QTY_READBACK=0.
  startAmazonQtyReadbackCron();
  // Published Amazon listings read their ASIN once Amazon makes them visible (Publish reads it once, at promotion).
  // Default-ON; opt out via NEXUS_AMAZON_ASIN_FILL=0.
  startAmazonAsinFillCron();
  // MCP full control I6 — what each channel account holds (identity audit #3, #4, #12).
  // Default-OFF; NEXUS_IDENTITY_SWEEP=1 turns it on.
  startIdentityChannelSweepCron();
  // P5.2 — eBay inventory read-back → ChannelStockEvent (NEXUS_EBAY_READBACK=0 to disable)
  startEbayReadbackCron();
  // P4.3f — Shopify quantity read-back, the third channel's closed loop
  // (NEXUS_SHOPIFY_QTY_READBACK=0 to disable). Scheduled, not registry-only.
  startShopifyQtyReadbackCron();
  startAdsRegionReconcileCron();
  startEtsyContentRefreshCron();
  // CX Etsy E5 — receipt polling. OFF by default: scheduled only with
  // NEXUS_ENABLE_ETSY_RECEIPTS_POLL_CRON=1, and a run writes nothing unless
  // NEXUS_ENABLE_ETSY_ORDER_INGEST=1 as well.
  if (process.env.NEXUS_ENABLE_ETSY_RECEIPTS_POLL_CRON === '1') startEtsyReceiptsPollCron();
  // E2 eBay Ads read-side sync (prod default-ON; NEXUS_ENABLE_EBAY_ADS_SYNC gates)
  startEbayAdsSyncCrons();
  // P5.3 — daily reconcile cron: Amazon drift + cumulative bleed + stale-conflict escalation
  startReconcileCron();

  // H.5 — late-shipment auto-flag cron. Every 6h, scans non-terminal
  // inbound shipments past their expectedAt + 2 days and creates a
  // LATE_ARRIVAL InboundDiscrepancy if one doesn't exist. Idempotent.
  // Default-ON; opt out via NEXUS_ENABLE_LATE_SHIPMENT_FLAG_CRON=0.
  if (process.env.NEXUS_ENABLE_LATE_SHIPMENT_FLAG_CRON !== '0') {
    startLateShipmentFlagCron();
  }

  // O.12 — tracking pushback retry cron. Every 2 minutes, walks
  // TrackingMessageLog rows where status='PENDING' AND nextAttemptAt
  // <= NOW(), routes each to the channel pushback module (Amazon
  // FBM / eBay / Shopify / Woo), and finalizes to SUCCESS / FAILED
  // (with backoff) / DEAD_LETTER. Default-ON because silent
  // pushback failures cost marketplace SLA penalties; opt out via
  // NEXUS_ENABLE_TRACKING_PUSHBACK_CRON=0. Per-channel
  // ENABLE_*_SHIP_CONFIRM flags still gate whether the underlying
  // call hits the real API or returns dryRun mocks.
  startTrackingPushbackCron();

  // P2.1 — the inbound ledger's retry worker. Takes the inbound events whose
  // backoff has expired, re-runs each through the handler that first received it,
  // and moves the ones that are out of attempts — or that nothing can replay —
  // into dead letters where an operator can find them. Default-ON: before this,
  // a failed inbound event stayed `failed` forever and no retry existed at all.
  // Opt out via NEXUS_ENABLE_INBOUND_RETRY_CRON=0.

  // CR.12 — daily Sendcloud service-catalog sync. Pulls
  // /shipping_methods per connected Sendcloud account and upserts
  // CarrierService rows so the CR.7 Services-tab picker stays
  // current without firing /shipping_methods on every drawer-open.
  // Default-ON; opt out via NEXUS_ENABLE_CARRIER_SERVICE_SYNC_CRON=0.
  startCarrierServiceSyncCron();

  // CR.21 — daily recurring-pickup dispatcher. Walks PickupSchedule
  // rows where isRecurring=true + today matches the daysOfWeek
  // bitmap, fires sendcloud.requestPickup. Idempotent: skips rows
  // already dispatched today. Runs at 04:00 (after the catalog sync
  // at 02:00). Default-ON; NEXUS_ENABLE_PICKUP_DISPATCH_CRON=0 opts out.
  startPickupDispatchCron();

  // CR.23 — daily CarrierMetric pre-warm. Aggregates Shipment
  // counts + cost + on-time/late + median delivery into the
  // CarrierMetric cache table for 30 / 90 / 365 day windows. The
  // Performance tab reads from cache when present, falls back to
  // live aggregation otherwise. Runs at 03:00 (between catalog
  // sync at 02:00 and pickup dispatch at 04:00). Default-ON;
  // NEXUS_ENABLE_CARRIER_METRICS_CRON=0 opts out.
  startCarrierMetricsCron();

  // O.19 — outbound late-shipment risk monitor. Hourly sweep that
  // logs counts of overdue / due-today / became-overdue-in-last-24h
  // pending orders. Real-time alerting is on the surface (O.4
  // OVERDUE urgency chip); this cron is for SLA reporting + future
  // pager hooks. Default-ON; opt out via
  // NEXUS_ENABLE_OUTBOUND_LATE_RISK_CRON=0.
  startOutboundLateRiskCron();

  // H.8 — saved-view alerts cron. Every 5 minutes, evaluate every
  // active SavedViewAlert against its filter and fire an in-app
  // Notification when the threshold + cooldown say so. Default-ON;
  // opt out via NEXUS_ENABLE_SAVED_VIEW_ALERTS_CRON=0.
  if (process.env.NEXUS_ENABLE_SAVED_VIEW_ALERTS_CRON !== '0') {
    startSavedViewAlertsCron();
  }

  // P.2 — sync drift detection cron. Every 30 minutes, scans
  // ChannelListing rows that follow master and logs a SyncHealthLog
  // CONFLICT_DETECTED row for each that's drifted away from the
  // master's price/quantity. Read-only — only writes to
  // SyncHealthLog. Default-ON; opt out via
  // NEXUS_ENABLE_SYNC_DRIFT_DETECTION_CRON=0.
  if (process.env.NEXUS_ENABLE_SYNC_DRIFT_DETECTION_CRON !== '0') {
    startSyncDriftDetectionCron();
  }

  // 2026-10-06 — stock push heal. Every 10 minutes, per business, a listing whose
  // latest quantity push failed for good (dead, never retried, or pending for
  // hours) gets ONE fresh push through the cascade's path, within a per-listing
  // budget (a channel refusal once a day). NEXUS_STOCK_PUSH_HEAL: 1 on,
  // count = count-only (lists, sends nothing), 0 off; unset = the default in
  // jobs/stock-push-heal-mode.ts (on). Checked inside.
  startStockPushHealCron();

  // H.8d — FBA shipment status polling cron. Every 15 minutes,
  // batches non-terminal local FBAShipment IDs into SP-API
  // getShipments calls and mirrors Amazon's authoritative status.
  // No-op if SP-API isn't configured. Default-ON; opt out via
  // NEXUS_ENABLE_FBA_STATUS_POLL_CRON=0.
  if (process.env.NEXUS_ENABLE_FBA_STATUS_POLL_CRON !== '0') {
    startFbaStatusPollCron();
  }

  // Step 4 Send to FBA — every minute, queue the plans whose next look is due (an Amazon operation still running, a
  // hold, a run that stopped mid-way, tracking to send). Off with NEXUS_FBA_INBOUND_RESUME=0 (checked inside).
  startFbaInboundResumeCron();

  // R.1 — forecast accuracy (MAPE) cron. Daily at 04:00 UTC, after
  // sales-ingest (02:00) + forecast (03:30). For each (sku, channel,
  // marketplace) tuple with sales aggregated for yesterday, find
  // the most recent forecast generated BEFORE yesterday started and
  // UPSERT a ForecastAccuracy row. Default-ON; opt out via
  // NEXUS_ENABLE_FORECAST_ACCURACY_CRON=0.
  if (process.env.NEXUS_ENABLE_FORECAST_ACCURACY_CRON !== '0') {
    startForecastAccuracyCron();
  }

  // R.6 — auto-PO trigger cron. Daily 05:00 UTC after the forecast
  // pipeline. Creates DRAFT POs for CRITICAL/HIGH recommendations on
  // opt-in suppliers (Supplier.autoTriggerEnabled AND
  // ReplenishmentRule.autoTriggerEnabled both required). Per-PO
  // qty/cost ceilings cap blast radius. Default-ON; opt out via
  // NEXUS_ENABLE_AUTO_PO_CRON=0.
  if (process.env.NEXUS_ENABLE_AUTO_PO_CRON !== '0') {
    startAutoPoCron();
  }

  // R.11 — lead-time variance recompute. Daily 06:00 UTC. For each
  // active supplier with ≥3 PO receives in the last 365 days, writes
  // observed σ_LT to Supplier.leadTimeStdDevDays so the safety-stock
  // formula picks it up. Default-ON; opt out via
  // NEXUS_ENABLE_LEAD_TIME_STATS_CRON=0.
  if (process.env.NEXUS_ENABLE_LEAD_TIME_STATS_CRON !== '0') {
    startLeadTimeStatsCron();
  }

  // R.12 — stockout ledger sweep. Daily 06:30 UTC. Walks
  // StockLevel + open StockoutEvents to catch missed transitions
  // and refresh running loss estimates. Default-on; opt out via
  // NEXUS_ENABLE_STOCKOUT_DETECTOR_CRON=0.
  if (process.env.NEXUS_ENABLE_STOCKOUT_DETECTOR_CRON !== '0') {
    startStockoutDetectorCron();
  }

  // AE.3 — finish first copies of shared products whose review was applied while nobody
  // watched. Every minute, per business, idempotent. Opt out via NEXUS_ENABLE_ASSORTMENT_COPY_CRON=0.
  if (process.env.NEXUS_ENABLE_ASSORTMENT_COPY_CRON !== '0') {
    startAssortmentCopyCron();
  }

  // Shared stock (plan 2026-09-19) — the pool worker: updates listings in every business when a
  // pool changes where no code of ours kicked it (a lender's own sale, an import), and finishes the
  // lender's bookkeeping for pool sales. Woken at once by the database's notify (nexus_stock_pool) after
  // every write that queues pool work; polls every 2 s while busy, 10 s when quiet as the backstop. It
  // runs in the worker process (runtime/worker.ts). Idle-safe: one indexed query per poll. Opt out via
  // NEXUS_ENABLE_STOCK_POOL_WORKER=0.


  // Shared stock plan step 3 — end "Fixed number until …" / "Paused until …" (and the same on shared
  // eBay variants) on time. Every minute, per business; one indexed probe when nothing is due.
  // Opt out via NEXUS_ENABLE_LISTING_END_TIMES_CRON=0.
  if (process.env.NEXUS_ENABLE_LISTING_END_TIMES_CRON !== '0') {
    startListingEndTimesCron();
  }

  // Shared stock plan step 6 (AE.4) — live product sync: edits to a shared product reach the businesses
  // that follow it. LISTENs for the capture trigger's notify, with a poll behind it (2 s after work,
  // backing off to 60 s); nightly repair per business. Idle-safe: nothing is written until a product is
  // linked. Opt out via NEXUS_ENABLE_ASSORTMENT_SYNC=0.
  if (process.env.NEXUS_ENABLE_ASSORTMENT_SYNC !== '0') {
    startAssortmentRepair();
  }

  // R.8 — FBA Restock Inventory Recommendations ingestion. Daily
  // 04:00 UTC. Pulls Amazon's per-SKU rec for IT/DE/FR/ES/NL into
  // FbaRestockRow so the engine can cross-check against ours.
  // Default-on; opt out via NEXUS_ENABLE_FBA_RESTOCK_CRON=0.
  if (process.env.NEXUS_ENABLE_FBA_RESTOCK_CRON !== '0') {
    startFbaRestockCron();
  }

  // S.16 — weekly ABC classification recompute. Mondays 04:00 UTC.
  // Materializes Product.abcClass so the analytics page + the
  // /products list reads are O(1). Default-on; opt out via
  // NEXUS_ENABLE_ABC_CRON=0.
  if (process.env.NEXUS_ENABLE_ABC_CRON !== '0') {
    startAbcClassificationCron();
  }

  // P1.8 — the nightly channel contract run: one read and one dry-run write per operation against
  // each channel's SANDBOX, so a channel change turns red here before it reaches a live listing.
  // OFF until the Owner sets NEXUS_ENABLE_CHANNEL_CONTRACT_RUN=true and names a sandbox account per
  // channel; the starter itself checks that and schedules nothing otherwise.
  startChannelContractCron();

  // ACP.4a — Listing-Quality Keeper. Daily 06:45 UTC. Autonomous agent
  // that scans active products for content gaps and QUEUES reversible
  // apply-content proposals into the approval inbox (never auto-applies;
  // capped + deduped). Default-on; opt out via
  // NEXUS_ENABLE_LISTING_QUALITY_KEEPER=0.
  if (process.env.NEXUS_ENABLE_LISTING_QUALITY_KEEPER !== '0') {
    startListingQualityKeeperCron();
  }

  // ACP.4b — Pricing Watchdog. Daily 07:00 UTC. Autonomous agent that
  // scans products priced below floor/cost and QUEUES set-price
  // proposals (always-ask) that RAISE them to a sane margin — never
  // auto-applies, never proposes a cut. Default-on; opt out via
  // NEXUS_ENABLE_PRICING_WATCHDOG=0.
  if (process.env.NEXUS_ENABLE_PRICING_WATCHDOG !== '0') {
    startPricingWatchdogCron();
  }

  // W4.6 — automation rule evaluator. Every 15 minutes, walks
  // enabled rules grouped by trigger and fires the evaluator
  // against the appropriate context payloads. All seeded templates
  // default to dryRun=true so a fresh install only writes audit
  // rows. Default-OFF — opt in via NEXUS_ENABLE_AUTOMATION_RULE_CRON=1
  // because actions can fire side effects (auto-approve, create-PO)
  // once a rule is taken out of dry-run.
  if (process.env.NEXUS_ENABLE_AUTOMATION_RULE_CRON === '1') {
    startAutomationRuleEvaluatorCron();
  }

  // AD.1 + AD.2 — Trading Desk crons:
  //   ads-sync               every 30 min — pulls campaign structure
  //   fba-storage-age-ingest every 6 hours — Amazon Aged Inventory
  //   true-profit-rollup     nightly 03:00 UTC — yesterday's P&L
  //   ads-metrics-ingest     hourly — Amazon Ads Reports API
  // Plus the BullMQ ads-sync worker (consumes AD_* mutations).
  // Default-OFF — opt in via NEXUS_ENABLE_AMAZON_ADS_CRON (1/true/yes/on).
  // Tolerant parse: a strict === '1' previously froze this whole block when
  // the flag was set to "true"/with whitespace. Log the resolved decision so
  // it's visible in Railway logs at boot.
  const adsCronOn = envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON')
  logger.info('[startup] ads-cron block', {
    enabled: adsCronOn,
    rawValue: JSON.stringify(process.env.NEXUS_ENABLE_AMAZON_ADS_CRON ?? null),
  })
  // NAF.B — nightly analyst sweep. Self-gated on NEXUS_ENABLE_FLEET_SWEEP_CRON,
  // deliberately independent of the ads write-engine flag (the fleet is
  // read-only and must be startable/stoppable on its own).
  markCronStep('fleet:import fleet-sweep.job');
  const { startFleetSweepCron, startFleetCouncilCron } = await import('../jobs/fleet-sweep.job.js');
  startFleetSweepCron();
  startFleetCouncilCron();

  if (adsCronOn) {
    // Apex diagnostic + resilience: each step marks progress (visible via the
    // cron-status probe) so a hanging `await import` is locatable, and the
    // Redis-dependent worker init is deferred to the very end + made
    // non-blocking so it can never freeze cron registration (Redis may be
    // unreachable on prod). markCronStep BEFORE each await = the last marker
    // shown is the line that hung.
    markCronStep('ads:start');
    markCronStep('ads:import ads-sync.job');
    const { startAllAdvertisingCrons } = await import('../jobs/ads-sync.job.js');
    markCronStep('ads:import advertising-rule-evaluator.job');
    const { startAdvertisingRuleEvaluatorCron } = await import('../jobs/advertising-rule-evaluator.job.js');
    markCronStep('ads:import budget-pool-rebalance.job');
    const { startBudgetPoolRebalanceCron } = await import('../jobs/budget-pool-rebalance.job.js');
    markCronStep('ads:import automation-action-handlers');
    await import('../services/advertising/automation-action-handlers.js');
    markCronStep('ads:import ads-bid-optimizer');
    await import('../services/advertising/ads-bid-optimizer.service.js');
    markCronStep('ads:import ad-dayparting.job');
    const { startDaypartingCron } = await import('../jobs/ad-dayparting.job.js');
    const { startBudgetScheduleCron } = await import('../jobs/ad-budget-schedule.job.js');
    const { startBudgetEnforceCron } = await import('../jobs/ad-budget-enforce.job.js');
    const { startAutopilotCron } = await import('../jobs/ad-autopilot.job.js');
    // BID BRAIN BB-3 — the shadow bid brain: decides and logs IT/DE bids, writes nothing (NEXUS_BID_BRAIN_MODE=off stops it).
    const { startBidBrainCron } = await import('../jobs/ads-bid-brain.job.js');
    // ONE BRAIN AB-4 — the daily read of Amazon's own rules on brain campaigns (only while the brain is live or a product is enrolled).
    const { startNativeRulesCron } = await import('../jobs/ads-native-rules.job.js');
    // ONE BRAIN AB-9 — the term ledger and the market arbiter in shadow (only for products whose negatives or harvest lever is OBSERVE+).
    const { startBrainTermsCron } = await import('../jobs/ads-brain-terms.job.js');
    // RS.5 — rank-defend loop (self-gated on NEXUS_ENABLE_RANK_DEFEND=1).
    const { startAdsRetentionCron } = await import('../jobs/ads-retention.job.js');
    const { startRankDefendCron } = await import('../jobs/ad-rank-defend.job.js');
    markCronStep('ads:import ads-budget-pacing');
    await import('../services/advertising/ads-budget-pacing.service.js');
    // Apex D.2 — registers the defend_top_of_search handler.
    markCronStep('ads:import ads-top-of-search');
    await import('../services/advertising/ads-top-of-search.service.js');
    // RC2.T6 — registers the refresh_dayparting handler.
    markCronStep('ads:import ads-dayparting-refresh');
    await import('../services/advertising/ads-dayparting-refresh.service.js');
    markCronStep('ads:import marketing-action-handlers');
    await import('../services/marketing/marketing-action-handlers.js');
    markCronStep('ads:import marketing-rule-evaluator.job');
    const { startMarketingRuleEvaluatorCron } = await import('../jobs/marketing-rule-evaluator.job.js');
    markCronStep('ads:import marketing-sync-drain.job');
    const { startMarketingSyncDrainCron } = await import('../jobs/marketing-sync-drain.job.js');
    markCronStep('ads:import ads-sync-drain.job');
    const { startAdsSyncDrainCron } = await import('../jobs/ads-sync-drain.job.js');
    // AX-IE.1 — refresh the Amazon cross-channel shadow nightly. Without it the
    // shadow froze at its migration date and /marketing/campaigns disagreed with
    // the ads cockpit (338 pre-dedup rows vs the canonical 196).
    markCronStep('ads:import marketing-amazon-shadow-backfill.job');
    const { startMarketingAmazonShadowBackfillCron } = await import('../jobs/marketing-amazon-shadow-backfill.job.js');
    // Apex D.2 — Top-of-Search defense (self-gated: only schedules when
    // NEXUS_ENABLE_TOS_DEFENSE_CRON is on, since it writes live placement bids).
    const { startTosDefenseCron } = await import('../jobs/ads-tos-defense.job.js');
    // Apex B.1 — AMS SQS consumer (self-gated on NEXUS_AMS_SQS_QUEUE_URL + AWS creds).
    // Apex E.1 — SQP competitive-intel ingest. Default ON; opt out with
    // NEXUS_DISABLE_SQP_INGEST_CRON=1. (This comment used to name
    // NEXUS_ENABLE_SQP_INGEST_CRON, which has no readers at all — see SQP.1.)
    const { startSqpIngestCron } = await import('../jobs/sqp-ingest.job.js');
    // SQP.2 — the collect half of the async split. sqp-ingest now only REQUESTS.
    const { startSqpCollectCron } = await import('../jobs/sqp-collect.job.js');
    // KT.7 — the Keyword Tracker's daily digest. Opt-in: NEXUS_ENABLE_KT_DIGEST_CRON=1.
    const { startKtDigestCron } = await import('../jobs/kt-digest.job.js');
    // AX-VT.5 — 6-hourly structural reconcile: compare the whole account against Amazon and
    // record where it disagrees. Reads + portfolio repair only; never touches bids.
    const { startStructuralReconcileCron } = await import('../jobs/ads-structural-reconcile.job.js');
    // Register all schedules (these are synchronous node-cron registrations).
    markCronStep('ads:register schedules');
    startDaypartingCron();
    startBudgetScheduleCron();
    startAutopilotCron();
    startBidBrainCron();
    startNativeRulesCron();
    startBrainTermsCron();
    startRankDefendCron();
    // HX.11 — prunes the ads history tables. OFF unless NEXUS_ENABLE_ADS_RETENTION=1, because it deletes.
    startAdsRetentionCron();
    startAllAdvertisingCrons();
    startAdvertisingRuleEvaluatorCron();
    startBudgetPoolRebalanceCron();
    startBudgetEnforceCron();
    startMarketingRuleEvaluatorCron();
    startMarketingSyncDrainCron();
    startAdsSyncDrainCron();
    startMarketingAmazonShadowBackfillCron();
    startTosDefenseCron();
    startSqpIngestCron();
    startSqpCollectCron();
    startKtDigestCron();
    startStructuralReconcileCron();
    const { startTosIsIngestCron } = await import('../jobs/ads-tos-is-ingest.job.js');
    startTosIsIngestCron();
    // ADM-P6 — the budget-usage sampler. Default ON (NEXUS_DISABLE_BUDGET_USAGE_CRON
    // stops it): Out-of-Budget and Actively Bidding hours can only count hours that
    // were actually watched, and neither Amazon feed can be backfilled.
    const { startBudgetUsageCron } = await import('../jobs/ads-budget-usage.job.js');
    startBudgetUsageCron();
    // ADS AUTONOMY — auto-undo (A19): daily after the reports land, before the daily Claude ads run. Born OBSERVE: it
    // records what it would undo until a person turns it up (NEXUS_ENABLE_ADS_AUTO_UNDO_CRON=0 stops the cron).
    markCronStep('ads:import ads-auto-undo.job');
    const { startAdsAutoUndoCron } = await import('../jobs/ads-auto-undo.job.js');
    startAdsAutoUndoCron();
    markCronStep('ads:schedules registered');

    markCronStep('ads:block complete');
  }

  // SR.1 — Sentient Review Loop. Default-OFF — opt in via
  // NEXUS_ENABLE_REVIEW_INGEST=1. Sandbox mode (default) uses
  // fixture reviews; live mode pulls from configured channel sources.
  if (process.env.NEXUS_ENABLE_REVIEW_INGEST === '1') {
    const { startAllReviewCrons } = await import('../jobs/review-pipeline.job.js');
    startAllReviewCrons();
    // SR.3 — review-domain AutomationRule evaluator (same gate).
    const { startReviewRuleEvaluatorCron } = await import('../jobs/review-rule-evaluator.job.js');
    startReviewRuleEvaluatorCron();
    // SR.4 — post-purchase review request mailer (same gate).
    const { startReviewMailerCron } = await import('../jobs/review-request-mailer.job.js');
    startReviewMailerCron();
    // RV.7 — orders-delivered backfill (real Amazon report → deliveredAt; same gate).
    const { startOrdersDeliveredBackfillCron } = await import('../jobs/orders-delivered-backfill.job.js');
    startOrdersDeliveredBackfillCron();
    // RV.9.7 — review → request/rule attribution (same gate).
    const { startReviewAttributionCron } = await import('../jobs/review-attribution.job.js');
    startReviewAttributionCron();
  }

  // D.4 — Amazon official Customer Feedback API insights. Independently gated
  // (needs the SP-API Brand Analytics role, not the general review ingest) —
  // opt in via NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS=1. Stays dark until the role
  // is confirmed via POST /api/reviews/insights/probe. Weekly schedule.
  if (process.env.NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS === '1') {
    const { startAmazonReviewInsightsCron } = await import('../jobs/review-pipeline.job.js');
    startAmazonReviewInsightsCron();
  }

  // RV.9.2 — Stale CronRun sweeper. Always-on (not gated). Marks
  // status='RUNNING' rows stuck for >2h as FAILED so the dashboard
  // doesn't show false-positive "still running" states after a crash.
  {
    const { startCronOrphanSweeperCron } = await import('../jobs/cron-orphan-sweeper.job.js');
    startCronOrphanSweeperCron();
  }

  // NAF.AP.4/AP.5 — approval queue maintenance. Always-on, deliberately:
  // the fleet flags keep AGENTS dark, but this is what makes an operator's
  // own approve actually run once its undo window closes, and what stops a
  // stale request from staying actionable. Turning the fleet off must not
  // strand a decision a human already took.
  {
    const { startApprovalMaintenanceCron } = await import('../jobs/approval-maintenance.job.js');
    startApprovalMaintenanceCron();
  }

  // MB.1 — Brand Brain embedding ingester. Gated by NEXUS_ENABLE_BRAND_BRAIN=1.
  if (process.env.NEXUS_ENABLE_BRAND_BRAIN === '1') {
    const { startEmbeddingIngesterCron } = await import('../jobs/embedding-ingester.job.js');
    startEmbeddingIngesterCron();
    // CE.2 — Browse node predictor (shares BRAND_BRAIN gate).
    const { startBrowseNodePredictorCron } = await import('../jobs/browse-node-predictor.job.js');
    startBrowseNodePredictorCron();
  }

  // CE.5 — Cross-RMN Feed Export cron (always on; generates GMC + Meta feeds daily).
  {
    const { startFeedExportCron } = await import('../jobs/feed-export.job.js');
    startFeedExportCron();
  }

  // PA.2 — Listing Quality Snapshot (weekly; always on).
  {
    const { startListingQualitySnapshotCron } = await import('../jobs/listing-quality-snapshot.job.js');
    startListingQualitySnapshotCron();
  }

  // CI.1 — RFM Scoring (nightly; always on).
  {
    const { startRFMScoringCron } = await import('../jobs/rfm-scoring.job.js');
    startRFMScoringCron();
  }

  // CI.2 — Segment Recount (weekly; always on).
  {
    const { startSegmentRecountCron } = await import('../jobs/segment-recount.job.js');
    startSegmentRecountCron();
  }

  // AI-2.2 (list-wizard) — seed the four Step 5 attribute prompts
  // on boot. Idempotent: skips rows that already exist for
  // (feature, name='default', version=1) so an operator-edited
  // body isn't clobbered. Failures here mustn't kill startup —
  // the inline-prompt path in listing-content.service.ts still
  // works without the DB rows.
  visitActiveWorkspaces(async () => { await seedPromptTemplateDefaults(prisma) }).catch((err: unknown) => {
    console.warn(
      '[api] prompt-template seed failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  });

  // SP.3 (list-wizard) — scheduled wizard publish cron. No-op
  // unless NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH=1. Tick interval
  // 60s; cap 25 PENDING rows per tick so a backlog can't pin the
  // worker.
  startScheduledWizardPublishCron();

  // PB.10 — scheduled image publish cron. Default-OFF unless
  // NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1. Tick 60s; cap 25 rows.
  startScheduledImagePublishCron();

  // Safety net: reconcile feeds that finished on Amazon but left rows stuck on
  // DRAFT (empty-report finalize / missed poll). On by default; status-only,
  // never calls Amazon. Tick 3min + a boot sweep ~30s after start.
  startImagePublishReconcileCron();


  // PO-Plus.6 — recurring PO cron. Default-OFF unless
  // NEXUS_ENABLE_SCHEDULED_PO=1. Tick 5min; cap 25 schedules per
  // tick.
  startScheduledPoCron();

  // S.17 — daily ABC-driven cycle-count scheduler. 02:30 UTC.
  // Picks up products whose cadence has elapsed (A=7d, B=30d,
  // C=90d, D=180d) and creates a DRAFT CycleCount session at
  // IT-MAIN with those items. Default-on; opt out via
  // NEXUS_ENABLE_CYCLE_COUNT_SCHEDULER=0.
  if (process.env.NEXUS_ENABLE_CYCLE_COUNT_SCHEDULER !== '0') {
    startCycleCountSchedulerCron();
  }

  // T.8 part 2 — Year-end inventory snapshot. Jan 1 00:00 UTC,
  // snapshots the prior year close ("rimanenze finali") for
  // Italian fiscal filing. Idempotent so re-runs are safe.
  // Default-on; opt out via NEXUS_ENABLE_YEAR_END_SNAPSHOT_CRON=0.
  if (process.env.NEXUS_ENABLE_YEAR_END_SNAPSHOT_CRON !== '0') {
    startYearEndSnapshotCron();
  }

  // L.8 — Lot expiry alert. Daily 06:30 UTC, scans for lots with
  // expiresAt within NEXUS_LOT_EXPIRY_HORIZON_DAYS (default 30) so
  // the operator's morning observability log surfaces what needs
  // selling-down or disposal. Default-on; opt out via
  // NEXUS_ENABLE_LOT_EXPIRY_ALERT_CRON=0.
  if (process.env.NEXUS_ENABLE_LOT_EXPIRY_ALERT_CRON !== '0') {
    startLotExpiryAlertCron();
  }

  // C5.3 — CE/compliance certificate expiry sweep (daily 06:40). Flags certs
  // expiring within 90d or already expired so the operator renews before a
  // listing is blocked. Default-on; opt out via NEXUS_ENABLE_CERT_EXPIRY_ALERT_CRON=0.
  if (process.env.NEXUS_ENABLE_CERT_EXPIRY_ALERT_CRON !== '0') {
    startCertExpiryAlertCron();
  }

  // PD.0 — publish-mode banner at boot. 10k+ gated Amazon attempts went
  // unnoticed for 30 days because the mode was never surfaced. A 'gated' or
  // 'dry-run' line here means NOTHING reaches the channel — set
  // NEXUS_ENABLE_AMAZON_PUBLISH=true + AMAZON_PUBLISH_MODE=live to go live.
  logger.info(
    `📣 PUBLISH MODES at boot — Amazon=${getAmazonPublishMode()} eBay=${getEbayPublishMode()} Shopify=${getShopifyPublishMode()}`,
  );

  // F.3 — scheduled product changes worker. Every minute, picks up
  // ScheduledProductChange rows whose scheduledFor <= now() and
  // applies the same master*Service path as a live PATCH so
  // cascades behave identically. Default-on; opt out via
  // NEXUS_ENABLE_SCHEDULED_CHANGES=0.
  if (process.env.NEXUS_ENABLE_SCHEDULED_CHANGES !== '0') {
    startScheduledChangesCron();
  }

  // F.1 follow-up — hard-purge soft-deleted Product rows older than
  // NEXUS_SOFT_DELETE_PURGE_DAYS (default 30). Daily 03:15 UTC.
  // Cascades through the same 5 dependent tables that
  // cascadeDeleteProducts handles. Default-on; opt out via
  // NEXUS_ENABLE_SOFT_DELETE_PURGE=0.
  if (process.env.NEXUS_ENABLE_SOFT_DELETE_PURGE !== '0') {
    startPurgeSoftDeletedCron();
  }

  // Phase H follow-up — retention sweep. Reads
  // DataRetentionPolicy.policies and deletes rows past their
  // configured windows (audit log, login events, webhook events,
  // stock logs, old export requests). Orders deliberately
  // excluded — 7-year fiscal floor + cascade impact makes
  // auto-sweep risky. Default-on; opt out via
  // NEXUS_ENABLE_RETENTION_SWEEP=0.
  if (process.env.NEXUS_ENABLE_RETENTION_SWEEP !== '0') {
    startRetentionSweepCron();
  }

  // S.24 — Amazon MCF status sync. Every 15 min, walk active
  // MCFShipment rows and pull current status from SP-API. Webhook
  // path catches most transitions faster; this is the poll
  // safety net. Default-on; opt out via NEXUS_ENABLE_MCF_STATUS_CRON=0.
  if (process.env.NEXUS_ENABLE_MCF_STATUS_CRON !== '0') {
    startAmazonMCFStatusCron();
  }

  // S.25 — Pan-EU FBA distribution sync. Daily 03:00 UTC. Pulls
  // per-FC inventory detail from SP-API and upserts into
  // FbaInventoryDetail. Read-only snapshot for distribution
  // visibility / aged inventory / unfulfillable triage.
  // Default-on; opt out via NEXUS_ENABLE_FBA_PAN_EU_CRON=0.
  if (process.env.NEXUS_ENABLE_FBA_PAN_EU_CRON !== '0') {
    startFbaPanEuSyncCron();
  }

}
