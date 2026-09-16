# AE.0 item 1 — product closure (derived by classify.py from schema.json / closure_raw.json)

Schema: packages/database/prisma/schema.prisma (437 models). Closure = 121 models: 61 with a declared FK to Product/ProductVariation, 34 with only an un-related id column (*productId/*variationId/*variantId), 26 one hop further (declared FK to a hop-1 model).

Counts: A=13  B=101  C=7  (ambiguous flagged: 13)

## A — product definition that could FOLLOW

| Model | owner | schema line | how it references | reason |
|---|---|---|---|---|
| AssetUsage | workspace | 1145 | direct-FK productId->Product@1158 | DAM link Product<->DigitalAsset (role/sortOrder); needs DigitalAsset (+AssetFolder) in follower |
| Bundle | workspace | 12171 | soft-col productId@12175 | AMBIGUOUS: bundle definition (structure) but carries computedCostCents (cost = per profile) |
| BundleComponent | workspace | 12189 | soft-col productId@12194 | AMBIGUOUS: bundle components (structure) but carries unitCostCents; component productIds must be linked too |
| ListingImage | workspace | 8578 | direct-FK productId->Product@8648;variationId->ProductVariation@8649 | AMBIGUOUS: scope=GLOBAL rows are product media; PLATFORM/MARKETPLACE rows + publishStatus/publishedAt are per-channel listing state |
| ProductCategory | workspace | 15402 | direct-FK productId->Product@15410 | AMBIGUOUS: taxonomy membership; Category is a per-profile tree (Category/CategoryClosure/CategoryChannelMapping) so needs a category match key |
| ProductCertificate | workspace | 13616 | direct-FK productId->Product@13621 | compliance certificates (certType/number/standard/fileUrl) |
| ProductImage | workspace | 2437 | direct-FK productId->Product@2441 | master media (url, publicId, contentHash, ordering) |
| ProductRelation | workspace | 13538 | direct-FK fromProductId->Product@13542;toProductId->Product@13544 | AMBIGUOUS: product structure (CROSS_SELL/BUNDLE_PART/UPSELL); follows only if BOTH endpoints are linked in the follower |
| ProductSeo | workspace | 13569 | direct-FK productId->Product@13574 | SEO content per locale (metaTitle, urlHandle, schemaOrgJson) |
| ProductTag | workspace | 12156 | soft-col productId@12159 | AMBIGUOUS: tag membership; Tag is per-profile and shared with OrderTag/AssetTag |
| ProductTranslation | workspace | 13497 | direct-FK productId->Product@13501 | translations of name/description/bullets/keywords/attributes per language |
| SkuAlias | workspace | 471 | direct-FK productId->Product@476 | AMBIGUOUS: identifier aliases for import matching (MANUAL/IMPORT/AUTO); identity-like but an import aid |
| VariantImage | workspace | 1430 | direct-FK variantId->ProductVariation@1434 | legacy per-variation media (url/alt/sortOrder) |

## B — per-profile business data, NEVER copied

| Model | owner | schema line | how it references | reason |
|---|---|---|---|---|
| APlusContentAsin | workspace | 8290 | direct-FK productId->Product@8297 | AMBIGUOUS-B: A+ document attached to an ASIN (brand/seller-account scoped); product-level A+ JSON is Product.aPlusContent |
| AdProductAd | workspace | 3315 | direct-FK productId->Product@3322 | ad-group <-> product |
| AdProductSet | workspace | 3367 | soft-col productIds@3376 | ads product set (productIds[]) |
| AmazonImageFeedJob | workspace | 8701 | direct-FK productId->Product@8719 | image feed job |
| AmazonMediaRun | workspace | 8681 | soft-col productId@8685 | account/listing-scoped media run |
| AmazonReviewInsight | workspace | 12504 | direct-FK productId->Product@12511 | Amazon review aggregate per ASIN |
| AmazonSuppression | workspace | 2219 | hop2 listingId->ChannelListing@2224 | channel suppression lifecycle (hop2) |
| AutomationRule | workspace | 14554 | soft-col scopeProductId@14661 | automation rule (scopeProductId) |
| AutomationRuleExecution | workspace | 14746 | hop2 ruleId->AutomationRule@14751 | automation run (hop2) |
| BulkActionItem | workspace | 2943 | soft-col productId@2953;variationId@2954 | bulk job item |
| BulkActionJob | workspace | 2868 | soft-col targetProductIds@2879;targetVariationIds@2880 | bulk job (targetProductIds[]) |
| BuyBoxHistory | workspace | 6388 | direct-FK productId->Product@6392 | buy box observations |
| CampaignRuleAssignment | workspace | 14707 | hop2 ruleId->AutomationRule@14720 | campaign<->rule (hop2) |
| CatalogOrganizeChange | workspace | 15142 | soft-col productId@15151 | catalog reparent session change/undo log |
| CellFormula | workspace | 18851 | direct-FK productId->Product@18856 | AMBIGUOUS-B: per-product formula scoped to channel/market/channelConnectionId/alias |
| ChannelImagePublishJob | workspace | 8813 | direct-FK productId->Product@8838 | image publish job |
| ChannelListing | workspace | 1510 | direct-FK productId->Product@1518 | channel listing (price, qty, overrides, external ids) |
| ChannelListingClaim | GLOBAL | 19106 | hop2 channelListingId->ChannelListing@19125 | GLOBAL table: listing exclusivity lock on a shared account (hop2) |
| ChannelListingImage | workspace | 2404 | direct-FK productId->Product@2412 | per-listing image set |
| ChannelListingOverride | workspace | 1997 | hop2 channelListingId->ChannelListing@2003 | listing override history (hop2) |
| ChannelListingSnapshot | workspace | 1891 | hop2 channelListingId->ChannelListing@1896 | listing snapshot/restore (hop2) |
| ChannelListingTranslation | workspace | 19184 | hop2 channelListingId->ChannelListing@19188 | AMBIGUOUS-B: listing-level language pins (hop2); §3.4 says channel overrides never shared |
| ChannelLiveImage | workspace | 5188 | direct-FK productId->Product@5192 | read-replica of channel images |
| ChannelPublishAttempt | workspace | 13659 | direct-FK productId->Product@13672 | publish push log |
| ChannelStockEvent | workspace | 5235 | direct-FK productId->Product@5249 | channel-reported stock drift |
| CycleCountItem | workspace | 11312 | soft-col productId@11323;variationId@11324 | cycle count line |
| DevelopmentAttachment | workspace | 17136 | hop2 projectId->DevelopmentProject@17151 | R&D attachments (hop2) |
| DevelopmentCertification | workspace | 17161 | hop2 projectId->DevelopmentProject@17178 | AMBIGUOUS-B: R&D-stage certification (hop2); launched product compliance lives in ProductCertificate |
| DevelopmentProject | workspace | 17080 | soft-col linkedProductId@17092 | R&D project (linkedProductId) |
| DevelopmentProjectSupplier | workspace | 17113 | hop2 projectId->DevelopmentProject@17125 | R&D sourcing (hop2) |
| DraftListing | workspace | 2676 | direct-FK productId->Product@2682 | eBay draft listing |
| EbayAd | workspace | 13912 | soft-col productId@13938 | eBay promoted listing |
| EbayMarkdown | workspace | 14358 | hop2 channelListingId->ChannelListing@14364 | eBay promotion (hop2) |
| EbayWatcherStats | workspace | 14335 | hop2 channelListingId->ChannelListing@14341 | eBay listing stats (hop2) |
| FBAShipmentItem | workspace | 2735 | direct-FK productId->Product@2741 | FBA shipment line |
| FbaInventoryDetail | workspace | 9526 | direct-FK productId->Product@9545 | FBA per-FC inventory |
| FbaStorageAge | workspace | 4284 | direct-FK productId->Product@4289 | FBA aged-inventory snapshot |
| FieldLinkGroup | workspace | 2044 | direct-FK productId->Product@2048 | AMBIGUOUS-B: per-product link of one field across channel/market coordinates (members JSON); coordinate config, not content |
| GtinExemptionApplication | workspace | 7808 | soft-col productIds@7813 | Amazon GTIN exemption application (brand+marketplace, productIds[]) |
| InboundDiscrepancy | workspace | 10679 | hop2 inboundShipmentItemId->InboundShipmentItem@10710 | inbound discrepancy (hop2) |
| InboundReceipt | workspace | 10780 | hop2 inboundShipmentItemId->InboundShipmentItem@10801 | inbound receipt (hop2) |
| InboundShipment | workspace | 10562 | hop2 workOrderId->WorkOrder@10623 | inbound shipment (hop2 via WorkOrder) |
| InboundShipmentItem | workspace | 10719 | soft-col productId@10724 | inbound receiving line (soft productId) |
| Listing | workspace | 2654 | direct-FK productId->Product@2658 | legacy channel listing |
| ListingIssue | workspace | 2251 | hop2 listingId->ChannelListing@2256 | channel validation issues (hop2) |
| ListingReconciliation | workspace | 14990 | soft-col matchedProductId@15008;matchedVariationId@15009 | channel listing import matching |
| ListingRecoveryEvent | workspace | 2338 | direct-FK productId->Product@2344 | delete/recreate recovery flow on a channel |
| ListingWizard | workspace | 7867 | direct-FK productId->Product@7913 | listing-creation wizard state per channel |
| Lot | workspace | 9336 | direct-FK productId->Product@9357;variationId->ProductVariation@9358 | lot/batch stock |
| LotRecall | workspace | 9460 | hop2 lotId->Lot@9475 | lot recall (hop2) |
| MarketplaceSync | workspace | 2623 | direct-FK productId->Product@2627 | per-channel sync status |
| Offer | workspace | 2282 | hop2 channelListingId->ChannelListing@2288 | channel offer (price/qty) (hop2) |
| OrderItem | workspace | 5867 | direct-FK productId->Product@5877 | order line |
| OutboundApiCallLog | workspace | 11564 | soft-col productId@11604 | outbound API call log |
| OutboundSyncQueue | workspace | 6821 | direct-FK productId->Product@6829 | channel push queue |
| PoTemplateItem | workspace | 10504 | soft-col productId@10509 | PO template line |
| PriceChangeEvent | workspace | 6332 | direct-FK productId->Product@6336 | price history per coordinate |
| PricingRuleProduct | workspace | 2782 | direct-FK productId->Product@2788 | pricing rule membership |
| PricingRuleVariation | workspace | 2800 | direct-FK variationId->ProductVariation@2806 | pricing rule membership |
| ProductAiDraft | workspace | 12897 | soft-col productId@12903 | pending AI cell draft awaiting operator decision |
| ProductListingAlias | workspace | 1820 | direct-FK productId->Product@1827 | channel alias per connection (channelConnectionId) |
| ProductRankPlan | workspace | 16852 | soft-col productId@16858 | ads rank plan |
| ProductSubstitution | workspace | 11828 | direct-FK primaryProductId->Product@11839;substituteProductId->Product@11840 | AMBIGUOUS-B: stock-substitution fallback A->B with substitutionFraction (replenishment/stock policy), both endpoints products |
| ProductTierPrice | workspace | 969 | direct-FK productId->Product@974 | B2B tier price (price = per profile) |
| PurchaseOrder | workspace | 10227 | hop2 developmentProjectId->DevelopmentProject@10235 | PO (hop2 via DevelopmentProject) |
| PurchaseOrderItem | workspace | 10321 | soft-col productId@10326 | PO line |
| RankTarget | workspace | 16773 | soft-col scopeProductId@16821 | ads rank target (scopeProductId) |
| ReplenishmentRule | workspace | 11110 | soft-col productId@11114 | reorder settings |
| RepricingDecision | workspace | 1274 | hop2 ruleId->RepricingRule@1279 | repricer decisions (hop2) |
| RepricingRule | workspace | 1207 | direct-FK productId->Product@1212 | repricer per channel/market |
| ReturnItem | workspace | 10926 | soft-col productId@10932 | return line |
| Review | workspace | 12256 | direct-FK productId->Product@12267 | channel reviews |
| ReviewActionItem | workspace | 12376 | soft-col productId@12381 | review-driven action item |
| ReviewResponse | workspace | 12326 | hop2 reviewId->Review@12331 | review reply (hop2) |
| ReviewSentiment | workspace | 12407 | hop2 reviewId->Review@12412 | review sentiment (hop2) |
| ReviewSpike | workspace | 12468 | direct-FK productId->Product@12473 | review spike alert |
| ReviewSpotlight | workspace | 12354 | soft-col productId@12358 | AI VoC brief |
| ScheduledBulkAction | workspace | 7124 | soft-col targetProductIds@7156;targetVariationIds@7157 | scheduled bulk job |
| ScheduledImagePublish | workspace | 7943 | direct-FK productId->Product@7949 | scheduled image publish per channel |
| ScheduledProductChange | workspace | 14492 | direct-FK productId->Product@14497 | scheduled price/field change (kind=price today) |
| ScheduledWizardPublish | workspace | 7984 | hop2 wizardId->ListingWizard@7990 | scheduled publish of a wizard (hop2) |
| SerialNumber | workspace | 9377 | direct-FK productId->Product@9399;variationId->ProductVariation@9400 | serial stock units |
| SharedListingMembership | workspace | 17265 | soft-col productId@17273 | eBay shared-variant SKU -> ItemID fan-out (connection) |
| ShipmentItem | workspace | 10003 | soft-col productId@10009 | shipment line |
| StockBinQuantity | workspace | 9439 | hop2 stockLevelId->StockLevel@9448 | bin quantities (hop2) |
| StockCostLayer | workspace | 9268 | direct-FK productId->Product@9311 | FIFO cost layers |
| StockLevel | workspace | 9109 | direct-FK productId->Product@9130;variationId->ProductVariation@9131 | stock per location |
| StockLog | workspace | 2705 | direct-FK productId->Product@2709 | legacy stock log |
| StockMovement | workspace | 9193 | soft-col productId@9197;variationId@9198 | stock ledger (soft productId) |
| StockReservation | workspace | 9153 | hop2 stockLevelId->StockLevel@9174 | stock holds (hop2) |
| StockoutEvent | workspace | 11866 | direct-FK productId->Product@11902 | stockout episode |
| SupplierProduct | workspace | 10178 | soft-col productId@10183 | supplier cost/lead time per product (supplier is per profile) |
| SyncAttempt | workspace | 2180 | hop2 listingId->ChannelListing@2185 | listing sync attempt (hop2) |
| SyncHealthLog | workspace | 2818 | direct-FK productId->Product@2833;variationId->ProductVariation@2835 | sync health errors |
| SyncLog | workspace | 5329 | direct-FK productId->Product@5333 | sync run log |
| VariantChannelListing | workspace | 1449 | direct-FK variantId->ProductVariation@1453 | legacy per-variant channel listing |
| WizardStepEvent | workspace | 8039 | direct-FK productId->Product@8070 | wizard telemetry |
| WorkOrder | workspace | 10809 | soft-col productId@10813 | manufacturing work order |
| WorkflowAssignment | workspace | 895 | direct-FK productId->Product@900 | workflow assignee |
| WorkflowComment | workspace | 868 | direct-FK productId->Product@873 | workflow discussion |
| WorkflowTransition | workspace | 843 | direct-FK productId->Product@848 | workflow history (stage = per profile per §3.4) |

## C — derived / cache (recompute in follower)

| Model | owner | schema line | how it references | reason |
|---|---|---|---|---|
| EbayListingEconomics | workspace | 14128 | soft-col productId@14135 | margin read model per live listing |
| EbayListingIndex | workspace | 14082 | soft-col productIds@14106 | ads-side index of live eBay listings |
| ListingQualitySnapshot | workspace | 15513 | direct-FK productId->Product@15518 | quality score snapshots |
| ProductProfitDaily | workspace | 4322 | direct-FK productId->Product@4327 | pre-aggregated daily P&L roll-up (analytics; recomputed) |
| ReadinessIndex | workspace | 19208 | direct-FK productId->Product@19212 | materialized readiness per coordinate (LX.5) |
| ReplenishmentRecommendation | workspace | 11151 | direct-FK productId->Product@11249 | generated reorder recommendation (snapshot) |
| ReviewCategoryRate | workspace | 12444 | soft-col productId@12448 | rolling counters derived from reviews |

## Outside the FK/column closure but still product-bound (not counted above)

Polymorphic or id-mirror references (all B/C, never copied):
- ProductEvent @15474 aggregateId/aggregateType "Product" (B: event log)
- AuditLog @8151 entityType "Product" (B)
- AgentFinding @17912 entityType PRODUCT (B)
- GraphEdge @18101 fromType/toType (B/C)
- Notification @13399 entityType (B)
- SyncError @5368 context Json "(product ID, variant ID)" (B)
- ProductReadCache @15192 id mirrors Product.id, no FK (C: read cache)
- AdProductGoal @16964 products Json (B: ads)

Keyed by SKU/ASIN text, no product id (all B/C): AdsConsoleRow(C), AmazonEconomicsDaily, DailySalesAggregate, FbaInventoryAdjustment, FbaReimbursement, FbaRestockRow, ForecastAccuracy, ForecastModelAssignment, KeywordRank, PricingSnapshot, ReplenishmentForecast, SearchQueryPerformance, SqpReportRequest (B).

Definition DEPENDENCIES a followed product points at (must exist/match in the follower; all workspace-owned):
- ProductFamily @541 (Product.familyId @160, SetNull) -> ProductFamily.parentFamilyId @555, ProductFamily.workflowId -> ProductWorkflow @572
- FamilyAttribute @~722 (familyId, attributeId) -> CustomAttribute (groupId -> AttributeGroup @645) -> AttributeOption @676
- WorkflowStage @791 (Product.workflowStageId @173) -> ProductWorkflow @765  [plan §3.4: workflow stage = keep per profile]
- Category @15326 (+CategoryClosure @15390, CategoryChannelMapping @18787) via ProductCategory
- Tag @12111 via ProductTag (also OrderTag, AssetTag)
- DigitalAsset @1027 (+AssetFolder @1106, AssetLocaleOverlay @8531, AssetTag @12147) via AssetUsage
- Product self-relations: parentId @254/255 (variation family as child Products), masterProductId @278
