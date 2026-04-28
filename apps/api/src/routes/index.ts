/**
 * Main Router Integration
 * Registers all route modules and middleware
 * 
 * Usage in apps/api/src/index.ts:
 * 
 * import { setupRoutes } from './routes.js';
 * 
 * const app = express();
 * app.use(express.json());
 * 
 * setupRoutes(app);
 */

import { Express } from 'express';
import { logger } from '../utils/logger.js';
import { errorHandler, notFoundHandler } from '../middleware/error-handler.js';

// Import route modules
import bulkActionsRouter from './bulk-actions.routes.js';
import pricingRulesRouter from './pricing-rules.routes.js';
import syncHealthRouter from './sync-health.routes.js';
import { matrixRoutes } from './matrix.routes.js';
import { ordersRoutes } from './orders.routes.js';
import attributeInheritanceRouter from './attribute-inheritance.routes.js';
import imagesRouter from './images.js';

/**
 * Setup all routes and middleware
 */
export async function setupRoutes(app: Express): Promise<void> {
  logger.info('Setting up API routes');

  // ============================================================================
  // API Routes
  // ============================================================================

  /**
   * Bulk Actions Routes
   * POST   /api/bulk-actions              - Create job
   * GET    /api/bulk-actions              - List pending jobs
   * GET    /api/bulk-actions/:id          - Get job status
   * POST   /api/bulk-actions/:id/process  - Start processing
   * POST   /api/bulk-actions/:id/cancel   - Cancel job
   * POST   /api/bulk-actions/:id/rollback - Create rollback job
   */
  app.use('/api/bulk-actions', bulkActionsRouter);
  logger.info('Registered bulk-actions routes');

  /**
   * Pricing Rules Routes
   * POST   /api/pricing-rules              - Create rule
   * GET    /api/pricing-rules              - List all rules
   * GET    /api/pricing-rules/variation/:variationId - Get rules for variation
   * POST   /api/pricing-rules/evaluate     - Evaluate price
   * PUT    /api/pricing-rules/:id          - Update rule
   * DELETE /api/pricing-rules/:id          - Deactivate rule
   */
  app.use('/api/pricing-rules', pricingRulesRouter);
  logger.info('Registered pricing-rules routes');

  /**
   * Sync Health Routes
   * GET    /api/sync-health/:channel/score           - Get health score
   * GET    /api/sync-health/conflicts                - Get unresolved conflicts
   * GET    /api/sync-health/conflicts?channel=X      - Get conflicts for channel
   * POST   /api/sync-health/log                      - Log error
   * GET    /api/sync-health/errors/:channel          - Get recent errors
   * POST   /api/sync-health/conflicts/:id/resolve    - Resolve conflict
   * GET    /api/sync-health/summary                  - Get all channel scores
   */
  app.use('/api/sync-health', syncHealthRouter);
  logger.info('Registered sync-health routes');

  /**
   * Matrix Routes (Phase 9)
   * GET    /api/products/:id/matrix                    - Get complete product matrix
   * POST   /api/products/:id/matrix/channel-listing    - Create channel listing
   * PUT    /api/products/:id/matrix/channel-listing/:listingId - Update channel listing
   * POST   /api/products/:id/matrix/offer              - Create offer
   * PUT    /api/products/:id/matrix/offer/:offerId     - Update offer
   * DELETE /api/products/:id/matrix/offer/:offerId     - Delete offer
   */
  await matrixRoutes(app as any);
  logger.info('Registered matrix routes');

  /**
   * Orders Routes (Phase 26)
   * POST   /api/orders/ingest              - Trigger mock order ingestion
   * GET    /api/orders                     - Fetch all orders with pagination
   * PATCH  /api/orders/:id/ship            - Update order status to SHIPPED
   */
  await ordersRoutes(app as any);
  logger.info('Registered orders routes');

  /**
   * Attribute Inheritance Routes (Phase 30)
   * POST   /api/attributes/sync-parent     - Sync parent attributes to children
   * POST   /api/attributes/lock            - Toggle attribute lock
   * GET    /api/attributes/locked/:id      - Get locked attributes
   * POST   /api/attributes/bulk-lock       - Bulk toggle locks
   */
  app.use('/api/attributes', attributeInheritanceRouter);
  logger.info('Registered attribute-inheritance routes');

  /**
   * Images Routes (Phase 31)
   * POST   /api/images/upload                    - Upload image
   * GET    /api/images/:productId                - Get product images
   * PUT    /api/images/:imageId/hero             - Set hero image
   * PUT    /api/images/:imageId/color            - Update color override
   * DELETE /api/images/:imageId                  - Delete image
   * POST   /api/images/:productId/auto-assign    - Auto-assign to variants
   * POST   /api/images/:imageId/assign-variants  - Manually assign variants
   * GET    /api/images/:imageId/assigned-variants - Get assigned variants
   * GET    /api/images/:productId/by-color/:color - Get images by color
   * POST   /api/images/analyze-color            - Analyze image color
   */
  app.use('/api/images', imagesRouter);
  logger.info('Registered images routes');

  // ============================================================================
  // Error Handling Middleware (Must be last)
  // ============================================================================

  /**
   * 404 Not Found Handler
   * Catches requests to undefined routes
   */
  app.use(notFoundHandler);
  logger.info('Registered 404 not found handler');

  /**
   * Global Error Handler
   * Catches all unhandled exceptions and formats them consistently
   * Must be registered last in the middleware stack
   */
  app.use(errorHandler);
  logger.info('Registered global error handler');

  logger.info('API routes setup completed successfully');
}

/**
 * Route Documentation
 *
 * All endpoints follow these patterns:
 * - Success responses include data and metadata
 * - Error responses include error code, message, and optional details
 * - All responses include ISO 8601 timestamp
 *
 * HTTP Status Codes:
 * - 200 OK: Successful GET/PUT request
 * - 201 Created: Successful POST request creating a resource
 * - 400 Bad Request: Invalid request parameters or validation error
 * - 404 Not Found: Resource not found
 * - 500 Internal Server Error: Unhandled server error
 *
 * All requests are validated using Zod schemas from ./validation.ts
 * All responses are formatted using helpers from ./response.ts
 * All errors are logged using the logger utility
 */

export default setupRoutes;
