/**
 * R0.2 — Amazon report catalog (docs/AMAZON_DATA_STRATEGY.md).
 *
 * The canonical list of Amazon data feeds we pull, with the metadata the
 * freshness surface + Reports hub (R0.3) need. `cronJob` maps a feed to
 * its CronRun.jobName so we can derive "last successfully pulled" from the
 * existing cron history (the day-one freshness backfill). On-demand feeds
 * have cronJob = null.
 *
 * This is curated, not exhaustive — it's the set we actively rely on.
 * Data Kiosk economics (R1) + the wider report sweep (R2) extend it.
 */

export type ReportSource = 'REPORTS_API' | 'DATA_KIOSK' | 'DATA_API'

export interface ReportCatalogEntry {
  /** SP-API report type (GET_*), Data Kiosk query, or data-API dataset key. */
  reportType: string
  /** Human label for the hub. */
  label: string
  source: ReportSource
  /** True when the feed is pulled per-marketplace. */
  marketplaceScoped: boolean
  /** CronRun.jobName that pulls this (for freshness backfill); null = on-demand. */
  cronJob: string | null
  /** Human cadence. */
  cadence: string
}

export const AMAZON_REPORT_CATALOG: ReportCatalogEntry[] = [
  {
    reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
    label: 'Sales & Traffic',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: 'sales-report-ingest',
    cadence: 'Daily (T+1)',
  },
  {
    reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
    label: 'Merchant Listings — All',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: 'catalog-refresh',
    cadence: 'Daily',
  },
  {
    reportType: 'GET_MERCHANT_LISTINGS_DEFECT_DATA',
    label: 'Listing Defects / Suppression',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: null,
    cadence: 'On-demand',
  },
  {
    reportType: 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE',
    label: 'FBM Returns',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: 'amazon-returns-poll',
    cadence: 'Hourly',
  },
  {
    reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
    label: 'FBA Returns',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: 'amazon-returns-poll',
    cadence: 'Hourly',
  },
  {
    reportType: 'GET_FBA_REIMBURSEMENTS_DATA',
    label: 'FBA Reimbursements',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: null,
    cadence: 'On-demand',
  },
  {
    reportType: 'GET_FBA_INVENTORY_ADJUSTMENTS_DATA',
    label: 'FBA Inventory Adjustments',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: null,
    cadence: 'On-demand',
  },
  {
    reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
    label: 'FBA Inventory Planning (aged + storage)',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: 'fba-storage-age-ingest',
    cadence: 'Daily (gated)',
  },
  {
    reportType: 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA',
    label: 'FBA Estimated Fees',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: 'fba-storage-age-ingest',
    cadence: 'Weekly',
  },
  {
    reportType: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA',
    label: 'FBA Restock Inventory',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: 'fba-restock-ingestion',
    cadence: 'Daily (gated)',
  },
  {
    reportType: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    label: 'Settlement (V2)',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: 'amazon-settlement-sync',
    cadence: 'Daily (T+2–5)',
  },
  {
    reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
    label: 'All Orders (delivery status)',
    source: 'REPORTS_API',
    marketplaceScoped: true,
    cronJob: null,
    cadence: 'On-demand (gated)',
  },
  // Key data-API datasets — part of the Amazon data picture, not the
  // Reports API, but tracked here so the freshness surface is complete.
  {
    reportType: 'FINANCIAL_EVENTS',
    label: 'Finances — Events',
    source: 'DATA_API',
    marketplaceScoped: false,
    cronJob: 'amazon-financial-sync',
    cadence: 'Daily (T+1)',
  },
]

export function catalogEntry(reportType: string): ReportCatalogEntry | undefined {
  return AMAZON_REPORT_CATALOG.find((e) => e.reportType === reportType)
}
