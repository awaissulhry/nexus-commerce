import "./db.js"; // ensure dotenv loads before anything else
import { initOtel } from "./utils/otel-setup.js";
// L.26.0 — start OTel SDK as early as possible so HTTP/Prisma
// auto-instrumentation hooks are in place before route handlers
// load. Fire-and-forget init: NodeSDK.start() is synchronous and
// the dynamic-import chain inside initOtel is short. The SDK is
// usable on every subsequent require call.
// No-op when NEXUS_OTEL_ENABLED is not '1'.
void initOtel();
import Fastify from "fastify";
import { runWithRequestId } from "./utils/request-context.js";
import cors from "@fastify/cors";
import { ALLOWED_WEB_ORIGINS } from "./lib/cors-origins.js";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { listingsRoutes } from "./routes/listings.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { aiRoutes } from "./routes/ai.js";
import { marketplaceRoutes } from "./routes/marketplaces.js";
import { adminRoutes } from "./routes/admin.js";
import { monitoringRoutes } from "./routes/monitoring.js";
import { shopifyRoutes } from "./routes/shopify.js";
import { shopifyWebhookRoutes } from "./routes/shopify-webhooks.js";
import { woocommerceRoutes } from "./routes/woocommerce.js";
import { woocommerceWebhookRoutes } from "./routes/woocommerce-webhooks.js";
import { estyRoutes } from "./routes/etsy.js";
import { estyWebhookRoutes } from "./routes/etsy-webhooks.js";
import { syncRoutes } from "./routes/sync.routes.js";
import { ebayAuthRoutes } from "./routes/ebay-auth.js";
import { ebayRoutes } from "./routes/ebay.routes.js";
import { ebayOrdersRoutes } from "./routes/ebay-orders.routes.js";
import { catalogRoutes } from "./routes/catalog.routes.js";
import { outboundRoutes } from "./routes/outbound.routes.js";
import { matrixRoutes } from "./routes/matrix.routes.js";
import { inboundRoutes } from "./routes/inbound.routes.js";
// F.4 (P0 #50) — v2024-03-20 SP-API inbound flow.
import fbaInboundV2Routes from "./routes/fba-inbound-v2.routes.js";
import { webhookRoutes } from "./routes/webhooks.routes.js";
import { sendcloudWebhookRoutes } from "./routes/sendcloud-webhooks.routes.js";
import { ordersRoutes } from "./routes/orders.routes.js";
import { customersRoutes } from "./routes/customers.routes.js";
import { catalogSafeRoutes } from "./routes/catalog-safe.routes.js";
import catalogOrganizeRoutes from "./routes/catalog-organize.routes.js";
import healthRoutes from "./routes/health.js";
import amazonRoutes from "./routes/amazon.routes.js";
import amazonFlatFileRoutes from "./routes/amazon-flat-file.routes.js";
import amazonCockpitPublishRoutes from "./routes/amazon-cockpit-publish.routes.js";
import amazonPreflightRoutes from "./routes/amazon-preflight.routes.js";
import cockpitTelemetryRoutes from "./routes/cockpit-telemetry.routes.js";
import ebayFlatFileRoutes from "./routes/ebay-flat-file.routes.js";
import ebayCockpitRoutes from "./routes/ebay-cockpit.routes.js";
import flatFilePullHistoryRoutes from "./routes/flat-file-pull-history.routes.js";
import flatFileUnifiedRoutes from "./routes/flat-file-unified.routes.js";
import marketplacesRoutes from "./routes/marketplaces.routes.js";
import fulfillmentRoutes from "./routes/fulfillment.routes.js";
import returnsRoutes from "./routes/returns.routes.js";
import stockRoutes from "./routes/stock.routes.js";
import brandSettingsRoutes from "./routes/brand-settings.routes.js";
import settingsAuditRoutes from "./routes/settings-audit.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import settingsWebhooksRoutes from "./routes/settings-webhooks.routes.js";
import settingsPrivacyRoutes from "./routes/settings-privacy.routes.js";
import marketingRoutes from "./routes/marketing.routes.js";
import marketingOsRoutes from "./routes/marketing-os.routes.js";
import advertisingRoutes from "./routes/advertising.routes.js";
import advertisingIntelRoutes from "./routes/advertising-intel.routes.js";
import amazonAdsAuthRoutes from "./routes/amazon-ads-auth.routes.js";
import reviewsRoutes from "./routes/reviews.routes.js";
import brandBrainRoutes from "./routes/brand-brain.routes.js";
import feedTransformRoutes from "./routes/feed-transform.routes.js";
import feedExportRoutes from "./routes/feed-export.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import insightsRoutes from "./routes/insights.routes.js";
import customerSegmentsRoutes from "./routes/customer-segments.routes.js";
import ordersRoutingRoutes from "./routes/orders-routing.routes.js";
import productsRoutes from "./routes/products.routes.js";
import listingRecoveryRoutes from "./routes/listing-recovery.routes.js";
import familiesRoutes from "./routes/families.routes.js";
import attributesRoutes from "./routes/attributes.routes.js";
import workflowsRoutes from "./routes/workflows.routes.js";
import productWorkflowRoutes from "./routes/product-workflow.routes.js";
import tierPricingRoutes from "./routes/tier-pricing.routes.js";
import productChannelDataRoutes from "./routes/product-channel-data.routes.js";
import assetsRoutes from "./routes/assets.routes.js";
import aPlusContentRoutes from "./routes/aplus-content.routes.js";
import brandStoryRoutes from "./routes/brand-story.routes.js";
import brandKitRoutes from "./routes/brand-kit.routes.js";
import marketingAutomationRoutes from "./routes/marketing-automation.routes.js";
import channelPublishRoutes from "./routes/channel-publish.routes.js";
import cloudinaryWebhookRoutes from "./routes/cloudinary-webhook.routes.js";
import repricingRulesRoutes from "./routes/repricing-rules.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import pimCategoriesRoutes from "./routes/pim-categories.routes.js";
import listingWizardRoutes from "./routes/listing-wizard.routes.js";
import wizardTemplateRoutes from "./routes/wizard-templates.routes.js";
import gtinExemptionRoutes from "./routes/gtin-exemption.routes.js";
import listingContentRoutes from "./routes/listing-content.routes.js";
import terminologyRoutes from "./routes/terminology.routes.js";
import bulkOperationsRoutes from "./routes/bulk-operations.routes.js";
import bulkActionTemplateRoutes from "./routes/bulk-action-templates.routes.js";
import scheduledBulkActionRoutes from "./routes/scheduled-bulk-actions.routes.js";
import bulkAutomationRulesRoutes from "./routes/bulk-automation-rules.routes.js";
import listingAutomationRulesRoutes from "./routes/listing-automation-rules.routes.js";
import bulkAutomationApprovalsRoutes from "./routes/bulk-automation-approvals.routes.js";
import importWizardRoutes from "./routes/import-wizard.routes.js";
import scheduledImportsRoutes from "./routes/scheduled-imports.routes.js";
import scheduledImagePublishesRoutes from "./routes/scheduled-image-publishes.routes.js";
import bulkImagePublishRoutes from "./routes/bulk-image-publish.routes.js";
import exportWizardRoutes from "./routes/export-wizard.routes.js";
import scheduledExportsRoutes from "./routes/scheduled-exports.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import outboundQueueRoutes from "./routes/outbound-queue.routes.js";
import pimRoutes from "./routes/pim.routes.js";
import pimGlobalRoutes from "./routes/pim-global.routes.js";
import catalogMatrixRoutes from "./routes/catalog-matrix.routes.js";
import pimMappingRoutes from "./routes/pim-mapping.routes.js";
import valueMapRoutes from "./routes/value-map.routes.js";
import mappingPropagationRoutes from "./routes/mapping-propagation.routes.js";
import amazonCockpitRoutes from "./routes/amazon-cockpit.routes.js";
import auditLogRoutes from "./routes/audit-log.routes.js";
import syncLogsRoutes from "./routes/sync-logs.routes.js";
import { listingsSyndicationRoutes } from "./routes/listings-syndication.routes.js";
import { listingHealthRoutes } from "./routes/listing-health.routes.js";
import { fieldLinksRoutes } from "./routes/field-links.routes.js";
import productsCatalogRoutes from "./routes/products-catalog.routes.js";
import productsSearchRoutes from "./routes/products-search.routes.js";
import productsAiRoutes from "./routes/products-ai.routes.js";
import productsImagesRoutes from "./routes/products-images.routes.js";
import listingImagesRoutes from "./routes/listing-images.routes.js";
import amazonImagesRoutes from "./routes/images/amazon-images.routes.js";
import imagesWorkspaceRoutes from "./routes/images/images-workspace.routes.js";
import channelImagePublishRoutes from "./routes/images/channel-image-publish.routes.js";
import productTranslationsRoutes from "./routes/product-translations.routes.js";
import productRelationsRoutes from "./routes/product-relations.routes.js";
import productCertificatesRoutes from "./routes/product-certificates.routes.js";
import productImagesCrudRoutes from "./routes/product-images-crud.routes.js";
import productSeoRoutes from "./routes/product-seo.routes.js";
import workflowAssignmentsRoutes from "./routes/workflow-assignments.routes.js";
import forecastRoutes from "./routes/forecast.routes.js";
import aiUsageRoutes from "./routes/ai-usage.routes.js";
import agentRoutes from "./routes/agents.routes.js";
import amazonReportsRoutes from "./routes/amazon-reports.routes.js";
import amazonEconomicsRoutes from "./routes/amazon-economics.routes.js";
import productCostsRoutes from "./routes/product-costs.routes.js";
import savedViewAlertsRoutes from "./routes/saved-view-alerts.routes.js";
// saved-views CRUD lives in products-catalog.routes.ts (P.3); the
// duplicate plugin in routes/saved-views.routes.ts (O.27) was crashing
// boot with FST_ERR_DUPLICATED_ROUTE on `GET /api/saved-views`. The
// products-catalog version is the one /products + /listings + the
// pending-tab consume (it carries the alertSummary join those UIs
// rely on); the O.27 file is removed.
import notificationsRoutes from "./routes/notifications.routes.js";
import inboxRoutes from "./routes/inbox.routes.js";
import ordersReviewsRoutes from "./routes/orders-reviews.routes.js";
import reviewInsertsRoutes from "./routes/review-inserts.routes.js";
import reviewSendWindowsRoutes from "./routes/review-send-windows.routes.js";
import connectionsRoutes from "./routes/connections.routes.js";
import { jobMonitorRoutes } from "./routes/job-monitor.routes.js";
import reconciliationRoutes from "./routes/reconciliation.routes.js";
import ebayPhase3Routes from "./routes/ebay-phase3.routes.js";
import amazonNotificationsRoutes from "./routes/amazon-notifications.routes.js";
import ebayNotificationRoutes from "./routes/ebay-notification.routes.js";
import pushHealthRoutes from "./routes/push-health.routes.js";
import pushLatencyRoutes from "./routes/push-latency.routes.js";
import shopifySetupRoutes from "./routes/shopify-setup.routes.js";
import { startAmazonSqsPollCron } from "./jobs/amazon-sqs-poll.job.js";
import { startDlqMonitorCron } from "./jobs/dlq-monitor.job.js";
import { ensureAmazonNotificationSubscription } from "./services/amazon-notifications-boot.service.js";
import { initializeSyncWorker } from "./workers/sync.worker.js";
import { startWizardCleanupCron } from "./jobs/wizard-cleanup.job.js";
import { startOrphanBulkJobCleanupCron } from "./jobs/bulk-job-orphan-cleanup.job.js";
import { startFbaFlipGuardCron } from "./jobs/fba-flip-guard.job.js";
import { startFbaDriftDetectorCron } from "./jobs/fba-drift-detector.job.js";
import { startScheduledBulkActionCron } from "./jobs/scheduled-bulk-action.job.js";
import { startBulkAutomationTickCron } from "./jobs/bulk-automation-tick.job.js";
import { startScheduledImportCron } from "./jobs/scheduled-import.job.js";
import { startScheduledExportCron } from "./jobs/scheduled-export.job.js";
import { startSalesReportIngestCron } from "./jobs/sales-report-ingest.job.js";
import { startForecastCron } from "./jobs/forecast.job.js";
import { startDashboardDigestCron } from "./jobs/dashboard-digest.job.js";
import { startPricingCron } from "./jobs/pricing-refresh.job.js";
import { startRepricerCron } from "./jobs/repricer.job.js";
import { startCatalogRefreshCron } from "./jobs/catalog-refresh.job.js";
import { startSchemaRefreshCron } from "./jobs/schema-refresh.job.js";
import { startEbayTokenRefreshCron } from "./jobs/ebay-token-refresh.job.js";
import { startEbayReturnsPollCron } from "./jobs/ebay-returns-poll.job.js";
import { startAmazonReturnsPollCron } from "./jobs/amazon-returns-poll.job.js";
import { startFlatFileFeedPollCron } from "./jobs/amazon-flat-file-feed-poll.job.js";
import { startRefundRetryCron } from "./jobs/refund-retry.job.js";
import { startRefundDeadlineTrackerCron } from "./jobs/refund-deadline-tracker.job.js";
import { startAmazonOrdersCron } from "./jobs/amazon-orders-sync.job.js";
import { startAmazonZeroTotalsBackfillCron } from "./jobs/amazon-zero-totals-backfill.job.js";
import { startSalesDriftDetectorCron } from "./jobs/sales-drift-detector.job.js";
import { startAmazonOrderItemsRetryCron } from "./jobs/amazon-order-items-retry.job.js";
import { startEbayOrdersCron } from "./jobs/ebay-orders-sync.job.js";
import { startEbayStatusReconcileCron } from "./jobs/ebay-status-reconcile.job.js";
import { startAmazonFinancialSyncCron } from "./jobs/amazon-financial-sync.job.js";
import { startEbayFinancialSyncCron } from "./jobs/ebay-financial-sync.job.js";
import { startAmazonInventoryCron } from "./jobs/amazon-inventory-sync.job.js";
import { startReservationSweepCron } from "./jobs/reservation-sweep.job.js";
import { startLateShipmentFlagCron } from "./jobs/late-shipment-flag.job.js";
import { startTrackingPushbackCron } from "./jobs/tracking-pushback.job.js";
import { startCarrierServiceSyncCron } from "./jobs/carrier-service-sync.job.js";
import { startPickupDispatchCron } from "./jobs/pickup-dispatch.job.js";
import { startCarrierMetricsCron } from "./jobs/carrier-metrics.job.js";
import { startOutboundLateRiskCron } from "./jobs/outbound-late-risk.job.js";
import { startSavedViewAlertsCron } from "./jobs/saved-view-alerts.job.js";
import { startSyncDriftDetectionCron } from "./jobs/sync-drift-detection.job.js";
import { startFbaStatusPollCron } from "./jobs/fba-status-poll.job.js";
import { startForecastAccuracyCron } from "./jobs/forecast-accuracy.job.js";
import { startAutoPoCron } from "./jobs/auto-po-replenishment.job.js";
import { startLeadTimeStatsCron } from "./jobs/lead-time-stats.job.js";
import { startStockoutDetectorCron } from "./jobs/stockout-detector.job.js";
import { startAbcClassificationCron } from "./jobs/abc-classification.job.js";
import { startListingQualityKeeperCron } from "./jobs/listing-quality-keeper.job.js";
import { startPricingWatchdogCron } from "./jobs/pricing-watchdog.job.js";
import { startCycleCountSchedulerCron } from "./jobs/cycle-count-scheduler.job.js";
import { startYearEndSnapshotCron } from "./jobs/year-end-snapshot.job.js";
import { startLotExpiryAlertCron } from "./jobs/lot-expiry-alert.job.js";
import { startCertExpiryAlertCron } from "./jobs/cert-expiry-alert.job.js";
import { getAmazonPublishMode } from "./services/amazon-publish-gate.service.js";
import { getEbayPublishMode } from "./services/ebay-publish-gate.service.js";
import { getShopifyPublishMode } from "./services/shopify-publish-gate.service.js";
import { startScheduledChangesCron } from "./jobs/scheduled-changes.job.js";
import { startPurgeSoftDeletedCron } from "./jobs/purge-soft-deleted-products.job.js";
import { startRetentionSweepCron } from "./jobs/data-retention-sweep.job.js";
import { startAmazonMCFStatusCron } from "./jobs/amazon-mcf-status.job.js";
import { startFbaPanEuSyncCron } from "./jobs/fba-pan-eu-sync.job.js";
import { startFbaRestockCron } from "./jobs/fba-restock-ingestion.job.js";
import { startAutomationRuleEvaluatorCron } from "./jobs/automation-rule-evaluator.job.js";
// AI-2.2 (list-wizard) — idempotent seed of the four Step 5 attribute
// prompts on API boot so /settings/ai prompt admin (lands AI-2.5) has
// rows to render. DRAFT status keeps live AI calls on the inline
// path until operators promote.
import { seedPromptTemplateDefaults } from "./services/ai/prompt-template.service.js";
// SP.3 (list-wizard) — scheduled wizard publish cron. Default-OFF;
// opt in via NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH=1.
import { startScheduledWizardPublishCron } from "./jobs/scheduled-wizard-publish.job.js";
import { startScheduledImagePublishCron } from "./jobs/scheduled-image-publish.job.js";
import { startImagePublishReconcileCron } from "./jobs/image-publish-reconcile.job.js";
import { startScheduledPoCron } from "./jobs/scheduled-po.job.js";
import { startObservabilityRetentionCron } from "./jobs/observability-retention.job.js";
import { startAlertEvaluatorCron } from "./jobs/alert-evaluator.job.js";
import { startRepricingEvaluatorCron } from "./jobs/repricing-evaluator.job.js";
import pricingRoutes from "./routes/pricing.routes.js";
import pricingRulesRoutes from "./routes/pricing-rules.routes.js";
// BullMQ worker bootstrapping is gated behind ENABLE_QUEUE_WORKERS=1.
// initializeQueue pings Redis and throws on failure; tryStartQueueWorkers
// catches that so a missing/unreachable Redis can't crash the API process
// (the HTTP routes still work, only the queue surface is dormant).
import { initializeBullMQWorker } from "./workers/bullmq-sync.worker.js";
import { initializeChannelSyncWorker } from "./workers/channel-sync.worker.js";
import { initializeBulkListWorker } from "./workers/bulk-list.worker.js";
import { initializeBulkJobWorker } from "./workers/bulk-job.worker.js";
import { initializeReadCacheWorker } from "./workers/read-cache.worker.js";
import { initializeSearchIndexWorker } from "./workers/search-index.worker.js";
import { initializeQueue, closeQueue } from "./lib/queue.js";
import { logger } from "./utils/logger.js";
import { envEnabled } from "./utils/env-flag.js";
import { markCronStep } from "./jobs/cron-startup-state.js";
import prisma from "./db.js";

let queueWorkersStarted = false;

/**
 * Seed env-managed connections (Amazon today) into ChannelConnection.
 *
 * Until P2-2 ships per-account LWA OAuth, Amazon SP-API access lives
 * on `process.env.AMAZON_*` and `AWS_*`. The connection-layer audit
 * on 2026-05-06 (TECH_DEBT #45) noted that the synthetic Amazon row
 * was being computed at request time inside connections.routes.ts —
 * which made it impossible for other tables (e.g. VariantChannelListing)
 * to FK onto it. After H.2 we materialise the synthetic row in DB so
 * everything else can treat env-managed and oauth-managed connections
 * uniformly.
 *
 * Failure here MUST NOT crash the API. The connections endpoint has
 * a path that returns a "Misconfigured" Amazon card if the row is
 * missing/inactive, so a transient DB error during seed is degraded
 * but not fatal.
 */
async function seedEnvManagedConnections(): Promise<void> {
  try {
    const amazonConfigured = !!(
      process.env.AMAZON_LWA_CLIENT_ID &&
      process.env.AMAZON_LWA_CLIENT_SECRET &&
      process.env.AMAZON_REFRESH_TOKEN &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_ROLE_ARN
    );
    const sellerId =
      process.env.AMAZON_SELLER_ID ??
      process.env.AMAZON_MERCHANT_ID ??
      null;

    // findFirst+update-or-create rather than upsert because the
    // identifying tuple (channelType, managedBy) isn't a Prisma
    // @@unique. The H.2 partial unique on (channelType, marketplace)
    // WHERE isActive=true could fight a real OAuth Amazon row landing
    // later, so we do not let this seed step write isActive=true if
    // there's already an OAuth-managed Amazon row active.
    const existingOauth = await prisma.channelConnection.findFirst({
      where: { channelType: "AMAZON", managedBy: "oauth", isActive: true },
      select: { id: true },
    });
    if (existingOauth) {
      logger.info(
        "seedEnvManagedConnections: oauth-managed Amazon row already active — skipping env synthesis",
        { existingId: existingOauth.id },
      );
      return;
    }

    const existingEnv = await prisma.channelConnection.findFirst({
      where: { channelType: "AMAZON", managedBy: "env" },
      select: { id: true },
    });

    const data = {
      channelType: "AMAZON",
      marketplace: null,
      managedBy: "env",
      isActive: amazonConfigured,
      displayName: sellerId,
      lastSyncStatus: amazonConfigured ? "SUCCESS" : "FAILED",
      lastSyncError: amazonConfigured
        ? null
        : "Amazon credentials not configured (AMAZON_LWA_* and AWS_* env vars required)",
    };

    if (existingEnv) {
      await prisma.channelConnection.update({
        where: { id: existingEnv.id },
        data,
      });
      logger.info("seedEnvManagedConnections: updated env-managed Amazon row", {
        id: existingEnv.id,
        isActive: amazonConfigured,
        sellerId,
      });
    } else {
      const created = await prisma.channelConnection.create({ data });
      logger.info("seedEnvManagedConnections: created env-managed Amazon row", {
        id: created.id,
        isActive: amazonConfigured,
        sellerId,
      });
    }
  } catch (err) {
    logger.error("seedEnvManagedConnections: failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function tryStartQueueWorkers(): Promise<void> {
  // The DB-polling autopilot runs unconditionally — no Redis needed.
  // It drains OutboundSyncQueue rows every 60s so pushes work even
  // when BullMQ/Redis is not configured.
  initializeSyncWorker();

  if (process.env.ENABLE_QUEUE_WORKERS !== '1') {
    return;
  }
  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
    logger.warn('queue workers: ENABLE_QUEUE_WORKERS=1 but neither REDIS_URL nor REDIS_HOST is set — skipping');
    return;
  }
  try {
    await initializeQueue();
    initializeBullMQWorker();
    initializeChannelSyncWorker();
    initializeBulkListWorker();
    initializeBulkJobWorker();
    initializeReadCacheWorker();
    if (process.env.SEARCH_ENGINE_ENABLED === '1') {
      initializeSearchIndexWorker();
      logger.info('✅ Search-index worker started (SEARCH_ENGINE_ENABLED=1)');
    }
    queueWorkersStarted = true;
    logger.info('✅ Queue workers started (BullMQ outbound-sync + channel-sync + bulk-list + bulk-job + read-cache)');
  } catch (err) {
    logger.error('queue workers: initialization failed — HTTP routes still served, queue surface dormant', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const app = Fastify({ logger: true });

// L.12.0 — request context. Every HTTP request runs the handler
// inside an AsyncLocalStorage scope keyed by Fastify's request.id
// (or an incoming x-request-id header). Deep service calls — most
// importantly recordApiCall — read the ID via getRequestId() and
// stamp it on every OutboundApiCallLog row, giving an operator
// the ability to ask "show me every channel API call this one
// order ingestion made".
app.addHook('onRequest', (request, reply, done) => {
  const id =
    typeof request.headers['x-request-id'] === 'string' &&
    request.headers['x-request-id'].length > 0
      ? request.headers['x-request-id']
      : request.id
  reply.header('x-request-id', id)
  // Bind the context for the lifetime of this request. The done()
  // callback completes inside the scope so async work the route
  // handler dispatches still sees it.
  runWithRequestId(id, 'http', () => done())
});

// Compress responses (gzip / brotli). Threshold 1KB so small payloads
// don't pay the compression cost. Critical for /products/bulk-fetch
// at 10k rows (5.4 MB JSON → ~1 MB on the wire).
app.register(compress, {
  global: true,
  threshold: 1024,
  encodings: ['gzip', 'deflate'],
});

// D.4: bulk CSV/XLSX upload. 50 MB cap matches the documented spec
// and prevents an obvious DoS vector. Single-file uploads only.
app.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 1,
  },
});

// NN.5 / OO.1 — global rate limit. Default applies to every route
// at a very generous 2000 req/min per IP so a power user with a
// busy bulk-ops grid (poll + autoload + schema fetch + write) never
// hits the cap during normal use. Hot endpoints (/products/bulk,
// AI generation, replicate) opt into stricter per-route caps via
// the route-level config option. Allow-list covers read endpoints
// the UI hits frequently so a fast catalog browsing session can't
// be locked out.
//
// Disable entirely with NEXUS_DISABLE_RATE_LIMIT=1 if a load
// pattern triggers false positives — preferable to losing work.
if (process.env.NEXUS_DISABLE_RATE_LIMIT !== '1') {
  app.register(rateLimit, {
    global: true,
    max: 2000,
    timeWindow: '1 minute',
    allowList: (req) => {
      const url = req.url ?? '';
      // Health checks + the read-heavy product listing endpoints
      // skip the global limiter entirely so an aggressive grid
      // never starves them.
      if (url === '/api/health') return true;
      if (url.startsWith('/api/products/bulk-fetch')) return true;
      if (url.startsWith('/api/inventory')) return true;
      if (url.startsWith('/api/catalog/products')) return true;
      if (url.startsWith('/api/marketplaces')) return true;
      if (url.startsWith('/api/pim/fields')) return true;
      return false;
    },
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'rate_limited',
      message: `Rate limit exceeded — try again in ${Math.ceil(ctx.ttl / 1000)}s`,
      retryAfter: Math.ceil(ctx.ttl / 1000),
    }),
  });
}

// Register CORS to allow cross-origin requests from frontend (Port 3000)
app.register(cors, {
  origin: [...ALLOWED_WEB_ORIGINS],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  credentials: true,
});

// HTTP routes — all queue references are lazy (see lib/queue.ts), so registering
// these does not open Redis connections. Workers/jobs remain disabled (Phase 2).
app.register(listingsRoutes);
app.register(inventoryRoutes, { prefix: '/api' });
app.register(aiRoutes);
app.register(marketplaceRoutes);
app.register(adminRoutes);
app.register(monitoringRoutes);
app.register(shopifyRoutes);
app.register(shopifyWebhookRoutes);
app.register(woocommerceRoutes);
app.register(woocommerceWebhookRoutes);
app.register(estyRoutes);
app.register(estyWebhookRoutes);
app.register(syncRoutes, { prefix: '/api' });
app.register(ebayAuthRoutes);
app.register(ebayRoutes);
app.register(ebayOrdersRoutes);
app.register(catalogRoutes, { prefix: '/api/catalog' });
app.register(catalogOrganizeRoutes, { prefix: '/api/catalog' });
// S.0 / C-2 — listing-health.routes declares full /api/catalog/... paths
// internally, so register without a prefix. See DEVELOPMENT.md "Health
// endpoint conventions" for why /api/listings/health and
// /api/catalog/:productId/listing-health coexist as distinct concepts.
app.register(listingHealthRoutes);
app.register(fieldLinksRoutes);
app.register(outboundRoutes);
app.register(matrixRoutes);
app.register(inboundRoutes);
app.register(fbaInboundV2Routes, { prefix: '/api' });
app.register(webhookRoutes);
app.register(sendcloudWebhookRoutes);
app.register(ordersRoutes);
app.register(customersRoutes);
app.register(catalogSafeRoutes, { prefix: '/api/catalog' });
app.register(healthRoutes, { prefix: '/api' });
app.register(amazonRoutes, { prefix: '/api/amazon' });
app.register(amazonFlatFileRoutes, { prefix: '/api' });
app.register(amazonCockpitPublishRoutes, { prefix: '/api' });
app.register(amazonPreflightRoutes, { prefix: '/api' });
app.register(cockpitTelemetryRoutes, { prefix: '/api' });
app.register(ebayFlatFileRoutes, { prefix: '/api' });
app.register(ebayCockpitRoutes, { prefix: '/api' });
app.register(flatFilePullHistoryRoutes, { prefix: '/api' });
app.register(flatFileUnifiedRoutes, { prefix: '/api' });
app.register(marketplacesRoutes, { prefix: '/api' });
app.register(fulfillmentRoutes, { prefix: '/api' });
app.register(returnsRoutes, { prefix: '/api' });
app.register(stockRoutes, { prefix: '/api' });
app.register(brandSettingsRoutes, { prefix: '/api' });
app.register(settingsAuditRoutes, { prefix: '/api' });
app.register(profileRoutes, { prefix: '/api' });
app.register(settingsWebhooksRoutes, { prefix: '/api' });
app.register(settingsPrivacyRoutes, { prefix: '/api' });
app.register(pricingRoutes, { prefix: '/api' });
app.register(pricingRulesRoutes, { prefix: '/api' });
app.register(marketingRoutes, { prefix: '/api' });
app.register(marketingOsRoutes, { prefix: '/api' });
app.register(advertisingRoutes, { prefix: '/api' });
app.register(advertisingIntelRoutes, { prefix: '/api' });
app.register(amazonAdsAuthRoutes, { prefix: '/api' });
app.register(reviewsRoutes, { prefix: '/api' });
app.register(brandBrainRoutes, { prefix: '/api' });
app.register(feedTransformRoutes, { prefix: '/api/feed-transform' });
app.register(feedExportRoutes, { prefix: '/api/feed-export' });
app.register(analyticsRoutes, { prefix: '/api' });
app.register(insightsRoutes, { prefix: '/api' });
app.register(customerSegmentsRoutes, { prefix: '/api' });
app.register(ordersRoutingRoutes, { prefix: '/api' });
app.register(productsRoutes, { prefix: '/api' });
app.register(listingRecoveryRoutes, { prefix: '/api' });
app.register(familiesRoutes, { prefix: '/api' });
app.register(attributesRoutes, { prefix: '/api' });
app.register(workflowsRoutes, { prefix: '/api' });
app.register(productWorkflowRoutes, { prefix: '/api' });
app.register(tierPricingRoutes, { prefix: '/api' });
app.register(productChannelDataRoutes, { prefix: '/api' });
app.register(assetsRoutes, { prefix: '/api' });
app.register(aPlusContentRoutes, { prefix: '/api' });
app.register(brandStoryRoutes, { prefix: '/api' });
app.register(brandKitRoutes, { prefix: '/api' });
app.register(marketingAutomationRoutes, { prefix: '/api' });
app.register(channelPublishRoutes, { prefix: '/api' });
app.register(cloudinaryWebhookRoutes, { prefix: '/api' });
app.register(repricingRulesRoutes, { prefix: '/api' });
app.register(categoriesRoutes, { prefix: '/api' });
app.register(pimCategoriesRoutes, { prefix: '/api' });
app.register(listingWizardRoutes, { prefix: '/api' });
app.register(wizardTemplateRoutes, { prefix: '/api' });
app.register(gtinExemptionRoutes, { prefix: '/api' });
app.register(listingContentRoutes, { prefix: '/api' });
app.register(terminologyRoutes, { prefix: '/api' });
app.register(bulkOperationsRoutes, { prefix: '/api' });
app.register(bulkActionTemplateRoutes, { prefix: '/api' });
app.register(scheduledBulkActionRoutes, { prefix: '/api' });
app.register(bulkAutomationRulesRoutes, { prefix: '/api' });
app.register(listingAutomationRulesRoutes, { prefix: '/api' });
app.register(bulkAutomationApprovalsRoutes, { prefix: '/api' });
app.register(importWizardRoutes, { prefix: '/api' });
app.register(scheduledImportsRoutes, { prefix: '/api' });
app.register(scheduledImagePublishesRoutes, { prefix: '/api' });
app.register(bulkImagePublishRoutes, { prefix: '/api' });
app.register(exportWizardRoutes, { prefix: '/api' });
app.register(scheduledExportsRoutes, { prefix: '/api' });
app.register(dashboardRoutes, { prefix: '/api' });
app.register(outboundQueueRoutes, { prefix: '' });
app.register(pimRoutes, { prefix: '/api' });
app.register(pimGlobalRoutes, { prefix: '/api' });
app.register(catalogMatrixRoutes, { prefix: '/api' });
app.register(pimMappingRoutes, { prefix: '/api' });
app.register(valueMapRoutes, { prefix: '/api' });
app.register(mappingPropagationRoutes, { prefix: '/api' });
app.register(amazonCockpitRoutes, { prefix: '/api' });
app.register(auditLogRoutes, { prefix: '/api' });
app.register(syncLogsRoutes, { prefix: '/api' });
app.register(listingsSyndicationRoutes, { prefix: '/api' });
app.register(productsCatalogRoutes, { prefix: '/api' });
app.register(productsSearchRoutes, { prefix: '/api' });
app.register(productsAiRoutes, { prefix: '/api' });
app.register(productsImagesRoutes, { prefix: '/api' });
app.register(listingImagesRoutes, { prefix: '/api' });
app.register(amazonImagesRoutes, { prefix: '/api' });
app.register(imagesWorkspaceRoutes, { prefix: '/api' });
app.register(channelImagePublishRoutes, { prefix: '/api' });
app.register(productTranslationsRoutes, { prefix: '/api' });
app.register(productRelationsRoutes, { prefix: '/api' });
app.register(productCertificatesRoutes, { prefix: '/api' });
app.register(productImagesCrudRoutes, { prefix: '/api' });
app.register(productSeoRoutes, { prefix: '/api' });
app.register(workflowAssignmentsRoutes, { prefix: '/api' });
app.register(forecastRoutes, { prefix: '/api' });
app.register(aiUsageRoutes, { prefix: '/api' });
app.register(agentRoutes, { prefix: '/api' });
app.register(amazonReportsRoutes, { prefix: '/api' });
app.register(amazonEconomicsRoutes, { prefix: '/api' });
app.register(productCostsRoutes, { prefix: '/api' });
app.register(savedViewAlertsRoutes, { prefix: '/api' });
// savedViewsRoutes register removed — see import comment above.
// /api/saved-views{,/...} is owned by products-catalog.routes.ts.
app.register(notificationsRoutes, { prefix: '/api' });
app.register(inboxRoutes, { prefix: '/api' });
app.register(ordersReviewsRoutes, { prefix: '/api' });
app.register(reviewInsertsRoutes, { prefix: '/api' });
app.register(reviewSendWindowsRoutes, { prefix: '/api' });
app.register(connectionsRoutes, { prefix: '/api' });
app.register(reconciliationRoutes, { prefix: '/api' });
app.register(ebayPhase3Routes, { prefix: '/api' });
// IS.2 — real-time cross-channel inventory sync routes
app.register(amazonNotificationsRoutes, { prefix: '/api' });
app.register(ebayNotificationRoutes, { prefix: '/api' });
// RT.1 — unified push-health endpoint feeds the PushHealthChip on
// /orders + /insights/live.
app.register(pushHealthRoutes, { prefix: '/api' });
// RT.3 — push-latency dashboard (p50/p95/p99 + histogram per source).
app.register(pushLatencyRoutes, { prefix: '/api' });
// RT.11 — Shopify webhook registration helper. POST /api/admin/
// setup-shopify-webhooks registers every topic our handlers
// listen for so push delivery is no longer a manual partner-dashboard
// step.
app.register(shopifySetupRoutes, { prefix: '/api' });
// L.0d — BullMQ admin endpoints. Routes declare full /api/monitoring/...
// paths inline, so register without a prefix. Coexists with
// monitoringRoutes (which uses /monitoring/* without /api/).
app.register(jobMonitorRoutes);

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

async function start() {
  try {
    await app.listen({
      port: port,
      host: '0.0.0.0'
    });

    app.log.info(`API server listening at http://0.0.0.0:${port}`);

    // ── Seed env-managed ChannelConnection rows (H.2 Phase 2) ──────
    // Amazon SP-API today is single-tenant via process.env.AMAZON_*
    // and AWS_*. Until P2-2 ships per-account LWA OAuth, we keep the
    // synthetic representation in ChannelConnection so the rest of
    // the codebase can FK to it and the connections endpoint can
    // read uniformly. Idempotent: upsert keyed on (channelType,
    // managedBy='env').
    await seedEnvManagedConnections();

    // ── BullMQ queue workers (outbound sync, channel sync, bulk list) ──
    // Opt-in via ENABLE_QUEUE_WORKERS=1. Requires REDIS_URL or REDIS_HOST.
    // Fire-and-forget: this MUST NOT block startup. An unreachable Redis used to
    // hang the awaited init here (ioredis maxRetriesPerRequest:null → ping never
    // rejects), which froze ALL cron registration below it. The DB-polling sync
    // autopilot inside runs synchronously regardless; BullMQ workers attach in
    // the background when Redis is reachable.
    void tryStartQueueWorkers().catch((err) => {
      logger.error('queue workers: background init failed — HTTP + crons unaffected', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

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

    // W7.1 — register bulk-ops action handlers into the existing
    // AutomationRule registry. Idempotent — safe to call before /
    // after the W4 replenishment evaluator boots.
    try {
      const { registerBulkOpsActions } = await import(
        './services/automation/bulk-ops-actions.js'
      );
      registerBulkOpsActions();
    } catch (err) {
      logger.warn(
        `[boot] bulk-ops automation actions skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // W7.2 — bulk-ops automation cron tick. Fires the
    // `bulk_cron_tick` trigger every 15 min so scheduled hygiene
    // rules (auto-pause on failure burst, periodic re-syncs, etc.)
    // can run on a deterministic clock. No-op when no rules exist.
    startBulkAutomationTickCron();

    // W5.4 — seed built-in BulkActionTemplate rows. Idempotent —
    // keyed by (userId='__builtin', name) so re-running on every
    // boot picks up seed list changes without duplicating rows.
    // Best-effort: a failure (e.g., DB up but the migration hasn't
    // landed yet on this replica) logs and continues.
    try {
      const { seedBulkActionTemplates } = await import(
        './services/bulk-action-template-seeds.js'
      );
      const result = await seedBulkActionTemplates(
        (await import('./db.js')).default,
      );
      logger.info(
        `[boot] bulk-action-template seeds: ${result.created} created, ${result.updated} updated`,
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
    void import('./services/alert-evaluator.service.js')
      .then(({ seedDefaultAlertRules }) => seedDefaultAlertRules())
      .catch((e) => logger.warn('[startup] seedDefaultAlertRules failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) }));

    // W4.10 — Repricing evaluator cron (every 5 min). Walks every
    // enabled RepricingRule, builds market context from the latest
    // BuyBoxHistory + matching ChannelListing, calls
    // repricingEngineService.evaluate (applyToProduct=false on this
    // path — pushes are W4.10b once channel-override flow lands).
    startRepricingEvaluatorCron();

    // F.3 — Nightly Amazon Sales & Traffic ingest. Gated behind an env
    // flag so dev/test environments without SP-API credentials don't
    // try to run it. POST /api/fulfillment/sales-reports/ingest is the
    // manual trigger when the cron is off.
    if (process.env.NEXUS_ENABLE_SALES_REPORT_CRON === '1') {
      startSalesReportIngestCron();
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

    // ALA Phase 5 — proactive Amazon schema refresh (self-gates on
    // NEXUS_ENABLE_SCHEMA_REFRESH_CRON=1; dormant otherwise). 04:00 UTC daily.
    startSchemaRefreshCron();

    // Proactive eBay access-token refresh sweep. The reactive refresh
    // in EbayAuthService.getValidToken handles per-call refresh, but
    // when no sync runs for >2 hours the token expires silently.
    // Default-ON because a missing env flag silently breaking eBay is
    // exactly the failure mode this cron exists to prevent. The sweep
    // is a no-op when there are no active connections, so the
    // default-ON behaviour is safe in fresh / dev environments.
    // Set NEXUS_ENABLE_EBAY_TOKEN_REFRESH_CRON=0 to opt out.
    if (process.env.NEXUS_ENABLE_EBAY_TOKEN_REFRESH_CRON !== '0') {
      startEbayTokenRefreshCron();
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

    // IS.2 — Real-time Amazon order detection via SQS (~30-90 second latency).
    // Runs every 30s when NEXUS_ENABLE_AMAZON_SQS_POLL=1 and AMAZON_SQS_QUEUE_URL is set.
    startAmazonSqsPollCron();

    // RT.2 — Amazon SQS dead-letter-queue depth monitor (5min). Fires
    // sync.dlq.threshold on the order-events bus whenever DLQ depth
    // ≥ NEXUS_DLQ_THRESHOLD. No-op when AMAZON_SQS_DLQ_URL is unset.
    startDlqMonitorCron();

    // IS.2 — Ensure SP-API ORDER_CHANGE subscription exists on every boot.
    // Idempotent: skips if subscription already active. Fire-and-forget;
    // a failure here is logged but never crashes the server.
    ensureAmazonNotificationSubscription();

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
      const { startAmazonSettlementCron } = await import('./jobs/amazon-settlement-sync.job.js');
      startAmazonSettlementCron();
    }

    // Daily Amazon A+ Content metadata sync (04:00 UTC) — pulls all
    // /aplus/2020-11-01/contentDocuments and upserts metadata.
    // Gated behind NEXUS_ENABLE_AMAZON_APLUS_CRON=1.
    if (process.env.NEXUS_ENABLE_AMAZON_APLUS_CRON === '1') {
      const { startAmazonAplusCron } = await import('./jobs/amazon-aplus-sync.job.js');
      startAmazonAplusCron();
    }

    // Reservation TTL sweep — every 5 min, releases expired
    // PENDING_ORDER reservations so available = quantity - reserved
    // doesn't stay locked after a cancelled order. Default-ON; opt out
    // via NEXUS_ENABLE_RESERVATION_SWEEP_CRON=0.
    if (process.env.NEXUS_ENABLE_RESERVATION_SWEEP_CRON !== '0') {
      startReservationSweepCron();
    }

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

    // H.8d — FBA shipment status polling cron. Every 15 minutes,
    // batches non-terminal local FBAShipment IDs into SP-API
    // getShipments calls and mirrors Amazon's authoritative status.
    // No-op if SP-API isn't configured. Default-ON; opt out via
    // NEXUS_ENABLE_FBA_STATUS_POLL_CRON=0.
    if (process.env.NEXUS_ENABLE_FBA_STATUS_POLL_CRON !== '0') {
      startFbaStatusPollCron();
    }

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
    if (adsCronOn) {
      // Apex diagnostic + resilience: each step marks progress (visible via the
      // cron-status probe) so a hanging `await import` is locatable, and the
      // Redis-dependent worker init is deferred to the very end + made
      // non-blocking so it can never freeze cron registration (Redis may be
      // unreachable on prod). markCronStep BEFORE each await = the last marker
      // shown is the line that hung.
      markCronStep('ads:start');
      markCronStep('ads:import ads-sync.job');
      const { startAllAdvertisingCrons } = await import('./jobs/ads-sync.job.js');
      markCronStep('ads:import advertising-rule-evaluator.job');
      const { startAdvertisingRuleEvaluatorCron } = await import('./jobs/advertising-rule-evaluator.job.js');
      markCronStep('ads:import budget-pool-rebalance.job');
      const { startBudgetPoolRebalanceCron } = await import('./jobs/budget-pool-rebalance.job.js');
      markCronStep('ads:import automation-action-handlers');
      await import('./services/advertising/automation-action-handlers.js');
      markCronStep('ads:import ads-bid-optimizer');
      await import('./services/advertising/ads-bid-optimizer.service.js');
      markCronStep('ads:import ad-dayparting.job');
      const { startDaypartingCron } = await import('./jobs/ad-dayparting.job.js');
      const { startBudgetScheduleCron } = await import('./jobs/ad-budget-schedule.job.js');
      const { startBudgetEnforceCron } = await import('./jobs/ad-budget-enforce.job.js');
      const { startAutopilotCron } = await import('./jobs/ad-autopilot.job.js');
      // RS.5 — rank-defend loop (self-gated on NEXUS_ENABLE_RANK_DEFEND=1).
      const { startRankDefendCron } = await import('./jobs/ad-rank-defend.job.js');
      markCronStep('ads:import ads-budget-pacing');
      await import('./services/advertising/ads-budget-pacing.service.js');
      // Apex D.2 — registers the defend_top_of_search handler.
      markCronStep('ads:import ads-top-of-search');
      await import('./services/advertising/ads-top-of-search.service.js');
      // RC2.T6 — registers the refresh_dayparting handler.
      markCronStep('ads:import ads-dayparting-refresh');
      await import('./services/advertising/ads-dayparting-refresh.service.js');
      markCronStep('ads:import marketing-action-handlers');
      await import('./services/marketing/marketing-action-handlers.js');
      markCronStep('ads:import marketing-rule-evaluator.job');
      const { startMarketingRuleEvaluatorCron } = await import('./jobs/marketing-rule-evaluator.job.js');
      markCronStep('ads:import marketing-sync-drain.job');
      const { startMarketingSyncDrainCron } = await import('./jobs/marketing-sync-drain.job.js');
      markCronStep('ads:import ads-sync-drain.job');
      const { startAdsSyncDrainCron } = await import('./jobs/ads-sync-drain.job.js');
      // Apex D.2 — Top-of-Search defense (self-gated: only schedules when
      // NEXUS_ENABLE_TOS_DEFENSE_CRON is on, since it writes live placement bids).
      const { startTosDefenseCron } = await import('./jobs/ads-tos-defense.job.js');
      // Apex B.1 — AMS SQS consumer (self-gated on NEXUS_AMS_SQS_QUEUE_URL + AWS creds).
      const { startAmsSqsPollCron } = await import('./jobs/ams-sqs-poll.job.js');
      // Apex E.1 — SQP competitive-intel ingest (self-gated on NEXUS_ENABLE_SQP_INGEST_CRON).
      const { startSqpIngestCron } = await import('./jobs/sqp-ingest.job.js');
      // Register all schedules (these are synchronous node-cron registrations).
      markCronStep('ads:register schedules');
      startDaypartingCron();
      startBudgetScheduleCron();
      startAutopilotCron();
      startRankDefendCron();
      startAllAdvertisingCrons();
      startAdvertisingRuleEvaluatorCron();
      startBudgetPoolRebalanceCron();
      startBudgetEnforceCron();
      startMarketingRuleEvaluatorCron();
      startMarketingSyncDrainCron();
      startAdsSyncDrainCron();
      startTosDefenseCron();
      startAmsSqsPollCron();
      startSqpIngestCron();
      const { startTosIsIngestCron } = await import('./jobs/ads-tos-is-ingest.job.js');
      startTosIsIngestCron();
      markCronStep('ads:schedules registered');
      // Redis-dependent BullMQ worker LAST + non-blocking: a hung/failed Redis
      // connect must not freeze the crons above (which is what happened — the
      // worker init blocked the whole block). Fire-and-forget with its own guard.
      markCronStep('ads:import ads-sync.worker (deferred)');
      void import('./workers/ads-sync.worker.js')
        .then(({ initializeAdsSyncWorker }) => {
          try { initializeAdsSyncWorker(); markCronStep('ads:worker initialized'); }
          catch (e) { logger.error('[startup] ads-sync worker init failed (crons unaffected)', { error: e instanceof Error ? e.message : String(e) }); }
        })
        .catch((e) => logger.error('[startup] ads-sync.worker import failed (crons unaffected)', { error: e instanceof Error ? e.message : String(e) }));
      markCronStep('ads:block complete');
    }

    // SR.1 — Sentient Review Loop. Default-OFF — opt in via
    // NEXUS_ENABLE_REVIEW_INGEST=1. Sandbox mode (default) uses
    // fixture reviews; live mode pulls from configured channel sources.
    if (process.env.NEXUS_ENABLE_REVIEW_INGEST === '1') {
      const { startAllReviewCrons } = await import('./jobs/review-pipeline.job.js');
      startAllReviewCrons();
      // SR.3 — review-domain AutomationRule evaluator (same gate).
      const { startReviewRuleEvaluatorCron } = await import('./jobs/review-rule-evaluator.job.js');
      startReviewRuleEvaluatorCron();
      // SR.4 — post-purchase review request mailer (same gate).
      const { startReviewMailerCron } = await import('./jobs/review-request-mailer.job.js');
      startReviewMailerCron();
      // RV.7 — orders-delivered backfill (real Amazon report → deliveredAt; same gate).
      const { startOrdersDeliveredBackfillCron } = await import('./jobs/orders-delivered-backfill.job.js');
      startOrdersDeliveredBackfillCron();
      // RV.9.7 — review → request/rule attribution (same gate).
      const { startReviewAttributionCron } = await import('./jobs/review-attribution.job.js');
      startReviewAttributionCron();
    }

    // D.4 — Amazon official Customer Feedback API insights. Independently gated
    // (needs the SP-API Brand Analytics role, not the general review ingest) —
    // opt in via NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS=1. Stays dark until the role
    // is confirmed via POST /api/reviews/insights/probe. Weekly schedule.
    if (process.env.NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS === '1') {
      const { startAmazonReviewInsightsCron } = await import('./jobs/review-pipeline.job.js');
      startAmazonReviewInsightsCron();
    }

    // RV.9.2 — Stale CronRun sweeper. Always-on (not gated). Marks
    // status='RUNNING' rows stuck for >2h as FAILED so the dashboard
    // doesn't show false-positive "still running" states after a crash.
    {
      const { startCronOrphanSweeperCron } = await import('./jobs/cron-orphan-sweeper.job.js');
      startCronOrphanSweeperCron();
    }

    // MB.1 — Brand Brain embedding ingester. Gated by NEXUS_ENABLE_BRAND_BRAIN=1.
    if (process.env.NEXUS_ENABLE_BRAND_BRAIN === '1') {
      const { startEmbeddingIngesterCron } = await import('./jobs/embedding-ingester.job.js');
      startEmbeddingIngesterCron();
      // CE.2 — Browse node predictor (shares BRAND_BRAIN gate).
      const { startBrowseNodePredictorCron } = await import('./jobs/browse-node-predictor.job.js');
      startBrowseNodePredictorCron();
    }

    // CE.5 — Cross-RMN Feed Export cron (always on; generates GMC + Meta feeds daily).
    {
      const { startFeedExportCron } = await import('./jobs/feed-export.job.js');
      startFeedExportCron();
    }

    // PA.2 — Listing Quality Snapshot (weekly; always on).
    {
      const { startListingQualitySnapshotCron } = await import('./jobs/listing-quality-snapshot.job.js');
      startListingQualitySnapshotCron();
    }

    // CI.1 — RFM Scoring (nightly; always on).
    {
      const { startRFMScoringCron } = await import('./jobs/rfm-scoring.job.js');
      startRFMScoringCron();
    }

    // CI.2 — Segment Recount (weekly; always on).
    {
      const { startSegmentRecountCron } = await import('./jobs/segment-recount.job.js');
      startSegmentRecountCron();
    }

    // AI-2.2 (list-wizard) — seed the four Step 5 attribute prompts
    // on boot. Idempotent: skips rows that already exist for
    // (feature, name='default', version=1) so an operator-edited
    // body isn't clobbered. Failures here mustn't kill startup —
    // the inline-prompt path in listing-content.service.ts still
    // works without the DB rows.
    seedPromptTemplateDefaults(prisma).catch((err: unknown) => {
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

    logger.info('✅ API server initialized', {
      queueWorkers: queueWorkersStarted,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    app.log.error(error);
    logger.error('❌ Failed to start API', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  if (queueWorkersStarted) {
    try { await closeQueue(); } catch (err) {
      logger.warn('closeQueue failed during shutdown', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  if (queueWorkersStarted) {
    try { await closeQueue(); } catch (err) {
      logger.warn('closeQueue failed during shutdown', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  process.exit(0);
});
