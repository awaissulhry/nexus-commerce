# Database Schema

→ [[00 - Nexus Commerce MOC]] | [[01 - System Architecture Overview]]

## Overview

| Property | Value |
|----------|-------|
| ORM | Prisma 6.19.3 |
| Database | PostgreSQL (Neon managed) |
| Schema file | `packages/database/prisma/schema.prisma` (13,423 lines) |
| Total models | **416** |
| Migrations | **310** folders (from `20260422` onwards) |
| Package | `@nexus/database` |

---

## Model Groups

### Products & Variations

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `Product` | id, sku, title, status, familyId | Master product record |
| `ProductVariation` | id, productId, color, size, sku | Child variant of a Product |
| `ProductFamily` | id, name, slug | Groups Products into families |
| `SkuAlias` | id, productId, alias, channel | Per-channel SKU aliases |
| `ProductTag` | id, productId, tag | Tagging system |
| `Bundle` | id, name, sku | Product bundles |
| `BundleComponent` | id, bundleId, productId, qty | Bundle-to-product map |

### Marketplace & Channel

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `Marketplace` | id, code, name, region | e.g. Amazon IT, eBay DE |
| `ChannelListing` | id, productId, marketplaceId, status, externalId | Per-product per-channel listing |
| `VariantChannelListing` | id, variationId, channelListingId | Variant-level channel state |
| `ChannelListingOverride` | id, channelListingId, field, value | Field-level overrides |
| `ChannelConnection` | id, channel, managedBy, credentials | OAuth tokens / env-managed creds (**PRESERVE**) |

> `ChannelConnection` is **preserve-by-default** in all data wipes — it holds live API credentials.

### Inventory & Stock

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `StockLevel` | id, variationId, warehouseId, qty | Current stock quantity |
| `StockMovement` | id, variationId, type, qty, reason | Audit trail of stock changes |
| `StockBin` | id, warehouseId, code | Physical bin location |
| `StockBinQuantity` | id, binId, variationId, qty | Qty per bin |
| `StockReservation` | id, variationId, qty, orderId | Soft/hard reservations |
| `StockCostLayer` | id, variationId, cost, qty | FIFO cost layers |
| `Lot` | id, variationId, lotNumber, expiryDate | EU GPSR lot compliance |
| `SerialNumber` | id, variationId, serial | Serial tracking |
| `StockLog` | id, type, description | System stock log |

### Pricing & Repricing

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `PricingRule` | id, name, type, value | Master pricing rules |
| `PricingRuleProduct` | id, ruleId, productId | Rule → product mapping |
| `RepricingRule` | id, name, conditions, actions | Automated repricing logic |
| `RepricingDecision` | id, ruleId, productId, newPrice, reason | Audit of repricing choices |
| `PriceChangeEvent` | id, productId, oldPrice, newPrice, source | Unified price history |
| `BuyBoxHistory` | id, productId, marketplaceId, price, timestamp | Buy Box price tracking |
| `FxRate` | id, from, to, rate, date | Currency exchange rates |
| `PricingSnapshot` | id, productId, timestamp, data | Point-in-time price snapshot |

### Orders & Fulfillment

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `Order` | id, externalId, channel, status, total | Master order record |
| `OrderItem` | id, orderId, variationId, qty, price | Line items |
| `OrderNote` | id, orderId, note | Internal notes |
| `OrderTag` | id, orderId, tag | Order tagging |
| `OrderRiskScore` | id, orderId, score, factors | Fraud risk scoring |
| `Shipment` | id, orderId, status, carrier, trackingNumber | Shipment record |
| `TrackingEvent` | id, shipmentId, status, timestamp | Tracking updates |
| `ShipmentItem` | id, shipmentId, orderItemId | Items in a shipment |
| `Return` | id, orderId, status, reason | Return record |
| `ReturnItem` | id, returnId, orderItemId, qty | Return line items |
| `Refund` | id, orderId, amount, reason | Refund record |
| `FBAShipment` | id, amazonShipmentId, status | FBA inbound shipment |
| `InboundShipment` | id, warehouseId, status | Internal inbound |
| `WorkOrder` | id, type, status, assignedTo | Warehouse work orders |

### Marketing & Advertising

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `Campaign` | id, name, type, channel, status | Unified marketing campaign |
| `AdGroup` | id, campaignId, name, defaultBid | Ad group |
| `AdTarget` | id, adGroupId, targetType, bid | Keyword / ASIN target |
| `AdProductAd` | id, adGroupId, productId, asin | Product ad creative |
| `MarketingCampaign` | id, name, channel, objective | Higher-level marketing campaign |
| `MarketingCampaignLink` | id, campaignId, contentId | Campaign → content asset |
| `RetailEvent` | id, name, date, channel | Sales events (Prime Day, etc.) |
| `EbayCampaign` | id, externalId, status, budget | eBay-specific campaign |
| `EbayMarkdown` | id, listingId, discountPct, startDate | eBay markdown sale |
| `EbayVolumePromotion` | id, listingId, tiers | eBay volume discount tiers |

### Analytics

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `DailySalesAggregate` | id, date, channel, revenue, units | Daily sales rollup |
| `AmazonAdsHourlyPerformance` | id, campaignId, hour, impressions, clicks, spend | Hourly ad metrics |
| `AmazonAdsDailyPerformance` | id, campaignId, date, acos, roas | Daily ad metrics |
| `AmazonAdsSearchTerm` | id, campaignId, term, clicks, conversions | Search term report |
| `ProductProfitDaily` | id, productId, date, revenue, cogs, profit | Per-SKU profit |
| `CampaignMetric` | id, campaignId, date, impressions, clicks | Generic campaign metrics |

### Content & Assets

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `DigitalAsset` | id, url, type, cloudinaryId | DAM asset record |
| `AssetFolder` | id, name, parentId | DAM folder tree |
| `AssetUsage` | id, assetId, entityId, entityType | Where assets are used |
| `ProductImage` | id, productId, url, isPrimary, slot | Product-level image |
| `ChannelListingImage` | id, channelListingId, url, position | Channel-specific image |
| `ChannelLiveImage` | id, channelListingId, url, fetchedAt | Current live image from channel |
| `ListingImage` | id, listingId, url | Listing image |
| `APlusContent` | id, productId, marketplaceId, modules | A+ Content blocks |
| `BrandStory` | id, brandId, content, status | Amazon Brand Story |
| `BrandKit` | id, brandId, colors, fonts, logos | Brand identity kit |

### Listing Management

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `Listing` | id, productId, channelId, status | Channel listing record |
| `DraftListing` | id, productId, channelId, data | Draft before publish |
| `ListingWizard` | id, productId, step, data | Wizard in-progress state |
| `ListingIssue` | id, listingId, code, severity, message | Listing health issue |
| `ListingRecoveryEvent` | id, listingId, action, result | Recovery action log |
| `ListingReconciliation` | id, listingId, source, target, diff | Reconciliation audit |
| `ListingQualitySnapshot` | id, listingId, score, timestamp | Quality score history |

### Customer & Reviews

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `Customer` | id, email, name, channel, externalId | Customer record |
| `CustomerSegment` | id, name, rules | RFM / custom segments |
| `CustomerAddress` | id, customerId, type, address | Shipping/billing addresses |
| `CustomerNote` | id, customerId, note | Internal CRM notes |
| `Review` | id, productId, channel, rating, body | Product review |
| `ReviewResponse` | id, reviewId, body, status | Brand response |
| `ReviewRequest` | id, orderId, status, sentAt | Review solicitation |
| `ReviewRule` | id, name, trigger, delay, template | Review request automation rule |
| `ReviewSpotlight` | id, reviewId, featured | Curated spotlight reviews |
| `ReviewSentiment` | id, reviewId, score, topics | AI sentiment analysis |

### Purchase Orders

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `PurchaseOrder` | id, supplierId, status, total | PO record |
| `PurchaseOrderItem` | id, poId, variationId, qty, cost | PO line items |
| `PurchaseOrderRevision` | id, poId, version, changes | Version history |
| `PurchaseOrderAttachment` | id, poId, url, type | PO file attachments |
| `PoComment` | id, poId, userId, comment | Collaboration comments |
| `PoTemplate` | id, name, supplierId, items | Reusable PO template |
| `PoSchedule` | id, templateId, cronExpression | Recurring PO schedule |

### System & Sync

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `OutboundSyncQueue` | id, channel, entityId, status, attempts | Publish job queue |
| `ChannelStockEvent` | id, channel, variationId, delta, source | Stock change events |
| `SyncLog` | id, channel, type, status, payload | Sync audit log |
| `SyncError` | id, syncLogId, message, stack | Sync error detail |
| `AmazonImageFeedJob` | id, feedId, status, productId | Amazon image feed status |
| `AmazonFlatFileFeedJob` | id, feedId, status | Flat file submission tracking |
| `ChannelImagePublishJob` | id, channelListingId, status | Image publish job |

### Financial & Fiscal

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `FiscalInvoice` | id, orderId, number, total, vatAmount | Italian fiscal invoice |
| `CreditNote` | id, invoiceId, amount, reason | Credit note |
| `FinancialTransaction` | id, orderId, type, amount, currency | Transaction record |
| `SettlementReport` | id, period, channel, data | Settlement report |
| `FbaReimbursement` | id, externalId, amount, reason | FBA reimbursement |
| `FbaInventoryAdjustment` | id, sku, qty, reason | FBA inventory adj |
| `FbaInventoryDetail` | id, sku, asin, qty, warehouseId | FBA inventory snapshot |

### AI & Agents

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `AgentDefinition` | id, name, tools, systemPrompt | AI agent spec |
| `AgentRun` | id, agentId, input, output, status | Agent execution record |
| `AgentTool` | id, agentId, name, schema | Tool definition |
| `AiUsageLog` | id, model, tokens, cost, purpose | LLM cost tracking |
| `PromptTemplate` | id, name, template, variables | Reusable prompt templates |
| `AdsRuleSuggestion` | id, type, suggestion, confidence | AI-generated ads suggestions |

---

## Key Enums (28 total)

| Enum | Values |
|------|--------|
| `FulfillmentMethod` | `FBA`, `FBM` |
| `CampaignType` | `SP`, `SB`, `SD`, `DSP` |
| `CampaignStatus` | `ENABLED`, `PAUSED`, `ARCHIVED`, `DRAFT` |
| `BiddingStrategy` | `LEGACY_FOR_SALES`, `AUTO_FOR_SALES`, `MANUAL` |
| `SyncChannel` | `AMAZON`, `EBAY`, `SHOPIFY`, `WOOCOMMERCE`, `GOOGLE`, `META`, `TIKTOK` |
| `OrderStatus` | Multiple channel-specific statuses |
| `ShipmentStatus` | `WORKING`, `SHIPPED`, `IN_TRANSIT`, `RECEIVING`, `CLOSED` |
| `PurchaseOrderStatus` | `DRAFT`, `PENDING`, `APPROVED`, `RECEIVED`, `CANCELLED` |
| `RefundKind` | `FULL`, `PARTIAL`, `REPLACEMENT` |
| `ReviewRequestStatus` | `PENDING`, `SENT`, `OPENED`, `RESPONDED`, `SUPPRESSED` |
| `MktChannel` | `AMAZON`, `EBAY`, `SHOPIFY`, `EXTERNAL` |
| `MktObjective` | `AWARENESS`, `CONSIDERATION`, `CONVERSION`, `RETENTION` |
| `MktStatus` | `DRAFT`, `ACTIVE`, `PAUSED`, `COMPLETED` |

---

## Important Schema Notes

1. **Prisma `DateTime`** maps to Postgres `timestamp` (no TZ). Use `AT TIME ZONE 'UTC' AT TIME ZONE 'Rome'` for Italian locale — single `AT TZ 'Rome'` INVERTS the conversion.
2. **`ChannelConnection`** — preserve in all data wipes; holds live channel credentials.
3. **`categoryAttributes.variations`** vs `variantAttributes` — old bulk-create products keep Color/Size in `categoryAttributes.variations`; resolvers must fall back or images/variants don't map.
4. **FulfillmentMethod** — `FBA` vs `FBM` per `ChannelListing`; FBA→FBM flip guard is a hard fail-closed gate.

---

## Related Notes

- [[04 - API Layer (Fastify)]] — services that read/write these models
- [[17 - Inventory & Fulfillment]] — Stock/FBA/FBM domain
- [[18 - Orders & Sales]] — Order domain
- [[20 - Advertising]] — Campaign/AdGroup domain
