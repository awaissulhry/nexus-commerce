# Data Wipe Audit — 2026-05-20

**Generated:** 2026-05-20T14:47:27.364Z
**Database:** postgresql://neondb_owner:***@ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.a...
**Purpose:** Phase 0 + Phase 1 read-only audit. No data modified.

---

## Phase 0a — Canary baseline (PRESERVE)

These counts are what must survive the wipe. Verify post-wipe matches.

### Products (master catalog)
| total_products | real_null_source | real_manual | fake_xavia_test | fake_perf_test | active | draft | inactive |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 268 | 262 | 6 | 0 | 0 | 267 | 0 | 1 |

### Product importSource distribution (full breakdown)
| source | rows |
| --- | --- |
| _NULL_ | 262 |
| MANUAL | 6 |

### Product variations
| total_variations | products_with_variations |
| --- | --- |
| 0 | 0 |

### Product images (master gallery)
| total_images | products_with_images |
| --- | --- |
| 0 | 0 |

### ChannelListing (per-channel listings)
| channel | marketplace | listings | active | inactive |
| --- | --- | --- | --- | --- |
| AMAZON | IT | 262 | 97 | 0 |
| AMAZON | DE | 235 | 81 | 0 |
| AMAZON | ES | 140 | 0 | 0 |
| AMAZON | FR | 132 | 0 | 0 |

### VariantChannelListing (per-variant per-channel)
| total | distinct_variants | distinct_channels |
| --- | --- | --- |
| 0 | 0 | 0 |

### ChannelConnection (auth — PRESERVE always)
| channelType | marketplace | managedBy | displayName | has_access_token | has_refresh_token |
| --- | --- | --- | --- | --- | --- |
| AMAZON | _null_ | env | A1VRHKTGYO1JNU | false | false |
| EBAY | _null_ | oauth | eBay seller (verified) | true | true |

### DigitalAsset (DAM) summary
| total_assets | images | videos | total_mb |
| --- | --- | --- | --- |
| 0 | 0 | 0 | _null_ |

### Product → channel-identity coverage
| products | with_amazon_asin | with_ebay_item_id | with_shopify_id | with_upc | with_ean | with_cost_price | with_brand |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 268 | 260 | 0 | 0 | 0 | 0 | 0 | 7 |

### ChannelListing → external-id coverage
| channel | marketplace | listings | with_external_id | with_platform_product_id | with_title |
| --- | --- | --- | --- | --- | --- |
| AMAZON | DE | 235 | 226 | 0 | 235 |
| AMAZON | ES | 140 | 140 | 0 | 140 |
| AMAZON | FR | 132 | 132 | 0 | 132 |
| AMAZON | IT | 262 | 255 | 0 | 262 |

### Marketplace (config — PRESERVE)
| marketplaces |
| --- |
| 17 |

### Operational templates (PRESERVE)
| bulk_action_templates | wizard_templates | return_policies | retail_events | terminology_prefs | warehouses |
| --- | --- | --- | --- | --- | --- |
| 12 | 5 | 3 | 0 | 7 | 1 |


---

## Phase 0b — Wipe manifest (DELETE candidates)

Each subsection shows row counts and date range for tables that Phase 2 will delete.

### Orders + line items
| total_orders | amazon | ebay | shopify | other | earliest | latest | gross_revenue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 0 | 0 | _null_ | _null_ | _null_ |

| total_order_items |
| --- |
| 0 |

| total_order_notes |
| --- |
| 0 |

| total_order_tags |
| --- |
| 0 |

| total_order_risk_scores |
| --- |
| 0 |

| total_routing_decisions |
| --- |
| 0 |

### Customers
| total_customers | with_orders | b2b | b2c |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 0 |

| total_customer_addresses |
| --- |
| 0 |

| total_customer_notes |
| --- |
| 0 |

| total_customer_segments |
| --- |
| 0 |

### Shipments + fulfillment
| total_shipments |
| --- |
| 0 |

| total_shipment_items |
| --- |
| 0 |

| total_inbound_shipments |
| --- |
| 0 |

| total_inbound_shipment_items |
| --- |
| 0 |

| total_inbound_receipts |
| --- |
| 0 |

| total_outbound_sync_queue |
| --- |
| 0 |

| total_outbound_api_call_log |
| --- |
| 0 |

| total_fba_shipments |
| --- |
| 0 |

| total_mcf_shipments |
| --- |
| 0 |

### Returns + refunds
| total_returns | earliest | latest |
| --- | --- | --- |
| 0 | _null_ | _null_ |

| total_return_items |
| --- |
| 0 |

| total_refunds |
| --- |
| 0 |

| total_refund_attempts |
| --- |
| 0 |

### Inventory + stock
| total_stock_movements | earliest | latest |
| --- | --- | --- |
| 0 | _null_ | _null_ |

| total_stock_levels |
| --- |
| 0 |

| total_stock_log |
| --- |
| 0 |

| total_stock_reservations |
| --- |
| 0 |

| total_stockout_events |
| --- |
| 0 |

| total_stock_cost_layers |
| --- |
| 0 |

| total_cycle_counts |
| --- |
| 0 |

| total_cycle_count_items |
| --- |
| 0 |

| total_stock_bin_quantities |
| --- |
| 0 |

| total_channel_stock_events |
| --- |
| 0 |

### Inventory PRESERVED (real physical / lot data — do NOT delete in Phase 2)
| total_lots |
| --- |
| 0 |

| total_lot_recalls |
| --- |
| 0 |

| total_serial_numbers |
| --- |
| 0 |

| total_bundles |
| --- |
| 0 |

| total_stock_bins |
| --- |
| 0 |

| total_stock_locations |
| --- |
| 2 |

### Fiscal + financial
| total_fiscal_invoices | sdi_sent | sdi_accepted |
| --- | --- | --- |
| 0 | 0 | 0 |

| total_credit_notes |
| --- |
| 0 |

| total_financial_transactions | earliest | latest |
| --- | --- | --- |
| 0 | _null_ | _null_ |

| total_fx_rates |
| --- |
| 0 |

| total_year_end_snapshots |
| --- |
| 0 |

### Advertising (Amazon Ads + eBay Promoted)
| total_campaigns | with_external_id | local_only | enabled |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 0 |

| total_ad_groups |
| --- |
| 0 |

| total_ad_targets |
| --- |
| 0 |

| total_ad_product_ads |
| --- |
| 0 |

| total_daily_perf |
| --- |
| 0 |

| total_search_terms |
| --- |
| 0 |

| total_placement_reports |
| --- |
| 0 |

| total_brand_metrics |
| --- |
| 0 |

| total_ads_report_jobs |
| --- |
| 0 |

| total_ads_export_jobs |
| --- |
| 0 |

| total_advertising_action_log |
| --- |
| 0 |

| total_budget_pools |
| --- |
| 0 |

| total_budget_pool_allocations |
| --- |
| 0 |

| total_budget_pool_rebalances |
| --- |
| 0 |

| total_campaign_bid_history |
| --- |
| 0 |

| total_ebay_campaigns |
| --- |
| 0 |

| total_ebay_markdowns |
| --- |
| 0 |

| total_connections | active | sandbox | production |
| --- | --- | --- | --- |
| 9 | 9 | 9 | 0 |

### Analytics aggregates
| total_daily_sales_aggregate |
| --- |
| 0 |

| total_product_profit_daily |
| --- |
| 0 |

| total_fba_storage_age |
| --- |
| 0 |

| total_listing_quality_snapshots |
| --- |
| 0 |

| total_listing_reconciliation |
| --- |
| 0 |

| total_forecast_accuracy |
| --- |
| 0 |

### Wizard / draft artifacts
| total_wizards | drafts | submitted | live | failed |
| --- | --- | --- | --- | --- |
| 6 | 6 | 0 | 0 | 0 |

| total_wizard_step_events |
| --- |
| 0 |

| total_scheduled_wizard_publishes | future |
| --- | --- |
| 0 | 0 |

| total_draft_listings |
| --- |
| 0 |

### Logs + telemetry
| total_audit_log |
| --- |
| 129 |

| total_sync_log |
| --- |
| 0 |

| total_sync_log_error_groups |
| --- |
| 0 |

| total_sync_errors |
| --- |
| 0 |

| total_sync_health_log |
| --- |
| 0 |

| total_ai_usage_log |
| --- |
| 0 |

| total_alert_events |
| --- |
| 0 |

| total_cron_runs |
| --- |
| 68107 |

| total_rate_limit_log |
| --- |
| 0 |

| total_tracking_events |
| --- |
| 0 |

| total_tracking_message_log |
| --- |
| 0 |

| total_webhook_events |
| --- |
| 0 |

| total_login_events |
| --- |
| 0 |

| total_flat_file_pull_jobs |
| --- |
| 0 |

| total_flat_file_pull_records |
| --- |
| 0 |

| total_import_jobs |
| --- |
| 0 |

| total_export_jobs |
| --- |
| 0 |

| total_repricing_decisions |
| --- |
| 0 |


---

## Phase 1 — Listing-graph fence tagging

Identifies which rows in ambiguous tables are linked to the live 279-SKU catalog vs orphaned test data.

### DigitalAsset orphan analysis
_(no rows)_

### AssetUsage breakdown
_(no rows)_

### AssetUsage rows pointing to non-existent Products (truly orphaned)
| dangling_usages |
| --- |
| 0 |

### Campaign / AdGroup / AdTarget orphan tagging
_(no rows)_

### AdProductAd → Product linkage
| total | with_product_fk | no_product_fk | dangling_product_fk |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 0 |

### APlusContent / APlusContentAsin linkage
| total_aplus | published | draft | approved |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 0 |

| total_attachments | with_product_fk | standalone_asin | dangling_product_fk |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 0 |

### BrandStory inventory
| total_brand_stories | distinct_brands | distinct_marketplaces |
| --- | --- | --- |
| 0 | 0 | 0 |

### ListingWizard expiry tagging
| tag | rows |
| --- | --- |
| KEEP_recent_draft | 6 |

### Brand assets (PRESERVE — these are brand-level, not per-product)
| brand_kits | brand_settings | brand_voices | brand_watermark_templates |
| --- | --- | --- | --- |
| 0 | 1 | 0 | 0 |


---

## Phase 0c — Live channel signal check

Are the production crons actually writing data? Quick health check.

### Sync health log (last 7 days, by channel + errorType)
_(no rows)_

### Cron runs (last 7 days)
| jobName | status | runs | last_run |
| --- | --- | --- | --- |
| amazon-sqs-poll | SUCCESS | 18583 | "2026-05-20T12:47:30.027Z" |
| scheduled-bulk-action | SUCCESS | 9870 | "2026-05-20T12:47:04.682Z" |
| scheduled-changes | SUCCESS | 9787 | "2026-05-20T12:47:00.028Z" |
| alert-evaluator | SUCCESS | 9789 | "2026-05-20T12:47:00.025Z" |
| ads-v1-export-ingest | SUCCESS | 573 | "2026-05-20T12:47:00.023Z" |
| tracking-pushback | SUCCESS | 4887 | "2026-05-20T12:46:00.026Z" |
| scheduled-export | SUCCESS | 1885 | "2026-05-20T12:45:04.583Z" |
| scheduled-import | SUCCESS | 1885 | "2026-05-20T12:45:04.583Z" |
| bulk-automation-tick | SUCCESS | 585 | "2026-05-20T12:45:04.562Z" |
| repricing-evaluator | SUCCESS | 1956 | "2026-05-20T12:45:00.069Z" |
| ads-v1-export-poll | SUCCESS | 575 | "2026-05-20T12:45:00.069Z" |
| advertising-rule-evaluator | SUCCESS | 318 | "2026-05-20T12:45:00.068Z" |
| amazon-inventory-sync | SUCCESS | 569 | "2026-05-20T12:45:00.067Z" |
| budget-pool-rebalance | SUCCESS | 318 | "2026-05-20T12:45:00.066Z" |
| reservation-sweep | SUCCESS | 1956 | "2026-05-20T12:45:00.061Z" |
| saved-view-alerts | SUCCESS | 1956 | "2026-05-20T12:45:00.060Z" |
| fba-status-poll | SUCCESS | 652 | "2026-05-20T12:45:00.060Z" |
| ads-report-poll | SUCCESS | 333 | "2026-05-20T12:40:00.047Z" |
| ads-report-ingest | SUCCESS | 219 | "2026-05-20T12:37:00.029Z" |
| ebay-token-refresh | SUCCESS | 325 | "2026-05-20T12:30:00.179Z" |
| sync-drift-detection | SUCCESS | 325 | "2026-05-20T12:30:00.077Z" |
| bulk-job-orphan-cleanup | SUCCESS | 274 | "2026-05-20T12:00:04.559Z" |
| outbound-late-risk | SUCCESS | 163 | "2026-05-20T12:00:00.085Z" |
| amazon-inventory-sync | RUNNING | 83 | "2026-05-20T11:15:00.063Z" |
| fba-storage-age-ingest | SUCCESS | 13 | "2026-05-20T10:07:00.032Z" |
| late-shipment-flag | SUCCESS | 27 | "2026-05-20T10:00:00.129Z" |
| ads-v1-export-create | SUCCESS | 8 | "2026-05-20T10:00:00.117Z" |
| lot-expiry-alert | SUCCESS | 7 | "2026-05-20T04:30:00.069Z" |
| stockout-detector | SUCCESS | 7 | "2026-05-20T04:30:00.061Z" |
| lead-time-stats | SUCCESS | 7 | "2026-05-20T04:00:00.086Z" |
| feed-export | SUCCESS | 4 | "2026-05-20T04:00:00.080Z" |
| auto-po | SUCCESS | 7 | "2026-05-20T03:00:00.081Z" |
| observability-retention | SUCCESS | 7 | "2026-05-20T02:00:00.144Z" |
| fba-restock-ingestion | SUCCESS | 7 | "2026-05-20T02:00:00.134Z" |
| forecast-accuracy | SUCCESS | 7 | "2026-05-20T02:00:00.132Z" |
| pickup-dispatch | SUCCESS | 7 | "2026-05-20T02:00:00.114Z" |
| purge-soft-deleted-products | SUCCESS | 7 | "2026-05-20T01:15:00.069Z" |
| retention-sweep | SUCCESS | 1 | "2026-05-20T01:00:00.123Z" |
| true-profit-rollup | SUCCESS | 4 | "2026-05-20T01:00:00.121Z" |
| carrier-metrics | SUCCESS | 7 | "2026-05-20T01:00:00.118Z" |
| cycle-count-scheduler | SUCCESS | 6 | "2026-05-19T00:30:00.075Z" |
| rfm-scoring | SUCCESS | 3 | "2026-05-19T00:00:00.084Z" |
| carrier-service-sync | SUCCESS | 6 | "2026-05-19T00:00:00.075Z" |
| ads-report-create-pl | SUCCESS | 1 | "2026-05-18T23:45:00.046Z" |
| ads-report-create-st | SUCCESS | 1 | "2026-05-18T23:30:00.072Z" |
| ads-report-create | SUCCESS | 1 | "2026-05-18T23:15:00.066Z" |
| ads-v1-export-ingest | RUNNING | 1 | "2026-05-18T08:47:00.027Z" |
| ads-sync | SUCCESS | 63 | "2026-05-18T08:30:00.072Z" |
| listing-quality-snapshot | SUCCESS | 1 | "2026-05-18T05:00:00.079Z" |
| abc-classification | SUCCESS | 1 | "2026-05-18T02:00:00.104Z" |

### OutboundApiCallLog — recent activity (sample of channels hit)
_(no rows)_

### Recent order ingestion (last 14 days, by channel)
_(no rows)_


---

## Recommended next actions

1. **Take Neon branch snapshot** before any destructive action: `neon branches create --name pre-wipe-2026-05-20` (or via Neon Console).
2. **Review this manifest** — look for unexpected high counts in PRESERVE section.
3. **Decide on edge cases**:
   - APlusContentAsin standalone (productId IS NULL) — keep or wipe?
   - Campaigns with no Product link but with externalCampaignId — live in Amazon, just not mapped locally; keep or wipe?
   - DigitalAssets that are orphans but with operator labels (likely brand/lifestyle photos) — wipe or migrate to BrandKit?
4. **Approve Phase 2 destructive migration** with eyes open on row counts.

Generated by `scripts/data-wipe-2026-05-20-audit.mjs`. Re-run any time (read-only).