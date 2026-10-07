
import { legacyIngress } from './lib/workspace-ingress.js'
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
import cookie from "@fastify/cookie";
import { ALLOWED_WEB_ORIGINS } from "./lib/cors-origins.js";
import { apiContentSecurityPolicy } from './lib/api-content-security-policy.js'
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { listingsRoutes } from "./routes/listings.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { aiRoutes } from "./routes/ai.js";
import { adminRoutes } from "./routes/admin.js";
import { monitoringRoutes } from "./routes/monitoring.js";
import { shopifyWebhookRoutes } from "./routes/shopify-webhooks.js";
import etsyWebhookRoutes from "./routes/etsy-webhooks.routes.js";
import { estyRoutes } from "./routes/etsy.js";
import { syncRoutes } from "./routes/sync.routes.js";
import { ebayAuthRoutes } from "./routes/ebay-auth.js";
import { ebayRoutes } from "./routes/ebay.routes.js";
import { ebayOrdersRoutes } from "./routes/ebay-orders.routes.js";
import { catalogRoutes } from "./routes/catalog.routes.js";
import { outboundRoutes } from "./routes/outbound.routes.js";
import { matrixRoutes } from "./routes/matrix.routes.js";
// F.4 (P0 #50) — v2024-03-20 SP-API inbound flow.
import fbaInboundV2Routes from "./routes/fba-inbound-v2.routes.js";
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
import ebayDescriptionThemesRoutes from "./routes/ebay-description-themes.routes.js";
import ebayDescriptionPushRoutes from "./routes/ebay-description-push.routes.js";
import ebayCockpitRoutes from "./routes/ebay-cockpit.routes.js";
import ebayVolumePricingRoutes from "./routes/ebay-volume-pricing.routes.js";
import flatFilePullHistoryRoutes from "./routes/flat-file-pull-history.routes.js";
import flatFileUnifiedRoutes from "./routes/flat-file-unified.routes.js";
import flatFileImportRoutes from "./routes/flat-file-import.routes.js";
import marketplacesRoutes from "./routes/marketplaces.routes.js";
import fulfillmentRoutes from "./routes/fulfillment.routes.js";
import returnsRoutes from "./routes/returns.routes.js";
import stockRoutes from "./routes/stock.routes.js";
import stockCasesRoutes from "./routes/stock-cases.routes.js";
import brandSettingsRoutes from "./routes/brand-settings.routes.js";
import settingsAuditRoutes from "./routes/settings-audit.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import workspacesRoutes from "./routes/workspaces.routes.js";
import { workspaceHook } from "./lib/workspace-hook.js";
import workspaceInvitationsRoutes from './routes/workspace-invitations.routes.js';
import settingsWebhooksRoutes from "./routes/settings-webhooks.routes.js";
import settingsPrivacyRoutes from "./routes/settings-privacy.routes.js";
import marketingRoutes from "./routes/marketing.routes.js";
import marketingOsRoutes from "./routes/marketing-os.routes.js";
import ebayAdsRoutes from "./routes/ebay-ads.routes.js";
import advertisingRoutes from "./routes/advertising.routes.js";
import advertisingIntelRoutes from "./routes/advertising-intel.routes.js";
import automationSwitchRoutes from "./routes/automation-switch.routes.js";
import advertisingStrategyRoutes from "./routes/advertising-strategy.routes.js";
import advertisingPlaybookRoutes from "./routes/advertising-playbook.routes.js";
// KT.6 — the Keyword Tracker's action endpoints. A separate file: see its header.
import keywordActionsRoutes from "./routes/keyword-actions.routes.js";
import advertisingAiRoutes from "./routes/advertising-ai.routes.js";
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
import productCreateRoutes from "./routes/product-create.routes.js";
import productsBulkSaveRoutes from "./routes/products-bulk-save.routes.js";
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
import taxonomyRoutes from "./routes/taxonomy.routes.js";
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
import productsSheetRoutes from "./routes/products-sheet.routes.js";
import productStudioRoutes from "./routes/product-studio.routes.js";
import publicationHistoryRoutes from "./routes/publication-history.routes.js";
import publicationBatchRoutes from "./routes/publication-batches.routes.js";
import listingActionRoutes from "./routes/listing-actions.routes.js";
import sheetDeleteRowsRoutes from "./routes/sheet-delete-rows.routes.js";
import channelIdRoutes from "./routes/channel-id.routes.js";
import publishActionRoutes from "./routes/publish-actions.routes.js";
import liveReadRoutes from "./routes/live-read.routes.js"; // PE — read what a channel holds live (read only)
import studioMatrixRoutes from "./routes/studio-matrix.routes.js"; // MX.1 — the Matrix page
import catalogTransferRoutes from "./routes/catalog-transfer.routes.js";
import sheetTransferRoutes from "./routes/sheet-transfer.routes.js";
import catalogMatrixRoutes from "./routes/catalog-matrix.routes.js";
import pimMappingRoutes from "./routes/pim-mapping.routes.js";
import channelMappingRoutes from "./routes/channel-mapping.routes.js"; // PES.6
import cellFormulaRoutes from "./routes/cell-formula.routes.js"; // PES.6 wave-4
import valueMapRoutes from "./routes/value-map.routes.js";
import mappingPropagationRoutes from "./routes/mapping-propagation.routes.js";
import auditLogRoutes from "./routes/audit-log.routes.js";
import syncLogsRoutes from "./routes/sync-logs.routes.js";
import { listingsSyndicationRoutes } from "./routes/listings-syndication.routes.js";
import { listingHealthRoutes } from "./routes/listing-health.routes.js";
import { fieldLinksRoutes } from "./routes/field-links.routes.js";
import productsCatalogRoutes from "./routes/products-catalog.routes.js";
import { delistCascadeRoutes } from "./routes/delist-cascade.routes.js";
import productsSearchRoutes from "./routes/products-search.routes.js";
import productsAiRoutes from "./routes/products-ai.routes.js";
import { productEnrichmentAiRoutes, productAiDraftRoutes } from "./routes/product-enrichment.routes.js";
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
import agentFleetRoutes from "./routes/agent-fleet.routes.js";
import agentFleetTimelineRoutes from "./routes/agent-fleet-timeline.routes.js";
import agentFleetWorkflowRoutes from "./routes/agent-fleet-workflows.routes.js";
import agentFleetWorkerRoutes from "./routes/agent-fleet-workers.routes.js";
import agentFleetApprovalRoutes from "./routes/agent-fleet-approvals.routes.js";
import approvalQueueRoutes from "./routes/approval-queue.routes.js";
import agentFleetAssignmentRoutes from "./routes/agent-fleet-assignments.routes.js";
import agentFleetMapRoutes from "./routes/agent-fleet-map.routes.js";
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
// MAP.0/MAP.1 — uncollapsed account list + the single-account diagnostics proof.
import accountsRoutes from "./routes/accounts.routes.js";
import assortmentsRoutes from "./routes/assortments.routes.js";
import stockPoolRoutes from "./routes/stock-pool.routes.js";
// CX.1 — connection core, plus the other registries every process shares.
import "./runtime/registrations.js";
import cxConnectRoutes from "./routes/cx-connect.routes.js";
import cxConnectionsRoutes from "./routes/cx-connections.routes.js";
import { seedChannelApps } from "./services/cx/apps.service.js";
import { jobMonitorRoutes } from "./routes/job-monitor.routes.js";
import reconciliationRoutes from "./routes/reconciliation.routes.js";
import ebayPhase3Routes from "./routes/ebay-phase3.routes.js";
import amazonNotificationsRoutes from "./routes/amazon-notifications.routes.js";
import ebayNotificationRoutes from "./routes/ebay-notification.routes.js";
// P5.1 verification — ONE read-only live Orders 2026-01-01 call, at the Owner's yes.
import amazonOrders2026ProbeRoutes from "./routes/amazon-orders-2026-probe.routes.js";
import connectionDependentsRoutes from "./routes/connection-dependents.routes.js";
import amazonListingAsinRoutes from "./routes/amazon-listing-asin.routes.js";
import shopifyShadowReportRoutes from "./routes/shopify-shadow-report.routes.js";
import pushHealthRoutes from "./routes/push-health.routes.js";
import pushLatencyRoutes from "./routes/push-latency.routes.js";
import outboundLatencyRoutes from "./routes/outbound-latency.routes.js";
import inventorySyncDiagnosticsRoutes from "./routes/inventory-sync-diagnostics.routes.js";
import syncControlRoutes from "./routes/sync-control.routes.js";
import controlTowerRoutes from "./routes/control-tower.routes.js";
import { getAmazonPublishMode } from "./services/amazon-publish-gate.service.js";
import { getEbayPublishMode } from "./services/ebay-publish-gate.service.js";
import { getShopifyPublishMode } from "./services/shopify-publish-gate.service.js";
import pricingRoutes from "./routes/pricing.routes.js";
import pricingRulesRoutes from "./routes/pricing-rules.routes.js";
// Phase S1 (auth core) — human authentication endpoints.
import authRoutes from "./routes/auth.routes.js";
import mfaRoutes from "./routes/mfa.routes.js";
import oauthRoutes from './routes/oauth.routes.js';
import oauthGrantsRoutes from './routes/oauth-grants.routes.js';
import claudeControlRoutes from './routes/claude-control.routes.js';
import mcpRoutes from './routes/mcp.routes.js';
import teamRoutes from "./routes/team.routes.js";
// Phase S2 (RBAC engine) — the one global permission gate (shadow/enforce).
import { rbacHook } from "./lib/auth/rbac-hook.js";
// Phase S2 (RBAC engine) — field-level financial stripping (enforce mode).
import { financialFilterHook } from "./lib/auth/field-filter.js";
// Phase S2 (RBAC engine) — converge system roles on boot.
import { seedSystemRoles } from "./services/team-access.service.js";
import { closeQueue } from "./lib/queue.js";
import { closeBroker } from './lib/events/index.js';
import { logger } from "./utils/logger.js";
// EV.1 — outbox relay + cross-replica event fan-out.
import { startEventInfrastructure, stopEventInfrastructure } from "./workers/event-relay.worker.js";
// PH.3 — the read-only product graph at /graphql.
import { registerProductGraph } from "./graph/index.js";
import prisma from "./db.js";
import { registerCommandIdempotency } from './lib/command-idempotency.js';
import { endEventStreamsOnClose } from './lib/sse.js';
import { installStockPoolRefusalReplies } from './lib/stock-pool-refusal.js';
import { markProcessReady } from './lib/runtime-status/process-snapshot.js';
import { startRuntimeStatusPublisher } from './services/runtime-status/publisher.service.js';

process.env.NEXUS_PROCESS_ROLE = 'api';
let stopRuntimeStatus: (() => Promise<void>) | undefined;



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
    // A disconnected grant is still authoritative history. Recreating an env
    // account on restart would silently undo the operator's disconnect.
    const existingOauth = await prisma.channelConnection.findFirst({
      where: { channelType: "AMAZON", managedBy: "oauth" },
      select: { id: true },
    });
    if (existingOauth) {
      logger.info(
        "seedEnvManagedConnections: persisted Amazon authorization exists — skipping env synthesis",
        { existingId: existingOauth.id },
      );
      return;
    }

    // P6.6 — with the env token retired, do not synthesise a row that depends on it.
    // D1 = A puts the grant in the connection core; an env row created at boot is a
    // credential nothing can revoke, rotate or date.
    if (process.env.NEXUS_AMAZON_ENV_TOKEN === "off") {
      logger.info(
        "seedEnvManagedConnections: the environment refresh token is retired (NEXUS_AMAZON_ENV_TOKEN=off) — not synthesising an Amazon row",
      );
      return;
    }

    const existingEnv = await prisma.channelConnection.findFirst({
      where: { channelType: "AMAZON", managedBy: "env" },
      select: { id: true },
    });

    // CX.1 — no more `lastSyncStatus: "SUCCESS"` stamped at boot (audit S-honesty):
    // the row starts `unknown` and the heartbeat decides within a minute of boot.
    const data = {
      channelType: "AMAZON",
      marketplace: null,
      managedBy: "env",
      isActive: amazonConfigured,
      displayName: sellerId,
      region: "EU",
      authStatus: amazonConfigured ? "unknown" : "disconnected",
      lastSyncError: amazonConfigured
        ? null
        : "Amazon credentials not configured (AMAZON_LWA_* and AWS_* env vars required)",
    };

    if (existingEnv) {
      // CX.1 set `authStatus` here too, so every deploy reset a CONNECTED row to
      // 'unknown' and the page said "Not yet checked" about a connection the
      // heartbeat had verified minutes earlier. A process restart is not new
      // information about Amazon: the seed may say whether credentials are
      // CONFIGURED, but only a real call may say whether they WORK. On update it
      // therefore writes everything except the auth verdict — and still says
      // 'disconnected' when the credentials have gone, because that IS something
      // boot can know.
      const { authStatus, ...updatable } = data;
      await prisma.channelConnection.update({
        where: { id: existingEnv.id },
        data: amazonConfigured ? updatable : { ...updatable, authStatus },
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

// trustProxy: 1 — the API sits behind Railway's edge proxy (one hop), so
// without this req.ip is the proxy's address (identical for every client),
// which would collapse the per-IP login throttle into one shared bucket
// and record a useless IP on every audit/session row. `1` (not `true`)
// trusts exactly one hop so X-Forwarded-For cannot be spoofed to bypass
// the throttle. (Phase S1 auth core — review finding H2.)
const app = Fastify({ logger: true, trustProxy: 1 });

// Phase S2 (RBAC engine) — record every registered route so the
// rbac-coverage check can prove deny-by-default: every route must resolve
// to a permission in the manifest. onRoute fires as each plugin registers.
export const REGISTERED_ROUTES: { method: string; url: string }[] = [];
app.addHook('onRoute', (r) => {
  const methods = Array.isArray(r.method) ? r.method : [r.method];
  for (const m of methods) REGISTERED_ROUTES.push({ method: String(m), url: r.url });
});
export { app };

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

// Phase S1 (auth core) — security headers on every response (S0 finding
// F9). Conservative + safe for a JSON/file API: browsers ignore CSP on
// non-HTML responses, so downloads (PDF/CSV/ZIP) are unaffected, while
// any HTML error page is locked down. HSTS pins TLS; nosniff blocks MIME
// sniffing; frame denial blocks clickjacking.
/**
 * ACR.4.2 — routes that render an EMAIL for the operator to look at.
 *
 * These return our own generated HTML whose entire meaning is carried by inline `style`
 * attributes, and `default-src 'none'` blocks every one of them. Measured: the weekly-digest
 * preview served 101 inline styles and the browser applied zero, so the operator clicking
 * "Preview" saw an unstyled wall of text and would reasonably conclude the digest was broken.
 * The mail itself is fine — no CSP reaches an inbox — so the preview was lying about the
 * product, which is the one thing a preview must never do.
 *
 * `style-src 'unsafe-inline'` is added for these paths ONLY. Everything else stays denied:
 * no scripts, no images, no fonts, no connections, no framing. The payload is server-generated
 * from our own template with every interpolation escaped.
 */
app.addHook('onSend', (request, reply, payload, done) => {
  // DEV-ONLY instrumentation. Cross-origin Resource Timing reads back zeroed
  // without this, so a browser-side lane cannot measure what a request spent
  // where — it is what makes that question answerable at all.
  //
  // BOTH gates, and the env flag is not redundant with NODE_ENV: this API runs
  // in contexts where NODE_ENV is not reliably 'production' (a staging box, a
  // container with the var unset, a `railway run` shell). A missing variable
  // must produce "no header", never "header on production" — so enabling it is
  // the deliberate act, not disabling it.
  //
  //   run recipe: NEXUS_ENABLE_TIMING_ALLOW_ORIGIN=1 on the dev API only
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.NEXUS_ENABLE_TIMING_ALLOW_ORIGIN === '1'
  ) {
    reply.header('Timing-Allow-Origin', '*')
  }
  reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('X-Frame-Options', 'DENY')
  reply.header('Referrer-Policy', 'no-referrer')
  // Set here rather than in the route: this hook runs AFTER the handler, so a header the
  // handler sets would be silently overwritten.
  reply.header('Content-Security-Policy', apiContentSecurityPolicy(request.url ?? '', reply))
  done(null, payload)
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

// Phase S1 (auth core) — cookie parsing/signing. Must register before
// any route reads request.cookies / writes reply.setCookie (the auth
// session + CSRF cookies). No global secret needed: session/CSRF tokens
// are opaque random values validated against the DB, not signed cookies.
app.register(cookie);

// Phase S2 (RBAC engine) — global permission gate. Added BEFORE the route
// plugins so Fastify applies it to every one of them. Deny-by-default via
// the route→permission manifest; runs in shadow mode (log-only) until S3
// flips NEXUS_RBAC_MODE=enforce. Registered as a preHandler so it sits
// after body parsing and can read cookies / short-circuit with a reply.
app.addHook('preHandler', workspaceHook);
app.addHook('preHandler', rbacHook);

// Phase S2 (RBAC engine) — strip restricted financial fields from every
// JSON response for callers without the matching financials.* permission.
// preSerialization runs on the raw object (so nested JSON blobs are covered
// too) and is a no-op in shadow mode. SSE + export writers bypass this and
// call filterFinancialPayload() directly (S2 follow-up).
app.addHook('preSerialization', financialFilterHook);
// Shared stock by SKU (Owner D1, 2026-10-01): a rename or delete of a product that shares stock is refused by the
// database; reply 409 with its sentence ("… Disconnect it first …"). Every other error goes on to the default handler.
installStockPoolRefusalReplies(app);
// Before the routes: open event streams end when shutdown starts (lib/sse.ts).
endEventStreamsOnClose(app);
// After the workspace and RBAC hooks (a replay is served only to callers they
// admit) and after the financial filter (a receipt stores the filtered response).
registerCommandIdempotency(app);

// HTTP routes — all queue references are lazy (see lib/queue.ts), so registering
// these does not open Redis connections. Workers/jobs remain disabled (Phase 2).
// Phase S1 (auth core) — auth endpoints declare full /api/auth/* paths
// inline, so register without a prefix. Protects only its own surface;
// the deny-by-default sweep over the rest of the API is S2.
app.register(authRoutes);
// Phase S5 — self-service TOTP 2FA (/api/auth/2fa/*).
app.register(mfaRoutes);
// MCP.5 — OAuth 2.1 for connecting Claude (/api/oauth/*). 404 unless NEXUS_MCP_ENABLED=1.
app.register(oauthRoutes);
// MCP.6 — Connected apps: a person's own Claude connections and a business's, and revoking them.
app.register(oauthGrantsRoutes, { prefix: '/api' });
// MCP full control C5 — how far Claude may go without a person in a business: levels, limits, Pause, the daily cap.
app.register(claudeControlRoutes, { prefix: '/api' });
// MCP.7 — the /mcp endpoint Claude connects to (+ its RFC 9728 document). 404 unless NEXUS_MCP_ENABLED=1.
app.register(mcpRoutes);
app.register(workspaceInvitationsRoutes);
// Phase S4 — Team & Access API (/api/team/*), gated by the RBAC manifest.
app.register(teamRoutes);
app.register(listingsRoutes);
app.register(inventoryRoutes, { prefix: '/api' });
app.register(aiRoutes);
app.register(adminRoutes);
app.register(monitoringRoutes);
app.register(shopifyWebhookRoutes);
// P2.5 — Etsy's receiver. There was no Etsy webhook route at all, and the only Etsy
// order code in the repository has no call site, so no Etsy order has ever entered
// Nexus by any path. Etsy configures webhooks in its portal, not by API, so nothing
// arrives until the Owner points it here and sets ETSY_WEBHOOK_SIGNING_SECRET.
app.register(etsyWebhookRoutes);
app.register(estyRoutes);
app.register(syncRoutes, { prefix: '/api' });
app.register(ebayAuthRoutes);
app.register(ebayRoutes);
app.register(ebayOrdersRoutes);
app.register(catalogRoutes, { prefix: '/api/catalog' });
// PH.3 — mercurius at /graphql. Registered with the routes so it sits inside
// the same global hooks: the rbac preHandler gates it, and the financial
// preSerialization filter strips restricted fields from its replies.
registerProductGraph(app);
app.register(catalogOrganizeRoutes, { prefix: '/api/catalog' });
// S.0 / C-2 — listing-health.routes declares full /api/catalog/... paths
// internally, so register without a prefix. See DEVELOPMENT.md "Health
// endpoint conventions" for why /api/listings/health and
// /api/catalog/:productId/listing-health coexist as distinct concepts.
app.register(listingHealthRoutes);
app.register(fieldLinksRoutes);
app.register(outboundRoutes);
app.register(matrixRoutes);
app.register(fbaInboundV2Routes, { prefix: '/api' });
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
app.register(ebayDescriptionThemesRoutes, { prefix: '/api' }); // ED — dynamic description themes
app.register(ebayDescriptionPushRoutes, { prefix: '/api' }); // ED v2 P4a — description-only push (both lanes) + parity read-back
app.register(ebayCockpitRoutes, { prefix: '/api' });
app.register(ebayVolumePricingRoutes, { prefix: '/api' });
app.register(flatFilePullHistoryRoutes, { prefix: '/api' });
app.register(flatFileUnifiedRoutes, { prefix: '/api' });
app.register(flatFileImportRoutes, { prefix: '/api' }); // FF2.8b
app.register(marketplacesRoutes, { prefix: '/api' });
app.register(fulfillmentRoutes, { prefix: '/api' });
app.register(returnsRoutes, { prefix: '/api' });
app.register(stockRoutes, { prefix: '/api' });
app.register(stockCasesRoutes, { prefix: '/api' }); // Step 3 — PUT /api/stock/case-packs (case size, dims, FBA prep/label owner)
app.register(brandSettingsRoutes, { prefix: '/api' });
app.register(settingsAuditRoutes, { prefix: '/api' });
app.register(profileRoutes, { prefix: '/api' });
app.register(workspacesRoutes, { prefix: '/api' });
app.register(settingsWebhooksRoutes, { prefix: '/api' });
app.register(settingsPrivacyRoutes, { prefix: '/api' });
app.register(pricingRoutes, { prefix: '/api' });
app.register(pricingRulesRoutes, { prefix: '/api' });
app.register(marketingRoutes, { prefix: '/api' });
app.register(marketingOsRoutes, { prefix: '/api' });
app.register(ebayAdsRoutes, { prefix: '/api' }); // E3 eBay ads console (reads)
app.register(advertisingRoutes, { prefix: '/api' });
// R16 — a person's per-business engine switch, from the Control Room lever drawer.
app.register(automationSwitchRoutes, { prefix: '/api' });
app.register(advertisingStrategyRoutes, { prefix: '/api' });
app.register(advertisingPlaybookRoutes, { prefix: '/api' });
app.register(advertisingIntelRoutes, { prefix: '/api' });
app.register(keywordActionsRoutes, { prefix: '/api' });
app.register(advertisingAiRoutes, { prefix: '/api' }); // AIAD — AI Advertising goal wiring
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
app.register(productCreateRoutes, { prefix: '/api' }); // the Products page's "New product" dialog: one DRAFT product
app.register(productsBulkSaveRoutes, { prefix: '/api' }); // one sheet operation (fill, paste, undo) = one request, one transaction
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
app.register(taxonomyRoutes, { prefix: '/api' });
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
// MS.1/MS.2 — the master sheet's reads (docs/2026-08-29-master-sheet-design.md).
app.register(productsSheetRoutes, { prefix: '/api' });
// PES.5 — the Product Edit Studio's reads. Under /api/products, so the RBAC
// prefix rule maps GET->products:view and writes->products:edit automatically.
app.register(productStudioRoutes, { prefix: '/api' });
// Sheet publish parity, step 4 — the publish history: /api/publications (products.view; the exact request is products.publish).
app.register(publicationHistoryRoutes, { prefix: '/api' });
// Sheet publish parity, step 5 — one family to several destinations in one action: /api/publication-batches (products.publish).
app.register(publicationBatchRoutes, { prefix: '/api' });
// Sheet publish parity, step 7 — the Status column: /api/products/:id/listing-actions (state: products.view; pause/resume/relist: products.publish; end: products.delete).
app.register(listingActionRoutes, { prefix: '/api' });
// Delete rows from the product sheet (Owner 2026-10-06): /api/products/:id/sheet-rows/{delete/preview,delete/run,restore} (preview: products.view; run, restore: products.delete).
app.register(sheetDeleteRowsRoutes, { prefix: '/api' });
// Item ID control (step I1) — the sheet's eBay Item ID cell: /api/listings/:id/channel-id/{check,link,unlink} (listings.recover).
app.register(channelIdRoutes, { prefix: '/api' });
// Build shape v2 — the waiting Action and Status values: /api/products/:id/studio/publish-actions (read: products.view; send/delete and status/ended: products.delete; the rest: products.publish).
app.register(publishActionRoutes, { prefix: '/api' });
// PE — GET /api/products/:id/live-read: what the channel holds right now (read only; products:view by the prefix rule).
app.register(liveReadRoutes, { prefix: '/api' });
// MX.1 — the Matrix page's read, write door, verbs and revert (explicit manifest entry, most-specific-first).
app.register(studioMatrixRoutes, { prefix: '/api' });
app.register(catalogTransferRoutes, { prefix: '/api' });
// PSIE — the product sheet's Export and Import (one engine, two buttons).
app.register(sheetTransferRoutes, { prefix: '/api' });
app.register(catalogMatrixRoutes, { prefix: '/api' });
app.register(pimMappingRoutes, { prefix: '/api' });
app.register(channelMappingRoutes, { prefix: '/api' }); // PES.6 — global mapping engine
app.register(cellFormulaRoutes, { prefix: '/api' }); // PES.6 wave-4 — cell formulas + master rules
app.register(valueMapRoutes, { prefix: '/api' });
app.register(mappingPropagationRoutes, { prefix: '/api' });
app.register(auditLogRoutes, { prefix: '/api' });
app.register(syncLogsRoutes, { prefix: '/api' });
app.register(listingsSyndicationRoutes, { prefix: '/api' });
app.register(productsCatalogRoutes, { prefix: '/api' });
app.register(delistCascadeRoutes, { prefix: '/api' });
app.register(productsSearchRoutes, { prefix: '/api' });
app.register(productsAiRoutes, { prefix: '/api' });
// PES.8 — generation resolves to ai:run via pfx('/api/ai/'); draft review/approve
// resolves to products:view/products:edit via pfx('/api/products').
app.register(productEnrichmentAiRoutes, { prefix: '/api' });
app.register(productAiDraftRoutes, { prefix: '/api' });
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
app.register(agentFleetRoutes, { prefix: '/api' });
app.register(agentFleetTimelineRoutes, { prefix: '/api' });
app.register(agentFleetWorkflowRoutes, { prefix: '/api' });
app.register(agentFleetWorkerRoutes, { prefix: '/api' });
app.register(agentFleetApprovalRoutes, { prefix: '/api' });
app.register(approvalQueueRoutes, { prefix: '/api' });
app.register(agentFleetAssignmentRoutes, { prefix: '/api' });
app.register(agentFleetMapRoutes, { prefix: '/api' });
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
app.register(accountsRoutes, { prefix: '/api' });
// AE.2 — assortments and assortment shares between business profiles.
app.register(assortmentsRoutes, { prefix: '/api' });
// Shared stock between business profiles (plan 2026-09-19): the profile switch and the product switch.
app.register(stockPoolRoutes, { prefix: '/api' });
app.register(cxConnectRoutes, { prefix: '/api' });
app.register(cxConnectionsRoutes, { prefix: '/api' });
app.register(reconciliationRoutes, { prefix: '/api' });
app.register(ebayPhase3Routes, { prefix: '/api' });
// IS.2 — real-time cross-channel inventory sync routes
app.register(amazonNotificationsRoutes, { prefix: '/api' });
app.register(ebayNotificationRoutes, { prefix: '/api' });
app.register(amazonOrders2026ProbeRoutes, { prefix: '/api' });
app.register(connectionDependentsRoutes, { prefix: '/api' });
app.register(amazonListingAsinRoutes, { prefix: '/api' });
// Shopify orders shadow report — read-only counts before order ingest (NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT=1).
app.register(shopifyShadowReportRoutes, { prefix: '/api' });
// RT.1 — unified push-health endpoint feeds the PushHealthChip on
// /orders + /insights/live.
app.register(pushHealthRoutes, { prefix: '/api' });
// RT.3 — push-latency dashboard (p50/p95/p99 + histogram per source).
app.register(pushLatencyRoutes, { prefix: '/api' });
// Phase 0 — outbound push-latency dashboard (complement to RT.3).
app.register(outboundLatencyRoutes, { prefix: '/api' });
// Phase 0 — consolidated inventory-sync diagnostics.
app.register(inventorySyncDiagnosticsRoutes, { prefix: '/api' });
app.register(syncControlRoutes, { prefix: '/api' });
// Phase 6 Task 2 — control-tower aggregation + delta-preview.
app.register(controlTowerRoutes, { prefix: '/api' });
// RT.11 — Shopify webhook registration helper. POST /api/admin/
// setup-shopify-webhooks registers every topic our handlers
// listen for so push delivery is no longer a manual partner-dashboard
// step.
// L.0d — BullMQ admin endpoints. Routes declare full /api/monitoring/...
// paths inline, so register without a prefix. Coexists with
// monitoringRoutes (which uses /monitoring/* without /api/).
app.register(jobMonitorRoutes);

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

async function start() {
  try {
    // ── Bind host ────────────────────────────────────────────────
    // Default is UNCHANGED ('0.0.0.0'), so every deployed environment binds
    // exactly as before. The override exists for local browser verification:
    // `localhost` resolves to ::1 (IPv6) BEFORE 127.0.0.1 on macOS, and Chrome
    // honours that order, so it reaches for ::1 where an IPv4-only bind is not
    // listening. Measured here: with host '0.0.0.0' a direct IPv6 request to ::1
    // gets ECONNREFUSED; with '::' it gets HTTP 200. curl and node fall back to
    // IPv4 silently, so in-process probes and curl checks all passed — while
    // Chrome stalled rather than falling back (PES.3 measured the hang in-page),
    // which is what timed out every browser pass and the grid:conformance
    // networkidle gate.
    //
    // `NEXUS_API_HOST=::` binds dual-stack so both families answer.
    const host = process.env.NEXUS_API_HOST ?? '0.0.0.0';
    await app.listen({
      port: port,
      host,
    });

    // Report the host actually bound, not the default — a log line that says
    // 0.0.0.0 while listening on :: is the kind of small lie that costs an hour.
    app.log.info(`API server listening at http://${host}:${port}`);

    // ── Seed env-managed ChannelConnection rows (H.2 Phase 2) ──────
    // Amazon SP-API today is single-tenant via process.env.AMAZON_*
    // and AWS_*. Until P2-2 ships per-account LWA OAuth, we keep the
    // synthetic representation in ChannelConnection so the rest of
    // the codebase can FK to it and the connections endpoint can
    // read uniformly. Idempotent: upsert keyed on (channelType,
    // managedBy='env').
    await legacyIngress(() => seedEnvManagedConnections());
    // CX.1 — our per-channel app credentials become rows (once), so connection rows never carry them.
    await seedChannelApps().catch((err) =>
      logger.error("seedChannelApps failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) }),
    );

    // Phase S2 (RBAC engine) — converge the six system roles to the
    // registry on every boot (idempotent, prod-safe). Runs here (post-
    // listen) so a DB blip never blocks HTTP startup. No version bump —
    // that's the manual seed-roles script — to avoid re-resolving every
    // user's permissions on each deploy.
    try {
      await seedSystemRoles();
    } catch (err) {
      logger.warn('seedSystemRoles failed on boot (non-fatal; retry via script)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // IM.3.2 — close any stock-import job left in APPLYING by a restart
    // mid-apply. Committed chunks are durable; the row finalizes as PARTIAL
    // with an honest summary. Fire-and-forget: never blocks startup.
    void import('./services/stock-import.service.js')
      .then((m) => m.recoverStuckImportJobs())
      .catch((err) => {
        logger.warn('stock-import stuck-job sweep failed on boot (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

    // Every HTTP replica needs broadcast intake; relay/consumers run in worker.
    void startEventInfrastructure({ relay: false, intake: true, watchdog: false }).catch(error => {
      logger.error('API event intake failed', { error: String(error) });
    });


    // Every process publishes a runtime heartbeat (lib/runtime-status); the API's carries its own publish
    // circuits and applies circuit resets requested from any replica.
    stopRuntimeStatus = startRuntimeStatusPublisher();
    markProcessReady();

    logger.info('✅ API server initialized', {
      processRole: 'api',
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

// Skip listening / cron + queue startup when the module is imported purely
// to enumerate routes (rbac-coverage check).
if (!process.env.RBAC_COVERAGE) start();

// Stop accepting HTTP and close fan-out before releasing shared connections.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  try {
    await app.close();
    await stopRuntimeStatus?.();
    await stopEventInfrastructure();
    await closeBroker();
    await closeQueue();
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) { logger.error('API shutdown failed', { error: String(error) }); process.exit(1); }
});
