/**
 * ACP.1 — capability/tool registry. Aggregates the per-domain tool files
 * into one lookup. Types live in tool-types.ts (avoids an import cycle
 * between the registry and the tool files).
 */

import type { AgentTool } from './tool-types.js'
import { READ_TOOLS } from './tools/read.tools.js'
import { ANALYTICS_TOOLS } from './tools/analytics.tools.js'
import { DRAFT_TOOLS } from './tools/draft.tools.js'
import { MUTATE_TOOLS } from './tools/mutate.tools.js'
import { ADS_PROPOSE_TOOLS } from './tools/ads-propose.tools.js'
import { ADS_READ_TOOLS } from './tools/ads-read.tools.js'
import { ADS_RECOMMENDATION_TOOLS } from './tools/ads-recommendations-apply.tools.js'
import { ADS_CHANGE_TOOLS } from './tools/ads-change.tools.js'
import { ADS_TARGET_ACOS_TOOLS } from './tools/ads-target-acos.tools.js'
import { ADS_STRATEGY_TOOLS } from './tools/ads-strategy.tools.js'
import { ADS_BID_BRAIN_TOOLS } from './tools/ads-bid-brain.tools.js'
import { ADS_PLAYBOOK_TOOLS } from './tools/ads-playbook.tools.js'
import { ADS_MANAGER_TOOLS } from './tools/ads-manager.tools.js'
import { ADS_CREATE_TOOLS } from './tools/ads-create.tools.js'
import { ADS_PLAYBOOK_APPLY_TOOLS } from './tools/ads-playbook-apply.tools.js'
import { ADS_SP_WIZARD_TOOLS } from './tools/ads-sp-wizard.tools.js'
import { ADS_REPLICATE_TOOLS } from './tools/ads-replicate.tools.js'
import { ADS_AI_GOAL_TOOLS } from './tools/ads-ai-goal.tools.js'
import { ADS_STATUS_TOOLS } from './tools/ads-status.tools.js'
// ADS AUTONOMY W4-7 — budgets: the monthly plan, schedules, pools, baselines, and their read.
import { ADS_BUDGET_PLAN_TOOLS } from './tools/ads-budget-plan.tools.js'
import { ADS_BUDGET_SCHEDULE_TOOLS } from './tools/ads-budget-schedule.tools.js'
import { ADS_BUDGET_POOL_TOOLS } from './tools/ads-budget-pool.tools.js'
import { ADS_BUDGET_READ_TOOLS } from './tools/ads-budget-read.tools.js'
import { ADS_STOCK_TOOLS } from './tools/ads-stock.tools.js'
import { ADS_PORTFOLIO_TOOLS } from './tools/ads-portfolio.tools.js'
import { ADS_CAMPAIGN_SETTINGS_TOOLS } from './tools/ads-campaign-settings.tools.js'
import { ADS_HOURLY_PLAN_TOOLS } from './tools/ads-hourly-plan.tools.js'
import { ADS_TARGET_TOOLS } from './tools/ads-targets.tools.js'
import { ADS_NEGATIVE_TOOLS } from './tools/ads-negatives.tools.js'
import { ADS_AD_GROUP_TOOLS } from './tools/ads-ad-groups.tools.js'
import { ADS_QUEUED_WRITE_TOOLS } from './tools/ads-queued-write.tools.js'
import { ADS_AUTO_UNDO_TOOLS } from './tools/ads-auto-undo.tools.js'
import { EBAY_AD_TOOLS } from './tools/ebay-ads.tools.js'
import { APPROVAL_TOOLS } from './tools/approval.tools.js'
import { CHANNEL_TOOLS } from './tools/channel.tools.js'
import { BULK_TOOLS } from './tools/bulk.tools.js'
import { CONTROL_TOOLS } from './tools/control.tools.js'
import { ACTIVITY_TOOLS } from './tools/activity.tools.js'
import { AUTOMATION_READ_TOOLS } from './tools/automation-read.tools.js'
import { ORDER_READ_TOOLS } from './tools/order-read.tools.js'
import { FULFILMENT_TOOLS } from './tools/fulfilment.tools.js'
import { ORDER_CARE_TOOLS } from './tools/order-care.tools.js'
import { STOCK_READ_TOOLS } from './tools/stock-read.tools.js'
import { SUPPLY_READ_TOOLS } from './tools/supply-read.tools.js'
import { PRICING_READ_TOOLS } from './tools/pricing-read.tools.js'
import { CONTENT_TOOLS } from './tools/content.tools.js'
import { CONTENT_CHANGE_TOOLS } from './tools/content-change.tools.js'
import { IDENTITY_TOOLS } from './tools/identity.tools.js'
import { IDENTITY_FIX_TOOLS } from './tools/identity-fix.tools.js'
import { IDENTITY_MERGE_TOOLS } from './tools/identity-merge.tools.js'
import { LISTING_READ_TOOLS } from './tools/listing-read.tools.js'
import { PUBLISH_TOOLS } from './tools/publish.tools.js'
import { LISTING_CREATE_TOOLS } from './tools/listing-create.tools.js'
import { PLATFORM_BUSINESS_TOOLS } from './tools/platform-business.tools.js'
import { CATALOG_STRUCTURE_TOOLS } from './tools/catalog-structure.tools.js'
import { PLATFORM_LIBRARY_TOOLS } from './tools/platform-library.tools.js'
import { REPORT_TOOLS } from './tools/reports.tools.js'
import { PLATFORM_ACTIVITY_TOOLS } from './tools/platform-activity.tools.js'
import { PLATFORM_HEALTH_TOOLS } from './tools/platform-health.tools.js'
import { ORGANIZE_CATALOG_TOOLS } from './tools/organize-catalog.tools.js'
import { ORGANIZE_PLATFORM_TOOLS } from './tools/organize-platform.tools.js'
import { STRUCTURE_CHANGE_TOOLS } from './tools/structure-change.tools.js'
import { MAPPING_CHANGE_TOOLS } from './tools/mapping-change.tools.js'
import { BUSINESS_SETTINGS_TOOLS } from './tools/business-settings.tools.js'
import { AUTOMATION_CHANGE_TOOLS } from './tools/automation-change.tools.js'
import { ADS_ENGINE_SETTINGS_TOOLS } from './tools/ads-engine-settings.tools.js'
import { ORDER_DESK_TOOLS } from './tools/order-desk.tools.js'
import { SHIPPING_TOOLS } from './tools/shipping.tools.js'
import { ORDER_ACTION_TOOLS } from './tools/order-actions.tools.js'
import { RETURN_TOOLS } from './tools/return.tools.js'
import { REVIEW_ACTION_TOOLS } from './tools/review-actions.tools.js'
import { FISCAL_TOOLS } from './tools/fiscal.tools.js'
import { STOCK_CHANGE_TOOLS } from './tools/stock.tools.js'
import { STOCK_SYNC_TOOLS } from './tools/stock-sync.tools.js'
import { PRICING_CHANGE_TOOLS } from './tools/pricing.tools.js'
import { PRICE_CHANGE_TOOLS } from './tools/price-change.tools.js'
import { SUPPLY_CHANGE_TOOLS } from './tools/supply.tools.js'
import { FBA_INBOUND_TOOLS } from './tools/fba-inbound.tools.js'
import { CHANNEL_CONTENT_TOOLS } from './tools/channel-content.tools.js'
import { LISTING_STOCK_TOOLS } from './tools/listing-stock.tools.js'
import { LISTING_CLOSE_TOOLS } from './tools/listing-close.tools.js'
import { LISTING_LIFECYCLE_TOOLS } from './tools/listing-lifecycle.tools.js'
import { PHOTO_TOOLS } from './tools/photos.tools.js'
import { DATA_TRANSFER_TOOLS } from './tools/data-transfer.tools.js'
import { EBAY_CATEGORY_TOOLS } from './tools/ebay-category.tools.js'

export type {
  RiskTier,
  ToolContext,
  ToolResult,
  AgentTool,
} from './tool-types.js'

const ALL: AgentTool[] = [
  ...READ_TOOLS,
  // MCP full control 07 — order, fulfilment, return, customer and review reads (buyer data masked).
  ...ORDER_READ_TOOLS,
  ...FULFILMENT_TOOLS,
  ...ORDER_CARE_TOOLS,
  // MCP full control 07 O7+ — the order desk's changes.
  ...ORDER_DESK_TOOLS,
  ...SHIPPING_TOOLS,
  ...ORDER_ACTION_TOOLS,
  ...RETURN_TOOLS,
  ...REVIEW_ACTION_TOOLS,
  ...FISCAL_TOOLS,
  ...ANALYTICS_TOOLS,
  ...DRAFT_TOOLS,
  ...MUTATE_TOOLS,
  // NAF.C — preview-only ads propose tools (no execute until Phase F).
  ...ADS_PROPOSE_TOOLS,
  // MCP full control A2 — advertising reads: overview, campaigns, targets, search terms, change log, recommendations.
  ...ADS_READ_TOOLS,
  // Ads autonomy W3-1 — the engines' recommendations carried out by id (one change plan), and muted by id.
  ...ADS_RECOMMENDATION_TOOLS,
  // MCP full control A6–A12 — Claude's further Amazon ad changes (undo first), each approved by a person.
  ...ADS_CHANGE_TOOLS,
  // Phase 3 T5 — campaign target ACoS (one target per market), Nexus only.
  ...ADS_TARGET_ACOS_TOOLS,
  // Ads autonomy W1-2/W1-3 — the Owner's ads strategy per market, category and product: read, and set (raises need the code).
  ...ADS_STRATEGY_TOOLS,
  // Bid brain BB-4 — what the shadow bid brain decides (why this bid, what-if for a target, the shadow vs actual diff), read.
  ...ADS_BID_BRAIN_TOOLS,
  // Ads playbook PB-2 — how a product's ads are built and run (templates, rows per market, category and product), read.
  ...ADS_PLAYBOOK_TOOLS,
  // Ads autonomy W4-1 — the daily Claude ads run reports itself (bell + one e-mail a day), and its history.
  ...ADS_MANAGER_TOOLS,
  ...ADS_CREATE_TOOLS,
  ...ADS_PLAYBOOK_APPLY_TOOLS,
  // Builders for Claude B-3 — a one-off campaign set built by the SP Super Wizard's own launch, born at the floor.
  ...ADS_SP_WIZARD_TOOLS,
  // Ads autonomy B-1 — copy a running structure onto another product with the Replicate Structure builder (born safe).
  ...ADS_REPLICATE_TOOLS,
  // Ads autonomy B-2 — an AI Advertising goal and its campaigns, through the AI Goal builder's own launch (born safe).
  ...ADS_AI_GOAL_TOOLS,
  // Ads autonomy AA-W2-12 — a real pause of Amazon ads, and switching back on what a Claude request paused.
  ...ADS_STATUS_TOOLS,
  ...ADS_BUDGET_PLAN_TOOLS,
  ...ADS_BUDGET_SCHEDULE_TOOLS,
  ...ADS_BUDGET_POOL_TOOLS,
  ...ADS_BUDGET_READ_TOOLS,
  // Ads autonomy W3-3 — stock-aware bids: which ad groups are short of stock; lower their bids, give them back (never FBA).
  ...ADS_STOCK_TOOLS,
  // Ads autonomy W4-3 — portfolios (read; create, rename, cap, archive) and campaign settings (portfolio, name, end
  // date, bidding strategy), through the Portfolios page's and the campaign Details tab's own services.
  ...ADS_PORTFOLIO_TOOLS,
  ...ADS_CAMPAIGN_SETTINGS_TOOLS,
  // Ads autonomy W4-1 — the Hourly Bids page's plans: read one week by week, and change ONE plan (paint, members, switch).
  ...ADS_HOURLY_PLAN_TOOLS,
  // Ads autonomy W4-5 — keywords and product or category targets, harvests and their destination; negatives in the list
  // form, and retiring any negative.
  ...ADS_TARGET_TOOLS,
  ...ADS_NEGATIVE_TOOLS,
  // Ads autonomy W4-6 — ad groups and product ads: read them, create one (born at the floor), add product ads, change one.
  ...ADS_AD_GROUP_TOOLS,
  // Ads autonomy W3-2 — cancel an ad write Nexus queued and has not sent yet (a brake: nothing reaches Amazon).
  ...ADS_QUEUED_WRITE_TOOLS,
  // ADS AUTONOMY — auto-undo (A19): one undo of an automatic change it judged clearly worse, a person decides it.
  ...ADS_AUTO_UNDO_TOOLS,
  ...EBAY_AD_TOOLS,
  // MCP.7 — what became of a queued change (Claude follows up; only a person decides).
  ...APPROVAL_TOOLS,
  // MCP full control C8 — what Claude did in the business (read only).
  ...ACTIVITY_TOOLS,
  // MCP.9 — cross-channel reads: listing issues, channel price and stock, out-of-sync listings.
  ...CHANNEL_TOOLS,
  // MCP.10 — bulk master price and master attribute changes, always approved by a person.
  ...BULK_TOOLS,
  // MCP full control C2 — control tools: they run in the door and ask for changes through the same gate.
  ...CONTROL_TOOLS,
  // MCP full control R6 — every automation, read-only: the 39 of plan part 06 and their rules, plans and schedules.
  ...AUTOMATION_READ_TOOLS,
  // MCP full control 08 S3 — stock reads: per location, ledger, locations and policies, reservations, counts, shared stock, FBA.
  ...STOCK_READ_TOOLS,
  // MCP full control 08 S4 — supply reads: suppliers, purchase orders, inbound shipments, product costs.
  ...SUPPLY_READ_TOOLS,
  // MCP full control 08 S5 — pricing reads: prices with currency, bounds and held rows; rules; promotions; scheduled changes.
  ...PRICING_READ_TOOLS,
  // MCP full control (section 03) — content reads: a family's text and attributes, translation status.
  ...CONTENT_TOOLS,
  // Section 03 — content changes: shared text in any language, always approved by a person, Nexus only.
  ...CONTENT_CHANGE_TOOLS,
  // MCP full control I2/I3 — product identity: where ids disagree, and what an id is (read-only).
  ...IDENTITY_TOOLS,
  // I10 — identity fixes (SKU, barcode, brand, extra listing SKU), Nexus only, always approved by a person.
  ...IDENTITY_FIX_TOOLS,
  // I11 — broken families and duplicate products (safe merges and shell adoption only), always approved by a person.
  ...IDENTITY_MERGE_TOOLS,
  // MCP full control L2 — where each listing lives, its stock and price per market, and its photo plan.
  ...LISTING_READ_TOOLS,
  // MCP full control L3 — the studio's review of a publish (saves nothing) and a publication's result in the business.
  ...PUBLISH_TOOLS,
  // MCP full control L6 — draft listings and a listing's own fields, in Nexus only.
  ...LISTING_CREATE_TOOLS,
  // MCP full control P4 — the business, its channel accounts, their health and its team, read.
  ...PLATFORM_BUSINESS_TOOLS,
  // MCP full control P5 — catalog structure, channel mappings, the image library, saved views and job history, read.
  ...CATALOG_STRUCTURE_TOOLS,
  ...PLATFORM_LIBRARY_TOOLS,
  // MCP full control P6 — reports, the alerts inbox, the audit trail, sync activity and AI usage, read.
  ...REPORT_TOOLS,
  ...PLATFORM_ACTIVITY_TOOLS,
  // Platform health watchdog (2026-10-07) — the daily checks of crons, feeds, ad writes, approvals, automation and queues.
  ...PLATFORM_HEALTH_TOOLS,
  // MCP full control P7 — organizing changes: tags, workflow stage, saved views, alert rules, acknowledging alerts, the image library.
  ...ORGANIZE_CATALOG_TOOLS,
  ...ORGANIZE_PLATFORM_TOOLS,
  // MCP full control P8 — structure changes: attributes, families, categories, channel mappings, listing templates.
  ...STRUCTURE_CHANGE_TOOLS,
  ...MAPPING_CHANGE_TOOLS,
  // MCP full control P10 — the business's own settings and brand.
  ...BUSINESS_SETTINGS_TOOLS,
  // MCP full control R9–R15 — automation changes, each a request a person approves.
  ...AUTOMATION_CHANGE_TOOLS,
  // ADS AUTONOMY W4-8 — engine settings: which campaigns a rule acts on, a coverage set's seed and terms, an engine's Run now.
  ...ADS_ENGINE_SETTINGS_TOOLS,
  // MCP full control 08 S6 — stock changes in Nexus: counts, transfers, stock counts, holds, own warehouses.
  ...STOCK_CHANGE_TOOLS,
  // MCP full control 08 S7 — Sync Control: many listings' stock mode at once; stock policies and location feeds.
  ...STOCK_SYNC_TOOLS,
  // MCP full control 08 S12 — pricing records: pricing rules, promotions, scheduled price changes.
  ...PRICING_CHANGE_TOOLS,
  // MCP full control 08 S11 — prices across many listings: floor and ceiling, bulk listing prices, send prices again.
  ...PRICE_CHANGE_TOOLS,
  // MCP full control 08 S9 — suppliers and purchase orders: keep a supplier, draft, move on and cancel a PO.
  ...SUPPLY_CHANGE_TOOLS,
  // MCP full control 08 S13 — FBA inbound: create the plan at Amazon, read its options (a person confirms them).
  ...FBA_INBOUND_TOOLS,
  // Section 03 phase 2 — content read from the channel itself (Shopify's store fields, a listing's live content).
  ...CHANNEL_CONTENT_TOOLS,
  // MCP full control L8 — stock and price per listing and market, through the Matrix door.
  ...LISTING_STOCK_TOOLS,
  // MCP full control L9 — reversible close and reopen of live listings.
  ...LISTING_CLOSE_TOOLS,
  // MCP full control, phase 3 (T1) — the product page's End, Relist and Delete, each approved by a person in Nexus.
  ...LISTING_LIFECYCLE_TOOLS,
  // MCP full control L10/L11 — a family's photo plan.
  ...PHOTO_TOOLS,
  // MCP full control (09 §4, P-3) — catalog rows into the conversation, money filtered. The import half (P9) is on hold.
  ...DATA_TRANSFER_TOOLS,
  // MCP phase 3 T3 — find an eBay category and read its item specifics and conditions (cached, else live, never stored).
  ...EBAY_CATEGORY_TOOLS,
]
const REGISTRY = new Map<string, AgentTool>(ALL.map((t) => [t.name, t]))

export function getTool(name: string): AgentTool | undefined {
  return REGISTRY.get(name)
}
export function listTools(): AgentTool[] {
  return [...REGISTRY.values()]
}
