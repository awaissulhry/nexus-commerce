/**
 * L.14.0 — Cron registry.
 *
 * Maps the jobName passed to recordCronRun() (the same string the
 * /sync-logs hub displays) to the per-tick async function. Powers
 * manual triggers from the hub's cron status panel:
 *
 *   POST /api/sync-logs/cron/<jobName>/trigger
 *
 * The endpoint wraps the lookup in recordCronRun(triggeredBy='manual')
 * so the manual run shows up in CronRun alongside its automatic
 * siblings. Operators get a unified history.
 *
 * Why explicit registry rather than dynamic discovery: cron jobs have
 * heterogeneous export shapes (named exports, re-exports, multiple
 * ticks per file). A typed map is the only way to keep this
 * compile-time-safe while still hitting every job.
 */

import { runOrdersPoll as runAmazonOrdersPoll } from './amazon-orders-sync.job.js'
import { runFinancialSync as runAmazonFinancialSync } from './amazon-financial-sync.job.js'
import { runEbayFinancialSync } from './ebay-financial-sync.job.js'
import { runInventorySweep as runAmazonInventorySweep } from './amazon-inventory-sync.job.js'
import { runOrdersPoll as runEbayOrdersPoll } from './ebay-orders-sync.job.js'
import { runRefreshSweep as runEbayTokenRefresh } from './ebay-token-refresh.job.js'
import { runSyncDriftDetection } from './sync-drift-detection.job.js'
import { runAutoPoCronOnce } from './auto-po-replenishment.job.js'
import { runYesterdayIngest as runSalesReportIngest } from './sales-report-ingest.job.js'
import { runForecastTick } from './forecast.job.js'
import { runForecastAccuracyCronOnce } from './forecast-accuracy.job.js'
import { runMCFStatusSyncOnce } from './amazon-mcf-status.job.js'
import { runFbaRestockCronOnce } from './fba-restock-ingestion.job.js'
import { runFbaPanEuSyncOnce } from './fba-pan-eu-sync.job.js'
import { runFbaStatusPoll } from './fba-status-poll.job.js'
import { runPollSweep as runAmazonReturnsPoll } from './amazon-returns-poll.job.js'
import { runRetrySweep as runRefundRetry } from './refund-retry.job.js'
import { runRefundDeadlineScan } from './refund-deadline-tracker.job.js'
import { runReservationSweep } from './reservation-sweep.job.js'
import { runLateShipmentFlagSweep } from './late-shipment-flag.job.js'
import { runTrackingPushbackSweep } from './tracking-pushback.job.js'
import { runOutboundLateRiskSweep } from './outbound-late-risk.job.js'
import { runCarrierServiceSync } from './carrier-service-sync.job.js'
import { runCarrierMetricsSweep } from './carrier-metrics.job.js'
import { runPickupDispatchSweep } from './pickup-dispatch.job.js'
import { runSavedViewAlertsSweep } from './saved-view-alerts.job.js'
import { runStockoutCronOnce } from './stockout-detector.job.js'
import { runAbcCronOnce } from './abc-classification.job.js'
import { runAutomationRuleCronOnce } from './automation-rule-evaluator.job.js'
import { runCycleCountSchedulerOnce } from './cycle-count-scheduler.job.js'
import { runScheduledChangesOnce } from './scheduled-changes.job.js'
import { runPurgeSoftDeletedOnce } from './purge-soft-deleted-products.job.js'
import { runLeadTimeStatsCronOnce } from './lead-time-stats.job.js'
import { runCatalogRefresh } from './catalog-refresh.job.js'
import { runObservabilityRetention } from './observability-retention.job.js'
import { runOrphanBulkJobCleanupOnce } from './bulk-job-orphan-cleanup.job.js'
import { runScheduledBulkActionCronOnce } from './scheduled-bulk-action.job.js'
import { runScheduledImportCronOnce } from './scheduled-import.job.js'
import { runScheduledExportCronOnce } from './scheduled-export.job.js'
import { runBulkAutomationTickOnce } from './bulk-automation-tick.job.js'
import { runAlertEvaluator } from '../services/alert-evaluator.service.js'
import {
  runFxRefresh,
  runSnapshotRefresh,
  runPromotionTick,
  runFeeRefresh,
  runCompetitiveRefresh,
} from './pricing-refresh.job.js'
import { runAllEstySyncJobs } from './etsy-sync.job.js'
import { runAllShopifySyncJobs } from './shopify-sync.job.js'
import { runAllWooCommerceSyncJobs } from './woocommerce-sync.job.js'
// AD.1 + AD.2 — Trading Desk cron entrypoints.
import {
  runAdsSyncCron,
  runFbaStorageAgeIngestCron,
  runTrueProfitRollupCron,
  runAdsMetricsIngestCron,
} from './ads-sync.job.js'
// AD.3 — advertising-domain AutomationRule evaluator.
import { runAdvertisingRuleEvaluatorCron } from './advertising-rule-evaluator.job.js'
// AD.5 — cross-marketplace BudgetPool rebalancer.
import { runBudgetPoolRebalanceCron } from './budget-pool-rebalance.job.js'
// SR.1 — Sentient Review Loop ingest + spike detector.
import {
  runReviewIngestCron,
  runReviewSpikeDetectorCron,
} from './review-pipeline.job.js'
// SR.3 — review-domain AutomationRule evaluator.
import { runReviewRuleEvaluatorCron } from './review-rule-evaluator.job.js'

// Each entry returns an unknown (some run functions return summary
// objects, others return void). Manual-trigger callers don't need
// the result — recordCronRun captures the summary string from the
// wrapper that the cron itself uses.
export const CRON_REGISTRY: Record<string, () => Promise<unknown>> = {
  'amazon-orders-sync': () => runAmazonOrdersPoll(),
  'amazon-financial-sync': () => runAmazonFinancialSync(),
  'ebay-financial-sync': () => runEbayFinancialSync(),
  'amazon-inventory-sync': () => runAmazonInventorySweep(),
  'amazon-mcf-status': () => runMCFStatusSyncOnce(),
  'amazon-returns-poll': () => runAmazonReturnsPoll(),
  'ebay-orders-sync': () => runEbayOrdersPoll(),
  'ebay-token-refresh': () => runEbayTokenRefresh(),
  'sync-drift-detection': () => runSyncDriftDetection(),
  'auto-po': () => runAutoPoCronOnce(),
  'sales-report-ingest': () => runSalesReportIngest(),
  forecast: () => runForecastTick(),
  'forecast-accuracy': () => runForecastAccuracyCronOnce(),
  'fba-restock-ingestion': () => runFbaRestockCronOnce(),
  'fba-pan-eu-sync': () => runFbaPanEuSyncOnce(),
  'fba-status-poll': () => runFbaStatusPoll(),
  'refund-retry': () => runRefundRetry(),
  'refund-deadline-tracker': () => runRefundDeadlineScan(),
  'reservation-sweep': () => runReservationSweep(),
  'late-shipment-flag': () => runLateShipmentFlagSweep(),
  'tracking-pushback': () => runTrackingPushbackSweep(),
  'outbound-late-risk': () => runOutboundLateRiskSweep(),
  'carrier-service-sync': () => runCarrierServiceSync(),
  'carrier-metrics': () => runCarrierMetricsSweep(),
  'pickup-dispatch': () => runPickupDispatchSweep(),
  'saved-view-alerts': () => runSavedViewAlertsSweep(),
  'stockout-detector': () => runStockoutCronOnce(),
  'abc-classification': () => runAbcCronOnce(),
  'automation-rule-evaluator': () => runAutomationRuleCronOnce(),
  'cycle-count-scheduler': () => runCycleCountSchedulerOnce(),
  'scheduled-changes': () => runScheduledChangesOnce(),
  'purge-soft-deleted-products': () => runPurgeSoftDeletedOnce(),
  'lead-time-stats': () => runLeadTimeStatsCronOnce(),
  'catalog-refresh': () => runCatalogRefresh(),
  'observability-retention': () => runObservabilityRetention(),
  'bulk-job-orphan-cleanup': () => runOrphanBulkJobCleanupOnce(),
  'scheduled-bulk-action': () => runScheduledBulkActionCronOnce(),
  'scheduled-import': () => runScheduledImportCronOnce(),
  'scheduled-export': () => runScheduledExportCronOnce(),
  'bulk-automation-tick': () => runBulkAutomationTickOnce(),
  'alert-evaluator': () => runAlertEvaluator(),

  // Multi-tick channels: pricing-refresh exposes 5 distinct ticks
  'pricing-fx-refresh': () => runFxRefresh(),
  'pricing-snapshot-refresh': () => runSnapshotRefresh(),
  'pricing-promotion-scheduler': () => runPromotionTick(),
  'pricing-fee-refresh': () => runFeeRefresh(),
  'pricing-competitive-refresh': () => runCompetitiveRefresh(),

  // Channel sync umbrella functions. Each runAll* invokes the 3
  // sub-ticks (listings/inventory/orders) sequentially. Operators
  // who only want a single sub-tick re-trigger from CLI today —
  // fine-grained sub-tick triggers can be exposed later.
  'etsy-sync': () => runAllEstySyncJobs(),
  'shopify-sync': () => runAllShopifySyncJobs(),
  'woocommerce-sync': () => runAllWooCommerceSyncJobs(),

  // AD.1 + AD.2 — Trading Desk substrate + metrics ingest.
  // AD.3 — advertising-domain AutomationRule evaluator.
  // Gated by NEXUS_ENABLE_AMAZON_ADS_CRON=1; sandbox-safe.
  'ads-sync': () => runAdsSyncCron(),
  'fba-storage-age-ingest': () => runFbaStorageAgeIngestCron(),
  'true-profit-rollup': () => runTrueProfitRollupCron(),
  'ads-metrics-ingest': () => runAdsMetricsIngestCron(),
  'advertising-rule-evaluator': () => runAdvertisingRuleEvaluatorCron(),
  'budget-pool-rebalance': () => runBudgetPoolRebalanceCron(),

  // SR.1 — Sentient Review Loop. Gated by NEXUS_ENABLE_REVIEW_INGEST=1.
  'review-ingest': () => runReviewIngestCron(),
  'review-spike-detector': () => runReviewSpikeDetectorCron(),
  // SR.3 — review-domain AutomationRule evaluator (same gate).
  'review-rule-evaluator': () => runReviewRuleEvaluatorCron(),
}

export function isKnownCron(jobName: string): boolean {
  return Object.prototype.hasOwnProperty.call(CRON_REGISTRY, jobName)
}

export function listKnownCrons(): string[] {
  return Object.keys(CRON_REGISTRY).sort()
}
