BEGIN;
-- Historical migrations used custom index names and UNIQUE constraints in several
-- tables. Accept those deployed definitions as well as Prisma-created baselines;
-- every natural key is recreated with workspace ownership below, in this transaction.
-- A constant column default assigns existing rows without issuing UPDATEs: immutable
-- audit records and historical timestamps stay intact. Each default is then changed
-- to the verified request context for future inserts, before this transaction commits.
-- DropForeignKey
ALTER TABLE "BrandWatermarkTemplate" DROP CONSTRAINT "BrandWatermarkTemplate_brand_fkey";

-- DropIndex
DROP INDEX "Product_sku_key";

-- DropIndex
DROP INDEX "SkuAlias_alias_key";

-- DropIndex
DROP INDEX "ProductFamily_code_key";

-- DropIndex
DROP INDEX "AttributeGroup_code_key";

-- DropIndex
DROP INDEX "CustomAttribute_code_key";

-- DropIndex
DROP INDEX "AttributeOption_attributeId_code_key";

-- DropIndex
DROP INDEX "FamilyAttribute_familyId_attributeId_key";

-- DropIndex
DROP INDEX "ProductWorkflow_code_key";

-- DropIndex
DROP INDEX "WorkflowStage_workflowId_code_key";

-- DropIndex
DROP INDEX "WorkflowAssignment_productId_assigneeId_role_key";

-- DropIndex
DROP INDEX "CustomerGroup_code_key";

-- DropIndex
DROP INDEX "ProductTierPrice_productId_minQty_customerGroupId_key";

-- DropIndex
DROP INDEX "DigitalAsset_code_key";

-- DropIndex
DROP INDEX "DigitalAsset_contentHash_key";

-- DropIndex
DROP INDEX "AssetUsage_assetId_scope_productId_role_sortOrder_key";

-- DropIndex
DROP INDEX "RepricingRule_productId_channel_marketplace_key";

-- DropIndex
DROP INDEX "ProductVariation_sku_key";

-- DropIndex
DROP INDEX "VariantChannelListing_variantId_channelId_key";

-- DropIndex
DROP INDEX "VariantChannelListing_variantId_channel_marketplace_conn_key";

-- DropIndex
DROP INDEX "ChannelListing_productId_channelMarket_akey_key";

-- DropIndex
DROP INDEX "ChannelListing_productId_channel_marketplace_akey_key";

-- DropIndex
DROP INDEX "ProductListingAlias_coord_position_key";

-- DropIndex
DROP INDEX "Marketplace_channel_code_key";

-- DropIndex
DROP INDEX "FieldValueMap_channel_marketplace_attribute_fromValue_key";

-- DropIndex
DROP INDEX "SizeScaleMap_scale_fromSystem_toSystem_fromValue_key";

-- DropIndex
DROP INDEX "MappingRevision_channel_code_version_key";

-- DropIndex
DROP INDEX "ListingIssue_listingId_fingerprint_key";

-- DropIndex
DROP INDEX "Offer_channelListingId_fulfillmentMethod_key";

-- DropIndex
DROP INDEX "ProductImage_productId_contentHash_key";

-- DropIndex
DROP INDEX "MarketplaceSync_productId_channel_key";

-- DropIndex
DROP INDEX "Listing_productId_channelId_key";

-- DropIndex
DROP INDEX "FBAShipment_shipmentId_key";

-- DropIndex
DROP INDEX "PricingRuleProduct_ruleId_productId_key";

-- DropIndex
DROP INDEX "PricingRuleVariation_ruleId_variationId_key";

-- DropIndex
DROP INDEX "Campaign_externalCampaignId_marketplace_key";

-- DropIndex
DROP INDEX "AdGroup_externalAdGroupId_campaignId_key";

-- DropIndex
DROP INDEX "AdProductAd_adGroupId_asin_key";

-- DropIndex
DROP INDEX "AdProductSet_channel_marketplace_name_key";

-- DropIndex
ALTER TABLE "AmazonAdsConnection" DROP CONSTRAINT IF EXISTS "AmazonAdsConnection_profileId_key";
DROP INDEX IF EXISTS "AmazonAdsConnection_profileId_key";

-- DropIndex
ALTER TABLE "AmazonAdsProfile" DROP CONSTRAINT IF EXISTS "AmazonAdsProfile_profileId_key";
DROP INDEX IF EXISTS "AmazonAdsProfile_profileId_key";

-- DropIndex
DROP INDEX "KeywordWatchlist_marketplace_name_key";

-- DropIndex
DROP INDEX "KeywordWatchlistTerm_watchlistId_term_key";

-- DropIndex
DROP INDEX "KeywordCoverageSet_portfolioId_marketplace_name_key";

-- DropIndex
DROP INDEX "KeywordCoverageTerm_setId_term_key";

-- DropIndex
ALTER TABLE "AmazonAdsPortfolio" DROP CONSTRAINT IF EXISTS "AmazonAdsPortfolio_profileId_externalPortfolioId_key";
DROP INDEX IF EXISTS "AmazonAdsPortfolio_profileId_externalPortfolioId_key";

-- DropIndex
ALTER TABLE "AmazonAdsDailyPerformance" DROP CONSTRAINT IF EXISTS "AmazonAdsDailyPerformance_unique";
DROP INDEX IF EXISTS "AmazonAdsDailyPerformance_unique";
DROP INDEX IF EXISTS "AmazonAdsDailyPerformance_profileId_adProduct_entityType_en_key";

-- DropIndex
DROP INDEX "AmazonAdsHourlyPerformance_entity_date_hour_key";

-- DropIndex
DROP INDEX "AdBudgetUsageSample_reading_key";

-- DropIndex
DROP INDEX IF EXISTS "SearchQueryPerformance_mkt_period_date_query_asin_key";
DROP INDEX IF EXISTS "SearchQueryPerformance_marketplace_reportPeriod_startDate_s_key";

-- DropIndex
ALTER TABLE "AmazonAdsPlacementReport" DROP CONSTRAINT IF EXISTS "AmazonAdsPlacementReport_unique";
DROP INDEX IF EXISTS "AmazonAdsPlacementReport_unique";
DROP INDEX IF EXISTS "AmazonAdsPlacementReport_campaignId_date_placement_key";

-- DropIndex
DROP INDEX IF EXISTS "AmazonEconomicsDaily_mkt_date_childAsin_msku_key";
DROP INDEX IF EXISTS "AmazonEconomicsDaily_marketplaceId_date_childAsin_msku_key";

-- DropIndex
ALTER TABLE "AmazonAdsBrandMetric" DROP CONSTRAINT IF EXISTS "AmazonAdsBrandMetric_unique";
DROP INDEX IF EXISTS "AmazonAdsBrandMetric_unique";
DROP INDEX IF EXISTS "AmazonAdsBrandMetric_profileId_brandName_date_key";

-- DropIndex
DROP INDEX IF EXISTS "AmazonAdsBrandBuildingMetric_profile_brand_date_lookback_cat_ke";
DROP INDEX IF EXISTS "AmazonAdsBrandBuildingMetric_profileId_brandName_computatio_key";

-- DropIndex
DROP INDEX "FbaStorageAge_sku_marketplace_polledAt_key";

-- DropIndex
DROP INDEX "ProductProfitDaily_productId_marketplace_date_key";

-- DropIndex
DROP INDEX "AdDrift_entityType_entityId_field_key";

-- DropIndex
DROP INDEX "BudgetPoolAllocation_budgetPoolId_marketplace_campaignId_key";

-- DropIndex
DROP INDEX "BudgetPoolAllocation_campaignId_key";

-- DropIndex
DROP INDEX "NotificationPreference_userId_eventType_key";

-- DropIndex
DROP INDEX "WebhookEvent_channel_externalId_key";

-- DropIndex
DROP INDEX IF EXISTS "ChannelLiveImage_productId_channel_marketplace_externalSku_slot";
DROP INDEX IF EXISTS "ChannelLiveImage_productId_channel_marketplace_externalSku__key";

-- DropIndex
DROP INDEX "ChannelStockEvent_channel_channelEventId_key";

-- DropIndex
DROP INDEX "RateLimitLog_channel_endpoint_resetAt_key";

-- DropIndex
DROP INDEX "Order_channel_channelOrderId_key";

-- DropIndex
DROP INDEX "Customer_email_key";

-- DropIndex
DROP INDEX "CustomerSegment_name_key";

-- DropIndex
DROP INDEX IF EXISTS "FiscalInvoice_year_seq_key";
DROP INDEX IF EXISTS "FiscalInvoice_issuer_fiscalYear_sequenceNumber_key";

-- DropIndex
DROP INDEX "CreditNote_issuer_fiscalYear_sequenceNumber_key";

-- DropIndex
DROP INDEX "OrderItem_orderId_externalLineItemId_key";

-- DropIndex
DROP INDEX "DailySalesAggregate_sku_channel_marketplace_day_key";

-- DropIndex
DROP INDEX IF EXISTS "ReplenishmentForecast_sku_channel_marketplace_horizonDay_model_";
DROP INDEX IF EXISTS "ReplenishmentForecast_sku_channel_marketplace_horizonDay_mo_key";

-- DropIndex
DROP INDEX "ForecastModelAssignment_sku_modelId_key";

-- DropIndex
DROP INDEX "ForecastAccuracy_sku_channel_marketplace_day_key";

-- DropIndex
DROP INDEX IF EXISTS "PricingSnapshot_sku_channel_marketplace_fm_key";
DROP INDEX IF EXISTS "PricingSnapshot_sku_channel_marketplace_fulfillmentMethod_key";

-- DropIndex
DROP INDEX "FxRate_fromCurrency_toCurrency_asOf_key";

-- DropIndex
DROP INDEX "SettlementReport_reportId_key";

-- DropIndex
DROP INDEX "ConnectionScope_connectionId_kind_externalId_key";

-- DropIndex
DROP INDEX "ImportJobRow_jobId_rowIndex_key";

-- DropIndex
DROP INDEX IF EXISTS "CategorySchema_channel_marketplace_productType_schemaVersion_ke";
DROP INDEX IF EXISTS "CategorySchema_channel_marketplace_productType_schemaVersio_key";

-- DropIndex
ALTER TABLE "ListingWizard" DROP CONSTRAINT IF EXISTS "ListingWizard_productId_channelsHash_status_key";
DROP INDEX IF EXISTS "ListingWizard_productId_channelsHash_status_key";

-- DropIndex
DROP INDEX "APlusContentVersion_contentId_version_key";

-- DropIndex
DROP INDEX "BrandStory_brand_marketplace_locale_key";

-- DropIndex
DROP INDEX "BrandStoryVersion_storyId_version_key";

-- DropIndex
DROP INDEX "BrandKit_brand_key";

-- DropIndex
DROP INDEX "AssetLocaleOverlay_assetId_locale_key";

-- DropIndex
DROP INDEX "AmazonFlatFileFeedJob_feedId_key";

-- DropIndex
ALTER TABLE "Warehouse" DROP CONSTRAINT IF EXISTS "Warehouse_code_key";
DROP INDEX IF EXISTS "Warehouse_code_key";

-- DropIndex
DROP INDEX "StockLocation_code_key";

-- DropIndex
DROP INDEX IF EXISTS "StockLevel_loc_prod_novar_unique";
DROP INDEX IF EXISTS "StockLevel_loc_prod_var_unique";
DROP INDEX IF EXISTS "StockLevel_locationId_productId_variationId_key";

-- DropIndex
DROP INDEX IF EXISTS "Lot_product_lotNumber_key";
DROP INDEX IF EXISTS "Lot_productId_lotNumber_key";

-- DropIndex
DROP INDEX IF EXISTS "SerialNumber_product_serial_key";
DROP INDEX IF EXISTS "SerialNumber_productId_serialNumber_key";

-- DropIndex
DROP INDEX IF EXISTS "StockBin_location_code_key";
DROP INDEX IF EXISTS "StockBin_locationId_code_key";

-- DropIndex
DROP INDEX IF EXISTS "StockBinQuantity_stockLevel_bin_key";
DROP INDEX IF EXISTS "StockBinQuantity_stockLevelId_binId_key";

-- DropIndex
DROP INDEX "YearEndSnapshot_year_key";

-- DropIndex
DROP INDEX IF EXISTS "FbaInventoryDetail_sku_market_fc_condition_unique_idx";
DROP INDEX IF EXISTS "FbaInventoryDetail_sku_marketplaceId_fulfillmentCenterId_co_key";

-- DropIndex
DROP INDEX "MCFShipment_amazonFulfillmentOrderId_key";

-- DropIndex
ALTER TABLE "Carrier" DROP CONSTRAINT IF EXISTS "Carrier_code_key";
DROP INDEX IF EXISTS "Carrier_code_key";

-- DropIndex
DROP INDEX "CarrierService_carrierId_externalId_key";

-- DropIndex
DROP INDEX "CarrierMetric_carrierId_windowDays_key";

-- DropIndex
DROP INDEX "CarrierAccount_carrierId_accountLabel_key";

-- DropIndex
ALTER TABLE "Shipment" DROP CONSTRAINT IF EXISTS "Shipment_sendcloudParcelId_key";
DROP INDEX IF EXISTS "Shipment_sendcloudParcelId_key";

-- DropIndex
ALTER TABLE "SupplierProduct" DROP CONSTRAINT IF EXISTS "SupplierProduct_supplier_product_unique";
DROP INDEX IF EXISTS "SupplierProduct_supplier_product_unique";
DROP INDEX IF EXISTS "SupplierProduct_supplierId_productId_key";

-- DropIndex
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT IF EXISTS "PurchaseOrder_poNumber_key";
DROP INDEX IF EXISTS "PurchaseOrder_poNumber_key";

-- DropIndex
DROP INDEX "PurchaseOrder_supplierAckToken_key";

-- DropIndex
DROP INDEX "PurchaseOrder_approverAckToken_key";

-- DropIndex
DROP INDEX "PurchaseOrderRevision_purchaseOrderId_version_key";

-- DropIndex
ALTER TABLE "Return" DROP CONSTRAINT IF EXISTS "Return_rmaNumber_key";
DROP INDEX IF EXISTS "Return_rmaNumber_key";

-- DropIndex
DROP INDEX IF EXISTS "Return_idempotencyKey_uniq";
DROP INDEX IF EXISTS "Return_idempotencyKey_key";

-- DropIndex
DROP INDEX IF EXISTS "ReturnPolicy_scope_uniq";
DROP INDEX IF EXISTS "ReturnPolicy_channel_marketplace_productType_key";

-- DropIndex
ALTER TABLE "ReplenishmentRule" DROP CONSTRAINT IF EXISTS "ReplenishmentRule_productId_key";
DROP INDEX IF EXISTS "ReplenishmentRule_productId_key";

-- DropIndex
DROP INDEX "SyncLogErrorGroup_fingerprint_key";

-- DropIndex
DROP INDEX "ProductSubstitution_primaryProductId_substituteProductId_key";

-- DropIndex
DROP INDEX "FbaRestockRow_sku_marketplace_reportId_key";

-- DropIndex
DROP INDEX "FbaInboundPlanV2_planId_key";

-- DropIndex
ALTER TABLE "Tag" DROP CONSTRAINT IF EXISTS "Tag_name_key";
DROP INDEX IF EXISTS "Tag_name_key";

-- DropIndex
ALTER TABLE "Bundle" DROP CONSTRAINT IF EXISTS "Bundle_productId_key";
DROP INDEX IF EXISTS "Bundle_productId_key";

-- DropIndex
ALTER TABLE "BundleComponent" DROP CONSTRAINT IF EXISTS "BundleComponent_bundle_product_unique";
DROP INDEX IF EXISTS "BundleComponent_bundle_product_unique";
DROP INDEX IF EXISTS "BundleComponent_bundleId_productId_key";

-- DropIndex
ALTER TABLE "SavedView" DROP CONSTRAINT IF EXISTS "SavedView_user_surface_name_unique";
DROP INDEX IF EXISTS "SavedView_user_surface_name_unique";
DROP INDEX IF EXISTS "SavedView_userId_surface_name_key";

-- DropIndex
DROP INDEX "Review_channel_externalReviewId_key";

-- DropIndex
DROP INDEX "ReviewCategoryRate_productId_marketplace_category_date_key";

-- DropIndex
DROP INDEX "AmazonReviewInsight_asin_marketplace_key";

-- DropIndex
ALTER TABLE "ReviewRequest" DROP CONSTRAINT IF EXISTS "ReviewRequest_orderId_channel_unique";
DROP INDEX IF EXISTS "ReviewRequest_orderId_channel_unique";
DROP INDEX IF EXISTS "ReviewRequest_orderId_channel_key";

-- DropIndex
ALTER TABLE "ReviewRule" DROP CONSTRAINT IF EXISTS "ReviewRule_name_scope_marketplace_unique";
DROP INDEX IF EXISTS "ReviewRule_name_scope_marketplace_unique";
DROP INDEX IF EXISTS "ReviewRule_name_scope_marketplace_key";

-- DropIndex
DROP INDEX "ReviewTimingDefault_pattern_key";

-- DropIndex
DROP INDEX "ReviewSendWindow_marketplace_dayOfWeek_key";

-- DropIndex
DROP INDEX "ReviewSentimentCheck_token_key";

-- DropIndex
DROP INDEX "EmailSuppression_email_channel_key";

-- DropIndex
DROP INDEX "AiFeatureModelPref_featureKey_key";

-- DropIndex
DROP INDEX "ProductAiDraft_cell_run_key";

-- DropIndex
DROP INDEX "AgentDefinition_key_key";

-- DropIndex
DROP INDEX "AgentTool_name_key";

-- DropIndex
DROP INDEX "AgentMemory_scope_entityType_entityId_key_key";

-- DropIndex
DROP INDEX "DashboardLayout_userId_key";

-- DropIndex
DROP INDEX "DashboardView_userId_name_key";

-- DropIndex
DROP INDEX "ProductTranslation_productId_language_key";

-- DropIndex
DROP INDEX IF EXISTS "ProductRelation_from_to_type_key";
DROP INDEX IF EXISTS "ProductRelation_fromProductId_toProductId_type_key";

-- DropIndex
DROP INDEX "ProductSeo_productId_locale_key";

-- DropIndex
DROP INDEX "EbayCampaign_channelConnectionId_externalCampaignId_key";

-- DropIndex
DROP INDEX "EbayAdGroup_campaignId_externalAdGroupId_key";

-- DropIndex
DROP INDEX "EbayAd_campaignId_listingId_key";

-- DropIndex
DROP INDEX "EbayAd_campaignId_inventoryReference_key";

-- DropIndex
DROP INDEX "EbayKeyword_adGroupId_externalKeywordId_key";

-- DropIndex
DROP INDEX "EbayNegativeKeyword_campaignId_externalId_key";

-- DropIndex
DROP INDEX "EbayAdsReportTask_externalTaskId_key";

-- DropIndex
DROP INDEX "EbayAdsDailyPerformance_marketplace_fundingModel_entityType_key";

-- DropIndex
DROP INDEX "EbayListingIndex_marketplace_itemId_key";

-- DropIndex
DROP INDEX "EbayListingEconomics_marketplace_itemId_key";

-- DropIndex
DROP INDEX "MarketingAutomationState_channel_key";

-- DropIndex
DROP INDEX "MarketingSpendCeiling_channel_marketplace_key";

-- DropIndex
DROP INDEX "EbayAdsRuleVersion_ruleId_version_key";

-- DropIndex
DROP INDEX "EbayAdsProposal_proposedKey_key";

-- DropIndex
DROP INDEX "EbayAdsDigest_weekStart_key";

-- DropIndex
DROP INDEX "CampaignRuleAssignment_campaignId_ruleId_key";

-- DropIndex
DROP INDEX "AdsRuleSuggestion_dedupe_key";

-- DropIndex
DROP INDEX "AdsSuggestionMute_scope_entityType_entityId_key";

-- DropIndex
DROP INDEX "ListingReconciliation_channel_marketplace_externalSku_key";

-- DropIndex
DROP INDEX "Category_parentId_slug_key";

-- DropIndex
DROP INDEX "FeedTransformRule_name_channel_marketplace_key";

-- DropIndex
DROP INDEX "ChannelSchema_channel_marketplace_fieldKey_key";

-- DropIndex
DROP INDEX "FbaReimbursement_reimbursementId_key";

-- DropIndex
DROP INDEX "FbaInventoryAdjustment_adjustmentId_key";

-- DropIndex
DROP INDEX "MarketingCampaignLink_campaignId_marketplace_key";

-- DropIndex
DROP INDEX "MarketingCampaignLink_externalId_marketplace_key";

-- DropIndex
DROP INDEX "AdNegativeReview_protectedTerm_campaignId_key";

-- DropIndex
DROP INDEX "AdBlueprint_name_key";

-- DropIndex
DROP INDEX "CampaignMetric_channel_entityType_entityId_date_key";

-- DropIndex
DROP INDEX "AdSchedule_campaignId_key";

-- DropIndex
DROP INDEX "RankTarget_key_key";

-- DropIndex
DROP INDEX "ProductRankPlan_productId_marketplace_key";

-- DropIndex
DROP INDEX "DevelopmentProject_code_key";

-- DropIndex
DROP INDEX "DevelopmentProjectSupplier_projectId_supplierId_key";

-- DropIndex
DROP INDEX "AmazonReportRun_reportId_key";

-- DropIndex
DROP INDEX "SharedListingMembership_marketplace_itemId_sku_key";

-- DropIndex
DROP INDEX "SyncChannelPolicy_channel_marketplace_conn_key";

-- DropIndex
DROP INDEX "EbayDescriptionTheme_name_key";

-- DropIndex
DROP INDEX "AmazonTemplateVault_templateIdentifier_key";

-- DropIndex
DROP INDEX "AmazonFamilyWorkbook_familyKey_marketplace_key";

-- DropIndex
DROP INDEX "ReportShareLink_tokenHash_key";

-- DropIndex
DROP INDEX "SavedReportVersion_savedReportId_version_key";

-- DropIndex
DROP INDEX "AdsConsoleRow_natural_key";

-- DropIndex
DROP INDEX "CustomMetric_reportId_name_key";

-- DropIndex
DROP INDEX "AgentCharter_key_version_key";

-- DropIndex
DROP INDEX "AgentCharterRevision_charterKey_revision_key";

-- DropIndex
DROP INDEX "AgentObservation_key_entityType_entityId_marketplace_key";

-- DropIndex
DROP INDEX "AgentFinding_dedupe";

-- DropIndex
DROP INDEX "AgentStep_agentRunId_seq_key";

-- DropIndex
DROP INDEX "AgentScorecard_charterKey_periodStart_periodEnd_key";

-- DropIndex
DROP INDEX "GraphEdge_unique";

-- DropIndex
DROP INDEX "AgentShadowGrade_findingId_key";

-- DropIndex
DROP INDEX "AgentWorkflow_key_key";

-- DropIndex
DROP INDEX "AgentWorkflowRevision_workflowKey_revision_key";

-- DropIndex
DROP INDEX "AdsHarvestPolicy_scopeGrain_scopeId_kind_key";

-- DropIndex
DROP INDEX "AdsHarvestDestination_scopeGrain_scopeId_matchType_key";

-- DropIndex
DROP INDEX "SqpReportRequest_reportId_key";

-- DropIndex
DROP INDEX "AdSpendCeiling_grain_scopeId_key";

-- DropIndex
DROP INDEX "AdBidPolicy_grain_scopeId_key";

-- DropIndex
DROP INDEX "AutomationRefusalDaily_actorKind_actorId_dayUtc_reason_key";

-- DropIndex
DROP INDEX "EventOutbox_eventId_key";

-- DropIndex
DROP INDEX "CategoryChannelMapping_categoryId_channel_marketplace_key";

-- DropIndex
DROP INDEX IF EXISTS "CellFormula_coord_key";
DROP INDEX IF EXISTS "CellFormula_productId_scope_channel_marketplace_locale_fiel_key";

-- DropIndex
DROP INDEX "MasterFieldRule_productType_fieldKey_key";

-- DropIndex
DROP INDEX IF EXISTS "MasterFieldRuleRevision_pt_fk_version_key";
DROP INDEX IF EXISTS "MasterFieldRuleRevision_productType_fieldKey_version_key";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Product" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SkuAlias" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SkuAlias" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockImportJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockImportJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductFamily" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductFamily" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AttributeGroup" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AttributeGroup" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomAttribute" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CustomAttribute" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AttributeOption" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AttributeOption" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FamilyAttribute" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FamilyAttribute" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductWorkflow" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductWorkflow" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowStage" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "WorkflowStage" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowTransition" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "WorkflowTransition" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowComment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "WorkflowComment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowAssignment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "WorkflowAssignment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomerGroup" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CustomerGroup" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductTierPrice" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductTierPrice" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DigitalAsset" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DigitalAsset" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AssetFolder" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AssetFolder" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AssetUsage" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AssetUsage" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RepricingRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RepricingRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RepricingDecision" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RepricingDecision" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductVariation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductVariation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "VariantImage" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "VariantImage" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "VariantChannelListing" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "VariantChannelListing" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelListing" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ChannelListing" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductListingAlias" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductListingAlias" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelListingSnapshot" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ChannelListingSnapshot" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Marketplace" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Marketplace" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelListingOverride" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ChannelListingOverride" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FieldLinkGroup" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FieldLinkGroup" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FieldValueMap" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FieldValueMap" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SizeScaleMap" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SizeScaleMap" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MappingRevision" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "MappingRevision" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SyncAttempt" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SyncAttempt" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonSuppression" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonSuppression" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ListingIssue" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ListingIssue" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Offer" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ListingRecoveryEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ListingRecoveryEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelListingImage" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ChannelListingImage" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductImage" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TerminologyPreference" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "TerminologyPreference" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BrandVoice" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BrandVoice" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MarketplaceSync" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "MarketplaceSync" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Channel" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Listing" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DraftListing" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DraftListing" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FBAShipment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FBAShipment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FBAShipmentItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FBAShipmentItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PricingRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PricingRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PricingRuleProduct" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PricingRuleProduct" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PricingRuleVariation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PricingRuleVariation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SyncHealthLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SyncHealthLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BulkActionJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BulkActionJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BulkActionItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BulkActionItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SellerFeedback" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SellerFeedback" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Campaign" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdGroup" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdGroup" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdTarget" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdTarget" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdProductAd" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdProductAd" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdProductSet" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdProductSet" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsConnection" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsConnection" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsProfile" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsProfile" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "KeywordWatchlist" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "KeywordWatchlist" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "KeywordWatchlistTerm" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "KeywordWatchlistTerm" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "KeywordCoverageSet" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "KeywordCoverageSet" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "KeywordCoverageTerm" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "KeywordCoverageTerm" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsPortfolio" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsPortfolio" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsDailyPerformance" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsHourlyPerformance" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsHourlyPerformance" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdBudgetUsageSample" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdBudgetUsageSample" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsSearchTerm" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsSearchTerm" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SearchQueryPerformance" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SearchQueryPerformance" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsPlacementReport" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsPlacementReport" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DataKioskQueryJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DataKioskQueryJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonEconomicsDaily" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonEconomicsDaily" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsBrandMetric" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsBrandMetric" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsBrandBuildingMetric" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsBrandBuildingMetric" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsReportJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsReportJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsExportJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsExportJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FbaStorageAge" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FbaStorageAge" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductProfitDaily" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductProfitDaily" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdDrift" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdDrift" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdvertisingActionLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdvertisingActionLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BudgetPool" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BudgetPool" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BudgetPoolAllocation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BudgetPoolAllocation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BudgetPoolRebalance" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BudgetPoolRebalance" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CampaignBidHistory" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CampaignBidHistory" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Coupon" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AccountSettings" ALTER COLUMN "workspaceId" SET NOT NULL,
ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), '');

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "NotificationPreference" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "NotificationWebhook" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "NotificationWebhook" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ApiKey" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DataRetentionPolicy" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DataRetentionPolicy" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DataExportRequest" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DataExportRequest" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "WebhookEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelLiveImage" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ChannelLiveImage" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelStockEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ChannelStockEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RateLimitLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RateLimitLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SyncLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SyncLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SyncError" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SyncError" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Order" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Customer" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomerSegment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CustomerSegment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomerAddress" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CustomerAddress" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomerNote" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CustomerNote" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FiscalInvoiceCounter" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FiscalInvoiceCounter" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FiscalInvoice" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FiscalInvoice" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CreditNoteCounter" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CreditNoteCounter" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CreditNote" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderNote" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "OrderNote" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderRiskScore" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "OrderRiskScore" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "OrderItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DailySalesAggregate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DailySalesAggregate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReplenishmentForecast" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReplenishmentForecast" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ForecastModelAssignment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ForecastModelAssignment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ForecastAccuracy" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ForecastAccuracy" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BrandSettings" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BrandSettings" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RetailEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RetailEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PricingSnapshot" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PricingSnapshot" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PriceChangeEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PriceChangeEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BuyBoxHistory" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BuyBoxHistory" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FxRate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FxRate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RetailEventPriceAction" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RetailEventPriceAction" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SettlementReport" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SettlementReport" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FinancialTransaction" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FinancialTransaction" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelConnection" ALTER COLUMN "workspaceId" SET NOT NULL,
ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), '');

-- AlterTable
ALTER TABLE "ConnectionScope" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ConnectionScope" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ConnectionEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ConnectionEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OutboundSyncQueue" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "OutboundSyncQueue" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BulkOperation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BulkOperation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BulkOpsTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BulkOpsTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BulkActionTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BulkActionTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ScheduledBulkAction" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ScheduledBulkAction" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BulkAutomationApproval" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BulkAutomationApproval" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FlatFileImport" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FlatFileImport" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ImportJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ImportJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ImportJobRow" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ImportJobRow" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ScheduledImport" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ScheduledImport" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ExportJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ExportJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ScheduledExport" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ScheduledExport" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CategorySchema" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CategorySchema" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "GtinExemptionApplication" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "GtinExemptionApplication" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ListingWizard" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ListingWizard" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ScheduledImagePublish" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ScheduledImagePublish" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ScheduledWizardPublish" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ScheduledWizardPublish" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WizardStepEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "WizardStepEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WizardTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "WizardTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AuditLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), '');

-- AlterTable
ALTER TABLE "APlusContent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "APlusContent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "APlusContentVersion" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "APlusContentVersion" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "APlusContentAsin" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "APlusContentAsin" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "APlusModule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "APlusModule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BrandStory" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BrandStory" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BrandStoryModule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BrandStoryModule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BrandStoryVersion" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BrandStoryVersion" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BrandKit" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BrandKit" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BrandWatermarkTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BrandWatermarkTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AssetLocaleOverlay" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AssetLocaleOverlay" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ListingImage" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ListingImage" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonMediaRun" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonMediaRun" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonImageFeedJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonImageFeedJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonFlatFileFeedJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonFlatFileFeedJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayPushJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayPushJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelImagePublishJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ChannelImagePublishJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SchemaChange" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SchemaChange" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Warehouse" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockLocation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockLocation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockLevel" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockLevel" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockReservation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockReservation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockMovement" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockCostLayer" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockCostLayer" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Lot" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Lot" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SerialNumber" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SerialNumber" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockBin" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockBin" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockBinQuantity" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockBinQuantity" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LotRecall" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "LotRecall" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "YearEndSnapshot" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "YearEndSnapshot" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FbaInventoryDetail" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FbaInventoryDetail" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MCFShipment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "MCFShipment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Carrier" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Carrier" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CarrierService" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CarrierService" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CarrierServiceMapping" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CarrierServiceMapping" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CarrierMetric" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CarrierMetric" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PickupSchedule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PickupSchedule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CarrierAccount" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CarrierAccount" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Shipment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TrackingEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "TrackingEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TrackingMessageLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "TrackingMessageLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ShipmentItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ShipmentItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ShippingRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ShippingRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Supplier" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SupplierShippingProfile" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SupplierShippingProfile" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SupplierProduct" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SupplierProduct" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PurchaseOrder" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PurchaseOrderItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseOrderAttachment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PurchaseOrderAttachment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseOrderRevision" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PurchaseOrderRevision" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PoComment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PoComment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PoEventLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PoEventLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PoTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PoTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PoTemplateItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PoTemplateItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PoSchedule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PoSchedule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InboundShipment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "InboundShipment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InboundShipmentAttachment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "InboundShipmentAttachment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InboundDiscrepancy" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "InboundDiscrepancy" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InboundShipmentItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "InboundShipmentItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InboundReceipt" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "InboundReceipt" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WorkOrder" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "WorkOrder" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Return" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Return" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReturnItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReturnItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Refund" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RefundAttempt" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RefundAttempt" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReturnPolicy" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReturnPolicy" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReplenishmentRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReplenishmentRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReplenishmentRecommendation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CycleCount" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CycleCount" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CycleCountItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CycleCountItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderRoutingRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "OrderRoutingRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReplenishmentSavedView" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReplenishmentSavedView" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CronRun" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CronRun" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OutboundApiCallLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "OutboundApiCallLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SyncLogErrorGroup" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SyncLogErrorGroup" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SyncLogSavedSearch" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SyncLogSavedSearch" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AlertRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AlertEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AlertEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductSubstitution" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductSubstitution" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockoutEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "StockoutEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AutoPoRunLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AutoPoRunLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FbaRestockReport" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FbaRestockReport" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FbaRestockRow" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FbaRestockRow" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FbaInboundPlanV2" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FbaInboundPlanV2" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Tag" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AssetTag" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AssetTag" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductTag" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductTag" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Bundle" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BundleComponent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BundleComponent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SavedView" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SavedView" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Review" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewResponse" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewResponse" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewSpotlight" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewSpotlight" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewActionItem" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewActionItem" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewSentiment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewSentiment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewCategoryRate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewCategoryRate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewSpike" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewSpike" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonReviewInsight" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonReviewInsight" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewRequest" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewRequest" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewTimingDefault" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewTimingDefault" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewSendWindow" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewSendWindow" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewSentimentCheck" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewSentimentCheck" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewMailerState" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReviewMailerState" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EmailSuppression" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EmailSuppression" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderTag" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "OrderTag" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AiUsageLog" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AiUsageLog" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AiFeatureModelPref" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AiFeatureModelPref" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductAiDraft" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductAiDraft" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentDefinition" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentDefinition" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentRun" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentTool" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentTool" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentApproval" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentApproval" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentMemory" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentMemory" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PromptTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "PromptTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Goal" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DashboardLayout" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DashboardLayout" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DashboardView" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DashboardView" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ScheduledReport" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ScheduledReport" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Notification" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SavedViewAlert" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SavedViewAlert" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductTranslation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductTranslation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductRelation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductRelation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductSeo" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductSeo" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductCertificate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductCertificate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelPublishAttempt" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ChannelPublishAttempt" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayCampaign" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayCampaign" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayRateDiscoveryPlan" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayRateDiscoveryPlan" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayCampaignAutomationPolicy" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayCampaignAutomationPolicy" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayAdGroup" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayAdGroup" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayAd" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayAd" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayKeyword" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayKeyword" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayNegativeKeyword" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayNegativeKeyword" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayAdsReportTask" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayAdsReportTask" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayAdsDailyPerformance" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayAdsDailyPerformance" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayListingIndex" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayListingIndex" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayListingEconomics" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayListingEconomics" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MarketingAutomationState" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "MarketingAutomationState" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MarketingSpendCeiling" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "MarketingSpendCeiling" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayAdsRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayAdsRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayAdsRuleVersion" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayAdsRuleVersion" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayAdsRuleExecution" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayAdsRuleExecution" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayAdsProposal" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayAdsProposal" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayAdsDigest" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayAdsDigest" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayWatcherStats" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayWatcherStats" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayMarkdown" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayMarkdown" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayVolumePromotion" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayVolumePromotion" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayVolumeTierTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayVolumeTierTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ScheduledProductChange" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ScheduledProductChange" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AutomationRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CampaignRuleAssignment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CampaignRuleAssignment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AutomationRuleTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AutomationRuleTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AutomationRuleExecution" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AutomationRuleExecution" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdsRuleSuggestion" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdsRuleSuggestion" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdsSuggestionMute" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdsSuggestionMute" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "KeywordRank" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "KeywordRank" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Scenario" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Scenario" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ScenarioRun" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ScenarioRun" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ListingReconciliation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ListingReconciliation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FlatFilePullRecord" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FlatFilePullRecord" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FlatFilePullJob" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FlatFilePullJob" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CatalogOrganizeSession" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CatalogOrganizeSession" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CatalogOrganizeChange" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CatalogOrganizeChange" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductReadCache" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductReadCache" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "Category" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CategoryClosure" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CategoryClosure" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductCategory" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductCategory" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FnskuLabelTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FnskuLabelTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ListingQualitySnapshot" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ListingQualitySnapshot" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RoutingDecision" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RoutingDecision" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FeedTransformRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FeedTransformRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChannelSchema" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ChannelSchema" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FbaReimbursement" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FbaReimbursement" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FbaInventoryAdjustment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "FbaInventoryAdjustment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MarketingCampaign" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "MarketingCampaign" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MarketingCampaignLink" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "MarketingCampaignLink" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonAdsCampaignDetail" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonAdsCampaignDetail" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayPromotedDetail" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayPromotedDetail" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DiscountDetail" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DiscountDetail" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ExternalAdsDetail" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ExternalAdsDetail" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ContentPushDetail" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ContentPushDetail" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OutreachDetail" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "OutreachDetail" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdMutation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdMutation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdBlueprintApplication" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdBlueprintApplication" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdKeywordProtection" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdKeywordProtection" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdNegativeReview" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdNegativeReview" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdBlueprint" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdBlueprint" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CampaignTarget" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CampaignTarget" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CampaignBudget" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CampaignBudget" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CampaignBudgetAllocation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CampaignBudgetAllocation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CampaignBudgetRebalance" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CampaignBudgetRebalance" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CampaignMetric" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CampaignMetric" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CampaignAction" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CampaignAction" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CalendarEntry" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CalendarEntry" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdSchedule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdSchedule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RankScheduleGroup" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RankScheduleGroup" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RankScheduleEvent" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RankScheduleEvent" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RankScheduleVersion" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RankScheduleVersion" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BudgetSchedule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "BudgetSchedule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AutopilotPlan" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AutopilotPlan" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AutopilotDecision" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AutopilotDecision" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RankTarget" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RankTarget" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RankScheduleTemplate" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "RankScheduleTemplate" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductRankPlan" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ProductRankPlan" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdAudience" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdAudience" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdBudgetPlan" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdBudgetPlan" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdProductGoal" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdProductGoal" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SupplierContact" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SupplierContact" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SupplierComm" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SupplierComm" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SupplierFollowUp" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SupplierFollowUp" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DevelopmentProject" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DevelopmentProject" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DevelopmentProjectSupplier" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DevelopmentProjectSupplier" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DevelopmentAttachment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DevelopmentAttachment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DevelopmentCertification" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "DevelopmentCertification" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdsAutomationState" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdsAutomationState" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonReportRun" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonReportRun" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SharedListingMembership" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SharedListingMembership" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SyncChannelPolicy" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SyncChannelPolicy" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SyncControlAudit" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SyncControlAudit" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EbayDescriptionTheme" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EbayDescriptionTheme" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonTemplateVault" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonTemplateVault" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AmazonFamilyWorkbook" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AmazonFamilyWorkbook" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReportShareLink" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReportShareLink" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SavedReport" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SavedReport" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SavedReportVersion" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SavedReportVersion" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReportSchedule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReportSchedule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReportDelivery" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "ReportDelivery" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdsConsoleImport" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdsConsoleImport" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdsConsoleRow" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdsConsoleRow" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomMetric" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CustomMetric" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentCharter" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentCharter" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentCharterRevision" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentCharterRevision" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentEvalRun" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentEvalRun" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentControlAudit" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentControlAudit" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentObservation" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentObservation" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentFinding" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentFinding" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentPlan" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentPlan" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentStrategy" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentStrategy" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentStep" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentStep" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentExemplar" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentExemplar" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentScorecard" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentScorecard" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "GraphEdge" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "GraphEdge" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentFleetState" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentFleetState" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentShadowGrade" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentShadowGrade" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentWorkflow" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentWorkflow" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentWorkflowRevision" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentWorkflowRevision" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentAssignment" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentAssignment" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentFindingRun" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AgentFindingRun" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdsHarvestPolicy" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdsHarvestPolicy" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdsHarvestDestination" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdsHarvestDestination" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SqpReportRequest" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "SqpReportRequest" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdSpendCeiling" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdSpendCeiling" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdBidPolicy" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdBidPolicy" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AdWriteRefusal" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AdWriteRefusal" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AutomationRefusalDaily" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "AutomationRefusalDaily" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "KeywordBidProposal" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "KeywordBidProposal" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EventOutbox" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "EventOutbox" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CategoryChannelMapping" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CategoryChannelMapping" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CellFormula" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "CellFormula" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MasterFieldRule" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "MasterFieldRule" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MasterFieldRuleRevision" ADD COLUMN "workspaceId" TEXT DEFAULT 'nexus_legacy_workspace';
ALTER TABLE "MasterFieldRuleRevision" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''), ALTER COLUMN "workspaceId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Product_workspaceId_idx" ON "Product"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_workspace_sku_key" ON "Product"("workspaceId", "sku");

-- CreateIndex
CREATE INDEX "SkuAlias_workspaceId_idx" ON "SkuAlias"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SkuAlias_workspace_alias_key" ON "SkuAlias"("workspaceId", "alias");

-- CreateIndex
CREATE INDEX "StockImportJob_workspaceId_idx" ON "StockImportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductFamily_workspaceId_idx" ON "ProductFamily"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductFamily_workspace_code_key" ON "ProductFamily"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "AttributeGroup_workspaceId_idx" ON "AttributeGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeGroup_workspace_code_key" ON "AttributeGroup"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "CustomAttribute_workspaceId_idx" ON "CustomAttribute"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomAttribute_workspace_code_key" ON "CustomAttribute"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "AttributeOption_workspaceId_idx" ON "AttributeOption"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeOption_attributeId_code_key" ON "AttributeOption"("workspaceId", "attributeId", "code");

-- CreateIndex
CREATE INDEX "FamilyAttribute_workspaceId_idx" ON "FamilyAttribute"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyAttribute_familyId_attributeId_key" ON "FamilyAttribute"("workspaceId", "familyId", "attributeId");

-- CreateIndex
CREATE INDEX "ProductWorkflow_workspaceId_idx" ON "ProductWorkflow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductWorkflow_workspace_code_key" ON "ProductWorkflow"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "WorkflowStage_workspaceId_idx" ON "WorkflowStage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStage_workflowId_code_key" ON "WorkflowStage"("workspaceId", "workflowId", "code");

-- CreateIndex
CREATE INDEX "WorkflowTransition_workspaceId_idx" ON "WorkflowTransition"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkflowComment_workspaceId_idx" ON "WorkflowComment"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkflowAssignment_workspaceId_idx" ON "WorkflowAssignment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowAssignment_productId_assigneeId_role_key" ON "WorkflowAssignment"("workspaceId", "productId", "assigneeId", "role");

-- CreateIndex
CREATE INDEX "CustomerGroup_workspaceId_idx" ON "CustomerGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerGroup_workspace_code_key" ON "CustomerGroup"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "ProductTierPrice_workspaceId_idx" ON "ProductTierPrice"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTierPrice_productId_minQty_customerGroupId_key" ON "ProductTierPrice"("workspaceId", "productId", "minQty", "customerGroupId");

-- CreateIndex
CREATE INDEX "DigitalAsset_workspaceId_idx" ON "DigitalAsset"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalAsset_workspace_code_key" ON "DigitalAsset"("workspaceId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalAsset_workspace_contentHash_key" ON "DigitalAsset"("workspaceId", "contentHash");

-- CreateIndex
CREATE INDEX "AssetFolder_workspaceId_idx" ON "AssetFolder"("workspaceId");

-- CreateIndex
CREATE INDEX "AssetUsage_workspaceId_idx" ON "AssetUsage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetUsage_assetId_scope_productId_role_sortOrder_key" ON "AssetUsage"("workspaceId", "assetId", "scope", "productId", "role", "sortOrder");

-- CreateIndex
CREATE INDEX "RepricingRule_workspaceId_idx" ON "RepricingRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RepricingRule_productId_channel_marketplace_key" ON "RepricingRule"("workspaceId", "productId", "channel", "marketplace");

-- CreateIndex
CREATE INDEX "RepricingDecision_workspaceId_idx" ON "RepricingDecision"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductVariation_workspaceId_idx" ON "ProductVariation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariation_workspace_sku_key" ON "ProductVariation"("workspaceId", "sku");

-- CreateIndex
CREATE INDEX "VariantImage_workspaceId_idx" ON "VariantImage"("workspaceId");

-- CreateIndex
CREATE INDEX "VariantChannelListing_workspaceId_idx" ON "VariantChannelListing"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantChannelListing_variantId_channelId_key" ON "VariantChannelListing"("workspaceId", "variantId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantChannelListing_variantId_channel_marketplace_conn_key" ON "VariantChannelListing"("workspaceId", "variantId", "channel", "marketplace", "channelConnectionId");

-- CreateIndex
CREATE INDEX "ChannelListing_workspaceId_idx" ON "ChannelListing"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelListing_productId_channelMarket_akey_key" ON "ChannelListing"("workspaceId", "productId", "channelMarket", "channelConnectionId", "aliasKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelListing_productId_channel_marketplace_akey_key" ON "ChannelListing"("workspaceId", "productId", "channel", "marketplace", "channelConnectionId", "aliasKey");

-- CreateIndex
CREATE INDEX "ProductListingAlias_workspaceId_idx" ON "ProductListingAlias"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductListingAlias_coord_position_key" ON "ProductListingAlias"("workspaceId", "productId", "channel", "marketplace", "channelConnectionId", "position");

-- CreateIndex
CREATE INDEX "ChannelListingSnapshot_workspaceId_idx" ON "ChannelListingSnapshot"("workspaceId");

-- CreateIndex
CREATE INDEX "Marketplace_workspaceId_idx" ON "Marketplace"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Marketplace_channel_code_key" ON "Marketplace"("workspaceId", "channel", "code");

-- CreateIndex
CREATE INDEX "ChannelListingOverride_workspaceId_idx" ON "ChannelListingOverride"("workspaceId");

-- CreateIndex
CREATE INDEX "FieldLinkGroup_workspaceId_idx" ON "FieldLinkGroup"("workspaceId");

-- CreateIndex
CREATE INDEX "FieldValueMap_workspaceId_idx" ON "FieldValueMap"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldValueMap_channel_marketplace_attribute_fromValue_key" ON "FieldValueMap"("workspaceId", "channel", "marketplace", "attribute", "fromValue");

-- CreateIndex
CREATE INDEX "SizeScaleMap_workspaceId_idx" ON "SizeScaleMap"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SizeScaleMap_scale_fromSystem_toSystem_fromValue_key" ON "SizeScaleMap"("workspaceId", "scale", "fromSystem", "toSystem", "fromValue");

-- CreateIndex
CREATE INDEX "MappingRevision_workspaceId_idx" ON "MappingRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MappingRevision_channel_code_version_key" ON "MappingRevision"("workspaceId", "channel", "code", "version");

-- CreateIndex
CREATE INDEX "SyncAttempt_workspaceId_idx" ON "SyncAttempt"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonSuppression_workspaceId_idx" ON "AmazonSuppression"("workspaceId");

-- CreateIndex
CREATE INDEX "ListingIssue_workspaceId_idx" ON "ListingIssue"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingIssue_listingId_fingerprint_key" ON "ListingIssue"("workspaceId", "listingId", "fingerprint");

-- CreateIndex
CREATE INDEX "Offer_workspaceId_idx" ON "Offer"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_channelListingId_fulfillmentMethod_key" ON "Offer"("workspaceId", "channelListingId", "fulfillmentMethod");

-- CreateIndex
CREATE INDEX "ListingRecoveryEvent_workspaceId_idx" ON "ListingRecoveryEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelListingImage_workspaceId_idx" ON "ChannelListingImage"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductImage_workspaceId_idx" ON "ProductImage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_productId_contentHash_key" ON "ProductImage"("workspaceId", "productId", "contentHash");

-- CreateIndex
CREATE INDEX "TerminologyPreference_workspaceId_idx" ON "TerminologyPreference"("workspaceId");

-- CreateIndex
CREATE INDEX "BrandVoice_workspaceId_idx" ON "BrandVoice"("workspaceId");

-- CreateIndex
CREATE INDEX "MarketplaceSync_workspaceId_idx" ON "MarketplaceSync"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceSync_productId_channel_key" ON "MarketplaceSync"("workspaceId", "productId", "channel");

-- CreateIndex
CREATE INDEX "Channel_workspaceId_idx" ON "Channel"("workspaceId");

-- CreateIndex
CREATE INDEX "Listing_workspaceId_idx" ON "Listing"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_productId_channelId_key" ON "Listing"("workspaceId", "productId", "channelId");

-- CreateIndex
CREATE INDEX "DraftListing_workspaceId_idx" ON "DraftListing"("workspaceId");

-- CreateIndex
CREATE INDEX "StockLog_workspaceId_idx" ON "StockLog"("workspaceId");

-- CreateIndex
CREATE INDEX "FBAShipment_workspaceId_idx" ON "FBAShipment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FBAShipment_workspace_shipmentId_key" ON "FBAShipment"("workspaceId", "shipmentId");

-- CreateIndex
CREATE INDEX "FBAShipmentItem_workspaceId_idx" ON "FBAShipmentItem"("workspaceId");

-- CreateIndex
CREATE INDEX "PricingRule_workspaceId_idx" ON "PricingRule"("workspaceId");

-- CreateIndex
CREATE INDEX "PricingRuleProduct_workspaceId_idx" ON "PricingRuleProduct"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRuleProduct_ruleId_productId_key" ON "PricingRuleProduct"("workspaceId", "ruleId", "productId");

-- CreateIndex
CREATE INDEX "PricingRuleVariation_workspaceId_idx" ON "PricingRuleVariation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRuleVariation_ruleId_variationId_key" ON "PricingRuleVariation"("workspaceId", "ruleId", "variationId");

-- CreateIndex
CREATE INDEX "SyncHealthLog_workspaceId_idx" ON "SyncHealthLog"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkActionJob_workspaceId_idx" ON "BulkActionJob"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkActionItem_workspaceId_idx" ON "BulkActionItem"("workspaceId");

-- CreateIndex
CREATE INDEX "SellerFeedback_workspaceId_idx" ON "SellerFeedback"("workspaceId");

-- CreateIndex
CREATE INDEX "Campaign_workspaceId_idx" ON "Campaign"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_externalCampaignId_marketplace_key" ON "Campaign"("workspaceId", "externalCampaignId", "marketplace");

-- CreateIndex
CREATE INDEX "AdGroup_workspaceId_idx" ON "AdGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdGroup_externalAdGroupId_campaignId_key" ON "AdGroup"("workspaceId", "externalAdGroupId", "campaignId");

-- CreateIndex
CREATE INDEX "AdTarget_workspaceId_idx" ON "AdTarget"("workspaceId");

-- CreateIndex
CREATE INDEX "AdProductAd_workspaceId_idx" ON "AdProductAd"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdProductAd_adGroupId_asin_key" ON "AdProductAd"("workspaceId", "adGroupId", "asin");

-- CreateIndex
CREATE INDEX "AdProductSet_workspaceId_idx" ON "AdProductSet"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdProductSet_channel_marketplace_name_key" ON "AdProductSet"("workspaceId", "channel", "marketplace", "name");

-- CreateIndex
CREATE INDEX "AmazonAdsConnection_workspaceId_idx" ON "AmazonAdsConnection"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsConnection_workspace_profileId_key" ON "AmazonAdsConnection"("workspaceId", "profileId");

-- CreateIndex
CREATE INDEX "AmazonAdsProfile_workspaceId_idx" ON "AmazonAdsProfile"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsProfile_workspace_profileId_key" ON "AmazonAdsProfile"("workspaceId", "profileId");

-- CreateIndex
CREATE INDEX "KeywordWatchlist_workspaceId_idx" ON "KeywordWatchlist"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordWatchlist_marketplace_name_key" ON "KeywordWatchlist"("workspaceId", "marketplace", "name");

-- CreateIndex
CREATE INDEX "KeywordWatchlistTerm_workspaceId_idx" ON "KeywordWatchlistTerm"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordWatchlistTerm_watchlistId_term_key" ON "KeywordWatchlistTerm"("workspaceId", "watchlistId", "term");

-- CreateIndex
CREATE INDEX "KeywordCoverageSet_workspaceId_idx" ON "KeywordCoverageSet"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordCoverageSet_portfolioId_marketplace_name_key" ON "KeywordCoverageSet"("workspaceId", "portfolioId", "marketplace", "name");

-- CreateIndex
CREATE INDEX "KeywordCoverageTerm_workspaceId_idx" ON "KeywordCoverageTerm"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordCoverageTerm_setId_term_key" ON "KeywordCoverageTerm"("workspaceId", "setId", "term");

-- CreateIndex
CREATE INDEX "AmazonAdsPortfolio_workspaceId_idx" ON "AmazonAdsPortfolio"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsPortfolio_profileId_externalPortfolioId_key" ON "AmazonAdsPortfolio"("workspaceId", "profileId", "externalPortfolioId");

-- CreateIndex
CREATE INDEX "AmazonAdsDailyPerformance_workspaceId_idx" ON "AmazonAdsDailyPerformance"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsDailyPerformance_profileId_adProduct_entityT_4f88ac473" ON "AmazonAdsDailyPerformance"("workspaceId", "profileId", "adProduct", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsHourlyPerformance_workspaceId_idx" ON "AmazonAdsHourlyPerformance"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsHourlyPerformance_entity_date_hour_key" ON "AmazonAdsHourlyPerformance"("workspaceId", "profileId", "adProduct", "entityType", "entityId", "date", "hour");

-- CreateIndex
CREATE INDEX "AdBudgetUsageSample_workspaceId_idx" ON "AdBudgetUsageSample"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdBudgetUsageSample_reading_key" ON "AdBudgetUsageSample"("workspaceId", "campaignId", "source", "usageUpdatedAt");

-- CreateIndex
CREATE INDEX "AmazonAdsSearchTerm_workspaceId_idx" ON "AmazonAdsSearchTerm"("workspaceId");

-- CreateIndex
CREATE INDEX "SearchQueryPerformance_workspaceId_idx" ON "SearchQueryPerformance"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchQueryPerformance_marketplace_reportPeriod_start_669db0493" ON "SearchQueryPerformance"("workspaceId", "marketplace", "reportPeriod", "startDate", "searchQuery", "asin");

-- CreateIndex
CREATE INDEX "AmazonAdsPlacementReport_workspaceId_idx" ON "AmazonAdsPlacementReport"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsPlacementReport_campaignId_date_placement_key" ON "AmazonAdsPlacementReport"("workspaceId", "campaignId", "date", "placement");

-- CreateIndex
CREATE INDEX "DataKioskQueryJob_workspaceId_idx" ON "DataKioskQueryJob"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonEconomicsDaily_workspaceId_idx" ON "AmazonEconomicsDaily"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonEconomicsDaily_marketplaceId_date_childAsin_msku_key" ON "AmazonEconomicsDaily"("workspaceId", "marketplaceId", "date", "childAsin", "msku");

-- CreateIndex
CREATE INDEX "AmazonAdsBrandMetric_workspaceId_idx" ON "AmazonAdsBrandMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsBrandMetric_profileId_brandName_date_key" ON "AmazonAdsBrandMetric"("workspaceId", "profileId", "brandName", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsBrandBuildingMetric_workspaceId_idx" ON "AmazonAdsBrandBuildingMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsBrandBuildingMetric_profileId_brandName_comp_d39fe70dc" ON "AmazonAdsBrandBuildingMetric"("workspaceId", "profileId", "brandName", "computationDate", "lookbackPeriod", "categoryNodeName");

-- CreateIndex
CREATE INDEX "AmazonAdsReportJob_workspaceId_idx" ON "AmazonAdsReportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonAdsExportJob_workspaceId_idx" ON "AmazonAdsExportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "FbaStorageAge_workspaceId_idx" ON "FbaStorageAge"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaStorageAge_sku_marketplace_polledAt_key" ON "FbaStorageAge"("workspaceId", "sku", "marketplace", "polledAt");

-- CreateIndex
CREATE INDEX "ProductProfitDaily_workspaceId_idx" ON "ProductProfitDaily"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductProfitDaily_productId_marketplace_date_key" ON "ProductProfitDaily"("workspaceId", "productId", "marketplace", "date");

-- CreateIndex
CREATE INDEX "AdDrift_workspaceId_idx" ON "AdDrift"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdDrift_entityType_entityId_field_key" ON "AdDrift"("workspaceId", "entityType", "entityId", "field");

-- CreateIndex
CREATE INDEX "AdvertisingActionLog_workspaceId_idx" ON "AdvertisingActionLog"("workspaceId");

-- CreateIndex
CREATE INDEX "BudgetPool_workspaceId_idx" ON "BudgetPool"("workspaceId");

-- CreateIndex
CREATE INDEX "BudgetPoolAllocation_workspaceId_idx" ON "BudgetPoolAllocation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPoolAllocation_budgetPoolId_marketplace_campaignId_key" ON "BudgetPoolAllocation"("workspaceId", "budgetPoolId", "marketplace", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPoolAllocation_campaignId_key" ON "BudgetPoolAllocation"("workspaceId", "campaignId");

-- CreateIndex
CREATE INDEX "BudgetPoolRebalance_workspaceId_idx" ON "BudgetPoolRebalance"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignBidHistory_workspaceId_idx" ON "CampaignBidHistory"("workspaceId");

-- CreateIndex
CREATE INDEX "Coupon_workspaceId_idx" ON "Coupon"("workspaceId");

-- CreateIndex
CREATE INDEX "NotificationPreference_workspaceId_idx" ON "NotificationPreference"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_eventType_key" ON "NotificationPreference"("workspaceId", "userId", "eventType");

-- CreateIndex
CREATE INDEX "NotificationWebhook_workspaceId_idx" ON "NotificationWebhook"("workspaceId");

-- CreateIndex
CREATE INDEX "ApiKey_workspaceId_idx" ON "ApiKey"("workspaceId");

-- CreateIndex
CREATE INDEX "DataRetentionPolicy_workspaceId_idx" ON "DataRetentionPolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "DataExportRequest_workspaceId_idx" ON "DataExportRequest"("workspaceId");

-- CreateIndex
CREATE INDEX "WebhookEvent_workspaceId_idx" ON "WebhookEvent"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_channel_externalId_key" ON "WebhookEvent"("workspaceId", "channel", "externalId");

-- CreateIndex
CREATE INDEX "ChannelLiveImage_workspaceId_idx" ON "ChannelLiveImage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelLiveImage_productId_channel_marketplace_extern_e9f2711dd" ON "ChannelLiveImage"("workspaceId", "productId", "channel", "marketplace", "externalSku", "slot");

-- CreateIndex
CREATE INDEX "ChannelStockEvent_workspaceId_idx" ON "ChannelStockEvent"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelStockEvent_channel_channelEventId_key" ON "ChannelStockEvent"("workspaceId", "channel", "channelEventId");

-- CreateIndex
CREATE INDEX "RateLimitLog_workspaceId_idx" ON "RateLimitLog"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitLog_channel_endpoint_resetAt_key" ON "RateLimitLog"("workspaceId", "channel", "endpoint", "resetAt");

-- CreateIndex
CREATE INDEX "SyncLog_workspaceId_idx" ON "SyncLog"("workspaceId");

-- CreateIndex
CREATE INDEX "SyncError_workspaceId_idx" ON "SyncError"("workspaceId");

-- CreateIndex
CREATE INDEX "Order_workspaceId_idx" ON "Order"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_channel_channelOrderId_key" ON "Order"("workspaceId", "channel", "channelOrderId");

-- CreateIndex
CREATE INDEX "Customer_workspaceId_idx" ON "Customer"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_workspace_email_key" ON "Customer"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "CustomerSegment_workspaceId_idx" ON "CustomerSegment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSegment_workspace_name_key" ON "CustomerSegment"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "CustomerAddress_workspaceId_idx" ON "CustomerAddress"("workspaceId");

-- CreateIndex
CREATE INDEX "CustomerNote_workspaceId_idx" ON "CustomerNote"("workspaceId");

-- CreateIndex
CREATE INDEX "FiscalInvoiceCounter_workspaceId_idx" ON "FiscalInvoiceCounter"("workspaceId");

-- CreateIndex
CREATE INDEX "FiscalInvoice_workspaceId_idx" ON "FiscalInvoice"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalInvoice_issuer_fiscalYear_sequenceNumber_key" ON "FiscalInvoice"("workspaceId", "issuer", "fiscalYear", "sequenceNumber");

-- CreateIndex
CREATE INDEX "CreditNoteCounter_workspaceId_idx" ON "CreditNoteCounter"("workspaceId");

-- CreateIndex
CREATE INDEX "CreditNote_workspaceId_idx" ON "CreditNote"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_issuer_fiscalYear_sequenceNumber_key" ON "CreditNote"("workspaceId", "issuer", "fiscalYear", "sequenceNumber");

-- CreateIndex
CREATE INDEX "OrderNote_workspaceId_idx" ON "OrderNote"("workspaceId");

-- CreateIndex
CREATE INDEX "OrderRiskScore_workspaceId_idx" ON "OrderRiskScore"("workspaceId");

-- CreateIndex
CREATE INDEX "OrderItem_workspaceId_idx" ON "OrderItem"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_externalLineItemId_key" ON "OrderItem"("workspaceId", "orderId", "externalLineItemId");

-- CreateIndex
CREATE INDEX "DailySalesAggregate_workspaceId_idx" ON "DailySalesAggregate"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DailySalesAggregate_sku_channel_marketplace_day_key" ON "DailySalesAggregate"("workspaceId", "sku", "channel", "marketplace", "day");

-- CreateIndex
CREATE INDEX "ReplenishmentForecast_workspaceId_idx" ON "ReplenishmentForecast"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentForecast_sku_channel_marketplace_horizon_5a855b66a" ON "ReplenishmentForecast"("workspaceId", "sku", "channel", "marketplace", "horizonDay", "model");

-- CreateIndex
CREATE INDEX "ForecastModelAssignment_workspaceId_idx" ON "ForecastModelAssignment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastModelAssignment_sku_modelId_key" ON "ForecastModelAssignment"("workspaceId", "sku", "modelId");

-- CreateIndex
CREATE INDEX "ForecastAccuracy_workspaceId_idx" ON "ForecastAccuracy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastAccuracy_sku_channel_marketplace_day_key" ON "ForecastAccuracy"("workspaceId", "sku", "channel", "marketplace", "day");

-- CreateIndex
CREATE INDEX "BrandSettings_workspaceId_idx" ON "BrandSettings"("workspaceId");

-- CreateIndex
CREATE INDEX "RetailEvent_workspaceId_idx" ON "RetailEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "PricingSnapshot_workspaceId_idx" ON "PricingSnapshot"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingSnapshot_sku_channel_marketplace_fulfillmentMethod_key" ON "PricingSnapshot"("workspaceId", "sku", "channel", "marketplace", "fulfillmentMethod");

-- CreateIndex
CREATE INDEX "PriceChangeEvent_workspaceId_idx" ON "PriceChangeEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "BuyBoxHistory_workspaceId_idx" ON "BuyBoxHistory"("workspaceId");

-- CreateIndex
CREATE INDEX "FxRate_workspaceId_idx" ON "FxRate"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FxRate_fromCurrency_toCurrency_asOf_key" ON "FxRate"("workspaceId", "fromCurrency", "toCurrency", "asOf");

-- CreateIndex
CREATE INDEX "RetailEventPriceAction_workspaceId_idx" ON "RetailEventPriceAction"("workspaceId");

-- CreateIndex
CREATE INDEX "SettlementReport_workspaceId_idx" ON "SettlementReport"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReport_workspace_reportId_key" ON "SettlementReport"("workspaceId", "reportId");

-- CreateIndex
CREATE INDEX "FinancialTransaction_workspaceId_idx" ON "FinancialTransaction"("workspaceId");

-- CreateIndex
CREATE INDEX "ConnectionScope_workspaceId_idx" ON "ConnectionScope"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionScope_connectionId_kind_externalId_key" ON "ConnectionScope"("workspaceId", "connectionId", "kind", "externalId");

-- CreateIndex
CREATE INDEX "ConnectionEvent_workspaceId_idx" ON "ConnectionEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "OutboundSyncQueue_workspaceId_idx" ON "OutboundSyncQueue"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkOperation_workspaceId_idx" ON "BulkOperation"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkOpsTemplate_workspaceId_idx" ON "BulkOpsTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkActionTemplate_workspaceId_idx" ON "BulkActionTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledBulkAction_workspaceId_idx" ON "ScheduledBulkAction"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkAutomationApproval_workspaceId_idx" ON "BulkAutomationApproval"("workspaceId");

-- CreateIndex
CREATE INDEX "FlatFileImport_workspaceId_idx" ON "FlatFileImport"("workspaceId");

-- CreateIndex
CREATE INDEX "ImportJob_workspaceId_idx" ON "ImportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ImportJobRow_workspaceId_idx" ON "ImportJobRow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportJobRow_jobId_rowIndex_key" ON "ImportJobRow"("workspaceId", "jobId", "rowIndex");

-- CreateIndex
CREATE INDEX "ScheduledImport_workspaceId_idx" ON "ScheduledImport"("workspaceId");

-- CreateIndex
CREATE INDEX "ExportJob_workspaceId_idx" ON "ExportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledExport_workspaceId_idx" ON "ScheduledExport"("workspaceId");

-- CreateIndex
CREATE INDEX "CategorySchema_workspaceId_idx" ON "CategorySchema"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CategorySchema_channel_marketplace_productType_schema_26e10fef6" ON "CategorySchema"("workspaceId", "channel", "marketplace", "productType", "schemaVersion");

-- CreateIndex
CREATE INDEX "GtinExemptionApplication_workspaceId_idx" ON "GtinExemptionApplication"("workspaceId");

-- CreateIndex
CREATE INDEX "ListingWizard_workspaceId_idx" ON "ListingWizard"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingWizard_productId_channelsHash_status_key" ON "ListingWizard"("workspaceId", "productId", "channelsHash", "status");

-- CreateIndex
CREATE INDEX "ScheduledImagePublish_workspaceId_idx" ON "ScheduledImagePublish"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledWizardPublish_workspaceId_idx" ON "ScheduledWizardPublish"("workspaceId");

-- CreateIndex
CREATE INDEX "WizardStepEvent_workspaceId_idx" ON "WizardStepEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "WizardTemplate_workspaceId_idx" ON "WizardTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_idx" ON "AuditLog"("workspaceId");

-- CreateIndex
CREATE INDEX "APlusContent_workspaceId_idx" ON "APlusContent"("workspaceId");

-- CreateIndex
CREATE INDEX "APlusContentVersion_workspaceId_idx" ON "APlusContentVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "APlusContentVersion_contentId_version_key" ON "APlusContentVersion"("workspaceId", "contentId", "version");

-- CreateIndex
CREATE INDEX "APlusContentAsin_workspaceId_idx" ON "APlusContentAsin"("workspaceId");

-- CreateIndex
CREATE INDEX "APlusModule_workspaceId_idx" ON "APlusModule"("workspaceId");

-- CreateIndex
CREATE INDEX "BrandStory_workspaceId_idx" ON "BrandStory"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandStory_brand_marketplace_locale_key" ON "BrandStory"("workspaceId", "brand", "marketplace", "locale");

-- CreateIndex
CREATE INDEX "BrandStoryModule_workspaceId_idx" ON "BrandStoryModule"("workspaceId");

-- CreateIndex
CREATE INDEX "BrandStoryVersion_workspaceId_idx" ON "BrandStoryVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandStoryVersion_storyId_version_key" ON "BrandStoryVersion"("workspaceId", "storyId", "version");

-- CreateIndex
CREATE INDEX "BrandKit_workspaceId_idx" ON "BrandKit"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandKit_workspace_brand_key" ON "BrandKit"("workspaceId", "brand");

-- CreateIndex
CREATE INDEX "BrandWatermarkTemplate_workspaceId_idx" ON "BrandWatermarkTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "AssetLocaleOverlay_workspaceId_idx" ON "AssetLocaleOverlay"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetLocaleOverlay_assetId_locale_key" ON "AssetLocaleOverlay"("workspaceId", "assetId", "locale");

-- CreateIndex
CREATE INDEX "ListingImage_workspaceId_idx" ON "ListingImage"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonMediaRun_workspaceId_idx" ON "AmazonMediaRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonImageFeedJob_workspaceId_idx" ON "AmazonImageFeedJob"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonFlatFileFeedJob_workspaceId_idx" ON "AmazonFlatFileFeedJob"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonFlatFileFeedJob_workspace_feedId_key" ON "AmazonFlatFileFeedJob"("workspaceId", "feedId");

-- CreateIndex
CREATE INDEX "EbayPushJob_workspaceId_idx" ON "EbayPushJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelImagePublishJob_workspaceId_idx" ON "ChannelImagePublishJob"("workspaceId");

-- CreateIndex
CREATE INDEX "SchemaChange_workspaceId_idx" ON "SchemaChange"("workspaceId");

-- CreateIndex
CREATE INDEX "Warehouse_workspaceId_idx" ON "Warehouse"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_workspace_code_key" ON "Warehouse"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "StockLocation_workspaceId_idx" ON "StockLocation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_workspace_code_key" ON "StockLocation"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "StockLevel_workspaceId_idx" ON "StockLevel"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_locationId_productId_variationId_key" ON "StockLevel"("workspaceId", "locationId", "productId", "variationId");

-- CreateIndex
CREATE INDEX "StockReservation_workspaceId_idx" ON "StockReservation"("workspaceId");

-- CreateIndex
CREATE INDEX "StockMovement_workspaceId_idx" ON "StockMovement"("workspaceId");

-- CreateIndex
CREATE INDEX "StockCostLayer_workspaceId_idx" ON "StockCostLayer"("workspaceId");

-- CreateIndex
CREATE INDEX "Lot_workspaceId_idx" ON "Lot"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_productId_lotNumber_key" ON "Lot"("workspaceId", "productId", "lotNumber");

-- CreateIndex
CREATE INDEX "SerialNumber_workspaceId_idx" ON "SerialNumber"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SerialNumber_productId_serialNumber_key" ON "SerialNumber"("workspaceId", "productId", "serialNumber");

-- CreateIndex
CREATE INDEX "StockBin_workspaceId_idx" ON "StockBin"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBin_locationId_code_key" ON "StockBin"("workspaceId", "locationId", "code");

-- CreateIndex
CREATE INDEX "StockBinQuantity_workspaceId_idx" ON "StockBinQuantity"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBinQuantity_stockLevelId_binId_key" ON "StockBinQuantity"("workspaceId", "stockLevelId", "binId");

-- CreateIndex
CREATE INDEX "LotRecall_workspaceId_idx" ON "LotRecall"("workspaceId");

-- CreateIndex
CREATE INDEX "YearEndSnapshot_workspaceId_idx" ON "YearEndSnapshot"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "YearEndSnapshot_workspace_year_key" ON "YearEndSnapshot"("workspaceId", "year");

-- CreateIndex
CREATE INDEX "FbaInventoryDetail_workspaceId_idx" ON "FbaInventoryDetail"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaInventoryDetail_sku_marketplaceId_fulfillmentCente_3d61041a5" ON "FbaInventoryDetail"("workspaceId", "sku", "marketplaceId", "fulfillmentCenterId", "condition");

-- CreateIndex
CREATE INDEX "MCFShipment_workspaceId_idx" ON "MCFShipment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MCFShipment_workspace_amazonFulfillmentOrderId_key" ON "MCFShipment"("workspaceId", "amazonFulfillmentOrderId");

-- CreateIndex
CREATE INDEX "Carrier_workspaceId_idx" ON "Carrier"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Carrier_workspace_code_key" ON "Carrier"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "CarrierService_workspaceId_idx" ON "CarrierService"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierService_carrierId_externalId_key" ON "CarrierService"("workspaceId", "carrierId", "externalId");

-- CreateIndex
CREATE INDEX "CarrierServiceMapping_workspaceId_idx" ON "CarrierServiceMapping"("workspaceId");

-- CreateIndex
CREATE INDEX "CarrierMetric_workspaceId_idx" ON "CarrierMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierMetric_carrierId_windowDays_key" ON "CarrierMetric"("workspaceId", "carrierId", "windowDays");

-- CreateIndex
CREATE INDEX "PickupSchedule_workspaceId_idx" ON "PickupSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "CarrierAccount_workspaceId_idx" ON "CarrierAccount"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierAccount_carrierId_accountLabel_key" ON "CarrierAccount"("workspaceId", "carrierId", "accountLabel");

-- CreateIndex
CREATE INDEX "Shipment_workspaceId_idx" ON "Shipment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_workspace_sendcloudParcelId_key" ON "Shipment"("workspaceId", "sendcloudParcelId");

-- CreateIndex
CREATE INDEX "TrackingEvent_workspaceId_idx" ON "TrackingEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "TrackingMessageLog_workspaceId_idx" ON "TrackingMessageLog"("workspaceId");

-- CreateIndex
CREATE INDEX "ShipmentItem_workspaceId_idx" ON "ShipmentItem"("workspaceId");

-- CreateIndex
CREATE INDEX "ShippingRule_workspaceId_idx" ON "ShippingRule"("workspaceId");

-- CreateIndex
CREATE INDEX "Supplier_workspaceId_idx" ON "Supplier"("workspaceId");

-- CreateIndex
CREATE INDEX "SupplierShippingProfile_workspaceId_idx" ON "SupplierShippingProfile"("workspaceId");

-- CreateIndex
CREATE INDEX "SupplierProduct_workspaceId_idx" ON "SupplierProduct"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_supplierId_productId_key" ON "SupplierProduct"("workspaceId", "supplierId", "productId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_workspaceId_idx" ON "PurchaseOrder"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_workspace_poNumber_key" ON "PurchaseOrder"("workspaceId", "poNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_workspace_supplierAckToken_key" ON "PurchaseOrder"("workspaceId", "supplierAckToken");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_workspace_approverAckToken_key" ON "PurchaseOrder"("workspaceId", "approverAckToken");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_workspaceId_idx" ON "PurchaseOrderItem"("workspaceId");

-- CreateIndex
CREATE INDEX "PurchaseOrderAttachment_workspaceId_idx" ON "PurchaseOrderAttachment"("workspaceId");

-- CreateIndex
CREATE INDEX "PurchaseOrderRevision_workspaceId_idx" ON "PurchaseOrderRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderRevision_purchaseOrderId_version_key" ON "PurchaseOrderRevision"("workspaceId", "purchaseOrderId", "version");

-- CreateIndex
CREATE INDEX "PoComment_workspaceId_idx" ON "PoComment"("workspaceId");

-- CreateIndex
CREATE INDEX "PoEventLog_workspaceId_idx" ON "PoEventLog"("workspaceId");

-- CreateIndex
CREATE INDEX "PoTemplate_workspaceId_idx" ON "PoTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "PoTemplateItem_workspaceId_idx" ON "PoTemplateItem"("workspaceId");

-- CreateIndex
CREATE INDEX "PoSchedule_workspaceId_idx" ON "PoSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundShipment_workspaceId_idx" ON "InboundShipment"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundShipmentAttachment_workspaceId_idx" ON "InboundShipmentAttachment"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundDiscrepancy_workspaceId_idx" ON "InboundDiscrepancy"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundShipmentItem_workspaceId_idx" ON "InboundShipmentItem"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundReceipt_workspaceId_idx" ON "InboundReceipt"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkOrder_workspaceId_idx" ON "WorkOrder"("workspaceId");

-- CreateIndex
CREATE INDEX "Return_workspaceId_idx" ON "Return"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Return_workspace_rmaNumber_key" ON "Return"("workspaceId", "rmaNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Return_workspace_idempotencyKey_key" ON "Return"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ReturnItem_workspaceId_idx" ON "ReturnItem"("workspaceId");

-- CreateIndex
CREATE INDEX "Refund_workspaceId_idx" ON "Refund"("workspaceId");

-- CreateIndex
CREATE INDEX "RefundAttempt_workspaceId_idx" ON "RefundAttempt"("workspaceId");

-- CreateIndex
CREATE INDEX "ReturnPolicy_workspaceId_idx" ON "ReturnPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnPolicy_channel_marketplace_productType_key" ON "ReturnPolicy"("workspaceId", "channel", "marketplace", "productType");

-- CreateIndex
CREATE INDEX "ReplenishmentRule_workspaceId_idx" ON "ReplenishmentRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentRule_workspace_productId_key" ON "ReplenishmentRule"("workspaceId", "productId");

-- CreateIndex
CREATE INDEX "ReplenishmentRecommendation_workspaceId_idx" ON "ReplenishmentRecommendation"("workspaceId");

-- CreateIndex
CREATE INDEX "CycleCount_workspaceId_idx" ON "CycleCount"("workspaceId");

-- CreateIndex
CREATE INDEX "CycleCountItem_workspaceId_idx" ON "CycleCountItem"("workspaceId");

-- CreateIndex
CREATE INDEX "OrderRoutingRule_workspaceId_idx" ON "OrderRoutingRule"("workspaceId");

-- CreateIndex
CREATE INDEX "ReplenishmentSavedView_workspaceId_idx" ON "ReplenishmentSavedView"("workspaceId");

-- CreateIndex
CREATE INDEX "CronRun_workspaceId_idx" ON "CronRun"("workspaceId");

-- CreateIndex
CREATE INDEX "OutboundApiCallLog_workspaceId_idx" ON "OutboundApiCallLog"("workspaceId");

-- CreateIndex
CREATE INDEX "SyncLogErrorGroup_workspaceId_idx" ON "SyncLogErrorGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncLogErrorGroup_workspace_fingerprint_key" ON "SyncLogErrorGroup"("workspaceId", "fingerprint");

-- CreateIndex
CREATE INDEX "SyncLogSavedSearch_workspaceId_idx" ON "SyncLogSavedSearch"("workspaceId");

-- CreateIndex
CREATE INDEX "AlertRule_workspaceId_idx" ON "AlertRule"("workspaceId");

-- CreateIndex
CREATE INDEX "AlertEvent_workspaceId_idx" ON "AlertEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductSubstitution_workspaceId_idx" ON "ProductSubstitution"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSubstitution_primaryProductId_substituteProductId_key" ON "ProductSubstitution"("workspaceId", "primaryProductId", "substituteProductId");

-- CreateIndex
CREATE INDEX "StockoutEvent_workspaceId_idx" ON "StockoutEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "AutoPoRunLog_workspaceId_idx" ON "AutoPoRunLog"("workspaceId");

-- CreateIndex
CREATE INDEX "FbaRestockReport_workspaceId_idx" ON "FbaRestockReport"("workspaceId");

-- CreateIndex
CREATE INDEX "FbaRestockRow_workspaceId_idx" ON "FbaRestockRow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaRestockRow_sku_marketplace_reportId_key" ON "FbaRestockRow"("workspaceId", "sku", "marketplace", "reportId");

-- CreateIndex
CREATE INDEX "FbaInboundPlanV2_workspaceId_idx" ON "FbaInboundPlanV2"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaInboundPlanV2_workspace_planId_key" ON "FbaInboundPlanV2"("workspaceId", "planId");

-- CreateIndex
CREATE INDEX "Tag_workspaceId_idx" ON "Tag"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_workspace_name_key" ON "Tag"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AssetTag_workspaceId_idx" ON "AssetTag"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductTag_workspaceId_idx" ON "ProductTag"("workspaceId");

-- CreateIndex
CREATE INDEX "Bundle_workspaceId_idx" ON "Bundle"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_workspace_productId_key" ON "Bundle"("workspaceId", "productId");

-- CreateIndex
CREATE INDEX "BundleComponent_workspaceId_idx" ON "BundleComponent"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BundleComponent_bundleId_productId_key" ON "BundleComponent"("workspaceId", "bundleId", "productId");

-- CreateIndex
CREATE INDEX "SavedView_workspaceId_idx" ON "SavedView"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedView_userId_surface_name_key" ON "SavedView"("workspaceId", "userId", "surface", "name");

-- CreateIndex
CREATE INDEX "Review_workspaceId_idx" ON "Review"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_channel_externalReviewId_key" ON "Review"("workspaceId", "channel", "externalReviewId");

-- CreateIndex
CREATE INDEX "ReviewResponse_workspaceId_idx" ON "ReviewResponse"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewSpotlight_workspaceId_idx" ON "ReviewSpotlight"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewActionItem_workspaceId_idx" ON "ReviewActionItem"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewSentiment_workspaceId_idx" ON "ReviewSentiment"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewCategoryRate_workspaceId_idx" ON "ReviewCategoryRate"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCategoryRate_productId_marketplace_category_date_key" ON "ReviewCategoryRate"("workspaceId", "productId", "marketplace", "category", "date");

-- CreateIndex
CREATE INDEX "ReviewSpike_workspaceId_idx" ON "ReviewSpike"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonReviewInsight_workspaceId_idx" ON "AmazonReviewInsight"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonReviewInsight_asin_marketplace_key" ON "AmazonReviewInsight"("workspaceId", "asin", "marketplace");

-- CreateIndex
CREATE INDEX "ReviewRequest_workspaceId_idx" ON "ReviewRequest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRequest_orderId_channel_key" ON "ReviewRequest"("workspaceId", "orderId", "channel");

-- CreateIndex
CREATE INDEX "ReviewRule_workspaceId_idx" ON "ReviewRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRule_name_scope_marketplace_key" ON "ReviewRule"("workspaceId", "name", "scope", "marketplace");

-- CreateIndex
CREATE INDEX "ReviewTimingDefault_workspaceId_idx" ON "ReviewTimingDefault"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewTimingDefault_workspace_pattern_key" ON "ReviewTimingDefault"("workspaceId", "pattern");

-- CreateIndex
CREATE INDEX "ReviewSendWindow_workspaceId_idx" ON "ReviewSendWindow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSendWindow_marketplace_dayOfWeek_key" ON "ReviewSendWindow"("workspaceId", "marketplace", "dayOfWeek");

-- CreateIndex
CREATE INDEX "ReviewSentimentCheck_workspaceId_idx" ON "ReviewSentimentCheck"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSentimentCheck_workspace_token_key" ON "ReviewSentimentCheck"("workspaceId", "token");

-- CreateIndex
CREATE INDEX "ReviewMailerState_workspaceId_idx" ON "ReviewMailerState"("workspaceId");

-- CreateIndex
CREATE INDEX "EmailSuppression_workspaceId_idx" ON "EmailSuppression"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_channel_key" ON "EmailSuppression"("workspaceId", "email", "channel");

-- CreateIndex
CREATE INDEX "OrderTag_workspaceId_idx" ON "OrderTag"("workspaceId");

-- CreateIndex
CREATE INDEX "AiUsageLog_workspaceId_idx" ON "AiUsageLog"("workspaceId");

-- CreateIndex
CREATE INDEX "AiFeatureModelPref_workspaceId_idx" ON "AiFeatureModelPref"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AiFeatureModelPref_workspace_featureKey_key" ON "AiFeatureModelPref"("workspaceId", "featureKey");

-- CreateIndex
CREATE INDEX "ProductAiDraft_workspaceId_idx" ON "ProductAiDraft"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAiDraft_cell_run_key" ON "ProductAiDraft"("workspaceId", "productId", "cellKey", "runId");

-- CreateIndex
CREATE INDEX "AgentDefinition_workspaceId_idx" ON "AgentDefinition"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDefinition_workspace_key_key" ON "AgentDefinition"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_idx" ON "AgentRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentTool_workspaceId_idx" ON "AgentTool"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTool_workspace_name_key" ON "AgentTool"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AgentApproval_workspaceId_idx" ON "AgentApproval"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentMemory_workspaceId_idx" ON "AgentMemory"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMemory_scope_entityType_entityId_key_key" ON "AgentMemory"("workspaceId", "scope", "entityType", "entityId", "key");

-- CreateIndex
CREATE INDEX "PromptTemplate_workspaceId_idx" ON "PromptTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "Goal_workspaceId_idx" ON "Goal"("workspaceId");

-- CreateIndex
CREATE INDEX "DashboardLayout_workspaceId_idx" ON "DashboardLayout"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardLayout_workspace_userId_key" ON "DashboardLayout"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "DashboardView_workspaceId_idx" ON "DashboardView"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardView_userId_name_key" ON "DashboardView"("workspaceId", "userId", "name");

-- CreateIndex
CREATE INDEX "ScheduledReport_workspaceId_idx" ON "ScheduledReport"("workspaceId");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_idx" ON "Notification"("workspaceId");

-- CreateIndex
CREATE INDEX "SavedViewAlert_workspaceId_idx" ON "SavedViewAlert"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductTranslation_workspaceId_idx" ON "ProductTranslation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTranslation_productId_language_key" ON "ProductTranslation"("workspaceId", "productId", "language");

-- CreateIndex
CREATE INDEX "ProductRelation_workspaceId_idx" ON "ProductRelation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRelation_fromProductId_toProductId_type_key" ON "ProductRelation"("workspaceId", "fromProductId", "toProductId", "type");

-- CreateIndex
CREATE INDEX "ProductSeo_workspaceId_idx" ON "ProductSeo"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSeo_productId_locale_key" ON "ProductSeo"("workspaceId", "productId", "locale");

-- CreateIndex
CREATE INDEX "ProductCertificate_workspaceId_idx" ON "ProductCertificate"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_workspaceId_idx" ON "ChannelPublishAttempt"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayCampaign_workspaceId_idx" ON "EbayCampaign"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayCampaign_channelConnectionId_externalCampaignId_key" ON "EbayCampaign"("workspaceId", "channelConnectionId", "externalCampaignId");

-- CreateIndex
CREATE INDEX "EbayRateDiscoveryPlan_workspaceId_idx" ON "EbayRateDiscoveryPlan"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayCampaignAutomationPolicy_workspaceId_idx" ON "EbayCampaignAutomationPolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayAdGroup_workspaceId_idx" ON "EbayAdGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdGroup_campaignId_externalAdGroupId_key" ON "EbayAdGroup"("workspaceId", "campaignId", "externalAdGroupId");

-- CreateIndex
CREATE INDEX "EbayAd_workspaceId_idx" ON "EbayAd"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAd_campaignId_listingId_key" ON "EbayAd"("workspaceId", "campaignId", "listingId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAd_campaignId_inventoryReference_key" ON "EbayAd"("workspaceId", "campaignId", "inventoryReference");

-- CreateIndex
CREATE INDEX "EbayKeyword_workspaceId_idx" ON "EbayKeyword"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayKeyword_adGroupId_externalKeywordId_key" ON "EbayKeyword"("workspaceId", "adGroupId", "externalKeywordId");

-- CreateIndex
CREATE INDEX "EbayNegativeKeyword_workspaceId_idx" ON "EbayNegativeKeyword"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayNegativeKeyword_campaignId_externalId_key" ON "EbayNegativeKeyword"("workspaceId", "campaignId", "externalId");

-- CreateIndex
CREATE INDEX "EbayAdsReportTask_workspaceId_idx" ON "EbayAdsReportTask"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsReportTask_workspace_externalTaskId_key" ON "EbayAdsReportTask"("workspaceId", "externalTaskId");

-- CreateIndex
CREATE INDEX "EbayAdsDailyPerformance_workspaceId_idx" ON "EbayAdsDailyPerformance"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsDailyPerformance_marketplace_fundingModel_enti_88283d238" ON "EbayAdsDailyPerformance"("workspaceId", "marketplace", "fundingModel", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "EbayListingIndex_workspaceId_idx" ON "EbayListingIndex"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayListingIndex_marketplace_itemId_key" ON "EbayListingIndex"("workspaceId", "marketplace", "itemId");

-- CreateIndex
CREATE INDEX "EbayListingEconomics_workspaceId_idx" ON "EbayListingEconomics"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayListingEconomics_marketplace_itemId_key" ON "EbayListingEconomics"("workspaceId", "marketplace", "itemId");

-- CreateIndex
CREATE INDEX "MarketingAutomationState_workspaceId_idx" ON "MarketingAutomationState"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAutomationState_workspace_channel_key" ON "MarketingAutomationState"("workspaceId", "channel");

-- CreateIndex
CREATE INDEX "MarketingSpendCeiling_workspaceId_idx" ON "MarketingSpendCeiling"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSpendCeiling_channel_marketplace_key" ON "MarketingSpendCeiling"("workspaceId", "channel", "marketplace");

-- CreateIndex
CREATE INDEX "EbayAdsRule_workspaceId_idx" ON "EbayAdsRule"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayAdsRuleVersion_workspaceId_idx" ON "EbayAdsRuleVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsRuleVersion_ruleId_version_key" ON "EbayAdsRuleVersion"("workspaceId", "ruleId", "version");

-- CreateIndex
CREATE INDEX "EbayAdsRuleExecution_workspaceId_idx" ON "EbayAdsRuleExecution"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayAdsProposal_workspaceId_idx" ON "EbayAdsProposal"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsProposal_workspace_proposedKey_key" ON "EbayAdsProposal"("workspaceId", "proposedKey");

-- CreateIndex
CREATE INDEX "EbayAdsDigest_workspaceId_idx" ON "EbayAdsDigest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsDigest_workspace_weekStart_key" ON "EbayAdsDigest"("workspaceId", "weekStart");

-- CreateIndex
CREATE INDEX "EbayWatcherStats_workspaceId_idx" ON "EbayWatcherStats"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayMarkdown_workspaceId_idx" ON "EbayMarkdown"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayVolumePromotion_workspaceId_idx" ON "EbayVolumePromotion"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayVolumeTierTemplate_workspaceId_idx" ON "EbayVolumeTierTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledProductChange_workspaceId_idx" ON "ScheduledProductChange"("workspaceId");

-- CreateIndex
CREATE INDEX "AutomationRule_workspaceId_idx" ON "AutomationRule"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignRuleAssignment_workspaceId_idx" ON "CampaignRuleAssignment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRuleAssignment_campaignId_ruleId_key" ON "CampaignRuleAssignment"("workspaceId", "campaignId", "ruleId");

-- CreateIndex
CREATE INDEX "AutomationRuleTemplate_workspaceId_idx" ON "AutomationRuleTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "AutomationRuleExecution_workspaceId_idx" ON "AutomationRuleExecution"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsRuleSuggestion_workspaceId_idx" ON "AdsRuleSuggestion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsRuleSuggestion_dedupe_key" ON "AdsRuleSuggestion"("workspaceId", "ruleId", "entityId", "proposedKey");

-- CreateIndex
CREATE INDEX "AdsSuggestionMute_workspaceId_idx" ON "AdsSuggestionMute"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsSuggestionMute_scope_entityType_entityId_key" ON "AdsSuggestionMute"("workspaceId", "scope", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "KeywordRank_workspaceId_idx" ON "KeywordRank"("workspaceId");

-- CreateIndex
CREATE INDEX "Scenario_workspaceId_idx" ON "Scenario"("workspaceId");

-- CreateIndex
CREATE INDEX "ScenarioRun_workspaceId_idx" ON "ScenarioRun"("workspaceId");

-- CreateIndex
CREATE INDEX "ListingReconciliation_workspaceId_idx" ON "ListingReconciliation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingReconciliation_channel_marketplace_externalSku_key" ON "ListingReconciliation"("workspaceId", "channel", "marketplace", "externalSku");

-- CreateIndex
CREATE INDEX "FlatFilePullRecord_workspaceId_idx" ON "FlatFilePullRecord"("workspaceId");

-- CreateIndex
CREATE INDEX "FlatFilePullJob_workspaceId_idx" ON "FlatFilePullJob"("workspaceId");

-- CreateIndex
CREATE INDEX "CatalogOrganizeSession_workspaceId_idx" ON "CatalogOrganizeSession"("workspaceId");

-- CreateIndex
CREATE INDEX "CatalogOrganizeChange_workspaceId_idx" ON "CatalogOrganizeChange"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductReadCache_workspaceId_idx" ON "ProductReadCache"("workspaceId");

-- CreateIndex
CREATE INDEX "Category_workspaceId_idx" ON "Category"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_parentId_slug_key" ON "Category"("workspaceId", "parentId", "slug");

-- CreateIndex
CREATE INDEX "CategoryClosure_workspaceId_idx" ON "CategoryClosure"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductCategory_workspaceId_idx" ON "ProductCategory"("workspaceId");

-- CreateIndex
CREATE INDEX "FnskuLabelTemplate_workspaceId_idx" ON "FnskuLabelTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductEvent_workspaceId_idx" ON "ProductEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "ListingQualitySnapshot_workspaceId_idx" ON "ListingQualitySnapshot"("workspaceId");

-- CreateIndex
CREATE INDEX "RoutingDecision_workspaceId_idx" ON "RoutingDecision"("workspaceId");

-- CreateIndex
CREATE INDEX "FeedTransformRule_workspaceId_idx" ON "FeedTransformRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedTransformRule_name_channel_marketplace_key" ON "FeedTransformRule"("workspaceId", "name", "channel", "marketplace");

-- CreateIndex
CREATE INDEX "ChannelSchema_workspaceId_idx" ON "ChannelSchema"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelSchema_channel_marketplace_fieldKey_key" ON "ChannelSchema"("workspaceId", "channel", "marketplace", "fieldKey");

-- CreateIndex
CREATE INDEX "FbaReimbursement_workspaceId_idx" ON "FbaReimbursement"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaReimbursement_workspace_reimbursementId_key" ON "FbaReimbursement"("workspaceId", "reimbursementId");

-- CreateIndex
CREATE INDEX "FbaInventoryAdjustment_workspaceId_idx" ON "FbaInventoryAdjustment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaInventoryAdjustment_workspace_adjustmentId_key" ON "FbaInventoryAdjustment"("workspaceId", "adjustmentId");

-- CreateIndex
CREATE INDEX "MarketingCampaign_workspaceId_idx" ON "MarketingCampaign"("workspaceId");

-- CreateIndex
CREATE INDEX "MarketingCampaignLink_workspaceId_idx" ON "MarketingCampaignLink"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignLink_campaignId_marketplace_key" ON "MarketingCampaignLink"("workspaceId", "campaignId", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignLink_externalId_marketplace_key" ON "MarketingCampaignLink"("workspaceId", "externalId", "marketplace");

-- CreateIndex
CREATE INDEX "AmazonAdsCampaignDetail_workspaceId_idx" ON "AmazonAdsCampaignDetail"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayPromotedDetail_workspaceId_idx" ON "EbayPromotedDetail"("workspaceId");

-- CreateIndex
CREATE INDEX "DiscountDetail_workspaceId_idx" ON "DiscountDetail"("workspaceId");

-- CreateIndex
CREATE INDEX "ExternalAdsDetail_workspaceId_idx" ON "ExternalAdsDetail"("workspaceId");

-- CreateIndex
CREATE INDEX "ContentPushDetail_workspaceId_idx" ON "ContentPushDetail"("workspaceId");

-- CreateIndex
CREATE INDEX "OutreachDetail_workspaceId_idx" ON "OutreachDetail"("workspaceId");

-- CreateIndex
CREATE INDEX "AdMutation_workspaceId_idx" ON "AdMutation"("workspaceId");

-- CreateIndex
CREATE INDEX "AdBlueprintApplication_workspaceId_idx" ON "AdBlueprintApplication"("workspaceId");

-- CreateIndex
CREATE INDEX "AdKeywordProtection_workspaceId_idx" ON "AdKeywordProtection"("workspaceId");

-- CreateIndex
CREATE INDEX "AdNegativeReview_workspaceId_idx" ON "AdNegativeReview"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdNegativeReview_protectedTerm_campaignId_key" ON "AdNegativeReview"("workspaceId", "protectedTerm", "campaignId");

-- CreateIndex
CREATE INDEX "AdBlueprint_workspaceId_idx" ON "AdBlueprint"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdBlueprint_workspace_name_key" ON "AdBlueprint"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "CampaignTarget_workspaceId_idx" ON "CampaignTarget"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignBudget_workspaceId_idx" ON "CampaignBudget"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignBudgetAllocation_workspaceId_idx" ON "CampaignBudgetAllocation"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignBudgetRebalance_workspaceId_idx" ON "CampaignBudgetRebalance"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignMetric_workspaceId_idx" ON "CampaignMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMetric_channel_entityType_entityId_date_key" ON "CampaignMetric"("workspaceId", "channel", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "CampaignAction_workspaceId_idx" ON "CampaignAction"("workspaceId");

-- CreateIndex
CREATE INDEX "CalendarEntry_workspaceId_idx" ON "CalendarEntry"("workspaceId");

-- CreateIndex
CREATE INDEX "AdSchedule_workspaceId_idx" ON "AdSchedule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdSchedule_campaignId_key" ON "AdSchedule"("workspaceId", "campaignId");

-- CreateIndex
CREATE INDEX "RankScheduleGroup_workspaceId_idx" ON "RankScheduleGroup"("workspaceId");

-- CreateIndex
CREATE INDEX "RankScheduleEvent_workspaceId_idx" ON "RankScheduleEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "RankScheduleVersion_workspaceId_idx" ON "RankScheduleVersion"("workspaceId");

-- CreateIndex
CREATE INDEX "BudgetSchedule_workspaceId_idx" ON "BudgetSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "AutopilotPlan_workspaceId_idx" ON "AutopilotPlan"("workspaceId");

-- CreateIndex
CREATE INDEX "AutopilotDecision_workspaceId_idx" ON "AutopilotDecision"("workspaceId");

-- CreateIndex
CREATE INDEX "RankTarget_workspaceId_idx" ON "RankTarget"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RankTarget_workspace_key_key" ON "RankTarget"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "RankScheduleTemplate_workspaceId_idx" ON "RankScheduleTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductRankPlan_workspaceId_idx" ON "ProductRankPlan"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRankPlan_productId_marketplace_key" ON "ProductRankPlan"("workspaceId", "productId", "marketplace");

-- CreateIndex
CREATE INDEX "AdAudience_workspaceId_idx" ON "AdAudience"("workspaceId");

-- CreateIndex
CREATE INDEX "AdBudgetPlan_workspaceId_idx" ON "AdBudgetPlan"("workspaceId");

-- CreateIndex
CREATE INDEX "AdProductGoal_workspaceId_idx" ON "AdProductGoal"("workspaceId");

-- CreateIndex
CREATE INDEX "SupplierContact_workspaceId_idx" ON "SupplierContact"("workspaceId");

-- CreateIndex
CREATE INDEX "SupplierComm_workspaceId_idx" ON "SupplierComm"("workspaceId");

-- CreateIndex
CREATE INDEX "SupplierFollowUp_workspaceId_idx" ON "SupplierFollowUp"("workspaceId");

-- CreateIndex
CREATE INDEX "DevelopmentProject_workspaceId_idx" ON "DevelopmentProject"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DevelopmentProject_workspace_code_key" ON "DevelopmentProject"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "DevelopmentProjectSupplier_workspaceId_idx" ON "DevelopmentProjectSupplier"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DevelopmentProjectSupplier_projectId_supplierId_key" ON "DevelopmentProjectSupplier"("workspaceId", "projectId", "supplierId");

-- CreateIndex
CREATE INDEX "DevelopmentAttachment_workspaceId_idx" ON "DevelopmentAttachment"("workspaceId");

-- CreateIndex
CREATE INDEX "DevelopmentCertification_workspaceId_idx" ON "DevelopmentCertification"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsAutomationState_workspaceId_idx" ON "AdsAutomationState"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonReportRun_workspaceId_idx" ON "AmazonReportRun"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonReportRun_workspace_reportId_key" ON "AmazonReportRun"("workspaceId", "reportId");

-- CreateIndex
CREATE INDEX "SharedListingMembership_workspaceId_idx" ON "SharedListingMembership"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedListingMembership_marketplace_itemId_sku_key" ON "SharedListingMembership"("workspaceId", "marketplace", "itemId", "sku");

-- CreateIndex
CREATE INDEX "SyncChannelPolicy_workspaceId_idx" ON "SyncChannelPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncChannelPolicy_channel_marketplace_conn_key" ON "SyncChannelPolicy"("workspaceId", "channel", "marketplace", "channelConnectionId");

-- CreateIndex
CREATE INDEX "SyncControlAudit_workspaceId_idx" ON "SyncControlAudit"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayDescriptionTheme_workspaceId_idx" ON "EbayDescriptionTheme"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayDescriptionTheme_workspace_name_key" ON "EbayDescriptionTheme"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AmazonTemplateVault_workspaceId_idx" ON "AmazonTemplateVault"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonTemplateVault_workspace_templateIdentifier_key" ON "AmazonTemplateVault"("workspaceId", "templateIdentifier");

-- CreateIndex
CREATE INDEX "AmazonFamilyWorkbook_workspaceId_idx" ON "AmazonFamilyWorkbook"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonFamilyWorkbook_familyKey_marketplace_key" ON "AmazonFamilyWorkbook"("workspaceId", "familyKey", "marketplace");

-- CreateIndex
CREATE INDEX "ReportShareLink_workspaceId_idx" ON "ReportShareLink"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportShareLink_workspace_tokenHash_key" ON "ReportShareLink"("workspaceId", "tokenHash");

-- CreateIndex
CREATE INDEX "SavedReport_workspaceId_idx" ON "SavedReport"("workspaceId");

-- CreateIndex
CREATE INDEX "SavedReportVersion_workspaceId_idx" ON "SavedReportVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedReportVersion_savedReportId_version_key" ON "SavedReportVersion"("workspaceId", "savedReportId", "version");

-- CreateIndex
CREATE INDEX "ReportSchedule_workspaceId_idx" ON "ReportSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "ReportDelivery_workspaceId_idx" ON "ReportDelivery"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsConsoleImport_workspaceId_idx" ON "AdsConsoleImport"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsConsoleRow_workspaceId_idx" ON "AdsConsoleRow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsConsoleRow_natural_key" ON "AdsConsoleRow"("workspaceId", "importId", "windowStart", "windowEnd", "campaignId", "adGroupId", "adId", "targetId", "searchTerm", "placement", "marketplace");

-- CreateIndex
CREATE INDEX "CustomMetric_workspaceId_idx" ON "CustomMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomMetric_reportId_name_key" ON "CustomMetric"("workspaceId", "reportId", "name");

-- CreateIndex
CREATE INDEX "AgentCharter_workspaceId_idx" ON "AgentCharter"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCharter_key_version_key" ON "AgentCharter"("workspaceId", "key", "version");

-- CreateIndex
CREATE INDEX "AgentCharterRevision_workspaceId_idx" ON "AgentCharterRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCharterRevision_charterKey_revision_key" ON "AgentCharterRevision"("workspaceId", "charterKey", "revision");

-- CreateIndex
CREATE INDEX "AgentEvalRun_workspaceId_idx" ON "AgentEvalRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentControlAudit_workspaceId_idx" ON "AgentControlAudit"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentObservation_workspaceId_idx" ON "AgentObservation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentObservation_key_entityType_entityId_marketplace_key" ON "AgentObservation"("workspaceId", "key", "entityType", "entityId", "marketplace");

-- CreateIndex
CREATE INDEX "AgentFinding_workspaceId_idx" ON "AgentFinding"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentFinding_dedupe" ON "AgentFinding"("workspaceId", "charterKey", "entityType", "entityId", "dedupeKey");

-- CreateIndex
CREATE INDEX "AgentPlan_workspaceId_idx" ON "AgentPlan"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentStrategy_workspaceId_idx" ON "AgentStrategy"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentStep_workspaceId_idx" ON "AgentStep"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_agentRunId_seq_key" ON "AgentStep"("workspaceId", "agentRunId", "seq");

-- CreateIndex
CREATE INDEX "AgentExemplar_workspaceId_idx" ON "AgentExemplar"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentScorecard_workspaceId_idx" ON "AgentScorecard"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentScorecard_charterKey_periodStart_periodEnd_key" ON "AgentScorecard"("workspaceId", "charterKey", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "GraphEdge_workspaceId_idx" ON "GraphEdge"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphEdge_unique" ON "GraphEdge"("workspaceId", "fromType", "fromId", "toType", "toId", "relation");

-- CreateIndex
CREATE INDEX "AgentFleetState_workspaceId_idx" ON "AgentFleetState"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentShadowGrade_workspaceId_idx" ON "AgentShadowGrade"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentShadowGrade_workspace_findingId_key" ON "AgentShadowGrade"("workspaceId", "findingId");

-- CreateIndex
CREATE INDEX "AgentWorkflow_workspaceId_idx" ON "AgentWorkflow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkflow_workspace_key_key" ON "AgentWorkflow"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "AgentWorkflowRevision_workspaceId_idx" ON "AgentWorkflowRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkflowRevision_workflowKey_revision_key" ON "AgentWorkflowRevision"("workspaceId", "workflowKey", "revision");

-- CreateIndex
CREATE INDEX "AgentAssignment_workspaceId_idx" ON "AgentAssignment"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentFindingRun_workspaceId_idx" ON "AgentFindingRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsHarvestPolicy_workspaceId_idx" ON "AdsHarvestPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsHarvestPolicy_scopeGrain_scopeId_kind_key" ON "AdsHarvestPolicy"("workspaceId", "scopeGrain", "scopeId", "kind");

-- CreateIndex
CREATE INDEX "AdsHarvestDestination_workspaceId_idx" ON "AdsHarvestDestination"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsHarvestDestination_scopeGrain_scopeId_matchType_key" ON "AdsHarvestDestination"("workspaceId", "scopeGrain", "scopeId", "matchType");

-- CreateIndex
CREATE INDEX "SqpReportRequest_workspaceId_idx" ON "SqpReportRequest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SqpReportRequest_workspace_reportId_key" ON "SqpReportRequest"("workspaceId", "reportId");

-- CreateIndex
CREATE INDEX "AdSpendCeiling_workspaceId_idx" ON "AdSpendCeiling"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpendCeiling_grain_scopeId_key" ON "AdSpendCeiling"("workspaceId", "grain", "scopeId");

-- CreateIndex
CREATE INDEX "AdBidPolicy_workspaceId_idx" ON "AdBidPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdBidPolicy_grain_scopeId_key" ON "AdBidPolicy"("workspaceId", "grain", "scopeId");

-- CreateIndex
CREATE INDEX "AdWriteRefusal_workspaceId_idx" ON "AdWriteRefusal"("workspaceId");

-- CreateIndex
CREATE INDEX "AutomationRefusalDaily_workspaceId_idx" ON "AutomationRefusalDaily"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRefusalDaily_actorKind_actorId_dayUtc_reason_key" ON "AutomationRefusalDaily"("workspaceId", "actorKind", "actorId", "dayUtc", "reason");

-- CreateIndex
CREATE INDEX "KeywordBidProposal_workspaceId_idx" ON "KeywordBidProposal"("workspaceId");

-- CreateIndex
CREATE INDEX "EventOutbox_workspaceId_idx" ON "EventOutbox"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EventOutbox_workspace_eventId_key" ON "EventOutbox"("workspaceId", "eventId");

-- CreateIndex
CREATE INDEX "CategoryChannelMapping_workspaceId_idx" ON "CategoryChannelMapping"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryChannelMapping_categoryId_channel_marketplace_key" ON "CategoryChannelMapping"("workspaceId", "categoryId", "channel", "marketplace");

-- CreateIndex
CREATE INDEX "CellFormula_workspaceId_idx" ON "CellFormula"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CellFormula_productId_scope_channel_marketplace_local_81ce279a6" ON "CellFormula"("workspaceId", "productId", "scope", "channel", "marketplace", "locale", "fieldKey");

-- CreateIndex
CREATE INDEX "MasterFieldRule_workspaceId_idx" ON "MasterFieldRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MasterFieldRule_productType_fieldKey_key" ON "MasterFieldRule"("workspaceId", "productType", "fieldKey");

-- CreateIndex
CREATE INDEX "MasterFieldRuleRevision_workspaceId_idx" ON "MasterFieldRuleRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MasterFieldRuleRevision_productType_fieldKey_version_key" ON "MasterFieldRuleRevision"("workspaceId", "productType", "fieldKey", "version");

-- AddForeignKey
ALTER TABLE "BrandWatermarkTemplate" ADD CONSTRAINT "BrandWatermarkTemplate_workspaceId_brand_fkey" FOREIGN KEY ("workspaceId", "brand") REFERENCES "BrandKit"("workspaceId", "brand") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "Product" ADD CONSTRAINT "Product_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SkuAlias" ADD CONSTRAINT "SkuAlias_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockImportJob" ADD CONSTRAINT "StockImportJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductFamily" ADD CONSTRAINT "ProductFamily_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AttributeGroup" ADD CONSTRAINT "AttributeGroup_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CustomAttribute" ADD CONSTRAINT "CustomAttribute_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AttributeOption" ADD CONSTRAINT "AttributeOption_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FamilyAttribute" ADD CONSTRAINT "FamilyAttribute_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductWorkflow" ADD CONSTRAINT "ProductWorkflow_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "WorkflowStage" ADD CONSTRAINT "WorkflowStage_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "WorkflowComment" ADD CONSTRAINT "WorkflowComment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "WorkflowAssignment" ADD CONSTRAINT "WorkflowAssignment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CustomerGroup" ADD CONSTRAINT "CustomerGroup_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductTierPrice" ADD CONSTRAINT "ProductTierPrice_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DigitalAsset" ADD CONSTRAINT "DigitalAsset_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AssetFolder" ADD CONSTRAINT "AssetFolder_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AssetUsage" ADD CONSTRAINT "AssetUsage_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RepricingRule" ADD CONSTRAINT "RepricingRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RepricingDecision" ADD CONSTRAINT "RepricingDecision_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductVariation" ADD CONSTRAINT "ProductVariation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "VariantImage" ADD CONSTRAINT "VariantImage_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "VariantChannelListing" ADD CONSTRAINT "VariantChannelListing_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductListingAlias" ADD CONSTRAINT "ProductListingAlias_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ChannelListingSnapshot" ADD CONSTRAINT "ChannelListingSnapshot_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Marketplace" ADD CONSTRAINT "Marketplace_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ChannelListingOverride" ADD CONSTRAINT "ChannelListingOverride_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FieldLinkGroup" ADD CONSTRAINT "FieldLinkGroup_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FieldValueMap" ADD CONSTRAINT "FieldValueMap_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SizeScaleMap" ADD CONSTRAINT "SizeScaleMap_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "MappingRevision" ADD CONSTRAINT "MappingRevision_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SyncAttempt" ADD CONSTRAINT "SyncAttempt_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonSuppression" ADD CONSTRAINT "AmazonSuppression_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ListingIssue" ADD CONSTRAINT "ListingIssue_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Offer" ADD CONSTRAINT "Offer_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ListingRecoveryEvent" ADD CONSTRAINT "ListingRecoveryEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ChannelListingImage" ADD CONSTRAINT "ChannelListingImage_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "TerminologyPreference" ADD CONSTRAINT "TerminologyPreference_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BrandVoice" ADD CONSTRAINT "BrandVoice_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "MarketplaceSync" ADD CONSTRAINT "MarketplaceSync_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Channel" ADD CONSTRAINT "Channel_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Listing" ADD CONSTRAINT "Listing_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DraftListing" ADD CONSTRAINT "DraftListing_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockLog" ADD CONSTRAINT "StockLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FBAShipment" ADD CONSTRAINT "FBAShipment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FBAShipmentItem" ADD CONSTRAINT "FBAShipmentItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PricingRuleProduct" ADD CONSTRAINT "PricingRuleProduct_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PricingRuleVariation" ADD CONSTRAINT "PricingRuleVariation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SyncHealthLog" ADD CONSTRAINT "SyncHealthLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BulkActionJob" ADD CONSTRAINT "BulkActionJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BulkActionItem" ADD CONSTRAINT "BulkActionItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SellerFeedback" ADD CONSTRAINT "SellerFeedback_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdGroup" ADD CONSTRAINT "AdGroup_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdTarget" ADD CONSTRAINT "AdTarget_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdProductAd" ADD CONSTRAINT "AdProductAd_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdProductSet" ADD CONSTRAINT "AdProductSet_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsConnection" ADD CONSTRAINT "AmazonAdsConnection_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsProfile" ADD CONSTRAINT "AmazonAdsProfile_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "KeywordWatchlist" ADD CONSTRAINT "KeywordWatchlist_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "KeywordWatchlistTerm" ADD CONSTRAINT "KeywordWatchlistTerm_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "KeywordCoverageSet" ADD CONSTRAINT "KeywordCoverageSet_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "KeywordCoverageTerm" ADD CONSTRAINT "KeywordCoverageTerm_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsPortfolio" ADD CONSTRAINT "AmazonAdsPortfolio_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsDailyPerformance" ADD CONSTRAINT "AmazonAdsDailyPerformance_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsHourlyPerformance" ADD CONSTRAINT "AmazonAdsHourlyPerformance_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdBudgetUsageSample" ADD CONSTRAINT "AdBudgetUsageSample_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsSearchTerm" ADD CONSTRAINT "AmazonAdsSearchTerm_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SearchQueryPerformance" ADD CONSTRAINT "SearchQueryPerformance_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsPlacementReport" ADD CONSTRAINT "AmazonAdsPlacementReport_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DataKioskQueryJob" ADD CONSTRAINT "DataKioskQueryJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonEconomicsDaily" ADD CONSTRAINT "AmazonEconomicsDaily_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsBrandMetric" ADD CONSTRAINT "AmazonAdsBrandMetric_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsBrandBuildingMetric" ADD CONSTRAINT "AmazonAdsBrandBuildingMetric_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsReportJob" ADD CONSTRAINT "AmazonAdsReportJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsExportJob" ADD CONSTRAINT "AmazonAdsExportJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FbaStorageAge" ADD CONSTRAINT "FbaStorageAge_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductProfitDaily" ADD CONSTRAINT "ProductProfitDaily_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdDrift" ADD CONSTRAINT "AdDrift_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdvertisingActionLog" ADD CONSTRAINT "AdvertisingActionLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BudgetPool" ADD CONSTRAINT "BudgetPool_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BudgetPoolAllocation" ADD CONSTRAINT "BudgetPoolAllocation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BudgetPoolRebalance" ADD CONSTRAINT "BudgetPoolRebalance_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CampaignBidHistory" ADD CONSTRAINT "CampaignBidHistory_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "NotificationWebhook" ADD CONSTRAINT "NotificationWebhook_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DataRetentionPolicy" ADD CONSTRAINT "DataRetentionPolicy_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DataExportRequest" ADD CONSTRAINT "DataExportRequest_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ChannelLiveImage" ADD CONSTRAINT "ChannelLiveImage_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ChannelStockEvent" ADD CONSTRAINT "ChannelStockEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RateLimitLog" ADD CONSTRAINT "RateLimitLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SyncError" ADD CONSTRAINT "SyncError_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Order" ADD CONSTRAINT "Order_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Customer" ADD CONSTRAINT "Customer_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CustomerSegment" ADD CONSTRAINT "CustomerSegment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FiscalInvoiceCounter" ADD CONSTRAINT "FiscalInvoiceCounter_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FiscalInvoice" ADD CONSTRAINT "FiscalInvoice_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CreditNoteCounter" ADD CONSTRAINT "CreditNoteCounter_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "OrderNote" ADD CONSTRAINT "OrderNote_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "OrderRiskScore" ADD CONSTRAINT "OrderRiskScore_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DailySalesAggregate" ADD CONSTRAINT "DailySalesAggregate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReplenishmentForecast" ADD CONSTRAINT "ReplenishmentForecast_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ForecastModelAssignment" ADD CONSTRAINT "ForecastModelAssignment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ForecastAccuracy" ADD CONSTRAINT "ForecastAccuracy_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BrandSettings" ADD CONSTRAINT "BrandSettings_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RetailEvent" ADD CONSTRAINT "RetailEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PricingSnapshot" ADD CONSTRAINT "PricingSnapshot_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PriceChangeEvent" ADD CONSTRAINT "PriceChangeEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BuyBoxHistory" ADD CONSTRAINT "BuyBoxHistory_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FxRate" ADD CONSTRAINT "FxRate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RetailEventPriceAction" ADD CONSTRAINT "RetailEventPriceAction_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SettlementReport" ADD CONSTRAINT "SettlementReport_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ConnectionScope" ADD CONSTRAINT "ConnectionScope_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ConnectionEvent" ADD CONSTRAINT "ConnectionEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "OutboundSyncQueue" ADD CONSTRAINT "OutboundSyncQueue_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BulkOperation" ADD CONSTRAINT "BulkOperation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BulkOpsTemplate" ADD CONSTRAINT "BulkOpsTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BulkActionTemplate" ADD CONSTRAINT "BulkActionTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ScheduledBulkAction" ADD CONSTRAINT "ScheduledBulkAction_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BulkAutomationApproval" ADD CONSTRAINT "BulkAutomationApproval_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FlatFileImport" ADD CONSTRAINT "FlatFileImport_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ImportJobRow" ADD CONSTRAINT "ImportJobRow_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ScheduledImport" ADD CONSTRAINT "ScheduledImport_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ScheduledExport" ADD CONSTRAINT "ScheduledExport_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CategorySchema" ADD CONSTRAINT "CategorySchema_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "GtinExemptionApplication" ADD CONSTRAINT "GtinExemptionApplication_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ListingWizard" ADD CONSTRAINT "ListingWizard_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ScheduledImagePublish" ADD CONSTRAINT "ScheduledImagePublish_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ScheduledWizardPublish" ADD CONSTRAINT "ScheduledWizardPublish_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "WizardStepEvent" ADD CONSTRAINT "WizardStepEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "WizardTemplate" ADD CONSTRAINT "WizardTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "APlusContent" ADD CONSTRAINT "APlusContent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "APlusContentVersion" ADD CONSTRAINT "APlusContentVersion_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "APlusContentAsin" ADD CONSTRAINT "APlusContentAsin_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "APlusModule" ADD CONSTRAINT "APlusModule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BrandStory" ADD CONSTRAINT "BrandStory_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BrandStoryModule" ADD CONSTRAINT "BrandStoryModule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BrandStoryVersion" ADD CONSTRAINT "BrandStoryVersion_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BrandKit" ADD CONSTRAINT "BrandKit_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BrandWatermarkTemplate" ADD CONSTRAINT "BrandWatermarkTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AssetLocaleOverlay" ADD CONSTRAINT "AssetLocaleOverlay_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ListingImage" ADD CONSTRAINT "ListingImage_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonMediaRun" ADD CONSTRAINT "AmazonMediaRun_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonImageFeedJob" ADD CONSTRAINT "AmazonImageFeedJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonFlatFileFeedJob" ADD CONSTRAINT "AmazonFlatFileFeedJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayPushJob" ADD CONSTRAINT "EbayPushJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ChannelImagePublishJob" ADD CONSTRAINT "ChannelImagePublishJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SchemaChange" ADD CONSTRAINT "SchemaChange_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockCostLayer" ADD CONSTRAINT "StockCostLayer_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Lot" ADD CONSTRAINT "Lot_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockBin" ADD CONSTRAINT "StockBin_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockBinQuantity" ADD CONSTRAINT "StockBinQuantity_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "LotRecall" ADD CONSTRAINT "LotRecall_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "YearEndSnapshot" ADD CONSTRAINT "YearEndSnapshot_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FbaInventoryDetail" ADD CONSTRAINT "FbaInventoryDetail_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "MCFShipment" ADD CONSTRAINT "MCFShipment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Carrier" ADD CONSTRAINT "Carrier_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CarrierService" ADD CONSTRAINT "CarrierService_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CarrierServiceMapping" ADD CONSTRAINT "CarrierServiceMapping_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CarrierMetric" ADD CONSTRAINT "CarrierMetric_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PickupSchedule" ADD CONSTRAINT "PickupSchedule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CarrierAccount" ADD CONSTRAINT "CarrierAccount_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "TrackingMessageLog" ADD CONSTRAINT "TrackingMessageLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ShippingRule" ADD CONSTRAINT "ShippingRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SupplierShippingProfile" ADD CONSTRAINT "SupplierShippingProfile_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PurchaseOrderAttachment" ADD CONSTRAINT "PurchaseOrderAttachment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PurchaseOrderRevision" ADD CONSTRAINT "PurchaseOrderRevision_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PoComment" ADD CONSTRAINT "PoComment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PoEventLog" ADD CONSTRAINT "PoEventLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PoTemplate" ADD CONSTRAINT "PoTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PoTemplateItem" ADD CONSTRAINT "PoTemplateItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PoSchedule" ADD CONSTRAINT "PoSchedule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "InboundShipment" ADD CONSTRAINT "InboundShipment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "InboundShipmentAttachment" ADD CONSTRAINT "InboundShipmentAttachment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "InboundDiscrepancy" ADD CONSTRAINT "InboundDiscrepancy_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "InboundShipmentItem" ADD CONSTRAINT "InboundShipmentItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Return" ADD CONSTRAINT "Return_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RefundAttempt" ADD CONSTRAINT "RefundAttempt_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReturnPolicy" ADD CONSTRAINT "ReturnPolicy_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReplenishmentRule" ADD CONSTRAINT "ReplenishmentRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReplenishmentRecommendation" ADD CONSTRAINT "ReplenishmentRecommendation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CycleCount" ADD CONSTRAINT "CycleCount_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CycleCountItem" ADD CONSTRAINT "CycleCountItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "OrderRoutingRule" ADD CONSTRAINT "OrderRoutingRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReplenishmentSavedView" ADD CONSTRAINT "ReplenishmentSavedView_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CronRun" ADD CONSTRAINT "CronRun_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "OutboundApiCallLog" ADD CONSTRAINT "OutboundApiCallLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SyncLogErrorGroup" ADD CONSTRAINT "SyncLogErrorGroup_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SyncLogSavedSearch" ADD CONSTRAINT "SyncLogSavedSearch_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductSubstitution" ADD CONSTRAINT "ProductSubstitution_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "StockoutEvent" ADD CONSTRAINT "StockoutEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AutoPoRunLog" ADD CONSTRAINT "AutoPoRunLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FbaRestockReport" ADD CONSTRAINT "FbaRestockReport_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FbaRestockRow" ADD CONSTRAINT "FbaRestockRow_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FbaInboundPlanV2" ADD CONSTRAINT "FbaInboundPlanV2_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Tag" ADD CONSTRAINT "Tag_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AssetTag" ADD CONSTRAINT "AssetTag_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductTag" ADD CONSTRAINT "ProductTag_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BundleComponent" ADD CONSTRAINT "BundleComponent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Review" ADD CONSTRAINT "Review_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewResponse" ADD CONSTRAINT "ReviewResponse_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewSpotlight" ADD CONSTRAINT "ReviewSpotlight_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewActionItem" ADD CONSTRAINT "ReviewActionItem_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewSentiment" ADD CONSTRAINT "ReviewSentiment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewCategoryRate" ADD CONSTRAINT "ReviewCategoryRate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewSpike" ADD CONSTRAINT "ReviewSpike_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonReviewInsight" ADD CONSTRAINT "AmazonReviewInsight_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewRule" ADD CONSTRAINT "ReviewRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewTimingDefault" ADD CONSTRAINT "ReviewTimingDefault_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewSendWindow" ADD CONSTRAINT "ReviewSendWindow_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewSentimentCheck" ADD CONSTRAINT "ReviewSentimentCheck_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReviewMailerState" ADD CONSTRAINT "ReviewMailerState_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "OrderTag" ADD CONSTRAINT "OrderTag_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AiFeatureModelPref" ADD CONSTRAINT "AiFeatureModelPref_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductAiDraft" ADD CONSTRAINT "ProductAiDraft_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentDefinition" ADD CONSTRAINT "AgentDefinition_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "PromptTemplate" ADD CONSTRAINT "PromptTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Goal" ADD CONSTRAINT "Goal_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DashboardLayout" ADD CONSTRAINT "DashboardLayout_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DashboardView" ADD CONSTRAINT "DashboardView_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ScheduledReport" ADD CONSTRAINT "ScheduledReport_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SavedViewAlert" ADD CONSTRAINT "SavedViewAlert_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductTranslation" ADD CONSTRAINT "ProductTranslation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductSeo" ADD CONSTRAINT "ProductSeo_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductCertificate" ADD CONSTRAINT "ProductCertificate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ChannelPublishAttempt" ADD CONSTRAINT "ChannelPublishAttempt_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayCampaign" ADD CONSTRAINT "EbayCampaign_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayRateDiscoveryPlan" ADD CONSTRAINT "EbayRateDiscoveryPlan_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayCampaignAutomationPolicy" ADD CONSTRAINT "EbayCampaignAutomationPolicy_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayAdGroup" ADD CONSTRAINT "EbayAdGroup_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayAd" ADD CONSTRAINT "EbayAd_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayKeyword" ADD CONSTRAINT "EbayKeyword_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayNegativeKeyword" ADD CONSTRAINT "EbayNegativeKeyword_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayAdsReportTask" ADD CONSTRAINT "EbayAdsReportTask_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayAdsDailyPerformance" ADD CONSTRAINT "EbayAdsDailyPerformance_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayListingIndex" ADD CONSTRAINT "EbayListingIndex_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayListingEconomics" ADD CONSTRAINT "EbayListingEconomics_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "MarketingAutomationState" ADD CONSTRAINT "MarketingAutomationState_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "MarketingSpendCeiling" ADD CONSTRAINT "MarketingSpendCeiling_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayAdsRule" ADD CONSTRAINT "EbayAdsRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayAdsRuleVersion" ADD CONSTRAINT "EbayAdsRuleVersion_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayAdsRuleExecution" ADD CONSTRAINT "EbayAdsRuleExecution_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayAdsProposal" ADD CONSTRAINT "EbayAdsProposal_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayAdsDigest" ADD CONSTRAINT "EbayAdsDigest_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayWatcherStats" ADD CONSTRAINT "EbayWatcherStats_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayMarkdown" ADD CONSTRAINT "EbayMarkdown_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayVolumePromotion" ADD CONSTRAINT "EbayVolumePromotion_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayVolumeTierTemplate" ADD CONSTRAINT "EbayVolumeTierTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ScheduledProductChange" ADD CONSTRAINT "ScheduledProductChange_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CampaignRuleAssignment" ADD CONSTRAINT "CampaignRuleAssignment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AutomationRuleTemplate" ADD CONSTRAINT "AutomationRuleTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AutomationRuleExecution" ADD CONSTRAINT "AutomationRuleExecution_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdsRuleSuggestion" ADD CONSTRAINT "AdsRuleSuggestion_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdsSuggestionMute" ADD CONSTRAINT "AdsSuggestionMute_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "KeywordRank" ADD CONSTRAINT "KeywordRank_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Scenario" ADD CONSTRAINT "Scenario_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ScenarioRun" ADD CONSTRAINT "ScenarioRun_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ListingReconciliation" ADD CONSTRAINT "ListingReconciliation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FlatFilePullRecord" ADD CONSTRAINT "FlatFilePullRecord_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FlatFilePullJob" ADD CONSTRAINT "FlatFilePullJob_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CatalogOrganizeSession" ADD CONSTRAINT "CatalogOrganizeSession_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CatalogOrganizeChange" ADD CONSTRAINT "CatalogOrganizeChange_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductReadCache" ADD CONSTRAINT "ProductReadCache_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "Category" ADD CONSTRAINT "Category_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CategoryClosure" ADD CONSTRAINT "CategoryClosure_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FnskuLabelTemplate" ADD CONSTRAINT "FnskuLabelTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ListingQualitySnapshot" ADD CONSTRAINT "ListingQualitySnapshot_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RoutingDecision" ADD CONSTRAINT "RoutingDecision_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FeedTransformRule" ADD CONSTRAINT "FeedTransformRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ChannelSchema" ADD CONSTRAINT "ChannelSchema_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FbaReimbursement" ADD CONSTRAINT "FbaReimbursement_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "FbaInventoryAdjustment" ADD CONSTRAINT "FbaInventoryAdjustment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "MarketingCampaignLink" ADD CONSTRAINT "MarketingCampaignLink_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonAdsCampaignDetail" ADD CONSTRAINT "AmazonAdsCampaignDetail_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayPromotedDetail" ADD CONSTRAINT "EbayPromotedDetail_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DiscountDetail" ADD CONSTRAINT "DiscountDetail_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ExternalAdsDetail" ADD CONSTRAINT "ExternalAdsDetail_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ContentPushDetail" ADD CONSTRAINT "ContentPushDetail_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "OutreachDetail" ADD CONSTRAINT "OutreachDetail_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdMutation" ADD CONSTRAINT "AdMutation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdBlueprintApplication" ADD CONSTRAINT "AdBlueprintApplication_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdKeywordProtection" ADD CONSTRAINT "AdKeywordProtection_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdNegativeReview" ADD CONSTRAINT "AdNegativeReview_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdBlueprint" ADD CONSTRAINT "AdBlueprint_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CampaignBudget" ADD CONSTRAINT "CampaignBudget_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CampaignBudgetAllocation" ADD CONSTRAINT "CampaignBudgetAllocation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CampaignBudgetRebalance" ADD CONSTRAINT "CampaignBudgetRebalance_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CampaignMetric" ADD CONSTRAINT "CampaignMetric_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CampaignAction" ADD CONSTRAINT "CampaignAction_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdSchedule" ADD CONSTRAINT "AdSchedule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RankScheduleGroup" ADD CONSTRAINT "RankScheduleGroup_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RankScheduleEvent" ADD CONSTRAINT "RankScheduleEvent_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RankScheduleVersion" ADD CONSTRAINT "RankScheduleVersion_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "BudgetSchedule" ADD CONSTRAINT "BudgetSchedule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AutopilotPlan" ADD CONSTRAINT "AutopilotPlan_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AutopilotDecision" ADD CONSTRAINT "AutopilotDecision_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RankTarget" ADD CONSTRAINT "RankTarget_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "RankScheduleTemplate" ADD CONSTRAINT "RankScheduleTemplate_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ProductRankPlan" ADD CONSTRAINT "ProductRankPlan_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdAudience" ADD CONSTRAINT "AdAudience_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdBudgetPlan" ADD CONSTRAINT "AdBudgetPlan_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdProductGoal" ADD CONSTRAINT "AdProductGoal_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SupplierContact" ADD CONSTRAINT "SupplierContact_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SupplierComm" ADD CONSTRAINT "SupplierComm_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SupplierFollowUp" ADD CONSTRAINT "SupplierFollowUp_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DevelopmentProject" ADD CONSTRAINT "DevelopmentProject_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DevelopmentProjectSupplier" ADD CONSTRAINT "DevelopmentProjectSupplier_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DevelopmentAttachment" ADD CONSTRAINT "DevelopmentAttachment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "DevelopmentCertification" ADD CONSTRAINT "DevelopmentCertification_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdsAutomationState" ADD CONSTRAINT "AdsAutomationState_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonReportRun" ADD CONSTRAINT "AmazonReportRun_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SharedListingMembership" ADD CONSTRAINT "SharedListingMembership_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SyncChannelPolicy" ADD CONSTRAINT "SyncChannelPolicy_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SyncControlAudit" ADD CONSTRAINT "SyncControlAudit_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EbayDescriptionTheme" ADD CONSTRAINT "EbayDescriptionTheme_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonTemplateVault" ADD CONSTRAINT "AmazonTemplateVault_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AmazonFamilyWorkbook" ADD CONSTRAINT "AmazonFamilyWorkbook_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReportShareLink" ADD CONSTRAINT "ReportShareLink_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SavedReportVersion" ADD CONSTRAINT "SavedReportVersion_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdsConsoleImport" ADD CONSTRAINT "AdsConsoleImport_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdsConsoleRow" ADD CONSTRAINT "AdsConsoleRow_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CustomMetric" ADD CONSTRAINT "CustomMetric_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentCharter" ADD CONSTRAINT "AgentCharter_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentCharterRevision" ADD CONSTRAINT "AgentCharterRevision_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentEvalRun" ADD CONSTRAINT "AgentEvalRun_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentControlAudit" ADD CONSTRAINT "AgentControlAudit_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentObservation" ADD CONSTRAINT "AgentObservation_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentFinding" ADD CONSTRAINT "AgentFinding_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentPlan" ADD CONSTRAINT "AgentPlan_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentStrategy" ADD CONSTRAINT "AgentStrategy_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentExemplar" ADD CONSTRAINT "AgentExemplar_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentScorecard" ADD CONSTRAINT "AgentScorecard_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentFleetState" ADD CONSTRAINT "AgentFleetState_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentShadowGrade" ADD CONSTRAINT "AgentShadowGrade_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentWorkflow" ADD CONSTRAINT "AgentWorkflow_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentWorkflowRevision" ADD CONSTRAINT "AgentWorkflowRevision_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentAssignment" ADD CONSTRAINT "AgentAssignment_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AgentFindingRun" ADD CONSTRAINT "AgentFindingRun_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdsHarvestPolicy" ADD CONSTRAINT "AdsHarvestPolicy_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdsHarvestDestination" ADD CONSTRAINT "AdsHarvestDestination_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "SqpReportRequest" ADD CONSTRAINT "SqpReportRequest_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdSpendCeiling" ADD CONSTRAINT "AdSpendCeiling_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdBidPolicy" ADD CONSTRAINT "AdBidPolicy_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AdWriteRefusal" ADD CONSTRAINT "AdWriteRefusal_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "AutomationRefusalDaily" ADD CONSTRAINT "AutomationRefusalDaily_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "KeywordBidProposal" ADD CONSTRAINT "KeywordBidProposal_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "EventOutbox" ADD CONSTRAINT "EventOutbox_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CategoryChannelMapping" ADD CONSTRAINT "CategoryChannelMapping_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "CellFormula" ADD CONSTRAINT "CellFormula_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "MasterFieldRule" ADD CONSTRAINT "MasterFieldRule_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

ALTER TABLE "MasterFieldRuleRevision" ADD CONSTRAINT "MasterFieldRuleRevision_business_owner_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

-- Prisma cannot express the historical partial/expression keys. Preserve their
-- NULL handling and idempotency guarantees while scoping them to the business.
CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL;
CREATE UNIQUE INDEX "StockLevel_loc_prod_var_unique" ON "StockLevel" ("workspaceId", "locationId", "productId", "variationId") WHERE "variationId" IS NOT NULL;
DROP INDEX IF EXISTS "PricingSnapshot_sku_channel_marketplace_default_key";
CREATE UNIQUE INDEX "PricingSnapshot_sku_channel_marketplace_default_key" ON "PricingSnapshot" ("workspaceId", "sku", "channel", "marketplace") WHERE "fulfillmentMethod" IS NULL;
CREATE UNIQUE INDEX "ReturnPolicy_scope_uniq" ON "ReturnPolicy" ("workspaceId", "channel", COALESCE("marketplace", '__NULL__'), COALESCE("productType", '__NULL__'));
DROP INDEX IF EXISTS "AdMutation_idempotencyKey_key";
CREATE UNIQUE INDEX "AdMutation_idempotencyKey_key" ON "AdMutation" ("workspaceId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
DROP INDEX IF EXISTS "StockLocation_externalChannel_externalLocationId_unique_idx";
CREATE UNIQUE INDEX "StockLocation_externalChannel_externalLocationId_unique_idx" ON "StockLocation" ("workspaceId", "externalChannel", "externalLocationId") WHERE "externalChannel" IS NOT NULL AND "externalLocationId" IS NOT NULL;
-- Phase E removed this as a constraint, but its earliest migration created an
-- index. Remove that stale global key so the per-user key above can take effect.
DROP INDEX IF EXISTS "NotificationPreference_eventType_key";
CREATE UNIQUE INDEX "NotificationPreference_workspace_default_event_key" ON "NotificationPreference" ("workspaceId", "eventType") WHERE "userId" IS NULL;

DROP INDEX IF EXISTS "ChannelConnection_channelType_primary_key";
CREATE UNIQUE INDEX "ChannelConnection_workspace_channel_primary_key" ON "ChannelConnection" ("workspaceId", "channelType") WHERE "isPrimary" = true;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime') THEN
        CREATE ROLE nexus_workspace_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime' AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'Workspace runtime role must not bypass row-level security';
      END IF;
    END $$;
GRANT nexus_workspace_runtime TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO nexus_workspace_runtime;
CREATE OR REPLACE FUNCTION nexus_workspace_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE relation jsonb; foreign_value text; parent_workspace text;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" THEN
        RAISE EXCEPTION 'Business ownership cannot be reassigned' USING ERRCODE = '23514';
      END IF;
      FOR relation IN SELECT * FROM jsonb_array_elements(TG_ARGV[0]::jsonb) LOOP
        foreign_value := to_jsonb(NEW)->>(relation->>'from');
        IF foreign_value IS NULL THEN CONTINUE; END IF;
        EXECUTE format('SELECT "workspaceId" FROM %I.%I WHERE %I::text = $1', TG_TABLE_SCHEMA, relation->>'model', relation->>'to')
          INTO parent_workspace USING foreign_value;
        IF parent_workspace IS DISTINCT FROM NEW."workspaceId" THEN
          RAISE EXCEPTION 'Related record is unavailable in this business profile' USING ERRCODE = '23503';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Workspace" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkspaceMembership" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkspaceMemberRole" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkspaceInvitation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkspaceAudit" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "UserProfile" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "UserSession" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Role" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "UserRole" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Invitation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PasswordResetToken" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "TwoFactorRecoveryCode" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "LoginEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ConsentRecord" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OAuthSession" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelApp" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelAccountRoute" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelAccountOwnership" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Product" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SkuAlias" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockImportJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductFamily" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AttributeGroup" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CustomAttribute" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AttributeOption" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FamilyAttribute" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductWorkflow" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkflowStage" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkflowTransition" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkflowComment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkflowAssignment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CustomerGroup" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductTierPrice" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DigitalAsset" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AssetFolder" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AssetUsage" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RepricingRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RepricingDecision" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductVariation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "VariantImage" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "VariantChannelListing" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelListing" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductListingAlias" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelListingSnapshot" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Marketplace" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelListingOverride" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FieldLinkGroup" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FieldValueMap" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SizeScaleMap" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MappingRevision" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SyncAttempt" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonSuppression" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ListingIssue" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Offer" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ListingRecoveryEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelListingImage" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductImage" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "TerminologyPreference" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BrandVoice" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MarketplaceSync" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Channel" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Listing" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DraftListing" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FBAShipment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FBAShipmentItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PricingRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PricingRuleProduct" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PricingRuleVariation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SyncHealthLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BulkActionJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BulkActionItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SellerFeedback" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Campaign" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdGroup" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdTarget" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdProductAd" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdProductSet" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsConnection" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsProfile" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "KeywordWatchlist" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "KeywordWatchlistTerm" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "KeywordCoverageSet" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "KeywordCoverageTerm" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsPortfolio" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsDailyPerformance" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsHourlyPerformance" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdBudgetUsageSample" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsSearchTerm" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SearchQueryPerformance" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsPlacementReport" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DataKioskQueryJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonEconomicsDaily" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsBrandMetric" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsBrandBuildingMetric" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsReportJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsExportJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FbaStorageAge" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductProfitDaily" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdDrift" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdvertisingActionLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BudgetPool" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BudgetPoolAllocation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BudgetPoolRebalance" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignBidHistory" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Coupon" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AccountSettings" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "NotificationPreference" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "NotificationWebhook" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ApiKey" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DataRetentionPolicy" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DataExportRequest" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WebhookEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelLiveImage" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelStockEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RateLimitLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SyncLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SyncError" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Order" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Customer" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CustomerSegment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CustomerAddress" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CustomerNote" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FiscalInvoiceCounter" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FiscalInvoice" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CreditNoteCounter" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CreditNote" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OrderNote" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OrderRiskScore" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OrderItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DailySalesAggregate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReplenishmentForecast" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ForecastModelAssignment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ForecastAccuracy" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BrandSettings" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RetailEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PricingSnapshot" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PriceChangeEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BuyBoxHistory" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FxRate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RetailEventPriceAction" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SettlementReport" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FinancialTransaction" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelConnection" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ConnectionScope" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ConnectionEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OutboundSyncQueue" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BulkOperation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BulkOpsTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BulkActionTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ScheduledBulkAction" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BulkAutomationApproval" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FlatFileImport" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ImportJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ImportJobRow" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ScheduledImport" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ExportJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ScheduledExport" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CategorySchema" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GtinExemptionApplication" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ListingWizard" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ScheduledImagePublish" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ScheduledWizardPublish" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WizardStepEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WizardTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AuditLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "APlusContent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "APlusContentVersion" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "APlusContentAsin" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "APlusModule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BrandStory" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BrandStoryModule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BrandStoryVersion" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BrandKit" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BrandWatermarkTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AssetLocaleOverlay" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ListingImage" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonMediaRun" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonImageFeedJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonFlatFileFeedJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayPushJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelImagePublishJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SchemaChange" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Warehouse" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockLocation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockLevel" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockReservation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockMovement" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockCostLayer" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Lot" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SerialNumber" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockBin" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockBinQuantity" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "LotRecall" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "YearEndSnapshot" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FbaInventoryDetail" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MCFShipment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Carrier" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CarrierService" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CarrierServiceMapping" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CarrierMetric" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PickupSchedule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CarrierAccount" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Shipment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "TrackingEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "TrackingMessageLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShipmentItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShippingRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Supplier" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SupplierShippingProfile" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SupplierProduct" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PurchaseOrder" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PurchaseOrderItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PurchaseOrderAttachment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PurchaseOrderRevision" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PoComment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PoEventLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PoTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PoTemplateItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PoSchedule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "InboundShipment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "InboundShipmentAttachment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "InboundDiscrepancy" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "InboundShipmentItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "InboundReceipt" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkOrder" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Return" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReturnItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Refund" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RefundAttempt" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReturnPolicy" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReplenishmentRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReplenishmentRecommendation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CycleCount" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CycleCountItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OrderRoutingRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReplenishmentSavedView" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CronRun" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OutboundApiCallLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SyncLogErrorGroup" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SyncLogSavedSearch" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AlertRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AlertEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductSubstitution" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockoutEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AutoPoRunLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FbaRestockReport" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FbaRestockRow" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FbaInboundPlanV2" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Tag" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AssetTag" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductTag" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Bundle" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BundleComponent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SavedView" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Review" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewResponse" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewSpotlight" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewActionItem" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewSentiment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewCategoryRate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewSpike" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonReviewInsight" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewRequest" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewTimingDefault" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewSendWindow" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewSentimentCheck" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewMailerState" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EmailSuppression" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OrderTag" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AiUsageLog" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AiFeatureModelPref" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductAiDraft" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentDefinition" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentRun" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentTool" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentApproval" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentMemory" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PromptTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Goal" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DashboardLayout" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DashboardView" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ScheduledReport" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Notification" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SavedViewAlert" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductTranslation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductRelation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductSeo" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductCertificate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelPublishAttempt" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayCampaign" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayRateDiscoveryPlan" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayCampaignAutomationPolicy" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayAdGroup" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayAd" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayKeyword" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayNegativeKeyword" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayAdsReportTask" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayAdsDailyPerformance" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayListingIndex" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayListingEconomics" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MarketingAutomationState" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MarketingSpendCeiling" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayAdsRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayAdsRuleVersion" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayAdsRuleExecution" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayAdsProposal" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayAdsDigest" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayWatcherStats" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayMarkdown" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayVolumePromotion" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayVolumeTierTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ScheduledProductChange" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AutomationRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignRuleAssignment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AutomationRuleTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AutomationRuleExecution" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsRuleSuggestion" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsSuggestionMute" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "KeywordRank" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Scenario" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ScenarioRun" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ListingReconciliation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FlatFilePullRecord" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FlatFilePullJob" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CatalogOrganizeSession" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CatalogOrganizeChange" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductReadCache" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Category" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CategoryClosure" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductCategory" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FnskuLabelTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ListingQualitySnapshot" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RoutingDecision" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FeedTransformRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelSchema" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FbaReimbursement" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FbaInventoryAdjustment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MarketingCampaign" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MarketingCampaignLink" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsCampaignDetail" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayPromotedDetail" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DiscountDetail" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ExternalAdsDetail" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ContentPushDetail" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OutreachDetail" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdMutation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdBlueprintApplication" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdKeywordProtection" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdNegativeReview" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdBlueprint" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignTarget" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignBudget" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignBudgetAllocation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignBudgetRebalance" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignMetric" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignAction" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CalendarEntry" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdSchedule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RankScheduleGroup" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RankScheduleEvent" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RankScheduleVersion" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BudgetSchedule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AutopilotPlan" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AutopilotDecision" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RankTarget" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RankScheduleTemplate" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductRankPlan" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdAudience" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdBudgetPlan" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdProductGoal" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SupplierContact" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SupplierComm" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SupplierFollowUp" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DevelopmentProject" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DevelopmentProjectSupplier" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DevelopmentAttachment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DevelopmentCertification" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsAutomationState" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonReportRun" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SharedListingMembership" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SyncChannelPolicy" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SyncControlAudit" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayDescriptionTheme" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonTemplateVault" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonFamilyWorkbook" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReportShareLink" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SavedReport" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SavedReportVersion" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReportSchedule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReportDelivery" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsConsoleImport" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsConsoleRow" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CustomMetric" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentCharter" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentCharterRevision" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentEvalRun" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentControlAudit" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentObservation" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentFinding" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentPlan" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentStrategy" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentStep" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentExemplar" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentScorecard" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GraphEdge" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentFleetState" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentShadowGrade" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentWorkflow" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentWorkflowRevision" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentAssignment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentFindingRun" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsHarvestPolicy" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsHarvestDestination" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SqpReportRequest" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdSpendCeiling" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdBidPolicy" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdWriteRefusal" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AutomationRefusalDaily" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "KeywordBidProposal" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EventOutbox" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CategoryChannelMapping" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CellFormula" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MasterFieldRule" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MasterFieldRuleRevision" TO nexus_workspace_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexus_workspace_runtime;
ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Product";
CREATE POLICY nexus_workspace_isolation ON "Product" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Product"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Product"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Product";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ProductFamily","from":"familyId","to":"id"},{"model":"WorkflowStage","from":"workflowStageId","to":"id"},{"model":"Product","from":"parentId","to":"id"},{"model":"Product","from":"masterProductId","to":"id"}]');
ALTER TABLE "SkuAlias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SkuAlias" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SkuAlias";
CREATE POLICY nexus_workspace_isolation ON "SkuAlias" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SkuAlias"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SkuAlias"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SkuAlias";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SkuAlias" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "StockImportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockImportJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockImportJob";
CREATE POLICY nexus_workspace_isolation ON "StockImportJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockImportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockImportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockImportJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockImportJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ProductFamily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductFamily" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductFamily";
CREATE POLICY nexus_workspace_isolation ON "ProductFamily" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductFamily"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductFamily"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductFamily";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductFamily" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ProductFamily","from":"parentFamilyId","to":"id"},{"model":"ProductWorkflow","from":"workflowId","to":"id"}]');
ALTER TABLE "AttributeGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttributeGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AttributeGroup";
CREATE POLICY nexus_workspace_isolation ON "AttributeGroup" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AttributeGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AttributeGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AttributeGroup";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AttributeGroup" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CustomAttribute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomAttribute" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CustomAttribute";
CREATE POLICY nexus_workspace_isolation ON "CustomAttribute" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomAttribute"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomAttribute"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CustomAttribute";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CustomAttribute" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AttributeGroup","from":"groupId","to":"id"}]');
ALTER TABLE "AttributeOption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttributeOption" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AttributeOption";
CREATE POLICY nexus_workspace_isolation ON "AttributeOption" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AttributeOption"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AttributeOption"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AttributeOption";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AttributeOption" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"CustomAttribute","from":"attributeId","to":"id"}]');
ALTER TABLE "FamilyAttribute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FamilyAttribute" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FamilyAttribute";
CREATE POLICY nexus_workspace_isolation ON "FamilyAttribute" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FamilyAttribute"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FamilyAttribute"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FamilyAttribute";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FamilyAttribute" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ProductFamily","from":"familyId","to":"id"},{"model":"CustomAttribute","from":"attributeId","to":"id"}]');
ALTER TABLE "ProductWorkflow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductWorkflow" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductWorkflow";
CREATE POLICY nexus_workspace_isolation ON "ProductWorkflow" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductWorkflow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductWorkflow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductWorkflow";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductWorkflow" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "WorkflowStage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowStage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WorkflowStage";
CREATE POLICY nexus_workspace_isolation ON "WorkflowStage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkflowStage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkflowStage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "WorkflowStage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "WorkflowStage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ProductWorkflow","from":"workflowId","to":"id"}]');
ALTER TABLE "WorkflowTransition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowTransition" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WorkflowTransition";
CREATE POLICY nexus_workspace_isolation ON "WorkflowTransition" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkflowTransition"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkflowTransition"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "WorkflowTransition";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "WorkflowTransition" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"WorkflowStage","from":"fromStageId","to":"id"},{"model":"WorkflowStage","from":"toStageId","to":"id"}]');
ALTER TABLE "WorkflowComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowComment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WorkflowComment";
CREATE POLICY nexus_workspace_isolation ON "WorkflowComment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkflowComment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkflowComment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "WorkflowComment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "WorkflowComment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"WorkflowStage","from":"stageId","to":"id"}]');
ALTER TABLE "WorkflowAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowAssignment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WorkflowAssignment";
CREATE POLICY nexus_workspace_isolation ON "WorkflowAssignment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkflowAssignment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkflowAssignment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "WorkflowAssignment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "WorkflowAssignment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"WorkflowStage","from":"stageId","to":"id"}]');
ALTER TABLE "CustomerGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CustomerGroup";
CREATE POLICY nexus_workspace_isolation ON "CustomerGroup" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomerGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomerGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CustomerGroup";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CustomerGroup" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ProductTierPrice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductTierPrice" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductTierPrice";
CREATE POLICY nexus_workspace_isolation ON "ProductTierPrice" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductTierPrice"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductTierPrice"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductTierPrice";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductTierPrice" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"CustomerGroup","from":"customerGroupId","to":"id"}]');
ALTER TABLE "DigitalAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DigitalAsset" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DigitalAsset";
CREATE POLICY nexus_workspace_isolation ON "DigitalAsset" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DigitalAsset"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DigitalAsset"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DigitalAsset";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DigitalAsset" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AssetFolder","from":"folderId","to":"id"}]');
ALTER TABLE "AssetFolder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetFolder" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AssetFolder";
CREATE POLICY nexus_workspace_isolation ON "AssetFolder" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssetFolder"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssetFolder"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AssetFolder";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AssetFolder" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AssetFolder","from":"parentId","to":"id"}]');
ALTER TABLE "AssetUsage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetUsage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AssetUsage";
CREATE POLICY nexus_workspace_isolation ON "AssetUsage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssetUsage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssetUsage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AssetUsage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AssetUsage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"DigitalAsset","from":"assetId","to":"id"},{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "RepricingRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepricingRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RepricingRule";
CREATE POLICY nexus_workspace_isolation ON "RepricingRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RepricingRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RepricingRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RepricingRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RepricingRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "RepricingDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepricingDecision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RepricingDecision";
CREATE POLICY nexus_workspace_isolation ON "RepricingDecision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RepricingDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RepricingDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RepricingDecision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RepricingDecision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"RepricingRule","from":"ruleId","to":"id"}]');
ALTER TABLE "ProductVariation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductVariation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductVariation";
CREATE POLICY nexus_workspace_isolation ON "ProductVariation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductVariation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductVariation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductVariation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductVariation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "VariantImage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VariantImage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "VariantImage";
CREATE POLICY nexus_workspace_isolation ON "VariantImage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "VariantImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "VariantImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "VariantImage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "VariantImage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ProductVariation","from":"variantId","to":"id"}]');
ALTER TABLE "VariantChannelListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VariantChannelListing" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "VariantChannelListing";
CREATE POLICY nexus_workspace_isolation ON "VariantChannelListing" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "VariantChannelListing"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "VariantChannelListing"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "VariantChannelListing";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "VariantChannelListing" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ProductVariation","from":"variantId","to":"id"},{"model":"ChannelConnection","from":"channelConnectionId","to":"id"}]');
ALTER TABLE "ChannelListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelListing" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelListing";
CREATE POLICY nexus_workspace_isolation ON "ChannelListing" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelListing"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelListing"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelListing";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelListing" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ChannelConnection","from":"channelConnectionId","to":"id"},{"model":"ProductListingAlias","from":"aliasId","to":"id"}]');
ALTER TABLE "ProductListingAlias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductListingAlias" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductListingAlias";
CREATE POLICY nexus_workspace_isolation ON "ProductListingAlias" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductListingAlias"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductListingAlias"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductListingAlias";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductListingAlias" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ChannelConnection","from":"channelConnectionId","to":"id"}]');
ALTER TABLE "ChannelListingSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelListingSnapshot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelListingSnapshot";
CREATE POLICY nexus_workspace_isolation ON "ChannelListingSnapshot" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelListingSnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelListingSnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelListingSnapshot";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelListingSnapshot" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"channelListingId","to":"id"}]');
ALTER TABLE "Marketplace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Marketplace" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Marketplace";
CREATE POLICY nexus_workspace_isolation ON "Marketplace" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Marketplace"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Marketplace"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Marketplace";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Marketplace" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ChannelListingOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelListingOverride" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelListingOverride";
CREATE POLICY nexus_workspace_isolation ON "ChannelListingOverride" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelListingOverride"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelListingOverride"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelListingOverride";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelListingOverride" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"channelListingId","to":"id"}]');
ALTER TABLE "FieldLinkGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FieldLinkGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FieldLinkGroup";
CREATE POLICY nexus_workspace_isolation ON "FieldLinkGroup" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FieldLinkGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FieldLinkGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FieldLinkGroup";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FieldLinkGroup" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "FieldValueMap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FieldValueMap" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FieldValueMap";
CREATE POLICY nexus_workspace_isolation ON "FieldValueMap" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FieldValueMap"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FieldValueMap"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FieldValueMap";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FieldValueMap" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SizeScaleMap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SizeScaleMap" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SizeScaleMap";
CREATE POLICY nexus_workspace_isolation ON "SizeScaleMap" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SizeScaleMap"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SizeScaleMap"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SizeScaleMap";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SizeScaleMap" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "MappingRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MappingRevision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MappingRevision";
CREATE POLICY nexus_workspace_isolation ON "MappingRevision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MappingRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MappingRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MappingRevision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MappingRevision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SyncAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncAttempt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SyncAttempt";
CREATE POLICY nexus_workspace_isolation ON "SyncAttempt" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncAttempt"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncAttempt"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SyncAttempt";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SyncAttempt" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"listingId","to":"id"}]');
ALTER TABLE "AmazonSuppression" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonSuppression" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonSuppression";
CREATE POLICY nexus_workspace_isolation ON "AmazonSuppression" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonSuppression"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonSuppression"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonSuppression";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonSuppression" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"listingId","to":"id"}]');
ALTER TABLE "ListingIssue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ListingIssue" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ListingIssue";
CREATE POLICY nexus_workspace_isolation ON "ListingIssue" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingIssue"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingIssue"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ListingIssue";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ListingIssue" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"listingId","to":"id"}]');
ALTER TABLE "Offer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Offer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Offer";
CREATE POLICY nexus_workspace_isolation ON "Offer" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Offer"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Offer"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Offer";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Offer" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"channelListingId","to":"id"}]');
ALTER TABLE "ListingRecoveryEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ListingRecoveryEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ListingRecoveryEvent";
CREATE POLICY nexus_workspace_isolation ON "ListingRecoveryEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingRecoveryEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingRecoveryEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ListingRecoveryEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ListingRecoveryEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "ChannelListingImage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelListingImage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelListingImage";
CREATE POLICY nexus_workspace_isolation ON "ChannelListingImage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelListingImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelListingImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelListingImage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelListingImage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ChannelListing","from":"channelListingId","to":"id"}]');
ALTER TABLE "ProductImage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductImage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductImage";
CREATE POLICY nexus_workspace_isolation ON "ProductImage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductImage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductImage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ProductImage","from":"derivedFromImageId","to":"id"}]');
ALTER TABLE "TerminologyPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TerminologyPreference" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "TerminologyPreference";
CREATE POLICY nexus_workspace_isolation ON "TerminologyPreference" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "TerminologyPreference"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "TerminologyPreference"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "TerminologyPreference";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "TerminologyPreference" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BrandVoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrandVoice" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BrandVoice";
CREATE POLICY nexus_workspace_isolation ON "BrandVoice" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandVoice"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandVoice"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BrandVoice";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BrandVoice" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "MarketplaceSync" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketplaceSync" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MarketplaceSync";
CREATE POLICY nexus_workspace_isolation ON "MarketplaceSync" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketplaceSync"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketplaceSync"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MarketplaceSync";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MarketplaceSync" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "Channel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Channel" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Channel";
CREATE POLICY nexus_workspace_isolation ON "Channel" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Channel"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Channel"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Channel";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Channel" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Listing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Listing" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Listing";
CREATE POLICY nexus_workspace_isolation ON "Listing" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Listing"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Listing"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Listing";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Listing" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"Channel","from":"channelId","to":"id"}]');
ALTER TABLE "DraftListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DraftListing" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DraftListing";
CREATE POLICY nexus_workspace_isolation ON "DraftListing" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DraftListing"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DraftListing"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DraftListing";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DraftListing" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "StockLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockLog";
CREATE POLICY nexus_workspace_isolation ON "StockLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "FBAShipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FBAShipment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FBAShipment";
CREATE POLICY nexus_workspace_isolation ON "FBAShipment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FBAShipment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FBAShipment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FBAShipment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FBAShipment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FBAShipmentItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FBAShipmentItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FBAShipmentItem";
CREATE POLICY nexus_workspace_isolation ON "FBAShipmentItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FBAShipmentItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FBAShipmentItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FBAShipmentItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FBAShipmentItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"FBAShipment","from":"shipmentId","to":"id"},{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "PricingRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PricingRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PricingRule";
CREATE POLICY nexus_workspace_isolation ON "PricingRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PricingRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PricingRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PricingRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PricingRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "PricingRuleProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PricingRuleProduct" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PricingRuleProduct";
CREATE POLICY nexus_workspace_isolation ON "PricingRuleProduct" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PricingRuleProduct"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PricingRuleProduct"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PricingRuleProduct";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PricingRuleProduct" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"PricingRule","from":"ruleId","to":"id"},{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "PricingRuleVariation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PricingRuleVariation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PricingRuleVariation";
CREATE POLICY nexus_workspace_isolation ON "PricingRuleVariation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PricingRuleVariation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PricingRuleVariation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PricingRuleVariation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PricingRuleVariation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"PricingRule","from":"ruleId","to":"id"},{"model":"ProductVariation","from":"variationId","to":"id"}]');
ALTER TABLE "SyncHealthLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncHealthLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SyncHealthLog";
CREATE POLICY nexus_workspace_isolation ON "SyncHealthLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncHealthLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncHealthLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SyncHealthLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SyncHealthLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ProductVariation","from":"variationId","to":"id"}]');
ALTER TABLE "BulkActionJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BulkActionJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BulkActionJob";
CREATE POLICY nexus_workspace_isolation ON "BulkActionJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkActionJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkActionJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BulkActionJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BulkActionJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BulkActionItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BulkActionItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BulkActionItem";
CREATE POLICY nexus_workspace_isolation ON "BulkActionItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkActionItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkActionItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BulkActionItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BulkActionItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"BulkActionJob","from":"jobId","to":"id"}]');
ALTER TABLE "SellerFeedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SellerFeedback" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SellerFeedback";
CREATE POLICY nexus_workspace_isolation ON "SellerFeedback" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SellerFeedback"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SellerFeedback"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SellerFeedback";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SellerFeedback" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Campaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Campaign" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Campaign";
CREATE POLICY nexus_workspace_isolation ON "Campaign" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Campaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Campaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Campaign";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Campaign" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdGroup";
CREATE POLICY nexus_workspace_isolation ON "AdGroup" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdGroup";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdGroup" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Campaign","from":"campaignId","to":"id"}]');
ALTER TABLE "AdTarget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdTarget" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdTarget";
CREATE POLICY nexus_workspace_isolation ON "AdTarget" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdTarget"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdTarget"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdTarget";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdTarget" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AdGroup","from":"adGroupId","to":"id"}]');
ALTER TABLE "AdProductAd" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdProductAd" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdProductAd";
CREATE POLICY nexus_workspace_isolation ON "AdProductAd" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdProductAd"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdProductAd"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdProductAd";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdProductAd" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AdGroup","from":"adGroupId","to":"id"},{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "AdProductSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdProductSet" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdProductSet";
CREATE POLICY nexus_workspace_isolation ON "AdProductSet" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdProductSet"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdProductSet"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdProductSet";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdProductSet" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsConnection";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsConnection" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsConnection"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsConnection"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsConnection";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsConnection" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsProfile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsProfile";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsProfile" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsProfile"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsProfile"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsProfile";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsProfile" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "KeywordWatchlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KeywordWatchlist" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "KeywordWatchlist";
CREATE POLICY nexus_workspace_isolation ON "KeywordWatchlist" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordWatchlist"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordWatchlist"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "KeywordWatchlist";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "KeywordWatchlist" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "KeywordWatchlistTerm" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KeywordWatchlistTerm" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "KeywordWatchlistTerm";
CREATE POLICY nexus_workspace_isolation ON "KeywordWatchlistTerm" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordWatchlistTerm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordWatchlistTerm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "KeywordWatchlistTerm";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "KeywordWatchlistTerm" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"KeywordWatchlist","from":"watchlistId","to":"id"}]');
ALTER TABLE "KeywordCoverageSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KeywordCoverageSet" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "KeywordCoverageSet";
CREATE POLICY nexus_workspace_isolation ON "KeywordCoverageSet" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordCoverageSet"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordCoverageSet"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "KeywordCoverageSet";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "KeywordCoverageSet" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "KeywordCoverageTerm" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KeywordCoverageTerm" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "KeywordCoverageTerm";
CREATE POLICY nexus_workspace_isolation ON "KeywordCoverageTerm" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordCoverageTerm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordCoverageTerm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "KeywordCoverageTerm";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "KeywordCoverageTerm" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"KeywordCoverageSet","from":"setId","to":"id"}]');
ALTER TABLE "AmazonAdsPortfolio" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsPortfolio" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsPortfolio";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsPortfolio" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsPortfolio"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsPortfolio"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsPortfolio";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsPortfolio" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsDailyPerformance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsDailyPerformance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsDailyPerformance";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsDailyPerformance" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsDailyPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsDailyPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsDailyPerformance";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsDailyPerformance" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsHourlyPerformance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsHourlyPerformance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsHourlyPerformance";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsHourlyPerformance" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsHourlyPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsHourlyPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsHourlyPerformance";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsHourlyPerformance" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdBudgetUsageSample" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdBudgetUsageSample" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdBudgetUsageSample";
CREATE POLICY nexus_workspace_isolation ON "AdBudgetUsageSample" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBudgetUsageSample"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBudgetUsageSample"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdBudgetUsageSample";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdBudgetUsageSample" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsSearchTerm" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsSearchTerm" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsSearchTerm";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsSearchTerm" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsSearchTerm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsSearchTerm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsSearchTerm";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsSearchTerm" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SearchQueryPerformance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SearchQueryPerformance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SearchQueryPerformance";
CREATE POLICY nexus_workspace_isolation ON "SearchQueryPerformance" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SearchQueryPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SearchQueryPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SearchQueryPerformance";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SearchQueryPerformance" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsPlacementReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsPlacementReport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsPlacementReport";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsPlacementReport" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsPlacementReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsPlacementReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsPlacementReport";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsPlacementReport" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "DataKioskQueryJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DataKioskQueryJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DataKioskQueryJob";
CREATE POLICY nexus_workspace_isolation ON "DataKioskQueryJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DataKioskQueryJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DataKioskQueryJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DataKioskQueryJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DataKioskQueryJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonEconomicsDaily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonEconomicsDaily" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonEconomicsDaily";
CREATE POLICY nexus_workspace_isolation ON "AmazonEconomicsDaily" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonEconomicsDaily"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonEconomicsDaily"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonEconomicsDaily";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonEconomicsDaily" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsBrandMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsBrandMetric" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsBrandMetric";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsBrandMetric" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsBrandMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsBrandMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsBrandMetric";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsBrandMetric" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsBrandBuildingMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsBrandBuildingMetric" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsBrandBuildingMetric";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsBrandBuildingMetric" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsBrandBuildingMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsBrandBuildingMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsBrandBuildingMetric";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsBrandBuildingMetric" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsReportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsReportJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsReportJob";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsReportJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsReportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsReportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsReportJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsReportJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonAdsExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsExportJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsExportJob";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsExportJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsExportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsExportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsExportJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsExportJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FbaStorageAge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FbaStorageAge" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FbaStorageAge";
CREATE POLICY nexus_workspace_isolation ON "FbaStorageAge" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaStorageAge"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaStorageAge"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FbaStorageAge";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FbaStorageAge" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "ProductProfitDaily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductProfitDaily" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductProfitDaily";
CREATE POLICY nexus_workspace_isolation ON "ProductProfitDaily" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductProfitDaily"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductProfitDaily"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductProfitDaily";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductProfitDaily" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "AdDrift" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdDrift" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdDrift";
CREATE POLICY nexus_workspace_isolation ON "AdDrift" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdDrift"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdDrift"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdDrift";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdDrift" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdvertisingActionLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdvertisingActionLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdvertisingActionLog";
CREATE POLICY nexus_workspace_isolation ON "AdvertisingActionLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdvertisingActionLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdvertisingActionLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdvertisingActionLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdvertisingActionLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BudgetPool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BudgetPool" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BudgetPool";
CREATE POLICY nexus_workspace_isolation ON "BudgetPool" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BudgetPool"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BudgetPool"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BudgetPool";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BudgetPool" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BudgetPoolAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BudgetPoolAllocation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BudgetPoolAllocation";
CREATE POLICY nexus_workspace_isolation ON "BudgetPoolAllocation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BudgetPoolAllocation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BudgetPoolAllocation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BudgetPoolAllocation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BudgetPoolAllocation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"BudgetPool","from":"budgetPoolId","to":"id"}]');
ALTER TABLE "BudgetPoolRebalance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BudgetPoolRebalance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BudgetPoolRebalance";
CREATE POLICY nexus_workspace_isolation ON "BudgetPoolRebalance" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BudgetPoolRebalance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BudgetPoolRebalance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BudgetPoolRebalance";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BudgetPoolRebalance" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"BudgetPool","from":"budgetPoolId","to":"id"}]');
ALTER TABLE "CampaignBidHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignBidHistory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CampaignBidHistory";
CREATE POLICY nexus_workspace_isolation ON "CampaignBidHistory" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignBidHistory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignBidHistory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CampaignBidHistory";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CampaignBidHistory" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Campaign","from":"campaignId","to":"id"}]');
ALTER TABLE "Coupon" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Coupon" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Coupon";
CREATE POLICY nexus_workspace_isolation ON "Coupon" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Coupon"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Coupon"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Coupon";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Coupon" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AccountSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountSettings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AccountSettings";
CREATE POLICY nexus_workspace_isolation ON "AccountSettings" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AccountSettings"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AccountSettings"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AccountSettings";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AccountSettings" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "NotificationPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationPreference" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "NotificationPreference";
CREATE POLICY nexus_workspace_isolation ON "NotificationPreference" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "NotificationPreference"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "NotificationPreference"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "NotificationPreference";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "NotificationPreference" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "NotificationWebhook" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationWebhook" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "NotificationWebhook";
CREATE POLICY nexus_workspace_isolation ON "NotificationWebhook" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "NotificationWebhook"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "NotificationWebhook"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "NotificationWebhook";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "NotificationWebhook" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ApiKey";
CREATE POLICY nexus_workspace_isolation ON "ApiKey" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ApiKey"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ApiKey"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ApiKey";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ApiKey" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "DataRetentionPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DataRetentionPolicy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DataRetentionPolicy";
CREATE POLICY nexus_workspace_isolation ON "DataRetentionPolicy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DataRetentionPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DataRetentionPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DataRetentionPolicy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DataRetentionPolicy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "DataExportRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DataExportRequest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DataExportRequest";
CREATE POLICY nexus_workspace_isolation ON "DataExportRequest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DataExportRequest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DataExportRequest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DataExportRequest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DataExportRequest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WebhookEvent";
CREATE POLICY nexus_workspace_isolation ON "WebhookEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WebhookEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WebhookEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "WebhookEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "WebhookEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ChannelLiveImage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelLiveImage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelLiveImage";
CREATE POLICY nexus_workspace_isolation ON "ChannelLiveImage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelLiveImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelLiveImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelLiveImage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelLiveImage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "ChannelStockEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelStockEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelStockEvent";
CREATE POLICY nexus_workspace_isolation ON "ChannelStockEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelStockEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelStockEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelStockEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelStockEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "RateLimitLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RateLimitLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RateLimitLog";
CREATE POLICY nexus_workspace_isolation ON "RateLimitLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RateLimitLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RateLimitLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RateLimitLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RateLimitLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SyncLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SyncLog";
CREATE POLICY nexus_workspace_isolation ON "SyncLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SyncLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SyncLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "SyncError" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncError" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SyncError";
CREATE POLICY nexus_workspace_isolation ON "SyncError" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncError"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncError"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SyncError";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SyncError" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Order";
CREATE POLICY nexus_workspace_isolation ON "Order" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Order"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Order"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Order";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Customer","from":"customerId","to":"id"},{"model":"ChannelConnection","from":"channelConnectionId","to":"id"}]');
ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Customer";
CREATE POLICY nexus_workspace_isolation ON "Customer" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Customer"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Customer"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Customer";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Customer" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CustomerSegment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerSegment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CustomerSegment";
CREATE POLICY nexus_workspace_isolation ON "CustomerSegment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomerSegment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomerSegment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CustomerSegment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CustomerSegment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CustomerAddress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerAddress" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CustomerAddress";
CREATE POLICY nexus_workspace_isolation ON "CustomerAddress" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomerAddress"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomerAddress"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CustomerAddress";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CustomerAddress" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Customer","from":"customerId","to":"id"}]');
ALTER TABLE "CustomerNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerNote" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CustomerNote";
CREATE POLICY nexus_workspace_isolation ON "CustomerNote" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomerNote"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomerNote"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CustomerNote";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CustomerNote" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Customer","from":"customerId","to":"id"}]');
ALTER TABLE "FiscalInvoiceCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FiscalInvoiceCounter" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FiscalInvoiceCounter";
CREATE POLICY nexus_workspace_isolation ON "FiscalInvoiceCounter" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FiscalInvoiceCounter"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FiscalInvoiceCounter"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FiscalInvoiceCounter";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FiscalInvoiceCounter" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FiscalInvoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FiscalInvoice" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FiscalInvoice";
CREATE POLICY nexus_workspace_isolation ON "FiscalInvoice" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FiscalInvoice"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FiscalInvoice"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FiscalInvoice";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FiscalInvoice" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"}]');
ALTER TABLE "CreditNoteCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditNoteCounter" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CreditNoteCounter";
CREATE POLICY nexus_workspace_isolation ON "CreditNoteCounter" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CreditNoteCounter"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CreditNoteCounter"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CreditNoteCounter";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CreditNoteCounter" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CreditNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditNote" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CreditNote";
CREATE POLICY nexus_workspace_isolation ON "CreditNote" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CreditNote"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CreditNote"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CreditNote";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CreditNote" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Refund","from":"refundId","to":"id"},{"model":"FiscalInvoice","from":"originalInvoiceId","to":"id"}]');
ALTER TABLE "OrderNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderNote" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "OrderNote";
CREATE POLICY nexus_workspace_isolation ON "OrderNote" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderNote"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderNote"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "OrderNote";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "OrderNote" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"}]');
ALTER TABLE "OrderRiskScore" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderRiskScore" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "OrderRiskScore";
CREATE POLICY nexus_workspace_isolation ON "OrderRiskScore" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderRiskScore"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderRiskScore"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "OrderRiskScore";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "OrderRiskScore" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"}]');
ALTER TABLE "OrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "OrderItem";
CREATE POLICY nexus_workspace_isolation ON "OrderItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "OrderItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "OrderItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"},{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "DailySalesAggregate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DailySalesAggregate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DailySalesAggregate";
CREATE POLICY nexus_workspace_isolation ON "DailySalesAggregate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DailySalesAggregate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DailySalesAggregate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DailySalesAggregate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DailySalesAggregate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReplenishmentForecast" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReplenishmentForecast" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReplenishmentForecast";
CREATE POLICY nexus_workspace_isolation ON "ReplenishmentForecast" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReplenishmentForecast"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReplenishmentForecast"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReplenishmentForecast";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReplenishmentForecast" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ForecastModelAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ForecastModelAssignment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ForecastModelAssignment";
CREATE POLICY nexus_workspace_isolation ON "ForecastModelAssignment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ForecastModelAssignment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ForecastModelAssignment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ForecastModelAssignment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ForecastModelAssignment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ForecastAccuracy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ForecastAccuracy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ForecastAccuracy";
CREATE POLICY nexus_workspace_isolation ON "ForecastAccuracy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ForecastAccuracy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ForecastAccuracy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ForecastAccuracy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ForecastAccuracy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BrandSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrandSettings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BrandSettings";
CREATE POLICY nexus_workspace_isolation ON "BrandSettings" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandSettings"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandSettings"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BrandSettings";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BrandSettings" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "RetailEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RetailEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RetailEvent";
CREATE POLICY nexus_workspace_isolation ON "RetailEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RetailEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RetailEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RetailEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RetailEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "PricingSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PricingSnapshot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PricingSnapshot";
CREATE POLICY nexus_workspace_isolation ON "PricingSnapshot" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PricingSnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PricingSnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PricingSnapshot";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PricingSnapshot" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "PriceChangeEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PriceChangeEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PriceChangeEvent";
CREATE POLICY nexus_workspace_isolation ON "PriceChangeEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PriceChangeEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PriceChangeEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PriceChangeEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PriceChangeEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "BuyBoxHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BuyBoxHistory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BuyBoxHistory";
CREATE POLICY nexus_workspace_isolation ON "BuyBoxHistory" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BuyBoxHistory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BuyBoxHistory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BuyBoxHistory";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BuyBoxHistory" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "FxRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FxRate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FxRate";
CREATE POLICY nexus_workspace_isolation ON "FxRate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FxRate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FxRate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FxRate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FxRate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "RetailEventPriceAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RetailEventPriceAction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RetailEventPriceAction";
CREATE POLICY nexus_workspace_isolation ON "RetailEventPriceAction" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RetailEventPriceAction"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RetailEventPriceAction"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RetailEventPriceAction";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RetailEventPriceAction" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"RetailEvent","from":"eventId","to":"id"}]');
ALTER TABLE "SettlementReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SettlementReport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SettlementReport";
CREATE POLICY nexus_workspace_isolation ON "SettlementReport" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SettlementReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SettlementReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SettlementReport";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SettlementReport" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FinancialTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FinancialTransaction";
CREATE POLICY nexus_workspace_isolation ON "FinancialTransaction" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FinancialTransaction"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FinancialTransaction"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FinancialTransaction";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FinancialTransaction" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"}]');
ALTER TABLE "ChannelConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelConnection";
CREATE POLICY nexus_workspace_isolation ON "ChannelConnection" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelConnection"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelConnection"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelConnection";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ConnectionScope" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectionScope" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ConnectionScope";
CREATE POLICY nexus_workspace_isolation ON "ConnectionScope" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ConnectionScope"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ConnectionScope"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ConnectionScope";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ConnectionScope" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"connectionId","to":"id"}]');
ALTER TABLE "ConnectionEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectionEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ConnectionEvent";
CREATE POLICY nexus_workspace_isolation ON "ConnectionEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ConnectionEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ConnectionEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ConnectionEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ConnectionEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"connectionId","to":"id"}]');
ALTER TABLE "OutboundSyncQueue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboundSyncQueue" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "OutboundSyncQueue";
CREATE POLICY nexus_workspace_isolation ON "OutboundSyncQueue" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OutboundSyncQueue"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OutboundSyncQueue"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "OutboundSyncQueue";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "OutboundSyncQueue" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ChannelListing","from":"channelListingId","to":"id"}]');
ALTER TABLE "BulkOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BulkOperation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BulkOperation";
CREATE POLICY nexus_workspace_isolation ON "BulkOperation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkOperation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkOperation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BulkOperation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BulkOperation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BulkOpsTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BulkOpsTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BulkOpsTemplate";
CREATE POLICY nexus_workspace_isolation ON "BulkOpsTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkOpsTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkOpsTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BulkOpsTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BulkOpsTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BulkActionTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BulkActionTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BulkActionTemplate";
CREATE POLICY nexus_workspace_isolation ON "BulkActionTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkActionTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkActionTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BulkActionTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BulkActionTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ScheduledBulkAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduledBulkAction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ScheduledBulkAction";
CREATE POLICY nexus_workspace_isolation ON "ScheduledBulkAction" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledBulkAction"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledBulkAction"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ScheduledBulkAction";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ScheduledBulkAction" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BulkAutomationApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BulkAutomationApproval" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BulkAutomationApproval";
CREATE POLICY nexus_workspace_isolation ON "BulkAutomationApproval" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkAutomationApproval"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BulkAutomationApproval"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BulkAutomationApproval";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BulkAutomationApproval" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FlatFileImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FlatFileImport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FlatFileImport";
CREATE POLICY nexus_workspace_isolation ON "FlatFileImport" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FlatFileImport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FlatFileImport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FlatFileImport";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FlatFileImport" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ImportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ImportJob";
CREATE POLICY nexus_workspace_isolation ON "ImportJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ImportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ImportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ImportJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ImportJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ImportJobRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportJobRow" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ImportJobRow";
CREATE POLICY nexus_workspace_isolation ON "ImportJobRow" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ImportJobRow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ImportJobRow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ImportJobRow";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ImportJobRow" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ImportJob","from":"jobId","to":"id"}]');
ALTER TABLE "ScheduledImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduledImport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ScheduledImport";
CREATE POLICY nexus_workspace_isolation ON "ScheduledImport" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledImport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledImport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ScheduledImport";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ScheduledImport" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExportJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ExportJob";
CREATE POLICY nexus_workspace_isolation ON "ExportJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ExportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ExportJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ExportJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ExportJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ScheduledExport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduledExport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ScheduledExport";
CREATE POLICY nexus_workspace_isolation ON "ScheduledExport" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledExport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledExport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ScheduledExport";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ScheduledExport" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CategorySchema" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CategorySchema" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CategorySchema";
CREATE POLICY nexus_workspace_isolation ON "CategorySchema" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CategorySchema"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CategorySchema"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CategorySchema";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CategorySchema" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "GtinExemptionApplication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GtinExemptionApplication" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GtinExemptionApplication";
CREATE POLICY nexus_workspace_isolation ON "GtinExemptionApplication" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GtinExemptionApplication"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GtinExemptionApplication"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GtinExemptionApplication";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GtinExemptionApplication" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ListingWizard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ListingWizard" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ListingWizard";
CREATE POLICY nexus_workspace_isolation ON "ListingWizard" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingWizard"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingWizard"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ListingWizard";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ListingWizard" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "ScheduledImagePublish" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduledImagePublish" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ScheduledImagePublish";
CREATE POLICY nexus_workspace_isolation ON "ScheduledImagePublish" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledImagePublish"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledImagePublish"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ScheduledImagePublish";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ScheduledImagePublish" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "ScheduledWizardPublish" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduledWizardPublish" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ScheduledWizardPublish";
CREATE POLICY nexus_workspace_isolation ON "ScheduledWizardPublish" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledWizardPublish"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledWizardPublish"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ScheduledWizardPublish";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ScheduledWizardPublish" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ListingWizard","from":"wizardId","to":"id"}]');
ALTER TABLE "WizardStepEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WizardStepEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WizardStepEvent";
CREATE POLICY nexus_workspace_isolation ON "WizardStepEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WizardStepEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WizardStepEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "WizardStepEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "WizardStepEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ListingWizard","from":"wizardId","to":"id"},{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "WizardTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WizardTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WizardTemplate";
CREATE POLICY nexus_workspace_isolation ON "WizardTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WizardTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WizardTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "WizardTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "WizardTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AuditLog";
CREATE POLICY nexus_workspace_isolation ON "AuditLog" FOR ALL TO nexus_workspace_runtime USING ((("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AuditLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))) OR ("workspaceId" IS NULL AND NULLIF(current_setting('nexus.workspace_id', true), '') IS NULL))) WITH CHECK ((("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AuditLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))) OR ("workspaceId" IS NULL AND NULLIF(current_setting('nexus.workspace_id', true), '') IS NULL)));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AuditLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "APlusContent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "APlusContent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "APlusContent";
CREATE POLICY nexus_workspace_isolation ON "APlusContent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "APlusContent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "APlusContent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "APlusContent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "APlusContent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"APlusContent","from":"masterContentId","to":"id"}]');
ALTER TABLE "APlusContentVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "APlusContentVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "APlusContentVersion";
CREATE POLICY nexus_workspace_isolation ON "APlusContentVersion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "APlusContentVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "APlusContentVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "APlusContentVersion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "APlusContentVersion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"APlusContent","from":"contentId","to":"id"}]');
ALTER TABLE "APlusContentAsin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "APlusContentAsin" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "APlusContentAsin";
CREATE POLICY nexus_workspace_isolation ON "APlusContentAsin" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "APlusContentAsin"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "APlusContentAsin"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "APlusContentAsin";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "APlusContentAsin" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"APlusContent","from":"contentId","to":"id"},{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "APlusModule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "APlusModule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "APlusModule";
CREATE POLICY nexus_workspace_isolation ON "APlusModule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "APlusModule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "APlusModule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "APlusModule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "APlusModule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"APlusContent","from":"contentId","to":"id"}]');
ALTER TABLE "BrandStory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrandStory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BrandStory";
CREATE POLICY nexus_workspace_isolation ON "BrandStory" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandStory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandStory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BrandStory";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BrandStory" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"BrandStory","from":"masterStoryId","to":"id"}]');
ALTER TABLE "BrandStoryModule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrandStoryModule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BrandStoryModule";
CREATE POLICY nexus_workspace_isolation ON "BrandStoryModule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandStoryModule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandStoryModule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BrandStoryModule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BrandStoryModule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"BrandStory","from":"storyId","to":"id"}]');
ALTER TABLE "BrandStoryVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrandStoryVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BrandStoryVersion";
CREATE POLICY nexus_workspace_isolation ON "BrandStoryVersion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandStoryVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandStoryVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BrandStoryVersion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BrandStoryVersion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"BrandStory","from":"storyId","to":"id"}]');
ALTER TABLE "BrandKit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrandKit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BrandKit";
CREATE POLICY nexus_workspace_isolation ON "BrandKit" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandKit"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandKit"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BrandKit";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BrandKit" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BrandWatermarkTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrandWatermarkTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BrandWatermarkTemplate";
CREATE POLICY nexus_workspace_isolation ON "BrandWatermarkTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandWatermarkTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BrandWatermarkTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BrandWatermarkTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BrandWatermarkTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"BrandKit","from":"brand","to":"brand"}]');
ALTER TABLE "AssetLocaleOverlay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetLocaleOverlay" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AssetLocaleOverlay";
CREATE POLICY nexus_workspace_isolation ON "AssetLocaleOverlay" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssetLocaleOverlay"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssetLocaleOverlay"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AssetLocaleOverlay";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AssetLocaleOverlay" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"DigitalAsset","from":"assetId","to":"id"}]');
ALTER TABLE "ListingImage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ListingImage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ListingImage";
CREATE POLICY nexus_workspace_isolation ON "ListingImage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingImage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ListingImage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ListingImage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ProductVariation","from":"variationId","to":"id"}]');
ALTER TABLE "AmazonMediaRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonMediaRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonMediaRun";
CREATE POLICY nexus_workspace_isolation ON "AmazonMediaRun" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonMediaRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonMediaRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonMediaRun";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonMediaRun" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonImageFeedJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonImageFeedJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonImageFeedJob";
CREATE POLICY nexus_workspace_isolation ON "AmazonImageFeedJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonImageFeedJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonImageFeedJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonImageFeedJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonImageFeedJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "AmazonFlatFileFeedJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonFlatFileFeedJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonFlatFileFeedJob";
CREATE POLICY nexus_workspace_isolation ON "AmazonFlatFileFeedJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonFlatFileFeedJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonFlatFileFeedJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonFlatFileFeedJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonFlatFileFeedJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayPushJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayPushJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayPushJob";
CREATE POLICY nexus_workspace_isolation ON "EbayPushJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayPushJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayPushJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayPushJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayPushJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ChannelImagePublishJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelImagePublishJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelImagePublishJob";
CREATE POLICY nexus_workspace_isolation ON "ChannelImagePublishJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelImagePublishJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelImagePublishJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelImagePublishJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelImagePublishJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "SchemaChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SchemaChange" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SchemaChange";
CREATE POLICY nexus_workspace_isolation ON "SchemaChange" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SchemaChange"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SchemaChange"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SchemaChange";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SchemaChange" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Warehouse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Warehouse" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Warehouse";
CREATE POLICY nexus_workspace_isolation ON "Warehouse" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Warehouse"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Warehouse"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Warehouse";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Warehouse" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"CarrierAccount","from":"defaultCarrierAccountId","to":"id"}]');
ALTER TABLE "StockLocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockLocation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockLocation";
CREATE POLICY nexus_workspace_isolation ON "StockLocation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockLocation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockLocation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockLocation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockLocation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Warehouse","from":"warehouseId","to":"id"}]');
ALTER TABLE "StockLevel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockLevel" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockLevel";
CREATE POLICY nexus_workspace_isolation ON "StockLevel" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockLevel"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockLevel"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockLevel";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockLevel" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"StockLocation","from":"locationId","to":"id"},{"model":"Product","from":"productId","to":"id"},{"model":"ProductVariation","from":"variationId","to":"id"}]');
ALTER TABLE "StockReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockReservation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockReservation";
CREATE POLICY nexus_workspace_isolation ON "StockReservation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockReservation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockReservation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockReservation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockReservation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"StockLevel","from":"stockLevelId","to":"id"}]');
ALTER TABLE "StockMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockMovement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockMovement";
CREATE POLICY nexus_workspace_isolation ON "StockMovement" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockMovement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockMovement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockMovement";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Warehouse","from":"warehouseId","to":"id"},{"model":"StockLocation","from":"locationId","to":"id"},{"model":"StockLocation","from":"fromLocationId","to":"id"},{"model":"StockLocation","from":"toLocationId","to":"id"},{"model":"Lot","from":"lotId","to":"id"},{"model":"SerialNumber","from":"serialNumberId","to":"id"},{"model":"StockBin","from":"binId","to":"id"}]');
ALTER TABLE "StockCostLayer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockCostLayer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockCostLayer";
CREATE POLICY nexus_workspace_isolation ON "StockCostLayer" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockCostLayer"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockCostLayer"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockCostLayer";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockCostLayer" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"StockLocation","from":"locationId","to":"id"},{"model":"Lot","from":"lotId","to":"id"}]');
ALTER TABLE "Lot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Lot";
CREATE POLICY nexus_workspace_isolation ON "Lot" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Lot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Lot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Lot";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Lot" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ProductVariation","from":"variationId","to":"id"},{"model":"StockMovement","from":"originStockMovementId","to":"id"}]');
ALTER TABLE "SerialNumber" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SerialNumber" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SerialNumber";
CREATE POLICY nexus_workspace_isolation ON "SerialNumber" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SerialNumber"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SerialNumber"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SerialNumber";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SerialNumber" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ProductVariation","from":"variationId","to":"id"},{"model":"Lot","from":"lotId","to":"id"},{"model":"StockLocation","from":"locationId","to":"id"}]');
ALTER TABLE "StockBin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockBin" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockBin";
CREATE POLICY nexus_workspace_isolation ON "StockBin" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockBin"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockBin"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockBin";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockBin" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"StockLocation","from":"locationId","to":"id"}]');
ALTER TABLE "StockBinQuantity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockBinQuantity" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockBinQuantity";
CREATE POLICY nexus_workspace_isolation ON "StockBinQuantity" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockBinQuantity"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockBinQuantity"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockBinQuantity";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockBinQuantity" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"StockLevel","from":"stockLevelId","to":"id"},{"model":"StockBin","from":"binId","to":"id"}]');
ALTER TABLE "LotRecall" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LotRecall" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "LotRecall";
CREATE POLICY nexus_workspace_isolation ON "LotRecall" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "LotRecall"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "LotRecall"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "LotRecall";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "LotRecall" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Lot","from":"lotId","to":"id"}]');
ALTER TABLE "YearEndSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "YearEndSnapshot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "YearEndSnapshot";
CREATE POLICY nexus_workspace_isolation ON "YearEndSnapshot" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "YearEndSnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "YearEndSnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "YearEndSnapshot";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "YearEndSnapshot" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FbaInventoryDetail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FbaInventoryDetail" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FbaInventoryDetail";
CREATE POLICY nexus_workspace_isolation ON "FbaInventoryDetail" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaInventoryDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaInventoryDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FbaInventoryDetail";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FbaInventoryDetail" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "MCFShipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MCFShipment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MCFShipment";
CREATE POLICY nexus_workspace_isolation ON "MCFShipment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MCFShipment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MCFShipment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MCFShipment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MCFShipment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"}]');
ALTER TABLE "Carrier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Carrier" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Carrier";
CREATE POLICY nexus_workspace_isolation ON "Carrier" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Carrier"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Carrier"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Carrier";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Carrier" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CarrierService" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CarrierService" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CarrierService";
CREATE POLICY nexus_workspace_isolation ON "CarrierService" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CarrierService"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CarrierService"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CarrierService";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CarrierService" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Carrier","from":"carrierId","to":"id"}]');
ALTER TABLE "CarrierServiceMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CarrierServiceMapping" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CarrierServiceMapping";
CREATE POLICY nexus_workspace_isolation ON "CarrierServiceMapping" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CarrierServiceMapping"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CarrierServiceMapping"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CarrierServiceMapping";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CarrierServiceMapping" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Carrier","from":"carrierId","to":"id"},{"model":"CarrierService","from":"serviceId","to":"id"}]');
ALTER TABLE "CarrierMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CarrierMetric" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CarrierMetric";
CREATE POLICY nexus_workspace_isolation ON "CarrierMetric" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CarrierMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CarrierMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CarrierMetric";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CarrierMetric" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Carrier","from":"carrierId","to":"id"}]');
ALTER TABLE "PickupSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PickupSchedule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PickupSchedule";
CREATE POLICY nexus_workspace_isolation ON "PickupSchedule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PickupSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PickupSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PickupSchedule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PickupSchedule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Carrier","from":"carrierId","to":"id"}]');
ALTER TABLE "CarrierAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CarrierAccount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CarrierAccount";
CREATE POLICY nexus_workspace_isolation ON "CarrierAccount" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CarrierAccount"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CarrierAccount"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CarrierAccount";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CarrierAccount" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Carrier","from":"carrierId","to":"id"}]');
ALTER TABLE "Shipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Shipment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Shipment";
CREATE POLICY nexus_workspace_isolation ON "Shipment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Shipment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Shipment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Shipment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Shipment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"},{"model":"Warehouse","from":"warehouseId","to":"id"}]');
ALTER TABLE "TrackingEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrackingEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "TrackingEvent";
CREATE POLICY nexus_workspace_isolation ON "TrackingEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "TrackingEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "TrackingEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "TrackingEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "TrackingEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Shipment","from":"shipmentId","to":"id"}]');
ALTER TABLE "TrackingMessageLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrackingMessageLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "TrackingMessageLog";
CREATE POLICY nexus_workspace_isolation ON "TrackingMessageLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "TrackingMessageLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "TrackingMessageLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "TrackingMessageLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "TrackingMessageLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Shipment","from":"shipmentId","to":"id"}]');
ALTER TABLE "ShipmentItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShipmentItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ShipmentItem";
CREATE POLICY nexus_workspace_isolation ON "ShipmentItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShipmentItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShipmentItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ShipmentItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ShipmentItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Shipment","from":"shipmentId","to":"id"}]');
ALTER TABLE "ShippingRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShippingRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ShippingRule";
CREATE POLICY nexus_workspace_isolation ON "ShippingRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShippingRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShippingRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ShippingRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ShippingRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Supplier";
CREATE POLICY nexus_workspace_isolation ON "Supplier" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Supplier"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Supplier"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Supplier";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Supplier" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SupplierShippingProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierShippingProfile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SupplierShippingProfile";
CREATE POLICY nexus_workspace_isolation ON "SupplierShippingProfile" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierShippingProfile"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierShippingProfile"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SupplierShippingProfile";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SupplierShippingProfile" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Supplier","from":"supplierId","to":"id"}]');
ALTER TABLE "SupplierProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierProduct" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SupplierProduct";
CREATE POLICY nexus_workspace_isolation ON "SupplierProduct" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierProduct"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierProduct"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SupplierProduct";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SupplierProduct" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Supplier","from":"supplierId","to":"id"}]');
ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrder" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PurchaseOrder";
CREATE POLICY nexus_workspace_isolation ON "PurchaseOrder" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PurchaseOrder"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PurchaseOrder"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PurchaseOrder";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PurchaseOrder" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"DevelopmentProject","from":"developmentProjectId","to":"id"},{"model":"Supplier","from":"supplierId","to":"id"},{"model":"Warehouse","from":"warehouseId","to":"id"}]');
ALTER TABLE "PurchaseOrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrderItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PurchaseOrderItem";
CREATE POLICY nexus_workspace_isolation ON "PurchaseOrderItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PurchaseOrderItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PurchaseOrderItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PurchaseOrderItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PurchaseOrderItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"PurchaseOrder","from":"purchaseOrderId","to":"id"}]');
ALTER TABLE "PurchaseOrderAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrderAttachment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PurchaseOrderAttachment";
CREATE POLICY nexus_workspace_isolation ON "PurchaseOrderAttachment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PurchaseOrderAttachment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PurchaseOrderAttachment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PurchaseOrderAttachment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PurchaseOrderAttachment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"PurchaseOrder","from":"purchaseOrderId","to":"id"}]');
ALTER TABLE "PurchaseOrderRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrderRevision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PurchaseOrderRevision";
CREATE POLICY nexus_workspace_isolation ON "PurchaseOrderRevision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PurchaseOrderRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PurchaseOrderRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PurchaseOrderRevision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PurchaseOrderRevision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"PurchaseOrder","from":"purchaseOrderId","to":"id"}]');
ALTER TABLE "PoComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PoComment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PoComment";
CREATE POLICY nexus_workspace_isolation ON "PoComment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoComment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoComment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PoComment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PoComment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"PurchaseOrder","from":"purchaseOrderId","to":"id"}]');
ALTER TABLE "PoEventLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PoEventLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PoEventLog";
CREATE POLICY nexus_workspace_isolation ON "PoEventLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoEventLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoEventLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PoEventLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PoEventLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "PoTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PoTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PoTemplate";
CREATE POLICY nexus_workspace_isolation ON "PoTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PoTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PoTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Supplier","from":"supplierId","to":"id"},{"model":"Warehouse","from":"warehouseId","to":"id"}]');
ALTER TABLE "PoTemplateItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PoTemplateItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PoTemplateItem";
CREATE POLICY nexus_workspace_isolation ON "PoTemplateItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoTemplateItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoTemplateItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PoTemplateItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PoTemplateItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"PoTemplate","from":"templateId","to":"id"}]');
ALTER TABLE "PoSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PoSchedule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PoSchedule";
CREATE POLICY nexus_workspace_isolation ON "PoSchedule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PoSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PoSchedule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PoSchedule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"PoTemplate","from":"templateId","to":"id"}]');
ALTER TABLE "InboundShipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundShipment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "InboundShipment";
CREATE POLICY nexus_workspace_isolation ON "InboundShipment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundShipment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundShipment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "InboundShipment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "InboundShipment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Warehouse","from":"warehouseId","to":"id"},{"model":"PurchaseOrder","from":"purchaseOrderId","to":"id"},{"model":"WorkOrder","from":"workOrderId","to":"id"}]');
ALTER TABLE "InboundShipmentAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundShipmentAttachment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "InboundShipmentAttachment";
CREATE POLICY nexus_workspace_isolation ON "InboundShipmentAttachment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundShipmentAttachment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundShipmentAttachment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "InboundShipmentAttachment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "InboundShipmentAttachment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"InboundShipment","from":"inboundShipmentId","to":"id"}]');
ALTER TABLE "InboundDiscrepancy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundDiscrepancy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "InboundDiscrepancy";
CREATE POLICY nexus_workspace_isolation ON "InboundDiscrepancy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundDiscrepancy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundDiscrepancy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "InboundDiscrepancy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "InboundDiscrepancy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"InboundShipment","from":"inboundShipmentId","to":"id"},{"model":"InboundShipmentItem","from":"inboundShipmentItemId","to":"id"}]');
ALTER TABLE "InboundShipmentItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundShipmentItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "InboundShipmentItem";
CREATE POLICY nexus_workspace_isolation ON "InboundShipmentItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundShipmentItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundShipmentItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "InboundShipmentItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "InboundShipmentItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"InboundShipment","from":"inboundShipmentId","to":"id"},{"model":"PurchaseOrderItem","from":"purchaseOrderItemId","to":"id"}]');
ALTER TABLE "InboundReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundReceipt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "InboundReceipt";
CREATE POLICY nexus_workspace_isolation ON "InboundReceipt" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundReceipt"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "InboundReceipt"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "InboundReceipt";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "InboundReceipt" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"InboundShipmentItem","from":"inboundShipmentItemId","to":"id"}]');
ALTER TABLE "WorkOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkOrder" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WorkOrder";
CREATE POLICY nexus_workspace_isolation ON "WorkOrder" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkOrder"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "WorkOrder"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "WorkOrder";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "WorkOrder" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Return" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Return" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Return";
CREATE POLICY nexus_workspace_isolation ON "Return" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Return"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Return"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Return";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Return" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"}]');
ALTER TABLE "ReturnItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReturnItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReturnItem";
CREATE POLICY nexus_workspace_isolation ON "ReturnItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReturnItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReturnItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReturnItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReturnItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Return","from":"returnId","to":"id"},{"model":"Lot","from":"lotId","to":"id"}]');
ALTER TABLE "Refund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Refund" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Refund";
CREATE POLICY nexus_workspace_isolation ON "Refund" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Refund"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Refund"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Refund";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Refund" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Return","from":"returnId","to":"id"}]');
ALTER TABLE "RefundAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefundAttempt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RefundAttempt";
CREATE POLICY nexus_workspace_isolation ON "RefundAttempt" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RefundAttempt"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RefundAttempt"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RefundAttempt";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RefundAttempt" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Refund","from":"refundId","to":"id"}]');
ALTER TABLE "ReturnPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReturnPolicy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReturnPolicy";
CREATE POLICY nexus_workspace_isolation ON "ReturnPolicy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReturnPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReturnPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReturnPolicy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReturnPolicy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReplenishmentRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReplenishmentRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReplenishmentRule";
CREATE POLICY nexus_workspace_isolation ON "ReplenishmentRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReplenishmentRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReplenishmentRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReplenishmentRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReplenishmentRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReplenishmentRecommendation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReplenishmentRecommendation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReplenishmentRecommendation";
CREATE POLICY nexus_workspace_isolation ON "ReplenishmentRecommendation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReplenishmentRecommendation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReplenishmentRecommendation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReplenishmentRecommendation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReplenishmentRecommendation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "CycleCount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CycleCount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CycleCount";
CREATE POLICY nexus_workspace_isolation ON "CycleCount" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CycleCount"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CycleCount"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CycleCount";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CycleCount" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"StockLocation","from":"locationId","to":"id"}]');
ALTER TABLE "CycleCountItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CycleCountItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CycleCountItem";
CREATE POLICY nexus_workspace_isolation ON "CycleCountItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CycleCountItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CycleCountItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CycleCountItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CycleCountItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"CycleCount","from":"cycleCountId","to":"id"}]');
ALTER TABLE "OrderRoutingRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderRoutingRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "OrderRoutingRule";
CREATE POLICY nexus_workspace_isolation ON "OrderRoutingRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderRoutingRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderRoutingRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "OrderRoutingRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "OrderRoutingRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Warehouse","from":"warehouseId","to":"id"}]');
ALTER TABLE "ReplenishmentSavedView" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReplenishmentSavedView" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReplenishmentSavedView";
CREATE POLICY nexus_workspace_isolation ON "ReplenishmentSavedView" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReplenishmentSavedView"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReplenishmentSavedView"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReplenishmentSavedView";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReplenishmentSavedView" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CronRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CronRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CronRun";
CREATE POLICY nexus_workspace_isolation ON "CronRun" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CronRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CronRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CronRun";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CronRun" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "OutboundApiCallLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboundApiCallLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "OutboundApiCallLog";
CREATE POLICY nexus_workspace_isolation ON "OutboundApiCallLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OutboundApiCallLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OutboundApiCallLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "OutboundApiCallLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "OutboundApiCallLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SyncLogErrorGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncLogErrorGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SyncLogErrorGroup";
CREATE POLICY nexus_workspace_isolation ON "SyncLogErrorGroup" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncLogErrorGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncLogErrorGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SyncLogErrorGroup";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SyncLogErrorGroup" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SyncLogSavedSearch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncLogSavedSearch" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SyncLogSavedSearch";
CREATE POLICY nexus_workspace_isolation ON "SyncLogSavedSearch" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncLogSavedSearch"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncLogSavedSearch"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SyncLogSavedSearch";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SyncLogSavedSearch" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AlertRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AlertRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AlertRule";
CREATE POLICY nexus_workspace_isolation ON "AlertRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AlertRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AlertRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AlertRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AlertRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AlertEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AlertEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AlertEvent";
CREATE POLICY nexus_workspace_isolation ON "AlertEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AlertEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AlertEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AlertEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AlertEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AlertRule","from":"ruleId","to":"id"}]');
ALTER TABLE "ProductSubstitution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductSubstitution" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductSubstitution";
CREATE POLICY nexus_workspace_isolation ON "ProductSubstitution" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductSubstitution"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductSubstitution"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductSubstitution";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductSubstitution" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"primaryProductId","to":"id"},{"model":"Product","from":"substituteProductId","to":"id"}]');
ALTER TABLE "StockoutEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockoutEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockoutEvent";
CREATE POLICY nexus_workspace_isolation ON "StockoutEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockoutEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockoutEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockoutEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockoutEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"StockLocation","from":"locationId","to":"id"}]');
ALTER TABLE "AutoPoRunLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutoPoRunLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AutoPoRunLog";
CREATE POLICY nexus_workspace_isolation ON "AutoPoRunLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutoPoRunLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutoPoRunLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AutoPoRunLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AutoPoRunLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FbaRestockReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FbaRestockReport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FbaRestockReport";
CREATE POLICY nexus_workspace_isolation ON "FbaRestockReport" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaRestockReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaRestockReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FbaRestockReport";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FbaRestockReport" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FbaRestockRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FbaRestockRow" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FbaRestockRow";
CREATE POLICY nexus_workspace_isolation ON "FbaRestockRow" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaRestockRow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaRestockRow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FbaRestockRow";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FbaRestockRow" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"FbaRestockReport","from":"reportId","to":"id"}]');
ALTER TABLE "FbaInboundPlanV2" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FbaInboundPlanV2" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FbaInboundPlanV2";
CREATE POLICY nexus_workspace_isolation ON "FbaInboundPlanV2" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaInboundPlanV2"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaInboundPlanV2"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FbaInboundPlanV2";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FbaInboundPlanV2" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"InboundShipment","from":"inboundShipmentId","to":"id"}]');
ALTER TABLE "Tag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tag" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Tag";
CREATE POLICY nexus_workspace_isolation ON "Tag" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Tag"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Tag"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Tag";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Tag" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AssetTag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetTag" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AssetTag";
CREATE POLICY nexus_workspace_isolation ON "AssetTag" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssetTag"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssetTag"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AssetTag";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AssetTag" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"DigitalAsset","from":"assetId","to":"id"},{"model":"Tag","from":"tagId","to":"id"}]');
ALTER TABLE "ProductTag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductTag" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductTag";
CREATE POLICY nexus_workspace_isolation ON "ProductTag" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductTag"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductTag"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductTag";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductTag" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Tag","from":"tagId","to":"id"}]');
ALTER TABLE "Bundle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Bundle" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Bundle";
CREATE POLICY nexus_workspace_isolation ON "Bundle" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Bundle"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Bundle"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Bundle";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Bundle" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "BundleComponent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BundleComponent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BundleComponent";
CREATE POLICY nexus_workspace_isolation ON "BundleComponent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BundleComponent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BundleComponent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BundleComponent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BundleComponent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Bundle","from":"bundleId","to":"id"}]');
ALTER TABLE "SavedView" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedView" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SavedView";
CREATE POLICY nexus_workspace_isolation ON "SavedView" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SavedView"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SavedView"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SavedView";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SavedView" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Review" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Review";
CREATE POLICY nexus_workspace_isolation ON "Review" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Review"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Review"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Review";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Review" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"ReviewRequest","from":"attributedRequestId","to":"id"},{"model":"ReviewRule","from":"attributedRuleId","to":"id"}]');
ALTER TABLE "ReviewResponse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewResponse" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewResponse";
CREATE POLICY nexus_workspace_isolation ON "ReviewResponse" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewResponse"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewResponse"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewResponse";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewResponse" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Review","from":"reviewId","to":"id"}]');
ALTER TABLE "ReviewSpotlight" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewSpotlight" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewSpotlight";
CREATE POLICY nexus_workspace_isolation ON "ReviewSpotlight" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSpotlight"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSpotlight"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewSpotlight";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewSpotlight" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReviewActionItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewActionItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewActionItem";
CREATE POLICY nexus_workspace_isolation ON "ReviewActionItem" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewActionItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewActionItem"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewActionItem";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewActionItem" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReviewSentiment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewSentiment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewSentiment";
CREATE POLICY nexus_workspace_isolation ON "ReviewSentiment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSentiment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSentiment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewSentiment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewSentiment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Review","from":"reviewId","to":"id"}]');
ALTER TABLE "ReviewCategoryRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewCategoryRate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewCategoryRate";
CREATE POLICY nexus_workspace_isolation ON "ReviewCategoryRate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewCategoryRate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewCategoryRate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewCategoryRate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewCategoryRate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReviewSpike" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewSpike" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewSpike";
CREATE POLICY nexus_workspace_isolation ON "ReviewSpike" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSpike"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSpike"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewSpike";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewSpike" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "AmazonReviewInsight" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonReviewInsight" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonReviewInsight";
CREATE POLICY nexus_workspace_isolation ON "AmazonReviewInsight" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonReviewInsight"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonReviewInsight"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonReviewInsight";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonReviewInsight" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "ReviewRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewRequest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewRequest";
CREATE POLICY nexus_workspace_isolation ON "ReviewRequest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewRequest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewRequest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewRequest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewRequest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"},{"model":"ReviewRule","from":"ruleId","to":"id"}]');
ALTER TABLE "ReviewRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewRule";
CREATE POLICY nexus_workspace_isolation ON "ReviewRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReviewTimingDefault" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewTimingDefault" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewTimingDefault";
CREATE POLICY nexus_workspace_isolation ON "ReviewTimingDefault" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewTimingDefault"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewTimingDefault"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewTimingDefault";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewTimingDefault" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReviewSendWindow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewSendWindow" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewSendWindow";
CREATE POLICY nexus_workspace_isolation ON "ReviewSendWindow" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSendWindow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSendWindow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewSendWindow";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewSendWindow" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReviewSentimentCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewSentimentCheck" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewSentimentCheck";
CREATE POLICY nexus_workspace_isolation ON "ReviewSentimentCheck" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSentimentCheck"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSentimentCheck"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewSentimentCheck";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewSentimentCheck" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"},{"model":"ReviewRule","from":"ruleId","to":"id"},{"model":"ReviewRequest","from":"reviewRequestId","to":"id"}]');
ALTER TABLE "ReviewMailerState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewMailerState" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewMailerState";
CREATE POLICY nexus_workspace_isolation ON "ReviewMailerState" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewMailerState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewMailerState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewMailerState";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewMailerState" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EmailSuppression" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailSuppression" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EmailSuppression";
CREATE POLICY nexus_workspace_isolation ON "EmailSuppression" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EmailSuppression"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EmailSuppression"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EmailSuppression";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EmailSuppression" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "OrderTag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderTag" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "OrderTag";
CREATE POLICY nexus_workspace_isolation ON "OrderTag" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderTag"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OrderTag"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "OrderTag";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "OrderTag" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"},{"model":"Tag","from":"tagId","to":"id"}]');
ALTER TABLE "AiUsageLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiUsageLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AiUsageLog";
CREATE POLICY nexus_workspace_isolation ON "AiUsageLog" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AiUsageLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AiUsageLog"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AiUsageLog";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AiUsageLog" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AiFeatureModelPref" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiFeatureModelPref" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AiFeatureModelPref";
CREATE POLICY nexus_workspace_isolation ON "AiFeatureModelPref" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AiFeatureModelPref"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AiFeatureModelPref"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AiFeatureModelPref";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AiFeatureModelPref" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ProductAiDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductAiDraft" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductAiDraft";
CREATE POLICY nexus_workspace_isolation ON "ProductAiDraft" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductAiDraft"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductAiDraft"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductAiDraft";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductAiDraft" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentDefinition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentDefinition" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentDefinition";
CREATE POLICY nexus_workspace_isolation ON "AgentDefinition" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentDefinition"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentDefinition"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentDefinition";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentDefinition" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentRun";
CREATE POLICY nexus_workspace_isolation ON "AgentRun" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentRun";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentRun" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AgentDefinition","from":"agentId","to":"id"}]');
ALTER TABLE "AgentTool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentTool" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentTool";
CREATE POLICY nexus_workspace_isolation ON "AgentTool" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentTool"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentTool"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentTool";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentTool" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentApproval" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentApproval";
CREATE POLICY nexus_workspace_isolation ON "AgentApproval" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentApproval"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentApproval"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentApproval";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentApproval" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AgentRun","from":"agentRunId","to":"id"}]');
ALTER TABLE "AgentMemory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentMemory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentMemory";
CREATE POLICY nexus_workspace_isolation ON "AgentMemory" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentMemory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentMemory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentMemory";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentMemory" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "PromptTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PromptTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PromptTemplate";
CREATE POLICY nexus_workspace_isolation ON "PromptTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PromptTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PromptTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PromptTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PromptTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Goal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Goal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Goal";
CREATE POLICY nexus_workspace_isolation ON "Goal" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Goal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Goal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Goal";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Goal" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "DashboardLayout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DashboardLayout" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DashboardLayout";
CREATE POLICY nexus_workspace_isolation ON "DashboardLayout" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DashboardLayout"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DashboardLayout"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DashboardLayout";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DashboardLayout" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "DashboardView" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DashboardView" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DashboardView";
CREATE POLICY nexus_workspace_isolation ON "DashboardView" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DashboardView"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DashboardView"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DashboardView";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DashboardView" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ScheduledReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduledReport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ScheduledReport";
CREATE POLICY nexus_workspace_isolation ON "ScheduledReport" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ScheduledReport";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ScheduledReport" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Notification";
CREATE POLICY nexus_workspace_isolation ON "Notification" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Notification"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Notification"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Notification";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Notification" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SavedViewAlert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedViewAlert" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SavedViewAlert";
CREATE POLICY nexus_workspace_isolation ON "SavedViewAlert" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SavedViewAlert"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SavedViewAlert"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SavedViewAlert";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SavedViewAlert" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"SavedView","from":"savedViewId","to":"id"}]');
ALTER TABLE "ProductTranslation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductTranslation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductTranslation";
CREATE POLICY nexus_workspace_isolation ON "ProductTranslation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductTranslation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductTranslation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductTranslation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductTranslation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "ProductRelation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductRelation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductRelation";
CREATE POLICY nexus_workspace_isolation ON "ProductRelation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductRelation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductRelation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductRelation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductRelation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"fromProductId","to":"id"},{"model":"Product","from":"toProductId","to":"id"}]');
ALTER TABLE "ProductSeo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductSeo" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductSeo";
CREATE POLICY nexus_workspace_isolation ON "ProductSeo" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductSeo"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductSeo"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductSeo";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductSeo" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "ProductCertificate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductCertificate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductCertificate";
CREATE POLICY nexus_workspace_isolation ON "ProductCertificate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductCertificate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductCertificate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductCertificate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductCertificate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "ChannelPublishAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelPublishAttempt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelPublishAttempt";
CREATE POLICY nexus_workspace_isolation ON "ChannelPublishAttempt" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelPublishAttempt"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelPublishAttempt"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelPublishAttempt";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelPublishAttempt" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "EbayCampaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayCampaign" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayCampaign";
CREATE POLICY nexus_workspace_isolation ON "EbayCampaign" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayCampaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayCampaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayCampaign";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayCampaign" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"channelConnectionId","to":"id"}]');
ALTER TABLE "EbayRateDiscoveryPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayRateDiscoveryPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayRateDiscoveryPlan";
CREATE POLICY nexus_workspace_isolation ON "EbayRateDiscoveryPlan" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayRateDiscoveryPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayRateDiscoveryPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayRateDiscoveryPlan";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayRateDiscoveryPlan" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"EbayCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "EbayCampaignAutomationPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayCampaignAutomationPolicy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayCampaignAutomationPolicy";
CREATE POLICY nexus_workspace_isolation ON "EbayCampaignAutomationPolicy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayCampaignAutomationPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayCampaignAutomationPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayCampaignAutomationPolicy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayCampaignAutomationPolicy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"EbayCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "EbayAdGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayAdGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayAdGroup";
CREATE POLICY nexus_workspace_isolation ON "EbayAdGroup" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayAdGroup";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayAdGroup" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"EbayCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "EbayAd" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayAd" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayAd";
CREATE POLICY nexus_workspace_isolation ON "EbayAd" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAd"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAd"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayAd";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayAd" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"EbayCampaign","from":"campaignId","to":"id"},{"model":"EbayAdGroup","from":"adGroupId","to":"id"}]');
ALTER TABLE "EbayKeyword" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayKeyword" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayKeyword";
CREATE POLICY nexus_workspace_isolation ON "EbayKeyword" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayKeyword"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayKeyword"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayKeyword";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayKeyword" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"EbayCampaign","from":"campaignId","to":"id"},{"model":"EbayAdGroup","from":"adGroupId","to":"id"}]');
ALTER TABLE "EbayNegativeKeyword" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayNegativeKeyword" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayNegativeKeyword";
CREATE POLICY nexus_workspace_isolation ON "EbayNegativeKeyword" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayNegativeKeyword"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayNegativeKeyword"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayNegativeKeyword";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayNegativeKeyword" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"EbayCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "EbayAdsReportTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayAdsReportTask" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayAdsReportTask";
CREATE POLICY nexus_workspace_isolation ON "EbayAdsReportTask" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsReportTask"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsReportTask"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayAdsReportTask";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayAdsReportTask" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayAdsDailyPerformance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayAdsDailyPerformance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayAdsDailyPerformance";
CREATE POLICY nexus_workspace_isolation ON "EbayAdsDailyPerformance" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsDailyPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsDailyPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayAdsDailyPerformance";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayAdsDailyPerformance" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayListingIndex" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayListingIndex" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayListingIndex";
CREATE POLICY nexus_workspace_isolation ON "EbayListingIndex" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayListingIndex"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayListingIndex"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayListingIndex";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayListingIndex" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayListingEconomics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayListingEconomics" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayListingEconomics";
CREATE POLICY nexus_workspace_isolation ON "EbayListingEconomics" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayListingEconomics"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayListingEconomics"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayListingEconomics";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayListingEconomics" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "MarketingAutomationState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketingAutomationState" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MarketingAutomationState";
CREATE POLICY nexus_workspace_isolation ON "MarketingAutomationState" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketingAutomationState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketingAutomationState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MarketingAutomationState";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MarketingAutomationState" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "MarketingSpendCeiling" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketingSpendCeiling" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MarketingSpendCeiling";
CREATE POLICY nexus_workspace_isolation ON "MarketingSpendCeiling" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketingSpendCeiling"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketingSpendCeiling"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MarketingSpendCeiling";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MarketingSpendCeiling" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayAdsRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayAdsRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayAdsRule";
CREATE POLICY nexus_workspace_isolation ON "EbayAdsRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayAdsRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayAdsRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayAdsRuleVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayAdsRuleVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayAdsRuleVersion";
CREATE POLICY nexus_workspace_isolation ON "EbayAdsRuleVersion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsRuleVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsRuleVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayAdsRuleVersion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayAdsRuleVersion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"EbayAdsRule","from":"ruleId","to":"id"}]');
ALTER TABLE "EbayAdsRuleExecution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayAdsRuleExecution" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayAdsRuleExecution";
CREATE POLICY nexus_workspace_isolation ON "EbayAdsRuleExecution" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsRuleExecution"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsRuleExecution"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayAdsRuleExecution";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayAdsRuleExecution" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"EbayAdsRule","from":"ruleId","to":"id"}]');
ALTER TABLE "EbayAdsProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayAdsProposal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayAdsProposal";
CREATE POLICY nexus_workspace_isolation ON "EbayAdsProposal" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsProposal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsProposal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayAdsProposal";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayAdsProposal" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayAdsDigest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayAdsDigest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayAdsDigest";
CREATE POLICY nexus_workspace_isolation ON "EbayAdsDigest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsDigest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayAdsDigest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayAdsDigest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayAdsDigest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayWatcherStats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayWatcherStats" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayWatcherStats";
CREATE POLICY nexus_workspace_isolation ON "EbayWatcherStats" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayWatcherStats"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayWatcherStats"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayWatcherStats";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayWatcherStats" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"channelListingId","to":"id"}]');
ALTER TABLE "EbayMarkdown" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayMarkdown" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayMarkdown";
CREATE POLICY nexus_workspace_isolation ON "EbayMarkdown" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayMarkdown"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayMarkdown"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayMarkdown";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayMarkdown" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"channelListingId","to":"id"}]');
ALTER TABLE "EbayVolumePromotion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayVolumePromotion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayVolumePromotion";
CREATE POLICY nexus_workspace_isolation ON "EbayVolumePromotion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayVolumePromotion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayVolumePromotion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayVolumePromotion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayVolumePromotion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayVolumeTierTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayVolumeTierTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayVolumeTierTemplate";
CREATE POLICY nexus_workspace_isolation ON "EbayVolumeTierTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayVolumeTierTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayVolumeTierTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayVolumeTierTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayVolumeTierTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ScheduledProductChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduledProductChange" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ScheduledProductChange";
CREATE POLICY nexus_workspace_isolation ON "ScheduledProductChange" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledProductChange"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScheduledProductChange"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ScheduledProductChange";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ScheduledProductChange" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "AutomationRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutomationRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AutomationRule";
CREATE POLICY nexus_workspace_isolation ON "AutomationRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AutomationRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AutomationRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CampaignRuleAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignRuleAssignment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CampaignRuleAssignment";
CREATE POLICY nexus_workspace_isolation ON "CampaignRuleAssignment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignRuleAssignment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignRuleAssignment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CampaignRuleAssignment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CampaignRuleAssignment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Campaign","from":"campaignId","to":"id"},{"model":"AutomationRule","from":"ruleId","to":"id"}]');
ALTER TABLE "AutomationRuleTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutomationRuleTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AutomationRuleTemplate";
CREATE POLICY nexus_workspace_isolation ON "AutomationRuleTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationRuleTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationRuleTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AutomationRuleTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AutomationRuleTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AutomationRuleExecution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutomationRuleExecution" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AutomationRuleExecution";
CREATE POLICY nexus_workspace_isolation ON "AutomationRuleExecution" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationRuleExecution"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationRuleExecution"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AutomationRuleExecution";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AutomationRuleExecution" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AutomationRule","from":"ruleId","to":"id"}]');
ALTER TABLE "AdsRuleSuggestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsRuleSuggestion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsRuleSuggestion";
CREATE POLICY nexus_workspace_isolation ON "AdsRuleSuggestion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsRuleSuggestion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsRuleSuggestion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsRuleSuggestion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsRuleSuggestion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdsSuggestionMute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsSuggestionMute" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsSuggestionMute";
CREATE POLICY nexus_workspace_isolation ON "AdsSuggestionMute" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsSuggestionMute"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsSuggestionMute"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsSuggestionMute";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsSuggestionMute" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "KeywordRank" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KeywordRank" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "KeywordRank";
CREATE POLICY nexus_workspace_isolation ON "KeywordRank" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordRank"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordRank"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "KeywordRank";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "KeywordRank" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Scenario" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Scenario" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Scenario";
CREATE POLICY nexus_workspace_isolation ON "Scenario" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Scenario"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Scenario"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Scenario";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Scenario" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ScenarioRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScenarioRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ScenarioRun";
CREATE POLICY nexus_workspace_isolation ON "ScenarioRun" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScenarioRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ScenarioRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ScenarioRun";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ScenarioRun" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Scenario","from":"scenarioId","to":"id"}]');
ALTER TABLE "ListingReconciliation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ListingReconciliation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ListingReconciliation";
CREATE POLICY nexus_workspace_isolation ON "ListingReconciliation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingReconciliation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingReconciliation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ListingReconciliation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ListingReconciliation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FlatFilePullRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FlatFilePullRecord" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FlatFilePullRecord";
CREATE POLICY nexus_workspace_isolation ON "FlatFilePullRecord" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FlatFilePullRecord"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FlatFilePullRecord"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FlatFilePullRecord";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FlatFilePullRecord" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FlatFilePullJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FlatFilePullJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FlatFilePullJob";
CREATE POLICY nexus_workspace_isolation ON "FlatFilePullJob" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FlatFilePullJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FlatFilePullJob"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FlatFilePullJob";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FlatFilePullJob" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CatalogOrganizeSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CatalogOrganizeSession" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CatalogOrganizeSession";
CREATE POLICY nexus_workspace_isolation ON "CatalogOrganizeSession" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CatalogOrganizeSession"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CatalogOrganizeSession"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CatalogOrganizeSession";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CatalogOrganizeSession" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CatalogOrganizeChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CatalogOrganizeChange" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CatalogOrganizeChange";
CREATE POLICY nexus_workspace_isolation ON "CatalogOrganizeChange" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CatalogOrganizeChange"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CatalogOrganizeChange"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CatalogOrganizeChange";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CatalogOrganizeChange" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"CatalogOrganizeSession","from":"sessionId","to":"id"}]');
ALTER TABLE "ProductReadCache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductReadCache" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductReadCache";
CREATE POLICY nexus_workspace_isolation ON "ProductReadCache" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductReadCache"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductReadCache"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductReadCache";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductReadCache" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "Category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Category" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Category";
CREATE POLICY nexus_workspace_isolation ON "Category" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Category"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Category"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Category";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Category" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Category","from":"parentId","to":"id"}]');
ALTER TABLE "CategoryClosure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CategoryClosure" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CategoryClosure";
CREATE POLICY nexus_workspace_isolation ON "CategoryClosure" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CategoryClosure"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CategoryClosure"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CategoryClosure";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CategoryClosure" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Category","from":"ancestorId","to":"id"},{"model":"Category","from":"descendantId","to":"id"}]');
ALTER TABLE "ProductCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductCategory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductCategory";
CREATE POLICY nexus_workspace_isolation ON "ProductCategory" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductCategory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductCategory"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductCategory";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductCategory" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"},{"model":"Category","from":"categoryId","to":"id"}]');
ALTER TABLE "FnskuLabelTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FnskuLabelTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FnskuLabelTemplate";
CREATE POLICY nexus_workspace_isolation ON "FnskuLabelTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FnskuLabelTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FnskuLabelTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FnskuLabelTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FnskuLabelTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ProductEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductEvent";
CREATE POLICY nexus_workspace_isolation ON "ProductEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ListingQualitySnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ListingQualitySnapshot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ListingQualitySnapshot";
CREATE POLICY nexus_workspace_isolation ON "ListingQualitySnapshot" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingQualitySnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ListingQualitySnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ListingQualitySnapshot";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ListingQualitySnapshot" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "RoutingDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoutingDecision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RoutingDecision";
CREATE POLICY nexus_workspace_isolation ON "RoutingDecision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RoutingDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RoutingDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RoutingDecision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RoutingDecision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"}]');
ALTER TABLE "FeedTransformRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeedTransformRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FeedTransformRule";
CREATE POLICY nexus_workspace_isolation ON "FeedTransformRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FeedTransformRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FeedTransformRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FeedTransformRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FeedTransformRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ChannelSchema" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelSchema" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelSchema";
CREATE POLICY nexus_workspace_isolation ON "ChannelSchema" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelSchema"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelSchema"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelSchema";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelSchema" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FbaReimbursement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FbaReimbursement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FbaReimbursement";
CREATE POLICY nexus_workspace_isolation ON "FbaReimbursement" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaReimbursement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaReimbursement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FbaReimbursement";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FbaReimbursement" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "FbaInventoryAdjustment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FbaInventoryAdjustment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FbaInventoryAdjustment";
CREATE POLICY nexus_workspace_isolation ON "FbaInventoryAdjustment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaInventoryAdjustment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaInventoryAdjustment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FbaInventoryAdjustment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FbaInventoryAdjustment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "MarketingCampaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketingCampaign" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MarketingCampaign";
CREATE POLICY nexus_workspace_isolation ON "MarketingCampaign" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketingCampaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketingCampaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MarketingCampaign";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MarketingCampaign" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "MarketingCampaignLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketingCampaignLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MarketingCampaignLink";
CREATE POLICY nexus_workspace_isolation ON "MarketingCampaignLink" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketingCampaignLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MarketingCampaignLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MarketingCampaignLink";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MarketingCampaignLink" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "AmazonAdsCampaignDetail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsCampaignDetail" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsCampaignDetail";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsCampaignDetail" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsCampaignDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsCampaignDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsCampaignDetail";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsCampaignDetail" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "EbayPromotedDetail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayPromotedDetail" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayPromotedDetail";
CREATE POLICY nexus_workspace_isolation ON "EbayPromotedDetail" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayPromotedDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayPromotedDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayPromotedDetail";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayPromotedDetail" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "DiscountDetail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscountDetail" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DiscountDetail";
CREATE POLICY nexus_workspace_isolation ON "DiscountDetail" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DiscountDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DiscountDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DiscountDetail";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DiscountDetail" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "ExternalAdsDetail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalAdsDetail" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ExternalAdsDetail";
CREATE POLICY nexus_workspace_isolation ON "ExternalAdsDetail" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ExternalAdsDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ExternalAdsDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ExternalAdsDetail";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ExternalAdsDetail" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "ContentPushDetail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentPushDetail" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ContentPushDetail";
CREATE POLICY nexus_workspace_isolation ON "ContentPushDetail" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ContentPushDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ContentPushDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ContentPushDetail";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ContentPushDetail" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "OutreachDetail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutreachDetail" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "OutreachDetail";
CREATE POLICY nexus_workspace_isolation ON "OutreachDetail" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OutreachDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "OutreachDetail"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "OutreachDetail";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "OutreachDetail" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "AdMutation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdMutation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdMutation";
CREATE POLICY nexus_workspace_isolation ON "AdMutation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdMutation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdMutation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdMutation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdMutation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdBlueprintApplication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdBlueprintApplication" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdBlueprintApplication";
CREATE POLICY nexus_workspace_isolation ON "AdBlueprintApplication" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBlueprintApplication"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBlueprintApplication"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdBlueprintApplication";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdBlueprintApplication" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdKeywordProtection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdKeywordProtection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdKeywordProtection";
CREATE POLICY nexus_workspace_isolation ON "AdKeywordProtection" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdKeywordProtection"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdKeywordProtection"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdKeywordProtection";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdKeywordProtection" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdNegativeReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdNegativeReview" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdNegativeReview";
CREATE POLICY nexus_workspace_isolation ON "AdNegativeReview" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdNegativeReview"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdNegativeReview"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdNegativeReview";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdNegativeReview" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdBlueprint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdBlueprint" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdBlueprint";
CREATE POLICY nexus_workspace_isolation ON "AdBlueprint" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBlueprint"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBlueprint"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdBlueprint";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdBlueprint" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CampaignTarget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignTarget" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CampaignTarget";
CREATE POLICY nexus_workspace_isolation ON "CampaignTarget" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignTarget"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignTarget"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CampaignTarget";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CampaignTarget" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "CampaignBudget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignBudget" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CampaignBudget";
CREATE POLICY nexus_workspace_isolation ON "CampaignBudget" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignBudget"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignBudget"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CampaignBudget";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CampaignBudget" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CampaignBudgetAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignBudgetAllocation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CampaignBudgetAllocation";
CREATE POLICY nexus_workspace_isolation ON "CampaignBudgetAllocation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignBudgetAllocation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignBudgetAllocation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CampaignBudgetAllocation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CampaignBudgetAllocation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"CampaignBudget","from":"budgetId","to":"id"},{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "CampaignBudgetRebalance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignBudgetRebalance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CampaignBudgetRebalance";
CREATE POLICY nexus_workspace_isolation ON "CampaignBudgetRebalance" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignBudgetRebalance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignBudgetRebalance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CampaignBudgetRebalance";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CampaignBudgetRebalance" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"CampaignBudget","from":"budgetId","to":"id"}]');
ALTER TABLE "CampaignMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignMetric" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CampaignMetric";
CREATE POLICY nexus_workspace_isolation ON "CampaignMetric" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CampaignMetric";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CampaignMetric" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "CampaignAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignAction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CampaignAction";
CREATE POLICY nexus_workspace_isolation ON "CampaignAction" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignAction"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CampaignAction"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CampaignAction";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CampaignAction" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "CalendarEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalendarEntry" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CalendarEntry";
CREATE POLICY nexus_workspace_isolation ON "CalendarEntry" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CalendarEntry"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CalendarEntry"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CalendarEntry";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CalendarEntry" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"MarketingCampaign","from":"campaignId","to":"id"}]');
ALTER TABLE "AdSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdSchedule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdSchedule";
CREATE POLICY nexus_workspace_isolation ON "AdSchedule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdSchedule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdSchedule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"RankScheduleGroup","from":"groupId","to":"id"}]');
ALTER TABLE "RankScheduleGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankScheduleGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RankScheduleGroup";
CREATE POLICY nexus_workspace_isolation ON "RankScheduleGroup" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankScheduleGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankScheduleGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RankScheduleGroup";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RankScheduleGroup" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "RankScheduleEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankScheduleEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RankScheduleEvent";
CREATE POLICY nexus_workspace_isolation ON "RankScheduleEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankScheduleEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankScheduleEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RankScheduleEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RankScheduleEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"RankScheduleGroup","from":"groupId","to":"id"}]');
ALTER TABLE "RankScheduleVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankScheduleVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RankScheduleVersion";
CREATE POLICY nexus_workspace_isolation ON "RankScheduleVersion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankScheduleVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankScheduleVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RankScheduleVersion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RankScheduleVersion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"RankScheduleGroup","from":"groupId","to":"id"}]');
ALTER TABLE "BudgetSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BudgetSchedule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BudgetSchedule";
CREATE POLICY nexus_workspace_isolation ON "BudgetSchedule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BudgetSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BudgetSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BudgetSchedule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BudgetSchedule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AutopilotPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutopilotPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AutopilotPlan";
CREATE POLICY nexus_workspace_isolation ON "AutopilotPlan" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutopilotPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutopilotPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AutopilotPlan";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AutopilotPlan" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AutopilotDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutopilotDecision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AutopilotDecision";
CREATE POLICY nexus_workspace_isolation ON "AutopilotDecision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutopilotDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutopilotDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AutopilotDecision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AutopilotDecision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AutopilotPlan","from":"planId","to":"id"}]');
ALTER TABLE "RankTarget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankTarget" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RankTarget";
CREATE POLICY nexus_workspace_isolation ON "RankTarget" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankTarget"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankTarget"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RankTarget";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RankTarget" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "RankScheduleTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankScheduleTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "RankScheduleTemplate";
CREATE POLICY nexus_workspace_isolation ON "RankScheduleTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankScheduleTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "RankScheduleTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "RankScheduleTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "RankScheduleTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ProductRankPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductRankPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductRankPlan";
CREATE POLICY nexus_workspace_isolation ON "ProductRankPlan" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductRankPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductRankPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductRankPlan";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductRankPlan" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdAudience" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdAudience" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdAudience";
CREATE POLICY nexus_workspace_isolation ON "AdAudience" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdAudience"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdAudience"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdAudience";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdAudience" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdBudgetPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdBudgetPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdBudgetPlan";
CREATE POLICY nexus_workspace_isolation ON "AdBudgetPlan" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBudgetPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBudgetPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdBudgetPlan";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdBudgetPlan" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdProductGoal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdProductGoal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdProductGoal";
CREATE POLICY nexus_workspace_isolation ON "AdProductGoal" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdProductGoal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdProductGoal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdProductGoal";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdProductGoal" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SupplierContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierContact" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SupplierContact";
CREATE POLICY nexus_workspace_isolation ON "SupplierContact" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierContact"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierContact"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SupplierContact";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SupplierContact" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Supplier","from":"supplierId","to":"id"}]');
ALTER TABLE "SupplierComm" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierComm" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SupplierComm";
CREATE POLICY nexus_workspace_isolation ON "SupplierComm" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierComm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierComm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SupplierComm";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SupplierComm" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Supplier","from":"supplierId","to":"id"}]');
ALTER TABLE "SupplierFollowUp" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierFollowUp" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SupplierFollowUp";
CREATE POLICY nexus_workspace_isolation ON "SupplierFollowUp" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierFollowUp"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SupplierFollowUp"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SupplierFollowUp";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SupplierFollowUp" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Supplier","from":"supplierId","to":"id"}]');
ALTER TABLE "DevelopmentProject" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DevelopmentProject" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DevelopmentProject";
CREATE POLICY nexus_workspace_isolation ON "DevelopmentProject" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DevelopmentProject"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DevelopmentProject"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DevelopmentProject";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DevelopmentProject" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "DevelopmentProjectSupplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DevelopmentProjectSupplier" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DevelopmentProjectSupplier";
CREATE POLICY nexus_workspace_isolation ON "DevelopmentProjectSupplier" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DevelopmentProjectSupplier"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DevelopmentProjectSupplier"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DevelopmentProjectSupplier";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DevelopmentProjectSupplier" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"DevelopmentProject","from":"projectId","to":"id"},{"model":"Supplier","from":"supplierId","to":"id"}]');
ALTER TABLE "DevelopmentAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DevelopmentAttachment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DevelopmentAttachment";
CREATE POLICY nexus_workspace_isolation ON "DevelopmentAttachment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DevelopmentAttachment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DevelopmentAttachment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DevelopmentAttachment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DevelopmentAttachment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"DevelopmentProject","from":"projectId","to":"id"}]');
ALTER TABLE "DevelopmentCertification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DevelopmentCertification" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "DevelopmentCertification";
CREATE POLICY nexus_workspace_isolation ON "DevelopmentCertification" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DevelopmentCertification"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "DevelopmentCertification"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "DevelopmentCertification";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "DevelopmentCertification" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"DevelopmentProject","from":"projectId","to":"id"}]');
ALTER TABLE "AdsAutomationState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsAutomationState" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsAutomationState";
CREATE POLICY nexus_workspace_isolation ON "AdsAutomationState" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsAutomationState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsAutomationState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsAutomationState";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsAutomationState" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonReportRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonReportRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonReportRun";
CREATE POLICY nexus_workspace_isolation ON "AmazonReportRun" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonReportRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonReportRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonReportRun";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonReportRun" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SharedListingMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SharedListingMembership" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SharedListingMembership";
CREATE POLICY nexus_workspace_isolation ON "SharedListingMembership" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SharedListingMembership"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SharedListingMembership"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SharedListingMembership";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SharedListingMembership" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"channelConnectionId","to":"id"}]');
ALTER TABLE "SyncChannelPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncChannelPolicy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SyncChannelPolicy";
CREATE POLICY nexus_workspace_isolation ON "SyncChannelPolicy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncChannelPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncChannelPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SyncChannelPolicy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SyncChannelPolicy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"channelConnectionId","to":"id"}]');
ALTER TABLE "SyncControlAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncControlAudit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SyncControlAudit";
CREATE POLICY nexus_workspace_isolation ON "SyncControlAudit" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncControlAudit"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SyncControlAudit"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SyncControlAudit";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SyncControlAudit" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EbayDescriptionTheme" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayDescriptionTheme" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayDescriptionTheme";
CREATE POLICY nexus_workspace_isolation ON "EbayDescriptionTheme" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayDescriptionTheme"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayDescriptionTheme"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayDescriptionTheme";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayDescriptionTheme" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonTemplateVault" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonTemplateVault" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonTemplateVault";
CREATE POLICY nexus_workspace_isolation ON "AmazonTemplateVault" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonTemplateVault"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonTemplateVault"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonTemplateVault";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonTemplateVault" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AmazonFamilyWorkbook" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonFamilyWorkbook" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonFamilyWorkbook";
CREATE POLICY nexus_workspace_isolation ON "AmazonFamilyWorkbook" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonFamilyWorkbook"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonFamilyWorkbook"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonFamilyWorkbook";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonFamilyWorkbook" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "ReportShareLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportShareLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReportShareLink";
CREATE POLICY nexus_workspace_isolation ON "ReportShareLink" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReportShareLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReportShareLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReportShareLink";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReportShareLink" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SavedReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedReport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SavedReport";
CREATE POLICY nexus_workspace_isolation ON "SavedReport" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SavedReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SavedReport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SavedReport";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SavedReport" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SavedReportVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedReportVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SavedReportVersion";
CREATE POLICY nexus_workspace_isolation ON "SavedReportVersion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SavedReportVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SavedReportVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SavedReportVersion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SavedReportVersion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"SavedReport","from":"savedReportId","to":"id"}]');
ALTER TABLE "ReportSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportSchedule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReportSchedule";
CREATE POLICY nexus_workspace_isolation ON "ReportSchedule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReportSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReportSchedule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReportSchedule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReportSchedule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"SavedReport","from":"savedReportId","to":"id"}]');
ALTER TABLE "ReportDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportDelivery" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReportDelivery";
CREATE POLICY nexus_workspace_isolation ON "ReportDelivery" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReportDelivery"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReportDelivery"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReportDelivery";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReportDelivery" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ReportSchedule","from":"scheduleId","to":"id"}]');
ALTER TABLE "AdsConsoleImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsConsoleImport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsConsoleImport";
CREATE POLICY nexus_workspace_isolation ON "AdsConsoleImport" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsConsoleImport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsConsoleImport"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsConsoleImport";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsConsoleImport" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdsConsoleRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsConsoleRow" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsConsoleRow";
CREATE POLICY nexus_workspace_isolation ON "AdsConsoleRow" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsConsoleRow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsConsoleRow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsConsoleRow";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsConsoleRow" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AdsConsoleImport","from":"importId","to":"id"}]');
ALTER TABLE "CustomMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomMetric" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CustomMetric";
CREATE POLICY nexus_workspace_isolation ON "CustomMetric" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CustomMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CustomMetric";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CustomMetric" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentCharter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentCharter" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentCharter";
CREATE POLICY nexus_workspace_isolation ON "AgentCharter" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentCharter"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentCharter"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentCharter";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentCharter" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentCharterRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentCharterRevision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentCharterRevision";
CREATE POLICY nexus_workspace_isolation ON "AgentCharterRevision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentCharterRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentCharterRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentCharterRevision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentCharterRevision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentEvalRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentEvalRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentEvalRun";
CREATE POLICY nexus_workspace_isolation ON "AgentEvalRun" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentEvalRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentEvalRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentEvalRun";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentEvalRun" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentControlAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentControlAudit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentControlAudit";
CREATE POLICY nexus_workspace_isolation ON "AgentControlAudit" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentControlAudit"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentControlAudit"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentControlAudit";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentControlAudit" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentObservation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentObservation";
CREATE POLICY nexus_workspace_isolation ON "AgentObservation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentObservation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentObservation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentObservation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentObservation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentFinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentFinding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentFinding";
CREATE POLICY nexus_workspace_isolation ON "AgentFinding" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentFinding"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentFinding"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentFinding";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentFinding" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentPlan";
CREATE POLICY nexus_workspace_isolation ON "AgentPlan" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentPlan";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentPlan" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentStrategy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentStrategy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentStrategy";
CREATE POLICY nexus_workspace_isolation ON "AgentStrategy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentStrategy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentStrategy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentStrategy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentStrategy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentStep" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentStep";
CREATE POLICY nexus_workspace_isolation ON "AgentStep" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentStep"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentStep"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentStep";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentStep" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentExemplar" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentExemplar" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentExemplar";
CREATE POLICY nexus_workspace_isolation ON "AgentExemplar" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentExemplar"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentExemplar"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentExemplar";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentExemplar" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentScorecard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentScorecard" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentScorecard";
CREATE POLICY nexus_workspace_isolation ON "AgentScorecard" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentScorecard"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentScorecard"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentScorecard";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentScorecard" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "GraphEdge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GraphEdge" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GraphEdge";
CREATE POLICY nexus_workspace_isolation ON "GraphEdge" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GraphEdge"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GraphEdge"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GraphEdge";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GraphEdge" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentFleetState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentFleetState" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentFleetState";
CREATE POLICY nexus_workspace_isolation ON "AgentFleetState" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentFleetState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentFleetState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentFleetState";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentFleetState" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentShadowGrade" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentShadowGrade" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentShadowGrade";
CREATE POLICY nexus_workspace_isolation ON "AgentShadowGrade" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentShadowGrade"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentShadowGrade"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentShadowGrade";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentShadowGrade" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentWorkflow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentWorkflow" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentWorkflow";
CREATE POLICY nexus_workspace_isolation ON "AgentWorkflow" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentWorkflow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentWorkflow"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentWorkflow";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentWorkflow" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentWorkflowRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentWorkflowRevision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentWorkflowRevision";
CREATE POLICY nexus_workspace_isolation ON "AgentWorkflowRevision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentWorkflowRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentWorkflowRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentWorkflowRevision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentWorkflowRevision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentAssignment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentAssignment";
CREATE POLICY nexus_workspace_isolation ON "AgentAssignment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentAssignment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentAssignment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentAssignment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentAssignment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AgentFindingRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentFindingRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentFindingRun";
CREATE POLICY nexus_workspace_isolation ON "AgentFindingRun" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentFindingRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentFindingRun"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentFindingRun";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentFindingRun" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdsHarvestPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsHarvestPolicy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsHarvestPolicy";
CREATE POLICY nexus_workspace_isolation ON "AdsHarvestPolicy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsHarvestPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsHarvestPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsHarvestPolicy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsHarvestPolicy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdsHarvestDestination" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsHarvestDestination" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsHarvestDestination";
CREATE POLICY nexus_workspace_isolation ON "AdsHarvestDestination" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsHarvestDestination"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsHarvestDestination"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsHarvestDestination";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsHarvestDestination" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "SqpReportRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SqpReportRequest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "SqpReportRequest";
CREATE POLICY nexus_workspace_isolation ON "SqpReportRequest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SqpReportRequest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "SqpReportRequest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "SqpReportRequest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "SqpReportRequest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdSpendCeiling" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdSpendCeiling" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdSpendCeiling";
CREATE POLICY nexus_workspace_isolation ON "AdSpendCeiling" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdSpendCeiling"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdSpendCeiling"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdSpendCeiling";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdSpendCeiling" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdBidPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdBidPolicy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdBidPolicy";
CREATE POLICY nexus_workspace_isolation ON "AdBidPolicy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBidPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdBidPolicy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdBidPolicy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdBidPolicy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AdWriteRefusal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdWriteRefusal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdWriteRefusal";
CREATE POLICY nexus_workspace_isolation ON "AdWriteRefusal" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdWriteRefusal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdWriteRefusal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdWriteRefusal";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdWriteRefusal" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AutomationRefusalDaily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutomationRefusalDaily" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AutomationRefusalDaily";
CREATE POLICY nexus_workspace_isolation ON "AutomationRefusalDaily" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationRefusalDaily"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationRefusalDaily"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AutomationRefusalDaily";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AutomationRefusalDaily" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "KeywordBidProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KeywordBidProposal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "KeywordBidProposal";
CREATE POLICY nexus_workspace_isolation ON "KeywordBidProposal" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordBidProposal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "KeywordBidProposal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "KeywordBidProposal";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "KeywordBidProposal" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "EventOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventOutbox" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EventOutbox";
CREATE POLICY nexus_workspace_isolation ON "EventOutbox" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EventOutbox"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EventOutbox"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EventOutbox";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EventOutbox" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "CategoryChannelMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CategoryChannelMapping" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CategoryChannelMapping";
CREATE POLICY nexus_workspace_isolation ON "CategoryChannelMapping" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CategoryChannelMapping"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CategoryChannelMapping"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CategoryChannelMapping";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CategoryChannelMapping" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Category","from":"categoryId","to":"id"}]');
ALTER TABLE "CellFormula" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CellFormula" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CellFormula";
CREATE POLICY nexus_workspace_isolation ON "CellFormula" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CellFormula"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CellFormula"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "CellFormula";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "CellFormula" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
ALTER TABLE "MasterFieldRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MasterFieldRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MasterFieldRule";
CREATE POLICY nexus_workspace_isolation ON "MasterFieldRule" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MasterFieldRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MasterFieldRule"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MasterFieldRule";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MasterFieldRule" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "MasterFieldRuleRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MasterFieldRuleRevision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MasterFieldRuleRevision";
CREATE POLICY nexus_workspace_isolation ON "MasterFieldRuleRevision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MasterFieldRuleRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MasterFieldRuleRevision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MasterFieldRuleRevision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MasterFieldRuleRevision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
CREATE OR REPLACE FUNCTION nexus_channel_route_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN DELETE FROM "ChannelAccountRoute" WHERE "connectionId" = OLD.id; RETURN OLD; END IF;
      IF NEW."externalAccountId" IS NOT NULL THEN
        INSERT INTO "ChannelAccountOwnership" ("channelType", environment, "externalAccountId", "workspaceId")
          VALUES (NEW."channelType", COALESCE(NEW."connectionMetadata"->>'environment', 'production'), NEW."externalAccountId", NEW."workspaceId")
          ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM "ChannelAccountOwnership" WHERE "channelType" = NEW."channelType" AND environment = COALESCE(NEW."connectionMetadata"->>'environment', 'production') AND "externalAccountId" = NEW."externalAccountId" AND "workspaceId" = NEW."workspaceId") THEN
          RAISE EXCEPTION 'This seller account belongs to another business profile' USING ERRCODE = '23505';
        END IF;
      END IF;
      IF NEW."isActive" THEN
        INSERT INTO "ChannelAccountRoute" ("connectionId", "workspaceId", "channelType", "externalAccountId", "destinationIds")
          VALUES (NEW.id, NEW."workspaceId", NEW."channelType", NEW."externalAccountId", ARRAY(
            SELECT DISTINCT identifier FROM "ConnectionScope" s CROSS JOIN LATERAL unnest(ARRAY[s."externalId", s.metadata->>'accountId']) identifier
            WHERE s."connectionId" = NEW.id AND s."isActive" AND s.kind = 'profile' AND identifier IS NOT NULL
          ))
          ON CONFLICT ("connectionId") DO UPDATE SET "workspaceId" = EXCLUDED."workspaceId", "channelType" = EXCLUDED."channelType", "externalAccountId" = EXCLUDED."externalAccountId", "destinationIds" = EXCLUDED."destinationIds";
      ELSE DELETE FROM "ChannelAccountRoute" WHERE "connectionId" = NEW.id; END IF;
      RETURN NEW;
    END $$;
DROP TRIGGER IF EXISTS nexus_channel_route ON "ChannelConnection";
CREATE TRIGGER nexus_channel_route AFTER INSERT OR UPDATE OR DELETE ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION nexus_channel_route_sync();
INSERT INTO "ChannelAccountOwnership" ("channelType", environment, "externalAccountId", "workspaceId") SELECT DISTINCT "channelType", COALESCE("connectionMetadata"->>'environment', 'production'), "externalAccountId", "workspaceId" FROM "ChannelConnection" WHERE "externalAccountId" IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO "ChannelAccountRoute" ("connectionId", "workspaceId", "channelType", "externalAccountId") SELECT id, "workspaceId", "channelType", "externalAccountId" FROM "ChannelConnection" WHERE "isActive" ON CONFLICT ("connectionId") DO NOTHING;
CREATE OR REPLACE FUNCTION nexus_channel_scope_route_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DECLARE target_id text;
    BEGIN
      target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."connectionId" ELSE NEW."connectionId" END;
      UPDATE "ChannelAccountRoute" SET "destinationIds" = ARRAY(
        SELECT DISTINCT identifier FROM "ConnectionScope" s CROSS JOIN LATERAL unnest(ARRAY[s."externalId", s.metadata->>'accountId']) identifier
        WHERE s."connectionId" = target_id AND s."isActive" AND s.kind = 'profile' AND identifier IS NOT NULL
      ) WHERE "connectionId" = target_id;
      RETURN COALESCE(NEW, OLD);
    END $$;
DROP TRIGGER IF EXISTS nexus_scope_route ON "ConnectionScope";
CREATE TRIGGER nexus_scope_route AFTER INSERT OR UPDATE OR DELETE ON "ConnectionScope" FOR EACH ROW EXECUTE FUNCTION nexus_channel_scope_route_sync();
UPDATE "ChannelAccountRoute" r SET "destinationIds" = ARRAY(SELECT DISTINCT identifier FROM "ConnectionScope" s CROSS JOIN LATERAL unnest(ARRAY[s."externalId", s.metadata->>'accountId']) identifier WHERE s."connectionId" = r."connectionId" AND s."isActive" AND s.kind = 'profile' AND identifier IS NOT NULL);
REVOKE INSERT, UPDATE, DELETE ON "ChannelAccountRoute" FROM nexus_workspace_runtime;
REVOKE INSERT, UPDATE, DELETE ON "ChannelAccountOwnership" FROM nexus_workspace_runtime;

COMMIT;
