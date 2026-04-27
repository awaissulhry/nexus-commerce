# Amazon Sync Quick Start Guide

Get up and running with the Amazon Sync feature in 5 minutes.

## Prerequisites

- ✅ Nexus Commerce application running
- ✅ Products in your inventory
- ✅ Amazon Seller Central account
- ✅ Valid product ASINs

## Step 1: Navigate to Inventory

1. Open the application in your browser
2. Click **Inventory** in the sidebar
3. You'll see the Master Catalog page with all your products

## Step 2: Prepare Your Products

Ensure your products have:
- **SKU** - Unique identifier (required)
- **Name** - Product title (required)
- **ASIN** - Amazon Standard Identification Number (required)
- **Price** - Product price (optional)
- **Stock** - Available quantity (optional)

**Example Product:**
```
SKU: PROD-001
Name: Blue Widget
ASIN: B0123456789
Price: $29.99
Stock: 100 units
```

## Step 3: Trigger Sync

1. Look for the **"Sync to Amazon"** button in the toolbar
2. Click the button
3. A sync status modal will appear

## Step 4: Monitor Progress

The sync status modal shows:
- **Status** - Current sync state (Processing, Success, Failed)
- **Progress Bar** - Visual progress indicator
- **Statistics** - Items processed, successful, failed
- **Duration** - How long the sync has taken

**Status Meanings:**
- 🟢 **Success** - All items synced without errors
- 🟡 **Partial** - Some items synced, others failed
- 🔴 **Failed** - Sync operation failed

## Step 5: Review Results

When sync completes, you'll see:

### Success ✅
```
Status: Success
Items Processed: 50
Successful: 50
Failed: 0
Duration: 2.5s
```

**Action:** Close modal and continue working

### Partial ⚠️
```
Status: Partial
Items Processed: 50
Successful: 45
Failed: 5
Duration: 3.2s
```

**Action:** Click "Retry Failed Items" to retry the 5 failed items

### Failed ❌
```
Status: Failed
Items Processed: 0
Successful: 0
Failed: 50
Duration: 1.2s
```

**Action:** Check error messages and fix issues before retrying

## Common Scenarios

### Scenario 1: First Time Sync

**Goal:** Sync all products to Amazon

**Steps:**
1. Go to Inventory page
2. Click "Sync to Amazon"
3. Wait for completion
4. Review results

**Expected Time:** 2-5 seconds for 50 products

### Scenario 2: Sync with Variations

**Goal:** Sync parent products with child variations

**Product Structure:**
```
Parent: Blue Widget (ASIN: B0123456780)
├── Size S (ASIN: B0123456789, SKU: PROD-001-S)
├── Size M (ASIN: B0123456790, SKU: PROD-001-M)
└── Size L (ASIN: B0123456791, SKU: PROD-001-L)
```

**Steps:**
1. Ensure parent ASIN is set for child products
2. Click "Sync to Amazon"
3. System automatically creates parent-child relationships
4. Review results

**Expected Result:**
- 1 parent created
- 3 children created
- All linked correctly

### Scenario 3: Update Existing Products

**Goal:** Update prices and stock for existing products

**Steps:**
1. Update product prices/stock in inventory
2. Click "Sync to Amazon"
3. System updates existing products
4. Review results

**Expected Result:**
- 0 parents created
- 0 children created
- X parents updated
- Y children updated

### Scenario 4: Handle Sync Errors

**Goal:** Fix and retry failed syncs

**Steps:**
1. Review error messages in modal
2. Fix issues (e.g., missing ASIN, duplicate SKU)
3. Click "Retry Failed Items"
4. Monitor retry progress

**Common Errors:**
- "Missing ASIN" → Add ASIN to product
- "Duplicate SKU" → Change SKU to unique value
- "Invalid stock" → Ensure stock is >= 0

## Tips & Tricks

### 💡 Tip 1: Batch Syncing
- Sync 100-500 products at a time
- Larger batches may take longer
- Smaller batches are faster but require more syncs

### 💡 Tip 2: Off-Peak Syncing
- Sync during low-traffic hours
- Reduces server load
- Faster sync times

### 💡 Tip 3: Verify Before Syncing
- Check product data before sync
- Ensure all required fields are filled
- Verify ASINs are correct

### 💡 Tip 4: Monitor Regularly
- Check sync history periodically
- Review error patterns
- Fix recurring issues

### 💡 Tip 5: Use Retry Feature
- Don't re-sync entire batch if partial failure
- Use "Retry Failed Items" button
- Saves time and reduces server load

## Troubleshooting

### Problem: Sync Button Not Appearing

**Solution:**
1. Refresh the page (F5)
2. Check if you have products in inventory
3. Verify browser console for errors (F12)

### Problem: Sync Takes Too Long

**Solution:**
1. Check server status
2. Reduce batch size
3. Try again during off-peak hours
4. Check database performance

### Problem: Products Not Syncing

**Solution:**
1. Verify products have required fields (SKU, Name, ASIN)
2. Check for duplicate SKUs
3. Review error messages in modal
4. Check troubleshooting guide

### Problem: Parent-Child Not Linked

**Solution:**
1. Ensure parent ASIN is set for children
2. Sync parents first, then children
3. Verify ASIN format is correct
4. Check database relationships

## Next Steps

### After First Sync ✅

1. **Verify Results**
   - Check Amazon Seller Central
   - Confirm products are listed
   - Verify prices and stock

2. **Set Up Automation** (Future)
   - Schedule regular syncs
   - Set up webhooks
   - Enable auto-sync on inventory changes

3. **Monitor Performance**
   - Track sync success rate
   - Monitor sync duration
   - Review error patterns

### Learn More 📚

- [Full API Documentation](./AMAZON-SYNC-API.md)
- [Troubleshooting Guide](./AMAZON-SYNC-TROUBLESHOOTING.md)
- [Implementation Details](./AMAZON-SYNC-IMPLEMENTATION.md)

## FAQ

**Q: How often can I sync?**
A: As often as needed. No rate limits for manual syncs.

**Q: What happens to existing products?**
A: They are updated with new data. No products are deleted.

**Q: Can I sync specific products?**
A: Currently, all products are synced. Selective sync coming soon.

**Q: How long does a sync take?**
A: ~2-3 seconds for 100 products, ~30-45 seconds for 1000 products.

**Q: What if sync fails?**
A: Use the "Retry Failed Items" button or check troubleshooting guide.

**Q: Can I cancel a sync?**
A: Not currently. Syncs complete automatically.

**Q: Where can I see sync history?**
A: Sync Logs page (coming soon) or check API history endpoint.

**Q: What data is synced?**
A: SKU, Name, ASIN, Price, Stock, Fulfillment Channel, Shipping Template.

**Q: Are variations handled automatically?**
A: Yes, parent-child relationships are created automatically.

**Q: Can I sync to other marketplaces?**
A: Currently Amazon only. eBay, Shopify coming soon.

## Support

Need help? Check these resources:

1. **Quick Issues** → Check FAQ above
2. **Common Problems** → See Troubleshooting section
3. **Detailed Help** → Read [Troubleshooting Guide](./AMAZON-SYNC-TROUBLESHOOTING.md)
4. **API Questions** → See [API Documentation](./AMAZON-SYNC-API.md)
5. **Still Stuck?** → Contact support team

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Trigger sync (when on inventory page) |
| `Esc` | Close sync modal |
| `F5` | Refresh page |
| `F12` | Open developer console |

## Performance Tips

### For Best Performance:

1. **Sync Timing**
   - Avoid peak hours (9 AM - 5 PM)
   - Sync early morning or late evening
   - Batch syncs 30 minutes apart

2. **Batch Size**
   - Small: 50-100 products (fastest)
   - Medium: 200-500 products (balanced)
   - Large: 1000+ products (slowest)

3. **Network**
   - Use stable internet connection
   - Avoid VPN if possible
   - Close other bandwidth-heavy apps

4. **Server**
   - Monitor server resources
   - Ensure sufficient disk space
   - Check database performance

## Success Checklist

- [ ] Products have SKU, Name, ASIN
- [ ] Prices and stock are correct
- [ ] Parent-child relationships defined
- [ ] Sync button is visible
- [ ] First sync completed successfully
- [ ] Results verified in Amazon Seller Central
- [ ] Error handling understood
- [ ] Retry process tested

## You're Ready! 🚀

You now have everything you need to sync your products to Amazon. Start with a small batch to test, then scale up as needed.

**Happy syncing!**
