# Phase 23.2: Safety Buffers & Low-Stock Alerts

## Overview

Phase 23.2 implements protective intelligence for inventory synchronization, preventing overselling while alerting users to low-stock situations. The system uses stock buffers to reserve inventory and low-stock thresholds to trigger alerts.

## Features Implemented

### 1. Stock Buffer Protection

**Purpose**: Prevent overselling by reserving a portion of inventory that marketplaces cannot see.

**How It Works**:
- Each channel listing can have a `stockBuffer` value (default: 0)
- When syncing inventory, the final quantity sent to marketplace = `Math.max(0, actualStock - stockBuffer)`
- The SSOT (Single Source of Truth) database always stores the actual stock
- Marketplaces see reduced stock to account for pending orders, returns, etc.

**Example**:
```
Actual Stock: 50 units
Listing Buffer: 5 units
ChannelListing Buffer: 3 units

Marketplace sees:
- Listing: 50 - 5 = 45 units
- ChannelListing: 50 - 3 = 47 units
```

**Database Fields**:
- `Product.lowStockThreshold` (Int, default: 10) - Alert threshold
- `Listing.stockBuffer` (Int, default: 0) - Legacy channel buffer
- `ChannelListing.stockBuffer` (Int, default: 0) - Modern channel buffer

### 2. Low-Stock Alerts

**Purpose**: Notify users when inventory falls below critical levels.

**Alert Types**:
1. **OUT_OF_STOCK** (CRITICAL)
   - Triggered when: `stock === 0`
   - Message: "🚨 CRITICAL ALERT: Product is OUT OF STOCK!"

2. **CRITICAL_LOW_STOCK** (CRITICAL)
   - Triggered when: `stock < 5` (hardcoded critical threshold)
   - Message: "🚨 CRITICAL ALERT: Product has only X units left!"

3. **APPROACHING_THRESHOLD** (WARNING)
   - Triggered when: `stock <= lowStockThreshold`
   - Message: "⚠️ WARNING: Product stock is low (X units, threshold: Y)"

**Alert Tracking**:
- Recent alerts stored in memory (max 100)
- Alert history includes: SKU, product ID, current stock, threshold, severity, timestamp
- Alerts can be marked as "notified" for notification tracking

### 3. Stock Health Evaluation

**Function**: `evaluateStockHealth(productId: string)`

Comprehensive stock health check that:
- Fetches product with stock and threshold info
- Uses product's configured `lowStockThreshold`
- Returns alert if stock is at or below threshold
- Returns null if stock is healthy

**Usage**:
```typescript
const alert = await evaluateStockHealth(productId)
if (alert) {
  console.log(`Alert: ${alert.message}`)
}
```

### 4. Dashboard Integration

**Component**: `RealTimeStockMonitor.tsx`

Visual enhancements:
- **Low-Stock Highlighting**: Rows with stock <= threshold highlighted in red
- **Alert Badge**: "⚠️ LOW STOCK" badge displayed on affected rows
- **Threshold Display**: Shows threshold and buffer values in tooltip
- **Color Coding**: Red background for low-stock items, gray for normal

**Example Display**:
```
SKU: PRODUCT-001
Status: ⚠️ LOW STOCK
Stock: 8 → 5 units (-3)
(threshold: 10, buffer: 5)
```

## Implementation Details

### Inventory Sync Service

**File**: `apps/api/src/services/inventory-sync.service.ts`

Key function: `syncGlobalStock(sku, newQuantity, reason)`

Process:
1. Find product by SKU
2. Update SSOT database with actual quantity
3. Fetch all channel listings with their buffers
4. For each listing:
   - Calculate: `finalQuantity = Math.max(0, newQuantity - stockBuffer)`
   - Queue job with buffered quantity for marketplace
5. Call `checkStockThreshold()` to evaluate alerts
6. Return adjustment record with affected channels

**Buffer Calculation**:
```typescript
const stockBuffer = listing.stockBuffer || 0
const finalQuantity = Math.max(0, newQuantity - stockBuffer)
// Send finalQuantity to marketplace
// Keep newQuantity in SSOT
```

### Alert Service

**File**: `apps/api/src/services/alert.service.ts`

Key functions:
- `evaluateStockHealth(productId)` - Comprehensive health check
- `checkStockThreshold(sku, currentStock, customThreshold?)` - Threshold check
- `getRecentAlerts(limit)` - Retrieve recent alerts
- `getCriticalAlerts()` - Get critical-severity alerts only
- `getProductAlerts(productId)` - Get alerts for specific product
- `checkAllProductStocks(threshold?)` - Batch health check

**Alert Storage**:
- In-memory array (max 100 recent alerts)
- Includes: id, sku, productId, currentStock, threshold, alertType, severity, message, timestamp, notified

### Integration Points

1. **Sync Job Execution**:
   - `syncGlobalStock()` automatically calls `checkStockThreshold()`
   - Alerts are triggered as part of sync process

2. **Dashboard Display**:
   - `RealTimeStockMonitor` fetches recent adjustments
   - Displays low-stock visual indicators
   - Shows threshold and buffer information

3. **Notification System** (Future):
   - Email notifications
   - Slack webhooks
   - SMS alerts
   - Dashboard notifications

## Configuration

### Product-Level Settings

```typescript
// Set low-stock threshold for a product
await prisma.product.update({
  where: { id: productId },
  data: { lowStockThreshold: 15 }
})
```

### Channel-Level Settings

```typescript
// Set stock buffer for a listing
await prisma.listing.update({
  where: { id: listingId },
  data: { stockBuffer: 5 }
})

// Set stock buffer for channel listing
await prisma.channelListing.update({
  where: { id: channelListingId },
  data: { stockBuffer: 3 }
})
```

## Testing

### Manual Test Script

**File**: `scripts/test-phase23-buffers.ts`

Run tests:
```bash
npx tsx scripts/test-phase23-buffers.ts
```

Tests cover:
1. Stock buffer protection
2. Low-stock alert triggering
3. Stock health evaluation
4. Alert history tracking
5. Integration scenarios
6. Edge cases

### Test Scenarios

1. **Buffer Protection**:
   - Verify final quantity = actual - buffer
   - Handle zero stock after buffer deduction
   - Prevent negative stock

2. **Alert Triggering**:
   - Alert at threshold
   - Critical alert below 5 units
   - Out-of-stock alert at 0
   - No alert for healthy stock

3. **Health Evaluation**:
   - Use product-specific threshold
   - Return null for healthy stock
   - Handle non-existent products

4. **Integration**:
   - Buffer protects while alerts warn
   - Rapid stock changes handled correctly
   - Edge cases (buffer > stock, zero threshold)

## API Endpoints

### Get Recent Adjustments
```
GET /api/webhooks/recent-adjustments?limit=15
```

Returns recent stock adjustments with affected channels.

### Get Recent Alerts
```
GET /api/alerts/recent?limit=20
```

Returns recent stock alerts with severity levels.

### Get Critical Alerts
```
GET /api/alerts/critical
```

Returns only critical-severity alerts.

## Monitoring & Observability

### Logging

All operations logged with context:
```
[INVENTORY SYNC] Starting stock sync for SKU: PRODUCT-001
[CRITICAL ALERT] Low Stock for SKU: PRODUCT-001
[ALERT] Batch check complete: 5 alerts triggered
```

### Metrics

Track:
- Total adjustments per period
- Alert frequency by severity
- Buffer effectiveness (overselling prevented)
- Threshold accuracy

## Best Practices

1. **Set Appropriate Buffers**:
   - High-velocity channels: 5-10 units
   - Standard channels: 2-5 units
   - Low-velocity channels: 0-2 units

2. **Configure Thresholds**:
   - Fast-moving products: 20-50 units
   - Standard products: 10-20 units
   - Slow-moving products: 5-10 units

3. **Monitor Alerts**:
   - Review critical alerts daily
   - Investigate patterns
   - Adjust thresholds based on data

4. **Test Changes**:
   - Test buffer changes in staging
   - Verify marketplace sync behavior
   - Monitor for overselling

## Future Enhancements

1. **Notification Channels**:
   - Email alerts for critical stock
   - Slack integration for team notifications
   - SMS for urgent situations

2. **Advanced Analytics**:
   - Stock velocity analysis
   - Predictive low-stock warnings
   - Seasonal adjustment recommendations

3. **Automation**:
   - Auto-reorder triggers
   - Automatic price adjustments for low stock
   - Channel-specific visibility rules

4. **Reporting**:
   - Stock health dashboard
   - Alert trend analysis
   - Buffer effectiveness metrics

## Troubleshooting

### Alerts Not Triggering

1. Check product `lowStockThreshold` is set
2. Verify stock is actually at or below threshold
3. Check alert service is initialized
4. Review logs for errors

### Buffer Not Applied

1. Verify `stockBuffer` is set on listing
2. Check sync job is queued correctly
3. Verify marketplace receives buffered quantity
4. Review sync logs

### Performance Issues

1. Limit alert history size (currently 100)
2. Archive old alerts to database
3. Batch process stock checks
4. Use indexed queries for lookups

## Related Documentation

- [Inventory Sync Architecture](./AMAZON-SYNC-ARCHITECTURE.md)
- [BullMQ Integration](./PHASE13-BULLMQ-MIGRATION.md)
- [Monitoring Guide](./SYNC-MONITORING-GUIDE.md)
