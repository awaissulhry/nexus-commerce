# S0 — Schema Inventory, Auth Models & Financial-Field Enumeration

Source: `/Users/awais/nexus-commerce/packages/database/prisma/schema.prisma` (13,473 lines, **327 models**, **36 enums**, Neon Postgres). Read-only discovery, 2026-07-03.

Money-unit conventions are **inconsistent by era**: legacy models use `Decimal @db.Decimal(10-14,2)` in listing currency; T/PO/stock-era models use `Int` cents (EUR unless a sibling `currency` column); ads ingest uses `BigInt` micros (1 EUR = 1,000,000) and `Int` cents; AI opex uses `Decimal costUSD`. Any FieldPolicy map must key on `Model.field`, not on type heuristics.

---

## 1. Model inventory by domain (327)

### Catalog / PIM (30)
| Model | Purpose |
|---|---|
| Product | Master product (hot-path; carries basePrice AND costPrice/minMargin/b2bPrice/weightedAvgCostCents directly) |
| SkuAlias | Arbitrary string → Product mapping (legacy SKU tolerance) |
| ProductFamily | Family/parent grouping (variation families) |
| AttributeGroup / CustomAttribute / AttributeOption / FamilyAttribute | PIM attribute system (global vs per-variant scope, per-channel validation) |
| ProductWorkflow / WorkflowStage / WorkflowTransition / WorkflowComment / WorkflowAssignment | Content-workflow stages, transitions, discussion, per-user assignment (assigneeId → UserProfile) |
| ProductVariation | Child variant (price + costPrice/min/max/mapPrice; hot in flat-file editors) |
| VariantImage / ProductImage | Variant + product-bound images |
| ProductTranslation / ProductRelation / ProductSeo / ProductCertificate | Localized copy, cross-sells, SEO handles, CE-compliance certificates |
| Category / CategoryClosure / ProductCategory | Internal merchandising taxonomy (closure table) |
| ProductReadCache | Denormalized /products grid cache — carries basePrice+totalStock ONLY, **no cost/margin** |
| Tag / ProductTag / Bundle / BundleComponent | Tagging + kit/bundle composition (bundle carries computedCostCents) |
| CatalogOrganizeSession / CatalogOrganizeChange | Bulk re-organize sessions + change log |
| ProductEvent | Per-product event stream (real-time UX) |

### Listings / Channels (42)
| Model | Purpose |
|---|---|
| ChannelListing | Per-channel×marketplace listing (hot-path; price/salePrice/overrides + estimatedFbaFee/referralFeePercent) |
| VariantChannelListing | Per-variant channel listing (channelPrice/currentPrice) |
| Marketplace | Marketplace lookup (vatRate, taxInclusive, currency) |
| ChannelListingOverride / FieldLinkGroup / FieldValueMap / SizeScaleMap / MappingRevision | Field-level channel overrides, cross-market field linking, value/size mapping, mapping snapshots |
| SyncAttempt / AmazonSuppression / ListingIssue / Offer / ListingRecoveryEvent | Sync + suppression + live-issue + competitor-offer + recovery audit |
| ChannelListingImage / ChannelLiveImage / ListingImage | Channel image sets (pushed + live-observed) |
| MarketplaceSync / Channel / Listing / DraftListing | Legacy channel/listing rails (Listing.channelPrice) |
| CategorySchema / ChannelSchema / SchemaChange / FeedTransformRule | Marketplace product-type schemas + change log + feed transforms |
| GtinExemptionApplication | Amazon GTIN-exemption workflow |
| ListingWizard / ScheduledImagePublish / ScheduledWizardPublish / WizardStepEvent / WizardTemplate | List-wizard state + scheduling + telemetry + templates |
| AmazonImageFeedJob / AmazonFlatFileFeedJob / EbayPushJob / ChannelImagePublishJob | Feed/push job logs |
| ChannelPublishAttempt / ListingReconciliation / FlatFilePullRecord / FlatFilePullJob | Publish attempts + marketplace↔local reconciliation + flat-file pulls |
| ListingQualitySnapshot | Listing quality scores over time |
| SharedListingMembership | eBay shared-SKU → multi-listing map (per-listing price override) |
| ChannelConnection / OutboundSyncQueue | Channel credentials (PRESERVE-sensitive) + outbound write queue |

### Pricing / Promotions (13)
| Model | Purpose |
|---|---|
| RepricingRule / RepricingDecision | Live repricer rules (min/maxPrice bounds) + per-decision audit |
| PricingRule / PricingRuleProduct / PricingRuleVariation | Rule-based pricing (minMarginPercent/maxMarginPercent) |
| PricingSnapshot / PriceChangeEvent / BuyBoxHistory / FxRate | Computed-price snapshots, unified price timeline, buy-box history (marginAtObservation), FX cache |
| RetailEvent / RetailEventPriceAction | Retail calendar (Prime Day etc.) + scheduled price actions |
| Coupon | Customer-facing coupon (discountType/Value) |
| BrandSettings | Brand config incl. company taxId/vatScheme |

### B2B customer pricing (2)
| Model | Purpose |
|---|---|
| CustomerGroup | **B2B customer segments** ('guest','retail_b2b','wholesale_b2b') — NOT staff roles (confirmed, quoted in §2) |
| ProductTierPrice | Per-product volume/customer-group tier price (absolute Decimal) — B2B *customer* pricing, not auth |

### Orders / Customers / Fiscal-Finance (17)
| Model | Purpose |
|---|---|
| Order | Cross-channel order (totalPrice, IT fiscal identity snapshot: codiceFiscale/partitaIva/pec/SDI) — hot-path |
| OrderItem | Line item (price per unit, itVatRatePct) — hot-path |
| OrderNote / OrderRiskScore / OrderTag | Operator notes, risk audit, tags |
| Customer / CustomerSegment / CustomerAddress / CustomerNote | Canonical customer + RFM segments (Customer.totalSpentCents = LTV) |
| FiscalInvoiceCounter / FiscalInvoice / CreditNoteCounter / CreditNote | Italian gap-free invoice + nota di credito (SDI/FatturaPA), CreditNote.amountCents |
| DailySalesAggregate | Per-(sku,channel,market,day) revenue/units rollup — the demand+revenue aggregate |
| SettlementReport | Amazon settlement (bank deposit totals + rawBody flat-file) |
| FinancialTransaction | Per-order fee/revenue breakdown (all marketplace fees, gross/net revenue) |
| SellerFeedback | Marketplace seller feedback |

### Fulfillment / Inventory / Shipping (51)
| Model | Purpose |
|---|---|
| StockImportJob / StockLog | Bulk stock import audit + legacy stock log |
| FBAShipment / FBAShipmentItem / FbaInboundPlanV2 | FBA inbound (legacy + v2 plans) |
| Warehouse / StockLocation / StockLevel / StockReservation / StockMovement | Multi-location inventory ledger (StockMovement.cogsCents on consume) |
| StockCostLayer | **FIFO/LIFO cost layers** — unitCost+freight+duty+insurance+VAT per receive |
| Lot / SerialNumber / StockBin / StockBinQuantity / LotRecall | Lot/serial/bin tracking + GPSR recalls |
| YearEndSnapshot | Rimanenze (year-end stock valuation, totalValueEurCents + vatTreatment) |
| FbaInventoryDetail / FbaInventoryAdjustment / FbaReimbursement / FbaStorageAge* / FbaRestockReport / FbaRestockRow | FBA per-FC stock, ledger adjustments, reimbursements (€), storage-age fees, restock reports (*storage-age listed under Advertising money in §3) |
| MCFShipment / Shipment / ShipmentItem / TrackingEvent / TrackingMessageLog / ShippingRule | Outbound shipments (Shipment.costCents = label cost) + tracking + routing rules |
| Carrier / CarrierService / CarrierServiceMapping / CarrierMetric / PickupSchedule / CarrierAccount | Carrier catalog (basePriceCents), service mapping, cost/performance metrics, pickups, accounts |
| Return / ReturnItem / Refund / RefundAttempt / ReturnPolicy | Returns + refunds (Refund.amountCents, restockingFeePct) |
| CycleCount / CycleCountItem | Cycle counting |
| OrderRoutingRule / RoutingDecision / ChannelStockEvent | Warehouse routing + channel stock-drift triage |
| WorkOrder | Assembly/kitting work orders (costCents) |
| InboundShipment / InboundShipmentAttachment / InboundDiscrepancy / InboundShipmentItem / InboundReceipt | Inbound receiving (landed-cost components: shipping/customs/duties/insurance) |
| StockoutEvent | Stockout tracking w/ lost revenue+margin estimates |

### Procurement / Suppliers / Replenishment / R&D (27)
| Model | Purpose |
|---|---|
| Supplier / SupplierShippingProfile / SupplierProduct | Supplier master (taxId, paymentTerms) + freight profile (cost/cbm/kg) + per-SKU supplier cost & landed cost |
| PurchaseOrder / PurchaseOrderItem / PurchaseOrderAttachment / PurchaseOrderRevision / PoComment / PoEventLog / PoTemplate / PoTemplateItem / PoSchedule | Full PO stack (totalCents, unitCostCents everywhere) |
| AutoPoRunLog | Auto-PO cron audit (cost ceilings) |
| ReplenishmentRule / ReplenishmentRecommendation / ReplenishmentForecast / ForecastModelAssignment / ForecastAccuracy / ReplenishmentSavedView | Replenishment engine (recommendation carries unit/freight/landed cost) |
| ProductSubstitution | Demand substitution links |
| SupplierContact / SupplierComm / SupplierFollowUp | Supplier CRM |
| DevelopmentProject / DevelopmentProjectSupplier / DevelopmentAttachment / DevelopmentCertification | New-product R&D + sourcing quotes (targetCostCents, quotedCostCents) |

### Advertising (Amazon + eBay ads, rank, autopilot) (42)
| Model | Purpose |
|---|---|
| Campaign / AdGroup / AdTarget / AdProductAd | Amazon ads entity mirror (bids, spend/sales cents, trueProfit) |
| AmazonAdsConnection / AmazonAdsProfile / AmazonAdsPortfolio | Ads OAuth + profiles + portfolios (budgetAmount) |
| AmazonAdsDailyPerformance / AmazonAdsHourlyPerformance / AmazonAdsSearchTerm / AmazonAdsPlacementReport / AmazonAdsBrandMetric / SearchQueryPerformance | Report-scale perf tables (costMicros BigInt, sales*Cents) |
| AmazonAdsReportJob / AmazonAdsExportJob / AmazonReportRun | Async report/export job state |
| FbaStorageAge / ProductProfitDaily | Aged-inventory LTS fees; **per-SKU daily true P&L** (revenue/COGS/fees/ad-spend/profit) |
| AdvertisingActionLog / CampaignBidHistory | Write audits (payloadBefore/After, oldValue/newValue carry bid+budget €) |
| BudgetPool / BudgetPoolAllocation / BudgetPoolRebalance | Cross-marketplace budget pools + rebalance audit |
| EbayCampaign / EbayWatcherStats / EbayMarkdown / EbayVolumePromotion / EbayVolumeTierTemplate | eBay Promoted Listings + markdowns + volume pricing |
| AdsRuleSuggestion / AutomationRule* / KeywordRank | Propose-only rule suggestions; rank tracking (*AutomationRule listed under Infra; has maxDailyAdSpendCentsEur) |
| AdSchedule / RankScheduleGroup / RankScheduleTemplate / BudgetSchedule | Dayparting + rank schedules + hourly budget schedules (bids/budgets inside Json) |
| AutopilotPlan / AutopilotDecision | AI conductor (guardrails Json w/ bid+budget cents; before/after Json) |
| RankTarget / ProductRankPlan | Rank goals (maxCpcCents, acosCap) + family rank plans (familyDailyBudgetCents) |
| AdAudience / AdBudgetPlan / AdProductGoal / AdsAutomationState | AMC-style audiences, monthly budget manager, product goals, automation kill-switch state |

### Marketing OS + Content/DAM (29)
| Model | Purpose |
|---|---|
| MarketingCampaign / MarketingCampaignLink | Channel-agnostic campaign (budget/spend/sales cents, acos/roas) + per-market external binding |
| AmazonAdsCampaignDetail / EbayPromotedDetail / DiscountDetail / ExternalAdsDetail / ContentPushDetail / OutreachDetail | Per-surface campaign detail rows |
| CampaignTarget / CampaignBudget / CampaignBudgetAllocation / CampaignBudgetRebalance / CampaignMetric / CampaignAction / CalendarEntry | Unified targeting, budget pools, metrics time-series, write audit, calendar |
| DigitalAsset / AssetFolder / AssetUsage / AssetTag | DAM library |
| APlusContent / APlusContentVersion / APlusContentAsin / APlusModule | Amazon A+ Content stack |
| BrandStory / BrandStoryModule / BrandStoryVersion / BrandKit / BrandWatermarkTemplate / AssetLocaleOverlay | Brand Story + kit + watermark + locale overlays |

### Reviews / Voice-of-customer (15)
Review, ReviewResponse, ReviewSpotlight, ReviewActionItem, ReviewSentiment (AI, costUSD), ReviewCategoryRate, ReviewSpike, AmazonReviewInsight, ReviewRequest, ReviewRule (minOrderTotalCents), ReviewTimingDefault, ReviewSendWindow, ReviewSentimentCheck, ReviewMailerState, EmailSuppression (GDPR).

### AI / Agents (10)
AiUsageLog (costUSD per call), AiFeatureModelPref, AgentDefinition, AgentRun (costUSD), AgentTool (dailyBudgetUSD), AgentApproval, AgentMemory, PromptTemplate, TerminologyPreference, BrandVoice.

### Analytics / Insights (8)
Goal (targetValue — may be revenue), DashboardLayout, DashboardView, ScheduledReport, Notification, SavedViewAlert, Scenario, ScenarioRun (totalCostDeltaCents).

### Infra / Ops / Settings / Auth (41)
AccountSettings, NotificationPreference, NotificationWebhook, **ApiKey**, **UserProfile**, ConsentRecord, DataRetentionPolicy, DataExportRequest, **TwoFactorRecoveryCode**, **UserSession**, **LoginEvent**, WebhookEvent, RateLimitLog, SyncLog, SyncError, SyncHealthLog, BulkActionJob, BulkActionItem, BulkOperation, BulkOpsTemplate, BulkActionTemplate, ScheduledBulkAction, BulkAutomationApproval, ImportJob, ImportJobRow, ScheduledImport, ExportJob, ScheduledExport, **AuditLog**, CronRun, OutboundApiCallLog, SyncLogErrorGroup, SyncLogSavedSearch, AlertRule, AlertEvent, SavedView, FnskuLabelTemplate, ScheduledProductChange, AutomationRule, AutomationRuleTemplate, AutomationRuleExecution.

---

## 2. Auth-relevant models (quoted) + migration observations

**There is NO Team / Role / Permission / Member / Invitation / Organization / Workspace / Tenant model.** Verified: `grep -inE "^model (Team|Role|Permission|Member|Invitation|Org|Organization|Workspace|Staff|Employee|Tenant|Account)\b"` → zero hits. The system is single-operator today; schema comments explicitly reference a future **"Phase I (auth)"** ("Until full auth middleware lands (Phase I)…", "Once Phase I (auth) lands and every preference has a user, the column flips NOT NULL"). Several models default `userId String @default("default-user")` (Goal, DashboardLayout, DashboardView, ScheduledReport). ~40 other models carry loose, FK-less actor strings (`createdBy`, `approvedBy`, `actor`, `resolvedBy`, `userId String?`) — e.g. PurchaseOrder.approvedByUserId, Refund.actor, StockMovement.actor, AuditLog.userId. The only cross-domain FK into UserProfile outside the auth tables is `WorkflowAssignment.assigneeId → UserProfile`.

### UserProfile (schema.prisma:3517)
```prisma
model UserProfile {
  id                   String                   @id @default(cuid())
  displayName          String                   @default("")
  email                String                   @default("")
  avatarUrl            String                   @default("")
  // Password hash. Phase C migrates from sha256 (legacy) to bcrypt;
  // the verifier auto-detects format and re-hashes on next successful
  // login. Empty string = no password set yet.
  passwordHash         String                   @default("")
  phone                String?
  timezone             String? // IANA, e.g. "Europe/Rome"
  language             String? // BCP-47, e.g. "it-IT"
  dateFormat           String?
  weekStart            Int?
  workingHoursStart    String?
  workingHoursEnd      String?
  quietHoursStart      String?
  quietHoursEnd        String?
  // Phase C — 2FA (TOTP). Secret is base32; null when 2FA is off.
  twoFactorSecret      String?
  twoFactorEnabledAt   DateTime?
  createdAt            DateTime                 @default(now())
  updatedAt            DateTime                 @updatedAt
  workflowAssignments  WorkflowAssignment[]
  recoveryCodes        TwoFactorRecoveryCode[]
  sessions             UserSession[]
  loginEvents          LoginEvent[]
  notificationPrefs    NotificationPreference[]
  notificationWebhooks NotificationWebhook[]
  consents             ConsentRecord[]
  exportRequests       DataExportRequest[]
}
```
Note: **no role/permission field of any kind** on UserProfile — nothing to hang `financials.view` on yet.

### UserSession (3667)
```prisma
model UserSession {
  id          String      @id @default(cuid())
  userId      String
  user        UserProfile @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenPrefix String // first 8 chars of the hashed refresh token
  userAgent   String?
  ipAddress   String? // truncated IPv4 /24 or IPv6 /64 for privacy
  ipCity      String?
  ipCountry   String?
  createdAt   DateTime    @default(now())
  lastSeenAt  DateTime    @default(now())
  revokedAt   DateTime?

  @@index([userId])
  @@index([userId, revokedAt])
}
```
Comment says table is "read-mostly — the only writer for now is the eventual auth handshake" (refresh-token rotation model anticipated).

### LoginEvent (3692)
```prisma
model LoginEvent {
  id         String       @id @default(cuid())
  userId     String?
  user       UserProfile? @relation(fields: [userId], references: [id], onDelete: SetNull)
  emailTried String?
  outcome    String // "success" | "bad_password" | "totp_failed" | "recovery_code_used" | "locked"
  userAgent  String?
  ipAddress  String?
  ipCity     String?
  ipCountry  String?
  metadata   Json?
  createdAt  DateTime     @default(now())

  @@index([userId])
  @@index([createdAt])
}
```

### TwoFactorRecoveryCode (3647)
```prisma
model TwoFactorRecoveryCode {
  id        String      @id @default(cuid())
  userId    String
  user      UserProfile @relation(fields: [userId], references: [id], onDelete: Cascade)
  codeHash  String // bcrypt of the raw code
  usedAt    DateTime?
  createdAt DateTime    @default(now())

  @@index([userId])
  @@index([userId, usedAt])
}
```

### ApiKey (3485) — already has a scopes system
```prisma
model ApiKey {
  id        String    @id @default(cuid())
  label     String
  keyHash   String // SHA-256 hash of the key
  keyPrefix String // First 8 chars for display (e.g., "nxk_abc1...")
  lastUsed  DateTime?
  revokedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  // Phase G — finer-grained authorization.
  scopes             String[]  @default([])   // CANONICAL_SCOPES; empty = full access (legacy)
  ipAllowlist        String[]  @default([])   // CIDR / plain-IP; empty = any IP
  expiresAt          DateTime?
  rotatedAt          DateTime?
  rotatedToId        String?
  rotationGraceUntil DateTime?
}
```
`CANONICAL_SCOPES` in `apps/api/src/lib/api-key-auth.ts` (9 scopes): `products:read|write`, `listings:read|write`, `orders:read|write`, `stock:read|write`, `analytics:read` ("Reports, dashboards, **profit + ad-spend rollups**"), `admin` (super-scope). **This is the closest existing thing to a permission vocabulary** — machine keys already have coarse RBAC; humans have none. `analytics:read` is a natural naming precedent for `financials.view`.

### AuditLog (6270) — the model behind audit-log.routes.ts
```prisma
model AuditLog {
  id String @id @default(cuid())

  // Who. userId is nullable so system / cron writes can still log.
  userId String?
  ip     String?

  // What.
  entityType String // "Product" | "ChannelListing" | "ListingWizard" | ...
  entityId   String
  action     String // "create" | "update" | "delete" | "submit" | "replicate"

  // Before / after snapshots — diff lives in the audit viewer.
  // Cap: writers should slim these down to changed fields only,
  // not full row dumps, or the table balloons.
  before Json?
  after  Json?

  // Free-form metadata: which bulk-op id triggered this, which
  // marketplace context, which idempotency key, etc.
  metadata Json?

  createdAt DateTime @default(now())

  @@index([entityType, entityId])
  @@index([userId])
  @@index([createdAt])
}
```
Hardened by migration `20260509_l6_0_audit_log_immutability`: Postgres BEFORE UPDATE/DELETE triggers raise exceptions (append-only at DB layer; retention bypass via `session_replication_role='replica'`; rollback.sql provided). Served by `apps/api/src/routes/audit-log.routes.ts` (search + detail) and `settings-audit.routes.ts`. **Security note: before/after snapshots will contain restricted financial values (cost edits, bid changes) — the audit viewer must be gated or redacted under field-level security.**

### Supporting auth-adjacent models (summarized)
- **AccountSettings (3397)** — single-row workspace config (business name/address/currency/primaryMarketplace). No auth content.
- **NotificationPreference (3419) / NotificationWebhook (3459)** — per-user prefs (userId nullable "for backwards-compat… until Phase I"), HMAC-signed outbound webhooks (secretHash bcrypt + secretPrefix).
- **ConsentRecord (3568)** — GDPR Art. 7 append-only consent log (kind/version/accepted/ip/UA).
- **DataRetentionPolicy (3596)** — single-row JSON map of retention days per data type (IT fiscal 7y floor).
- **DataExportRequest (3609)** — GDPR export jobs (status/format/scope/downloadUrl/expiresAt).

### CustomerGroup + ProductTierPrice — B2B *customer* pricing, NOT staff auth (confirmed)
```prisma
model CustomerGroup {
  id          String  @id @default(cuid())
  // Lower-snake_case: 'guest', 'retail_b2b', 'wholesale_b2b'.
  code        String  @unique
  label       String
  description String?
  tierPrices ProductTierPrice[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model ProductTierPrice {
  id        String  @id @default(cuid())
  productId String
  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  minQty Int
  price Decimal @db.Decimal(10, 2)   // absolute tier price (B2B/volume discount)
  customerGroupId String?
  customerGroup   CustomerGroup? @relation(fields: [customerGroupId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([productId, minQty, customerGroupId])
  @@index([productId])
  @@index([customerGroupId])
}
```
Doc comments: "W4.1 — ProductTierPrice (Magento parity). Per-product volume-discount + customer-group pricing… falls back to Product.basePrice." These segment *buyers*, not operators. (They ARE restricted financial data — tier ladders reveal B2B discount structure.)

### Migration observations
311 migration folders in `packages/database/prisma/migrations`. Auth-related:
- `20260519_phase_c_profile_security` — UserProfile password/2FA fields + TwoFactorRecoveryCode + UserSession + LoginEvent.
- `20260519_phase_g_api_key_scopes` — ApiKey scopes/ipAllowlist/expiry/rotation.
- `20260509_l6_0_audit_log_immutability` — AuditLog UPDATE/DELETE-blocking triggers (+ rollback.sql).
Near-misses that are NOT auth: `*_bulk_operations_audit`, `*_concurrency_audit`, `*_dismissal_audit` (domain audits), `cr9_carrier_account`, `cr10_warehouse_account` (business entities). No role/permission/team migration exists. Recent `20260702_shared_listing_membership_price` shows **new money columns still land regularly** — the field policy needs a maintenance/CI story (e.g. lint new Decimal/cents columns for classification).

### packages/database views/SQL + packages/shared
- No Prisma `view` blocks; no views/ dir. Only ad-hoc scripts: `packages/database/scripts/cleanup-test-data.sql`, `packages/database/scripts/audit-2026-05-05.sql`.
- `packages/shared` contains only `image-validation.ts` and `vault.ts` (AES-256-GCM Vault class for secret encryption — used for channel creds; relevant infrastructure for any future secret handling). **No shared Money/Currency type exists** — money conventions are per-model (see header).

---

## 3. Financial field enumeration

Sweep: case-insensitive field-name match on cost|cogs|fee(!feed)|margin|profit|payout|settle|spend|acos|roas|revenue|sales|turnover|price|tier|wholesale|supplier|landed|vat|tax|duty|commission|refund|balance|invoice|amount|total|subtotal|budget|bid|cpc|cpm|discount|msrp|rrp|charge|payment|paid|earning|income|expense → 367 raw hits, plus a supplemental sweep (shipping|freight|customs|insurance|reimburs|iban|bank|payout|earn — no IBAN/bank fields exist) and a reverse check of all Decimal/Float fields NOT matching keywords (all non-money: weights, dims, shares, forecast units, thresholds — except the borderline ones folded in below). Relation-only hits (e.g. `Product.tierPrices ProductTierPrice[]`) excluded from counts.

### 3a. RESTRICTED-FINANCIAL (needs `financials.view`) — 191 fields

**Product & inventory costs / COGS / valuation (21)**
| Model.field | Type | Notes |
|---|---|---|
| Product.costPrice | Decimal? | unit cost on the hottest model |
| Product.weightedAvgCostCents | Int? | WAC cache |
| Product.minMargin | Decimal? | margin floor |
| Product.b2bPrice | Decimal? | B2B price (tier) |
| Product.orderingCostCents | Int? | EOQ input |
| Product.carryingCostPctYear | Decimal? | EOQ input |
| ProductVariation.costPrice | Decimal? | per-variant cost (flat-file hot path) |
| ProductTierPrice.price | Decimal | B2B/volume tier ladder |
| StockCostLayer.unitCost | Decimal | FIFO/LIFO layer |
| StockCostLayer.freightCents | Int? | landed component |
| StockCostLayer.dutyCents | Int? | landed component |
| StockCostLayer.insuranceCents | Int? | landed component |
| StockCostLayer.costCurrency | String | reveals sourcing currency |
| StockCostLayer.unitCostVatExcluded | Boolean | cost semantics |
| StockCostLayer.vatRate | Decimal? | on-receive VAT |
| StockCostLayer.exchangeRateOnReceive | Decimal? | cost FX |
| StockMovement.cogsCents | Int? | COGS at consume — hot ledger table |
| Bundle.computedCostCents | Int | kit cost |
| BundleComponent.unitCostCents | Int? | component cost |
| YearEndSnapshot.totalValueEurCents | Int | rimanenze valuation |
| YearEndSnapshot.vatTreatment | Json | fiscal valuation detail |

**Supplier, landed cost & procurement (35)**
| Model.field | Type | Notes |
|---|---|---|
| Supplier.taxId | String? | supplier fiscal identity |
| Supplier.paymentTerms | String? | commercial terms |
| Supplier.autoTriggerMaxCostCentsPerPo | Int? | auto-PO ceiling |
| SupplierShippingProfile.costPerCbmCents / costPerKgCents / fixedCostCents | Int? ×3 | freight rates |
| SupplierProduct.costCents | Int? | negotiated unit cost |
| SupplierProduct.lastLandedCostCents | Int? | landed cost |
| PurchaseOrder.totalCents | Int | PO value |
| PurchaseOrderItem.unitCostCents | Int | PO line cost |
| PoTemplateItem.unitCostCents | Int | template cost |
| InboundShipment.shippingCostCents / customsCostCents / dutiesCostCents / insuranceCostCents | Int? ×4 | landed components |
| InboundShipment.exchangeRate | Decimal? | cost FX |
| InboundShipmentItem.unitCostCents / costVarianceCents | Int? ×2 | receive costs |
| InboundDiscrepancy.costImpactCents | Int? | discrepancy € |
| WorkOrder.costCents | Int? | assembly cost |
| ReplenishmentRecommendation.unitCostCents / unitCostCurrency / fxRateUsed / freightCostPerUnitCents / landedCostPerUnitCents | Int?/String?/Decimal? ×5 | landed-cost snapshot on replen UI |
| AutoPoRunLog.totalCostCentsCreated / declinedCostCeiling | Int ×2 | auto-PO audit € |
| StockoutEvent.marginCentsPerUnit / unitCostCents / sellingPriceCents / estimatedLostRevenue / estimatedLostMargin | Int? ×5 | margin analytics row |
| ScenarioRun.totalCostDeltaCents | Int | what-if cost output |
| DevelopmentProject.targetCostCents | Int? | R&D target cost |
| DevelopmentProjectSupplier.quotedCostCents | Int? | sourcing quotes |

**Marketplace fees, P&L, payouts, reimbursements (33)**
| Model.field | Type | Notes |
|---|---|---|
| ChannelListing.estimatedFbaFee | Decimal? | FBA fee preview (borderline — see §4.6) |
| ChannelListing.referralFeePercent | Decimal? | referral fee (borderline — see §4.6) |
| ProductProfitDaily.grossRevenueCents / cogsCents / referralFeesCents / fbaFulfillmentFeesCents / fbaStorageFeesCents / advertisingSpendCents / returnsRefundsCents / otherFeesCents / trueProfitCents | Int ×9 | daily true P&L |
| ProductProfitDaily.trueProfitMarginPct | Decimal? | margin |
| FbaStorageAge.projectedLtsFee30dCents / 60d / 90d / currentStorageFeeCents | Int ×4 | storage fees |
| SettlementReport.totalAmount | Decimal | bank deposit total |
| SettlementReport.depositDate | DateTime? | payout timing |
| SettlementReport.rawBody | String? | **entire settlement flat-file** |
| FinancialTransaction.amount / amazonFee / fbaFee / paymentServicesFee / ebayFee / paypalFee / otherFees / grossRevenue / netRevenue | Decimal ×9 | per-order fee+revenue breakdown |
| FbaReimbursement.amountPerUnitCents / totalAmountCents | Int ×2 | Amazon credits |
| BuyBoxHistory.marginAtObservation | Decimal? | margin time-series |
| PricingRule.minMarginPercent / maxMarginPercent | Decimal? ×2 | margin guardrails |

**Revenue aggregates & fiscal amounts (4)**
| Model.field | Type | Notes |
|---|---|---|
| DailySalesAggregate.grossRevenue | Decimal | per-SKU/day revenue (feeds insights + replen) |
| DailySalesAggregate.averageSellingPrice | Decimal? | ASP |
| Customer.totalSpentCents | BigInt | LTV (borderline for CS — §4.7) |
| CreditNote.amountCents | Int | fiscal doc amount (borderline — §4.8) |

**Ad spend / bids / budgets / ad performance (94)**
| Model.field | Type | Notes |
|---|---|---|
| Campaign.dailyBudget / spend / sales / acos / roas / trueProfitCents / trueProfitMarginPct | Decimal/Int ×7 | live cockpit |
| Campaign.budgetJson / bidStrategyJson / dynamicBidding | Json ×3 | bid/budget config blobs |
| AdGroup.defaultBidCents / suppressedFromBidCents / baseBidFromCents / spendCents / salesCents / bidStrategyJson | Int/Json ×6 | |
| AdTarget.bidCents / suppressedFromBidCents / baseBidFromCents / spendCents / salesCents | Int ×5 | keyword-level |
| AdProductAd.spendCents / salesCents | Int ×2 | |
| AmazonAdsPortfolio.budgetAmount / budgetPolicy | Decimal?/String? ×2 | |
| AmazonAdsDailyPerformance.costMicros / sales1dCents / sales7dCents / sales14dCents / sales30dCents / ntbSalesCents14d / acos7d / roas7d | BigInt/Int/Decimal ×8 | report-scale |
| AmazonAdsHourlyPerformance.costMicros / sales7dCents | ×2 | Marketing Stream |
| AmazonAdsSearchTerm.costMicros / sales7dCents | ×2 | high-cardinality |
| AmazonAdsPlacementReport.costMicros / sales7dCents | ×2 | |
| BudgetPool.totalDailyBudgetCents | Int | |
| BudgetPoolAllocation.minDailyBudgetCents / maxDailyBudgetCents / targetSharePct | Int/Decimal ×3 | |
| BudgetPoolRebalance.totalShiftCents / inputs / outputs | Int/Json ×3 | inputs/outputs embed per-market profit + budgets |
| CampaignBidHistory.oldValue / newValue | String? ×2 | stringified bid/budget € |
| AdvertisingActionLog.payloadBefore / payloadAfter | Json ×2 | bid/budget snapshots |
| EbayCampaign.bidPercentage / dailyBudget / sales / spend | Decimal ×4 | |
| MarketingCampaign.budgetCents / spendCents / salesCents / acos / roas | Int/Decimal ×5 | unified campaign |
| CampaignTarget.bidCents / spendCents / salesCents | Int ×3 | |
| CampaignBudget.totalDailyCents | Int | |
| CampaignBudgetAllocation.minDailyBudgetCents / maxDailyBudgetCents / targetSharePct | ×3 | |
| CampaignBudgetRebalance.totalShiftCents | Int | |
| CampaignMetric.costMicros / costEurCents / sales7dCents / sales14dCents / sales30dCents / acos7d / roas7d | BigInt/Int/Decimal ×7 | unified daily series |
| AdSchedule.originalBids | Json? | pre-schedule bid snapshot |
| BudgetSchedule.campaigns / windows / lastApplied | Json ×3 | embed dailyBudget € + hourly € values |
| AutopilotPlan.guardrails | Json | bidMin/Max, budgetMin/Max, maxDailySpendCents |
| AutopilotDecision.before / after | Json? ×2 | bid/budget change payloads |
| RankTarget.acosCapPct / maxCpcCents / bidValueCents / bidDeltaPct | Int? ×4 | |
| ProductRankPlan.familyDailyBudgetCents / familyAcosCapPct | Int? ×2 | |
| AdBudgetPlan.monthlyBudgetCents | Int | |
| AdProductGoal.totalBudgetCents | Int? | |
| AutomationRule.maxDailyAdSpendCentsEur | Int? | safety cap |
| AdsAutomationState.maxHourlySpendCentsEur | Int? | safety spine |
| AmazonAdsCampaignDetail.bidStrategyJson / dynamicBidding | Json? ×2 | |
| EbayPromotedDetail.bidPercentage | Decimal? | |

**AI / internal opex (4)** — low severity, still money
| Model.field | Type |
|---|---|
| AiUsageLog.costUSD | Decimal |
| ReviewSentiment.costUSD | Decimal |
| AgentRun.costUSD | Decimal |
| AgentTool.dailyBudgetUSD | Decimal? |

### 3b. OPERATIONAL-PRICE (ops need it) — 58 fields

**Listing & master sale prices (14)**: Product.basePrice (Decimal), ProductVariation.price (Decimal), ProductReadCache.basePrice (Decimal?), VariantChannelListing.channelPrice / currentPrice, ChannelListing.price / salePrice / priceAdjustmentPercent / followMasterPrice(Bool) / masterPrice / priceOverride, Listing.channelPrice, SharedListingMembership.price, ListingReconciliation.channelPrice.

**Public market / competitor data (8)**: Product.buyBoxPrice, Product.competitorPrice, ChannelListing.lowestCompetitorPrice, Offer.price, BuyBoxHistory.buyBoxPrice / lowestCompetitorPrice, RepricingDecision.buyBoxPrice / lowestCompPrice. (Publicly observable on Amazon; not secret.)

**Repricing engine + price events (11)**: RepricingRule.maxPrice / beatAmount / beatPct / lastDecisionPrice, RepricingDecision.oldPrice / newPrice, PricingSnapshot.computedPrice / clampedFrom, PriceChangeEvent.oldPrice / newPrice, RetailEventPriceAction.value. (All public-facing prices; min-price floors moved to borderline §4.4.)

**Customer-paid order money + refunds + fiscal docs (9)**: Order.totalPrice (Decimal 12,2 — §4.1), OrderItem.price (Decimal 10,2 — §4.1), OrderItem.itVatRatePct (statutory 22/10/4), Refund.amountCents (Int — §4.2), Refund.perLineAmounts (Json — §4.2), Return.refundCents / refundStatus (§4.2), FiscalInvoice.invoiceNumber, CreditNote.creditNoteNumber (doc numbers, printed on packing/fiscal docs — §4.8).

**Customer-facing promotions (11)**: Coupon.discountType / discountValue, EbayMarkdown.discountType / discountValue / originalPrice / markdownPrice, EbayVolumePromotion.tiers (Json), EbayVolumeTierTemplate.tiers (Json), DiscountDetail.discountType / discountValueCents / discountPercent.

**Operational config (5)**: ReturnPolicy.restockingFeePct (customer-charged %), ReviewRule.minOrderTotalCents (rule threshold), Marketplace.vatRate + taxInclusive (statutory country rates), FxRate.rate (public FX).

### 3c. NOT-SENSITIVE (keyword false positives) — ~50 fields
- Counts masquerading as money words: `*.totalRows` (StockImportJob, ImportJob), BulkActionJob.totalItems, ReplenishmentRecommendation.totalAvailable, YearEndSnapshot.totalUnits, ScenarioRun.totalUnitsDelta, AutoPoRunLog.totalUnitsCreated, ReviewCategoryRate.total, FlatFilePullJob.total, Customer.totalOrders, Product.totalStock, ProductReadCache.totalStock, SearchQueryPerformance.impressionsTotal/clicksTotal/cartAddsTotal/purchasesTotal, FbaRestockRow.salesPace30dUnits/salesShortageUnits, DailySalesAggregate.unitsSold/ordersCount (volume — see §4.10), StockMovement.balanceAfter (qty).
- `id`/ref fields: SyncHealthLog.syncJobId, BulkActionJob.rollbackJobId, BulkActionItem.jobId, ImportJob.parentJobId, ImportJobRow.jobId, ScheduledBulkAction/ScheduledImport/ScheduledExport.lastJobId, StockMovement.reservationId, FbaReimbursement.reimbursementId, DiscountDetail.priceRuleId/discountCodeId, FlatFilePullRecord.jobId, Lot.supplierLotRef, SupplierProduct/PurchaseOrderItem/PoTemplateItem.supplierSku, supplier relation fields.
- Substring accidents: UserProfile.avatarUrl (vat!), Order.paidAt (timestamp), AmazonAdsProfile.validPaymentMethod (bool), CarrierService.tier / CarrierServiceMapping.tierOverride (service class strings), AgentDefinition.autonomyTier / AgentTool.riskTier / AgentApproval.riskTier, PromptTemplate.totalEditChars, Product.shippingTemplate, OrderRoutingRule.shippingCountry, MCFShipment.shippingSpeedCategory, Supplier.shippingTimeDays, SupplierProduct.shippingTimeDaysOverride, Order.shippingAddress (PII, not money), Supplier ack/confirm timestamps, PurchaseOrderRevision.supplierNotifiedAt/supplierAckedAt, Return.channelRefundId/channelRefundError/channelRefundedAt/refundedAt (ids/timestamps), RefundAttempt.channelRefundId, Campaign.dailyBudgetCurrency / AmazonAdsPortfolio.budgetCurrencyCode / EbayCampaign.budgetCurrency / BudgetPool.currency (currency codes), Campaign.biddingStrategy / costType / budgetScope / liveBidWrites* (config/state, no €), AmazonAdsPortfolio.inBudget (bool), FiscalInvoiceCounter/CreditNoteCounter.current (sequence), FbaReimbursement.quantityReimbursed (qty), Customer aggregates handled above.
- Statutory/public: Marketplace.vatRate, OrderItem.itVatRatePct, FxRate.rate (listed operational), BrandSettings.taxId/vatScheme (own-company config; mildly sensitive, not financial-secret).

---

## 4. Borderline cases needing a human call

1. **Order.totalPrice + OrderItem.price** — customer-paid money. Ops need per-order values (packing slips, refunds, fiscal docs). Recommendation: OPERATIONAL per-row; RESTRICT the *aggregates* (DailySalesAggregate, insights/Global Snapshot endpoints, Customer.totalSpentCents) — otherwise anyone with orders:read can reconstruct revenue anyway by summing. Decide: is order-level money visible to warehouse staff?
2. **Refund.amountCents / perLineAmounts / Return.refundCents** — returns operators literally process refunds; hiding amounts breaks the job. Recommend OPERATIONAL, but it IS money out.
3. **Shipment.costCents, CarrierService.basePriceCents, CarrierMetric.totalCostCents/avgCostCents** — our carrier costs. Outbound ops pick services by cost. Recommend: visible to fulfillment role, hidden from view-only/CS. Human call.
4. **Price floors: Product.minPrice/maxPrice, ProductVariation.minPrice/maxPrice/mapPrice, RepricingRule.minPrice, ChannelListing.bestOfferFloor** — minPrice is typically cost+minMargin ⇒ leaks margin floor; MAP is a vendor-agreement value. Recommend RESTRICTED for min-floors, OPERATIONAL for max. Human call.
5. **Goal.targetValue (Decimal)** — generic goal target; may be a revenue figure. Depends on goal kind at runtime.
6. **ChannelListing.estimatedFbaFee / referralFeePercent** — classified RESTRICTED (fees), but they render inside pricing/flat-file surfaces used by listing ops, and the flat-file pages are UNTOUCHABLE (feedback_flat_file_untouchable). Filtering must happen in shared services/API serializers, not the pages. Decide whether listing ops get fee visibility.
7. **Customer.totalSpentCents (+ totalOrders)** — LTV. CS/segmentation (CI-series RFM) uses it; it is also a revenue aggregate. Human call per role.
8. **FiscalInvoice / CreditNote (invoiceNumber, amountCents, causale)** — fulfillment prints invoices/credit notes containing amounts; fiscal compliance flows need them. Restricting amounts breaks document generation — likely OPERATIONAL for the doc-generation path, RESTRICTED for browse/aggregate views.
9. **AI opex (AiUsageLog/AgentRun/ReviewSentiment.costUSD, AgentTool.dailyBudgetUSD)** — internal spend, small €. Restrict or leave open? Low severity.
10. **Volume non-money: DailySalesAggregate.unitsSold, sessions, buyBoxPct; Customer.totalOrders; KeywordRank** — not money, but competitively sensitive and enough to approximate revenue when combined with public prices. Out of financials.view scope or in?
11. **JSON smuggling (design-critical)**: `AuditLog.before/after/metadata` (cost & bid edits!), `Order.amazonMetadata` (OrderTotal & item prices), `PurchaseOrderRevision.snapshotJson` (full PO incl. costs), `BulkOperation`/`ImportJob`/`ExportJob` payloads & result files, `SettlementReport.rawBody`, `BudgetPoolRebalance.inputs/outputs`, `AgentRun` transcripts, `ScenarioRun` outputs, `Refund.perLineAmounts`, `BudgetSchedule.campaigns/windows`, `AutopilotPlan.guardrails`, `AutopilotDecision.before/after`, `Campaign.budgetJson`. Column-level filtering alone is defeated by these — need JSON redaction rules or route-level gating for their viewers (audit log UI, export downloads, PO revision history).
12. **B2B tier prices (Product.b2bPrice, ProductTierPrice.price)** — mission pre-classifies RESTRICTED; note that any future B2B sales role will need read access to quote customers.

---

## 5. Hot-path / performance notes for field filtering

- **Product** (schema lines 83–459; "~30 API call sites" per its own comments) is the worst case: RESTRICTED (costPrice, weightedAvgCostCents, minMargin, b2bPrice, orderingCostCents, carryingCostPctYear) and OPERATIONAL (basePrice, buyBoxPrice…) coexist on one row. BUT the heaviest read path — the /products grid — reads **ProductReadCache**, which contains **zero cost/margin fields** (only basePrice + totalStock). So the grid needs no filtering; enforcement concentrates on product-detail/edit endpoints, bulk endpoints, flat-file snapshot builders, and exports.
- **ChannelListing** (1413–1631): flat-file editors load entire families × 5 markets in one request. Only 2 restricted fields (estimatedFbaFee, referralFeePercent) → a static Prisma `select`/omit is cheap. Constraint: flat-file pages+routes are untouchable — implement in `AmazonFlatFileService` / serializer layer (already shared per AC/EC-series).
- **Order / OrderItem**: hot (orders workspace, SSE live-sync, packing flows). If borderline #1/#2 resolve as OPERATIONAL, the hot path needs **no per-field work**; restriction lands on aggregate/report endpoints instead (DailySalesAggregate, /insights, Global Snapshot, Customer LTV) which are naturally route-gateable.
- **Ads performance tables** (AmazonAdsDailyPerformance, Hourly, SearchTerm, Placement, CampaignMetric): report-scale row counts, BigInt micros. Nearly every column is restricted → **route-level gating of /marketing/ads + ads sections of /insights is cheaper and safer than field filtering**.
- **Pure-financial models** — ProductProfitDaily, FinancialTransaction, SettlementReport, FbaReimbursement, StockCostLayer, YearEndSnapshot, BudgetPool*, CampaignBudget*, AdBudgetPlan — every meaningful column is restricted: use model-level (route-level) deny, not per-field.
- **StockMovement.cogsCents** is one restricted field on a very hot ledger table (stock timeline UIs) — good candidate for serializer omission rather than query rewrite.
- **Bypass channels to cover in design**: SSE event payloads (order/ads events carry money), CSV/XLSX exports (ExportJob, insights exports, feed error reports), AuditLog viewer (before/after diffs), admin/backfill endpoints, webhook payloads (NotificationWebhook), and scheduled reports (ScheduledReport email). Enforcement belongs in a serialization layer shared by REST + SSE + export writers, not per-route ad hoc.
- **Decimal serialization**: Prisma Decimal → string in JSON; any redaction middleware must handle Decimal, BigInt (micros), Int cents, and Json blobs uniformly.

---

## Appendix: 36 enums
FulfillmentMethod, CampaignType, CampaignStatus, BiddingStrategy, AdSyncStatus, ShipmentStatus, SyncChannel, OutboundSyncStatus, PricingRuleType, FieldParentage, FieldTranslatePolicy, ChannelStockEventStatus, OrderChannel, OrderStatus, PriceChangeSource, ImageScope, ImageRole, StockMovementReason, ShipmentStatusFBM, ReturnStatusFlow, ReturnConditionGrade, PurchaseOrderStatus, WorkOrderStatus, InboundType, InboundStatus, CarrierCode, ReplenishmentUrgency, TrackingMessageStatus, RefundKind, RefundChannelStatus, ReviewRequestStatus, ReviewRuleScope, MktChannel, MktSurface, MktObjective, MktStatus. None encode money; BiddingStrategy/PricingRuleType are config vocabulary only.
