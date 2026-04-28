import "./db.js"; // ensure dotenv loads before anything else
import Fastify from "fastify";
import cors from "@fastify/cors";
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
import healthRoutes from "./routes/health.js";
import { startJobs } from "./jobs/sync.job.js";
import { initializeBullMQWorker } from "./workers/bullmq-sync.worker.js";
import { initializeChannelSyncWorker } from "./workers/channel-sync.worker.js";
import { bulkListWorker } from "./workers/bulk-list.worker.js";
import { initializeQueue, closeQueue } from "./lib/queue.js";
import { logger } from "./utils/logger.js";

const app = Fastify({ logger: true });

// Register CORS to allow cross-origin requests from frontend (Port 3000)
app.register(cors, {
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  credentials: true,
});

app.register(listingsRoutes);
app.register(inventoryRoutes);
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
app.register(syncRoutes);
app.register(ebayAuthRoutes);
app.register(ebayRoutes);
app.register(ebayOrdersRoutes);
app.register(catalogRoutes, { prefix: '/api/catalog' });
app.register(outboundRoutes);
app.register(matrixRoutes);
app.register(inboundRoutes);
app.register(webhookRoutes);
app.register(ordersRoutes);
app.register(healthRoutes, { prefix: '/api' });

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

async function start() {
  try {
    await app.listen({
      port: port,
      host: '0.0.0.0'
    });
    
    app.log.info(`API server listening at http://0.0.0.0:${port}`);

    // ── PHASE 13: Initialize BullMQ Infrastructure ──────────────────────
    // Initialize Redis connection and queue
    await initializeQueue();

    // Initialize the BullMQ Autopilot Worker (replaces node-cron)
    initializeBullMQWorker();

    // ── PHASE 25: Initialize Channel Sync Worker ──────────────────────
    // Initialize the channel-sync worker for marketplace sync execution
    initializeChannelSyncWorker();

    // ── Bulk Listing Worker ──────────────────────────────────────────
    // Initialize the bulk listing worker for sequential eBay publishing
    logger.info('Initializing bulk listing worker...');

    // Start the cron-based sync scheduler for other jobs
    startJobs();

    logger.info('✅ Autopilot infrastructure initialized', {
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    app.log.error(error);
    logger.error('❌ Failed to initialize Autopilot', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await closeQueue();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await closeQueue();
  process.exit(0);
});
