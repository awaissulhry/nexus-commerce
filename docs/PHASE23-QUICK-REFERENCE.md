# Phase 23.2: Safety Buffers & Low-Stock Alerts - Quick Reference

## 🎯 What Was Built

A protective inventory system that:
- **Reserves buffer stock** to prevent overselling across channels
- **Triggers alerts** when inventory falls below thresholds
- **Displays visual indicators** on the dashboard for low-stock items

## 📁 Key Files

| File | Purpose |
|------|---------|
| `packages/database/prisma/schema.prisma` | Database schema with new fields |
| `apps/api/src/services/inventory-sync.service.ts` | Stock sync with buffer protection |
| `apps/api/src/services/alert.service.ts` | Alert evaluation and tracking |
| `apps/web/src/components/dashboard/RealTimeStockMonitor.tsx` | Dashboard visual indicators |
| `docs/PHASE23-SAFETY-BUFFERS.md` | Full documentation |
| `scripts/test-phase23-buffers.ts` | Manual test script |

## 🔧 Quick Setup

### 1. Database Migration (Already Done)
```bash
npx prisma db push --schema=packages/database/prisma/schema.prisma
npx prisma generate --schema=packages/database/prisma/schema.prisma
```

### 2. Configure Product Threshold
```typescript
await prisma.product.update({
  where: { id: productId },
  data: { lowStockThreshold: 10 }  // Alert when stock <= 10
})
```

### 3. Configure Channel Buffer
```typescript
// For legacy Listing
await prisma.listing.update({
  where: { id: listingId },
  data: { stockBuffer: 5 }  // Reserve 5 units
})

// For modern ChannelListing
await prisma.channelListing.update({
  where: { id: channelListingId },
  data: { stockBuffer: 3 }  // Reserve 3 units
})
```

## 💡 How It Works

### Stock Sync Flow
```
syncGlobalStock(sku, 50)
  ↓
SSOT stores: 50 units
  ↓
For each channel:
  - Listing buffer: 5 → Marketplace sees: 45
  - ChannelListing buffer: 3 → Marketplace sees: 47
  ↓
Check threshold:
  - If 50 <= 10? No → No alert
  - If 50 < 5? No → No alert
  - If 50 == 0? No → No alert
```

### Alert Triggering
```
Stock Level → Alert Type → Severity
0 units    → OUT_OF_STOCK → CRITICAL 🚨
1-4 units  → CRITICAL_LOW_STOCK → CRITICAL 🚨
5-10 units → APPROACHING_THRESHOLD → WARNING ⚠️
11+ units  → (No alert) → OK ✅
```

## 📊 API Usage

### Sync Stock
```typescript
import { syncGlobalStock } from './services/inventory-sync.service'

const adjustment = await syncGlobalStock('PRODUCT-001', 50, 'RESTOCK')
// Returns: StockAdjustment with affected channels
```

### Check Stock Health
```typescript
import { evaluateStockHealth } from './services/alert.service'

const alert = await evaluateStockHealth(productId)
if (alert) {
  console.log(alert.message)  // "⚠️ WARNING: Product stock is low..."
}
```

### Get Alerts
```typescript
import { 
  getRecentAlerts, 
  getCriticalAlerts,
  getProductAlerts 
} from './services/alert.service'

const recent = getRecentAlerts(20)      // Last 20 alerts
const critical = getCriticalAlerts()    // Only critical
const product = getProductAlerts(id)    // For specific product
```

## 🎨 Dashboard Display

### Low-Stock Indicator
```
Row Background: Red (#fee2e2)
Border: Red (#fca5a5)
Badge: ⚠️ LOW STOCK (red background)
Info: (threshold: 10, buffer: 5)
```

### Normal Stock
```
Row Background: Gray (#f3f4f6)
Border: Gray (#d1d5db)
No badge
```

## 🧪 Testing

### Run Tests
```bash
npx tsx scripts/test-phase23-buffers.ts
```

### Test Scenarios
- ✅ Buffer protection
- ✅ Alert triggering
- ✅ Health evaluation
- ✅ Alert history
- ✅ Integration
- ✅ Edge cases

## 📈 Recommended Configuration

### By Product Type
| Type | Threshold | Buffer |
|------|-----------|--------|
| Fast-moving | 30-50 | 5-10 |
| Standard | 15-20 | 2-5 |
| Slow-moving | 5-10 | 0-2 |

### By Channel
| Channel | Buffer |
|---------|--------|
| Amazon (high velocity) | 5-10 |
| eBay (medium velocity) | 2-5 |
| Shopify (low velocity) | 0-2 |

## 🔍 Monitoring

### Check Alert Stats
```typescript
import { getAlertStats } from './services/alert.service'

const stats = getAlertStats()
// {
//   totalAlerts: 15,
//   criticalAlerts: 3,
//   warningAlerts: 12,
//   notifiedAlerts: 10,
//   unnotifiedAlerts: 5
// }
```

### View Recent Adjustments
```typescript
import { getRecentAdjustments } from './services/inventory-sync.service'

const adjustments = getRecentAdjustments(10)
// Shows last 10 stock changes with affected channels
```

## 🚨 Alert Severity Levels

| Level | Condition | Action |
|-------|-----------|--------|
| CRITICAL | Stock = 0 or < 5 | Immediate action needed |
| WARNING | Stock <= threshold | Monitor closely |
| INFO | Stock > threshold | Normal operation |

## 🔄 Integration Points

### Automatic
- `syncGlobalStock()` → automatically calls `checkStockThreshold()`
- Alerts triggered as part of sync process
- No additional code needed

### Manual
- Call `evaluateStockHealth()` for on-demand checks
- Call `checkAllProductStocks()` for batch checks
- Retrieve alerts with `getRecentAlerts()` or `getCriticalAlerts()`

## 📝 Logging

All operations logged with context:
```
[INVENTORY SYNC] Starting stock sync for SKU: PRODUCT-001
[INVENTORY SYNC] Updated SSOT: PRODUCT-001 from 50 to 45
[CRITICAL ALERT] Low Stock for SKU: PRODUCT-001
```

## 🐛 Troubleshooting

### Alerts Not Triggering
1. Check `product.lowStockThreshold` is set
2. Verify stock is actually at/below threshold
3. Check logs for errors

### Buffer Not Applied
1. Verify `stockBuffer` is set on listing
2. Check sync job is queued
3. Verify marketplace receives buffered quantity

### Performance Issues
1. Limit alert history (currently 100)
2. Archive old alerts to database
3. Batch process stock checks

## 🎓 Key Concepts

### SSOT (Single Source of Truth)
- Database always stores **actual** inventory
- Buffers are applied **only** when syncing to marketplaces
- Ensures accurate internal tracking

### Stock Buffer
- Units reserved that marketplaces cannot see
- Prevents overselling across channels
- Configurable per channel

### Low-Stock Threshold
- Product-specific alert trigger point
- Configurable per product
- Default: 10 units

### Alert Types
1. **OUT_OF_STOCK** - Stock = 0
2. **CRITICAL_LOW_STOCK** - Stock < 5
3. **APPROACHING_THRESHOLD** - Stock <= threshold

## 🔗 Related Documentation

- [Full Feature Documentation](./PHASE23-SAFETY-BUFFERS.md)
- [Completion Summary](./PHASE23-COMPLETION-SUMMARY.md)
- [Inventory Sync Architecture](./AMAZON-SYNC-ARCHITECTURE.md)
- [Monitoring Guide](./SYNC-MONITORING-GUIDE.md)

## 📞 Support

For issues or questions:
1. Check the full documentation: `docs/PHASE23-SAFETY-BUFFERS.md`
2. Review test scenarios: `scripts/test-phase23-buffers.ts`
3. Check logs for error context
4. Review troubleshooting section above

---

**Version**: 1.0  
**Status**: ✅ Production Ready  
**Last Updated**: 2026-04-27
