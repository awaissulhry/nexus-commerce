import "./db.js"; // ensure dotenv loads before anything else
import Fastify from "fastify";
import cors from "@fastify/cors";
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
import { catalogSafeRoutes } from "./routes/catalog-safe.routes.js";
import healthRoutes from "./routes/health.js";
import amazonRoutes from "./routes/amazon.routes.js";
import marketplacesRoutes from "./routes/marketplaces.routes.js";
import fulfillmentRoutes from "./routes/fulfillment.routes.js";
import returnsRoutes from "./routes/returns.routes.js";
import stockRoutes from "./routes/stock.routes.js";
import brandSettingsRoutes from "./routes/brand-settings.routes.js";
import marketingRoutes from "./routes/marketing.routes.js";
import productsRoutes from "./routes/products.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import listingWizardRoutes from "./routes/listing-wizard.routes.js";
import gtinExemptionRoutes from "./routes/gtin-exemption.routes.js";
import listingContentRoutes from "./routes/listing-content.routes.js";
import terminologyRoutes from "./routes/terminology.routes.js";
import bulkOperationsRoutes from "./routes/bulk-operations.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import pimRoutes from "./routes/pim.routes.js";
import auditLogRoutes from "./routes/audit-log.routes.js";
import { listingsSyndicationRoutes } from "./routes/listings-syndication.routes.js";
import { listingHealthRoutes } from "./routes/listing-health.routes.js";
import productsCatalogRoutes from "./routes/products-catalog.routes.js";
import productsAiRoutes from "./routes/products-ai.routes.js";
import productsImagesRoutes from "./routes/products-images.routes.js";
import listingImagesRoutes from "./routes/listing-images.routes.js";
import productTranslationsRoutes from "./routes/product-translations.routes.js";
import productRelationsRoutes from "./routes/product-relations.routes.js";
import forecastRoutes from "./routes/forecast.routes.js";
import aiUsageRoutes from "./routes/ai-usage.routes.js";
import savedViewAlertsRoutes from "./routes/saved-view-alerts.routes.js";
// saved-views CRUD lives in products-catalog.routes.ts (P.3); the
// duplicate plugin in routes/saved-views.routes.ts (O.27) was crashing
// boot with FST_ERR_DUPLICATED_ROUTE on `GET /api/saved-views`. The
// products-catalog version is the one /products + /listings + the
// pending-tab consume (it carries the alertSummary join those UIs
// rely on); the O.27 file is removed.
import notificationsRoutes from "./routes/notifications.routes.js";
import ordersReviewsRoutes from "./routes/orders-reviews.routes.js";
import connectionsRoutes from "./routes/connections.routes.js";
import { startWizardCleanupCron } from "./jobs/wizard-cleanup.job.js";
import { startSalesReportIngestCron } from "./jobs/sales-report-ingest.job.js";
import { startForecastCron } from "./jobs/forecast.job.js";
import { startPricingCron } from "./jobs/pricing-refresh.job.js";
import { startCatalogRefreshCron } from "./jobs/catalog-refresh.job.js";
import { startEbayTokenRefreshCron } from "./jobs/ebay-token-refresh.job.js";
import { startEbayReturnsPollCron } from "./jobs/ebay-returns-poll.job.js";
import { startAmazonReturnsPollCron } from "./jobs/amazon-returns-poll.job.js";
import { startRefundRetryCron } from "./jobs/refund-retry.job.js";
import { startRefundDeadlineTrackerCron } from "./jobs/refund-deadline-tracker.job.js";
import { startAmazonOrdersCron } from "./jobs/amazon-orders-sync.job.js";
import { startEbayOrdersCron } from "./jobs/ebay-orders-sync.job.js";
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
import { startCycleCountSchedulerCron } from "./jobs/cycle-count-scheduler.job.js";
import { startAmazonMCFStatusCron } from "./jobs/amazon-mcf-status.job.js";
import { startFbaPanEuSyncCron } from "./jobs/fba-pan-eu-sync.job.js";
import { startFbaRestockCron } from "./jobs/fba-restock-ingestion.job.js";
import pricingRoutes from "./routes/pricing.routes.js";
// BullMQ worker bootstrapping is gated behind ENABLE_QUEUE_WORKERS=1.
// initializeQueue pings Redis and throws on failure; tryStartQueueWorkers
// catches that so a missing/unreachable Redis can't crash the API process
// (the HTTP routes still work, only the queue surface is dormant).
import { initializeBullMQWorker } from "./workers/bullmq-sync.worker.js";
import { initializeChannelSyncWorker } from "./workers/channel-sync.worker.js";
import { initializeBulkListWorker } from "./workers/bulk-list.worker.js";
import { initializeQueue, closeQueue } from "./lib/queue.js";
import { logger } from "./utils/logger.js";
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
    queueWorkersStarted = true;
    logger.info('✅ Queue workers started (BullMQ outbound-sync + channel-sync + bulk-list)');
  } catch (err) {
    logger.error('queue workers: initialization failed — HTTP routes still served, queue surface dormant', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const app = Fastify({ logger: true });

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
  origin: [
    'http://localhost:3000',
    'https://nexus-commerce-three.vercel.app',
    'https://nexus-commerce-web.vercel.app',
  ],
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
// S.0 / C-2 — listing-health.routes declares full /api/catalog/... paths
// internally, so register without a prefix. See DEVELOPMENT.md "Health
// endpoint conventions" for why /api/listings/health and
// /api/catalog/:productId/listing-health coexist as distinct concepts.
app.register(listingHealthRoutes);
app.register(outboundRoutes);
app.register(matrixRoutes);
app.register(inboundRoutes);
app.register(fbaInboundV2Routes, { prefix: '/api' });
app.register(webhookRoutes);
app.register(sendcloudWebhookRoutes);
app.register(ordersRoutes);
app.register(catalogSafeRoutes, { prefix: '/api/catalog' });
app.register(healthRoutes, { prefix: '/api' });
app.register(amazonRoutes, { prefix: '/api/amazon' });
app.register(marketplacesRoutes, { prefix: '/api' });
app.register(fulfillmentRoutes, { prefix: '/api' });
app.register(returnsRoutes, { prefix: '/api' });
app.register(stockRoutes, { prefix: '/api' });
app.register(brandSettingsRoutes, { prefix: '/api' });
app.register(pricingRoutes, { prefix: '/api' });
app.register(marketingRoutes, { prefix: '/api' });
app.register(productsRoutes, { prefix: '/api' });
app.register(categoriesRoutes, { prefix: '/api' });
app.register(listingWizardRoutes, { prefix: '/api' });
app.register(gtinExemptionRoutes, { prefix: '/api' });
app.register(listingContentRoutes, { prefix: '/api' });
app.register(terminologyRoutes, { prefix: '/api' });
app.register(bulkOperationsRoutes, { prefix: '/api' });
app.register(dashboardRoutes, { prefix: '/api' });
app.register(pimRoutes, { prefix: '/api' });
app.register(auditLogRoutes, { prefix: '/api' });
app.register(listingsSyndicationRoutes, { prefix: '/api' });
app.register(productsCatalogRoutes, { prefix: '/api' });
app.register(productsAiRoutes, { prefix: '/api' });
app.register(productsImagesRoutes, { prefix: '/api' });
app.register(listingImagesRoutes, { prefix: '/api' });
app.register(productTranslationsRoutes, { prefix: '/api' });
app.register(productRelationsRoutes, { prefix: '/api' });
app.register(forecastRoutes, { prefix: '/api' });
app.register(aiUsageRoutes, { prefix: '/api' });
app.register(savedViewAlertsRoutes, { prefix: '/api' });
// savedViewsRoutes register removed — see import comment above.
// /api/saved-views{,/...} is owned by products-catalog.routes.ts.
app.register(notificationsRoutes, { prefix: '/api' });
app.register(ordersReviewsRoutes, { prefix: '/api' });
app.register(connectionsRoutes, { prefix: '/api' });

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
    // Failure to reach Redis logs and continues — HTTP routes stay up.
    await tryStartQueueWorkers();

    // NN.14 / OO.1 — daily cron for abandoned wizard cleanup. Now
    // gated behind NEXUS_ENABLE_WIZARD_CLEANUP=1 so the destructive
    // path is opt-in. The cron only deletes DRAFT wizards whose
    // expiresAt is in the past (NULL expiresAt rows from before the
    // migration are excluded by the < operator), but until the
    // operator explicitly opts in we keep it dormant.
    if (process.env.NEXUS_ENABLE_WIZARD_CLEANUP === '1') {
      startWizardCleanupCron();
    }

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

    // G.1 + G.2 — Nightly FX refresh + snapshot recompute. Gated
    // separately so dev environments don't hit the pricing layer
    // before they're ready.
    if (process.env.NEXUS_ENABLE_PRICING_CRON === '1') {
      startPricingCron();
    }

    // Nightly Amazon catalog refresh. Mirrors GET /api/amazon/products
    // upsert + parent/child hierarchy logic on a 03:00 UTC schedule
    // (one hour after sales-report cron, to avoid SP-API throttle
    // collision). Gated behind NEXUS_ENABLE_CATALOG_SYNC_CRON=1.
    if (process.env.NEXUS_ENABLE_CATALOG_SYNC_CRON === '1') {
      startCatalogRefreshCron();
    }

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

    // FBA inventory polling — every 15 min, full SP-API
    // getInventorySummaries sweep, writes fulfillableQuantity into
    // Product.totalStock. SKUs absent from the response are NOT zeroed
    // (MFN inventory ledger preservation — see service comment).
    // Manual trigger: POST /api/amazon/inventory/sync.
    // Gated behind NEXUS_ENABLE_AMAZON_INVENTORY_CRON=1.
    if (process.env.NEXUS_ENABLE_AMAZON_INVENTORY_CRON === '1') {
      startAmazonInventoryCron();
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

    // S.17 — daily ABC-driven cycle-count scheduler. 02:30 UTC.
    // Picks up products whose cadence has elapsed (A=7d, B=30d,
    // C=90d, D=180d) and creates a DRAFT CycleCount session at
    // IT-MAIN with those items. Default-on; opt out via
    // NEXUS_ENABLE_CYCLE_COUNT_SCHEDULER=0.
    if (process.env.NEXUS_ENABLE_CYCLE_COUNT_SCHEDULER !== '0') {
      startCycleCountSchedulerCron();
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
