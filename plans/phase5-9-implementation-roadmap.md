# Phases 5-9 Implementation Roadmap

> Comprehensive plan for completing the Rithum integration with marketplace APIs, competitor tracking, velocity-based allocation, repricing automation, and analytics.

---

## Phase 5: Marketplace API Integration

### Objective
Implement actual price update calls to Amazon and eBay from the repricing engine.

### Components to Create/Modify

#### 1. **Extend EbayService** (`apps/api/src/services/marketplaces/ebay.service.ts`)
- Add `updateVariantPrice(variantSku: string, newPrice: number): Promise<void>`
- Call eBay Inventory API to update offer price for specific SKU
- Handle rate limiting and retry logic
- Log price update attempts and results

#### 2. **Extend AmazonService** (`apps/api/src/services/marketplaces/amazon.service.ts`)
- Add `updateVariantPrice(asin: string, newPrice: number): Promise<void>`
- Call Amazon SP-API Pricing API to update price
- Handle regional pricing if applicable
- Log price update attempts and results

#### 3. **Update Sync Job Phase 2** (`apps/api/src/jobs/sync.job.ts`)
- Uncomment TODO calls to `ebay.updateVariantPrice()` and `amazon.updateVariantPrice()`
- Add error handling for marketplace API failures
- Implement retry logic for transient failures
- Update `VariantChannelListing.lastSyncStatus` based on API response

### Implementation Details

```typescript
// EbayService.updateVariantPrice()
async updateVariantPrice(variantSku: string, newPrice: number): Promise<void> {
  const accessToken = await this.getAccessToken();
  
  // Find inventory item by SKU
  const inventoryItems = await this.getInventoryItems();
  const item = inventoryItems.find(i => i.sku === variantSku);
  
  if (!item) throw new Error(`Inventory item not found: ${variantSku}`);
  
  // Update offer price
  const response = await fetch(
    `https://api.ebay.com/sell/inventory/v1/offer/${item.offerId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pricingSummary: {
          price: { currency: 'USD', value: newPrice.toString() }
        }
      })
    }
  );
  
  if (!response.ok) {
    throw new Error(`Failed to update eBay price: ${response.statusText}`);
  }
}

// AmazonService.updateVariantPrice()
async updateVariantPrice(asin: string, newPrice: number): Promise<void> {
  const sp = new SellingPartner({...});
  
  // Update pricing via Pricing API
  const response = await sp.callAPI({
    operation: 'updatePricing',
    body: {
      pricelist: [{
        asin,
        standardPrice: { currency: 'USD', amount: newPrice }
      }]
    }
  });
  
  if (response.errors?.length > 0) {
    throw new Error(`Failed to update Amazon price: ${response.errors[0].message}`);
  }
}
```

### Testing Strategy
- Mock marketplace API responses
- Test retry logic with transient failures
- Verify `VariantChannelListing` status updates
- Test with multiple variants and channels

---

## Phase 6: Competitor Price Tracking

### Objective
Fetch and store competitor prices to enable MATCH_LOW repricing strategy.

### New Models Required

```prisma
model CompetitorPrice {
  id        String   @id @default(cuid())
  variant   ProductVariation @relation(fields: [variantId], references: [id], onDelete: Cascade)
  variantId String
  
  // Competitor info
  competitor String // e.g., "AMAZON", "WALMART", "BEST_BUY"
  competitorUrl String?
  competitorPrice Decimal @db.Decimal(10, 2)
  
  // Tracking
  fetchedAt DateTime @default(now())
  expiresAt DateTime // Price validity window
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@unique([variantId, competitor])
  @@index([variantId])
  @@index([expiresAt])
}

model CompetitorPricingJob {
  id        String   @id @default(cuid())
  status    String   @default("PENDING") // PENDING, RUNNING, SUCCESS, FAILED
  variantsProcessed Int @default(0)
  pricesUpdated Int @default(0)
  startedAt DateTime?
  completedAt DateTime?
  error     String?
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

### Components to Create

#### 1. **CompetitorPricingService** (`apps/api/src/services/competitor-pricing.service.ts`)
- Fetch prices from multiple competitors (Amazon, Walmart, Best Buy, etc.)
- Parse HTML/API responses to extract prices
- Store prices in `CompetitorPrice` model
- Implement caching to avoid excessive API calls
- Handle rate limiting and retries

#### 2. **Competitor Price Sync Job** (`apps/api/src/jobs/competitor-pricing.job.ts`)
- Run every 6 hours (configurable)
- Fetch competitor prices for all active variants
- Update `CompetitorPrice` records
- Clean up expired prices
- Log results to `CompetitorPricingJob`

#### 3. **Competitor Pricing Routes** (`apps/api/src/routes/competitor-pricing.ts`)
- `GET /competitor-pricing/prices/:variantId` — Get competitor prices for a variant
- `POST /competitor-pricing/fetch` — Manually trigger competitor price fetch
- `GET /competitor-pricing/jobs` — List pricing jobs and their status

### Implementation Details

```typescript
// CompetitorPricingService
class CompetitorPricingService {
  async fetchCompetitorPrices(variantSku: string): Promise<CompetitorPrice[]> {
    const prices: CompetitorPrice[] = [];
    
    // Fetch from Amazon
    const amazonPrice = await this.fetchAmazonPrice(variantSku);
    if (amazonPrice) prices.push(amazonPrice);
    
    // Fetch from Walmart
    const walmartPrice = await this.fetchWalmartPrice(variantSku);
    if (walmartPrice) prices.push(walmartPrice);
    
    // Fetch from Best Buy
    const bestBuyPrice = await this.fetchBestBuyPrice(variantSku);
    if (bestBuyPrice) prices.push(bestBuyPrice);
    
    return prices;
  }
  
  private async fetchAmazonPrice(sku: string): Promise<CompetitorPrice | null> {
    // Use Amazon Product Advertising API or web scraping
    // Return { competitor: "AMAZON", competitorPrice: 129.99, expiresAt: ... }
  }
}
```

### Data Flow
```
Competitor Pricing Job (every 6 hours)
    ↓
For each active variant:
  - Fetch prices from Amazon, Walmart, Best Buy
  - Store in CompetitorPrice model
    ↓
Repricing Engine (MATCH_LOW strategy):
  - Query CompetitorPrice for variant
  - Use lowest price for repricing calculation
    ↓
Sync Job Phase 2:
  - Update variant prices based on repricing rules
  - Push to marketplaces
```

---

## Phase 7: Velocity-Based Allocation

### Objective
Implement inventory allocation based on historical sales velocity per channel.

### New Models Required

```prisma
model VariantSalesMetric {
  id        String   @id @default(cuid())
  variant   ProductVariation @relation(fields: [variantId], references: [id], onDelete: Cascade)
  variantId String
  channel   String // "AMAZON", "EBAY"
  
  // Sales velocity (units per day)
  salesLast7Days Int @default(0)
  salesLast30Days Int @default(0)
  salesLast90Days Int @default(0)
  
  // Calculated velocity
  velocityPerDay Decimal @db.Decimal(10, 3) // Average units/day
  
  // Turnover rate
  turnoverRate Decimal @db.Decimal(10, 3) // Percentage of inventory sold per day
  
  updatedAt DateTime @updatedAt
  
  @@unique([variantId, channel])
  @@index([variantId])
}
```

### Components to Create

#### 1. **SalesMetricsService** (`apps/api/src/services/sales-metrics.service.ts`)
- Calculate sales velocity from order history
- Compute turnover rates per variant per channel
- Identify fast-moving vs slow-moving variants
- Provide allocation recommendations

#### 2. **Sales Metrics Sync Job** (`apps/api/src/jobs/sales-metrics.job.ts`)
- Run daily
- Aggregate sales data from orders
- Calculate velocity metrics
- Update `VariantSalesMetric` records

#### 3. **Update Inventory Allocation** (`apps/api/src/routes/inventory.ts`)
- Extend `POST /inventory/allocate` to support `"velocity-based"` strategy
- Calculate allocation percentages based on sales velocity
- Fast-moving variants get higher allocation

### Implementation Details

```typescript
// SalesMetricsService
class SalesMetricsService {
  async calculateVelocity(variantId: string, channel: string): Promise<Decimal> {
    // Query OrderItem for this variant on this channel
    const last30Days = await prisma.orderItem.aggregate({
      where: {
        sku: variant.sku,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      },
      _sum: { quantity: true }
    });
    
    const unitsPerDay = (last30Days._sum.quantity ?? 0) / 30;
    return new Decimal(unitsPerDay);
  }
  
  async allocateByVelocity(
    productId: string,
    totalStock: number,
    channels: string[]
  ): Promise<Record<string, number>> {
    const metrics = await prisma.variantSalesMetric.findMany({
      where: { variant: { productId }, channel: { in: channels } }
    });
    
    // Calculate total velocity across all variants
    const totalVelocity = metrics.reduce((sum, m) => sum + m.velocityPerDay, 0);
    
    // Allocate proportionally
    const allocations: Record<string, number> = {};
    for (const channel of channels) {
      const channelVelocity = metrics
        .filter(m => m.channel === channel)
        .reduce((sum, m) => sum + m.velocityPerDay, 0);
      
      allocations[channel] = Math.floor((totalStock * channelVelocity) / totalVelocity);
    }
    
    return allocations;
  }
}
```

### Data Flow
```
Daily Sales Metrics Job
    ↓
For each variant per channel:
  - Count units sold in last 7/30/90 days
  - Calculate velocity (units/day)
  - Calculate turnover rate
    ↓
Inventory Allocation (velocity-based):
  - Query VariantSalesMetric
  - Allocate stock proportionally to velocity
  - Fast-moving variants get more stock
```

---

## Phase 8: Repricing Automation

### Objective
Schedule repricing rules to run automatically on a configurable schedule.

### New Models Required

```prisma
model RepricingSchedule {
  id        String   @id @default(cuid())
  rule      PricingRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  ruleId    String
  
  // Schedule
  enabled   Boolean @default(true)
  frequency String // "HOURLY", "DAILY", "WEEKLY", "MONTHLY"
  dayOfWeek Int? // 0-6 for weekly
  hour      Int? // 0-23
  minute    Int? @default(0)
  
  // Scope
  variantIds String[]? // If empty, apply to all variants
  
  // Execution tracking
  lastRunAt DateTime?
  nextRunAt DateTime?
  lastStatus String? // "SUCCESS", "FAILED"
  lastError String?
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model RepricingExecution {
  id        String   @id @default(cuid())
  schedule  RepricingSchedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)
  scheduleId String
  
  status    String // "PENDING", "RUNNING", "SUCCESS", "FAILED"
  variantsProcessed Int @default(0)
  variantsUpdated Int @default(0)
  
  startedAt DateTime?
  completedAt DateTime?
  error     String?
  
  createdAt DateTime @default(now())
}
```

### Components to Create

#### 1. **RepricingScheduler** (`apps/api/src/services/repricing-scheduler.service.ts`)
- Parse cron-like schedule expressions
- Calculate next run time
- Execute repricing rules on schedule
- Log execution results

#### 2. **Repricing Automation Job** (`apps/api/src/jobs/repricing-automation.job.ts`)
- Run every minute
- Check for due repricing schedules
- Execute repricing rules
- Update `RepricingSchedule.nextRunAt`
- Log to `RepricingExecution`

#### 3. **Repricing Schedule Routes** (`apps/api/src/routes/repricing-schedules.ts`)
- `GET /repricing/schedules` — List all schedules
- `POST /repricing/schedules` — Create a schedule
- `PUT /repricing/schedules/:scheduleId` — Update a schedule
- `DELETE /repricing/schedules/:scheduleId` — Delete a schedule
- `GET /repricing/executions` — List execution history

### Implementation Details

```typescript
// RepricingScheduler
class RepricingScheduler {
  calculateNextRun(schedule: RepricingSchedule): Date {
    const now = new Date();
    
    switch (schedule.frequency) {
      case "HOURLY":
        return new Date(now.getTime() + 60 * 60 * 1000);
      
      case "DAILY":
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(schedule.hour ?? 0, schedule.minute ?? 0, 0, 0);
        return tomorrow;
      
      case "WEEKLY":
        const nextWeek = new Date(now);
        const daysUntilTarget = ((schedule.dayOfWeek ?? 0) - nextWeek.getDay() + 7) % 7;
        nextWeek.setDate(nextWeek.getDate() + daysUntilTarget);
        nextWeek.setHours(schedule.hour ?? 0, schedule.minute ?? 0, 0, 0);
        return nextWeek;
      
      default:
        return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  
  async executeSchedule(schedule: RepricingSchedule): Promise<void> {
    const execution = await prisma.repricingExecution.create({
      data: {
        scheduleId: schedule.id,
        status: "RUNNING",
        startedAt: new Date(),
      }
    });
    
    try {
      const result = await repricingService.applyRule(
        schedule.ruleId,
        schedule.variantIds
      );
      
      await prisma.repricingExecution.update({
        where: { id: execution.id },
        data: {
          status: "SUCCESS",
          variantsProcessed: result.variantsProcessed,
          variantsUpdated: result.variantsUpdated,
          completedAt: new Date(),
        }
      });
      
      await prisma.repricingSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt: this.calculateNextRun(schedule),
          lastStatus: "SUCCESS",
        }
      });
    } catch (error) {
      await prisma.repricingExecution.update({
        where: { id: execution.id },
        data: {
          status: "FAILED",
          error: error.message,
          completedAt: new Date(),
        }
      });
      
      await prisma.repricingSchedule.update({
        where: { id: schedule.id },
        data: {
          lastStatus: "FAILED",
          lastError: error.message,
        }
      });
    }
  }
}
```

---

## Phase 9: Analytics & Reporting

### Objective
Add repricing impact analytics and reporting dashboard.

### New Models Required

```prisma
model RepricingImpact {
  id        String   @id @default(cuid())
  variant   ProductVariation @relation(fields: [variantId], references: [id], onDelete: Cascade)
  variantId String
  channel   String
  
  // Price change
  priceBeforeChange Decimal @db.Decimal(10, 2)
  priceAfterChange Decimal @db.Decimal(10, 2)
  priceChangePercent Decimal @db.Decimal(5, 2)
  
  // Margin impact
  costPrice Decimal? @db.Decimal(10, 2)
  marginBefore Decimal? @db.Decimal(10, 2)
  marginAfter Decimal? @db.Decimal(10, 2)
  
  // Sales impact (tracked over time)
  salesBefore Int @default(0) // Units sold in 7 days before
  salesAfter Int @default(0) // Units sold in 7 days after
  revenueImpact Decimal? @db.Decimal(10, 2)
  
  // Metadata
  repricingRule String? // Rule name that caused the change
  changeReason String? // Why the price changed
  
  changedAt DateTime @default(now())
  analyzedAt DateTime? // When impact was calculated
  
  @@index([variantId])
  @@index([channel])
  @@index([changedAt])
}
```

### Components to Create

#### 1. **RepricingAnalyticsService** (`apps/api/src/services/repricing-analytics.service.ts`)
- Calculate repricing impact (price change, margin impact, sales impact)
- Generate analytics reports
- Identify best/worst performing repricing rules
- Provide recommendations

#### 2. **Analytics Routes** (`apps/api/src/routes/analytics.ts`)
- `GET /analytics/repricing/summary` — Overall repricing impact
- `GET /analytics/repricing/by-rule` — Impact by repricing rule
- `GET /analytics/repricing/by-variant` — Impact by variant
- `GET /analytics/repricing/by-channel` — Impact by channel
- `GET /analytics/repricing/trends` — Trends over time

#### 3. **Analytics Dashboard** (`apps/web/src/app/analytics/repricing/page.tsx`)
- Charts showing price changes, margin impact, sales impact
- Tables with variant-level details
- Filters by rule, channel, date range
- Export functionality

### Implementation Details

```typescript
// RepricingAnalyticsService
class RepricingAnalyticsService {
  async calculateImpact(variantId: string, channel: string): Promise<RepricingImpact> {
    const variant = await prisma.productVariation.findUnique({
      where: { id: variantId },
      include: { channelListings: true }
    });
    
    const listing = variant.channelListings.find(cl => cl.channelId === channel);
    
    // Get sales before and after price change
    const salesBefore = await this.getSalesInPeriod(variantId, -14, -7);
    const salesAfter = await this.getSalesInPeriod(variantId, -7, 0);
    
    // Calculate margin impact
    const costPrice = variant.costPrice ? Number(variant.costPrice) : null;
    const marginBefore = costPrice ? Number(variant.price) - costPrice : null;
    const marginAfter = costPrice ? Number(listing.channelPrice) - costPrice : null;
    
    return {
      priceBeforeChange: Number(variant.price),
      priceAfterChange: Number(listing.channelPrice),
      priceChangePercent: ((Number(listing.channelPrice) - Number(variant.price)) / Number(variant.price)) * 100,
      marginBefore,
      marginAfter,
      salesBefore,
      salesAfter,
      revenueImpact: (Number(listing.channelPrice) - Number(variant.price)) * salesAfter,
    };
  }
  
  async getSummary(dateRange: { from: Date; to: Date }): Promise<{
    totalPriceChanges: number;
    avgPriceChange: number;
    totalRevenueImpact: number;
    bestPerformingRule: string;
    worstPerformingRule: string;
  }> {
    const impacts = await prisma.repricingImpact.findMany({
      where: {
        changedAt: { gte: dateRange.from, lte: dateRange.to }
      }
    });
    
    return {
      totalPriceChanges: impacts.length,
      avgPriceChange: impacts.reduce((sum, i) => sum + Number(i.priceChangePercent), 0) / impacts.length,
      totalRevenueImpact: impacts.reduce((sum, i) => sum + Number(i.revenueImpact ?? 0), 0),
      bestPerformingRule: this.findBestRule(impacts),
      worstPerformingRule: this.findWorstRule(impacts),
    };
  }
}
```

---

## Implementation Priority

### Critical Path (Week 1)
1. **Phase 5**: Marketplace API Integration (enables actual price updates)
2. **Phase 8**: Repricing Automation (enables scheduled repricing)

### High Priority (Week 2)
3. **Phase 6**: Competitor Price Tracking (enables MATCH_LOW strategy)
4. **Phase 7**: Velocity-Based Allocation (enables smart inventory allocation)

### Nice-to-Have (Week 3)
5. **Phase 9**: Analytics & Reporting (enables data-driven decisions)

---

## Testing Strategy

### Unit Tests
- RepricingService calculations
- CompetitorPricingService parsing
- SalesMetricsService velocity calculations
- RepricingScheduler cron logic

### Integration Tests
- Marketplace API calls (mocked)
- Database transactions
- Job execution and logging
- Schedule calculations

### End-to-End Tests
- Full repricing workflow (rule → calculation → update → marketplace)
- Competitor price fetch → repricing → marketplace update
- Velocity-based allocation → inventory distribution

---

## Deployment Considerations

### Database Migrations
- Add new models (CompetitorPrice, VariantSalesMetric, RepricingSchedule, etc.)
- Add indexes for performance
- Backfill historical data if needed

### Environment Variables
- Marketplace API credentials
- Competitor pricing API keys
- Job scheduling configuration
- Rate limiting settings

### Monitoring & Alerts
- Monitor repricing job success/failure rates
- Alert on marketplace API failures
- Track competitor price fetch failures
- Monitor repricing impact on margins

---

## Success Metrics

- ✅ Repricing rules execute automatically on schedule
- ✅ Prices update on marketplaces within 5 minutes of repricing
- ✅ Competitor prices tracked with <1 hour staleness
- ✅ Inventory allocated based on sales velocity
- ✅ Repricing impact visible in analytics dashboard
- ✅ Margin impact tracked and reported
- ✅ Zero data loss during repricing operations
