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
import { webhookRoutes } from "./routes/webhooks.routes.js";
import { ordersRoutes } from "./routes/orders.routes.js";
import { catalogSafeRoutes } from "./routes/catalog-safe.routes.js";
import healthRoutes from "./routes/health.js";
import amazonRoutes from "./routes/amazon.routes.js";
import marketplacesRoutes from "./routes/marketplaces.routes.js";
import fulfillmentRoutes from "./routes/fulfillment.routes.js";
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
import { startWizardCleanupCron } from "./jobs/wizard-cleanup.job.js";
// Queue/worker bootstrapping is gated behind ENABLE_QUEUE_WORKERS — Phase 2 will flip it on.
// import { startJobs } from "./jobs/sync.job.js";
// import { initializeBullMQWorker } from "./workers/bullmq-sync.worker.js";
// import { initializeChannelSyncWorker } from "./workers/channel-sync.worker.js";
// import { initializeBulkListWorker } from "./workers/bulk-list.worker.js";
// import { initializeQueue, closeQueue } from "./lib/queue.js";
import { logger } from "./utils/logger.js";

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
app.register(outboundRoutes);
app.register(matrixRoutes);
app.register(inboundRoutes);
app.register(webhookRoutes);
app.register(ordersRoutes);
app.register(catalogSafeRoutes, { prefix: '/api/catalog' });
app.register(healthRoutes, { prefix: '/api' });
app.register(amazonRoutes, { prefix: '/api/amazon' });
app.register(marketplacesRoutes, { prefix: '/api' });
app.register(fulfillmentRoutes, { prefix: '/api' });
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

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

async function start() {
  try {
    await app.listen({
      port: port,
      host: '0.0.0.0'
    });

    app.log.info(`API server listening at http://0.0.0.0:${port}`);

    // ── PHASE 13: Initialize BullMQ Infrastructure ──────────────────────
    // TEMPORARILY DISABLED - Phase 2 will re-enable workers
    // await initializeQueue();
    // initializeBullMQWorker();
    // initializeChannelSyncWorker();
    // initializeBulkListWorker();
    // startJobs();

    // NN.14 / OO.1 — daily cron for abandoned wizard cleanup. Now
    // gated behind NEXUS_ENABLE_WIZARD_CLEANUP=1 so the destructive
    // path is opt-in. The cron only deletes DRAFT wizards whose
    // expiresAt is in the past (NULL expiresAt rows from before the
    // migration are excluded by the < operator), but until the
    // operator explicitly opts in we keep it dormant.
    if (process.env.NEXUS_ENABLE_WIZARD_CLEANUP === '1') {
      startWizardCleanupCron();
    }

    logger.info('✅ API server initialized (workers disabled — Phase 2)', {
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
  // await closeQueue(); // re-enable in Phase 2 when workers are bootstrapped
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  // await closeQueue(); // re-enable in Phase 2 when workers are bootstrapped
  process.exit(0);
});
