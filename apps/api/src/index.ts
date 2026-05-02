import "./db.js"; // ensure dotenv loads before anything else
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
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
