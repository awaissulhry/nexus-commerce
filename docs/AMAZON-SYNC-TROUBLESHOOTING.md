# Amazon Sync Troubleshooting Guide

## Common Issues and Solutions

### 1. Sync Fails with "Product validation failed"

**Error Message:**
```json
{
  "success": false,
  "error": "Product validation failed",
  "validationErrors": [
    {
      "sku": "SKU-001",
      "errors": ["Missing ASIN", "Missing title"]
    }
  ]
}
```

**Causes:**
- Missing required fields (ASIN, SKU, or title)
- Invalid data format
- Empty products array

**Solutions:**
1. Verify all products have required fields:
   - `asin` - Must be a valid Amazon ASIN
   - `sku` - Must be unique and non-empty
   - `title` - Must be non-empty

2. Check data types:
   - `price` should be a number
   - `stock` should be an integer
   - `asin` and `sku` should be strings

3. Example of valid product:
```json
{
  "asin": "B0123456789",
  "title": "Product Name",
  "sku": "SKU-001",
  "price": 29.99,
  "stock": 100
}
```

---

### 2. Sync Returns "Partial" Status with Errors

**Symptoms:**
- Some products sync successfully, others fail
- Error count > 0 in response

**Common Causes:**
- Database constraints (duplicate SKU)
- Invalid parent-child relationships
- Stock quantity issues
- Price validation failures

**Solutions:**

**For Duplicate SKU Errors:**
```
Error: Unique constraint failed on sku
```
- Check if SKU already exists in database
- Use different SKU or update existing product
- Query: `SELECT * FROM "Product" WHERE sku = 'YOUR-SKU'`

**For Parent-Child Relationship Errors:**
```
Error: Parent product not found
```
- Ensure parent ASIN exists before syncing children
- Sync parent products first, then children
- Verify `parentAsin` matches an existing product's ASIN

**For Stock Issues:**
```
Error: Invalid stock quantity
```
- Stock must be >= 0
- Check for negative values
- Verify data type is integer

---

### 3. Sync Hangs or Times Out

**Symptoms:**
- Request takes > 30 seconds
- No response from server
- Connection timeout

**Causes:**
- Large batch size (> 1000 products)
- Database performance issues
- Network connectivity problems

**Solutions:**

1. **Reduce Batch Size:**
   - Send products in batches of 100-500
   - Implement pagination in your sync logic

2. **Check Database Performance:**
   ```sql
   -- Check for slow queries
   SELECT * FROM pg_stat_statements 
   WHERE mean_exec_time > 1000 
   ORDER BY mean_exec_time DESC;
   ```

3. **Monitor Server Resources:**
   - Check CPU usage: `top` or `htop`
   - Check memory: `free -h`
   - Check disk space: `df -h`

4. **Increase Timeout:**
   - Client-side: Increase fetch timeout to 60s
   - Server-side: Check Fastify configuration

---

### 4. "Sync with ID not found" Error

**Error Message:**
```json
{
  "success": false,
  "error": "Sync with ID sync-1713960000000-abc123def not found"
}
```

**Causes:**
- Sync ID is incorrect
- Sync record was deleted
- Sync ID expired (older than retention period)

**Solutions:**

1. **Verify Sync ID:**
   - Copy sync ID from initial response
   - Check for typos or truncation
   - Ensure full ID is used

2. **Check Sync History:**
   ```bash
   curl "http://localhost:3001/api/sync/amazon/catalog/history?limit=50"
   ```

3. **Retention Policy:**
   - Syncs are retained for 30 days
   - Older syncs are automatically archived
   - Export important sync data before expiration

---

### 5. Cannot Retry Successful Sync

**Error Message:**
```json
{
  "success": false,
  "error": "Cannot retry a successful sync"
}
```

**Explanation:**
- Retry is only available for failed or partial syncs
- Successful syncs don't need retrying

**Solutions:**
- If you need to re-sync, trigger a new sync instead
- Use the original product data to create a new sync request

---

### 6. Parent-Child Relationship Issues

**Symptoms:**
- Children created but not linked to parent
- Parent stock not calculated correctly
- Variation hierarchy broken

**Causes:**
- Parent ASIN not provided for children
- Parent product created after children
- Incorrect ASIN format

**Solutions:**

1. **Correct Sync Order:**
   ```
   Step 1: Sync parent products (without parentAsin)
   Step 2: Sync child products (with parentAsin)
   ```

2. **Verify Parent ASIN:**
   ```json
   {
     "asin": "B0123456789",
     "parentAsin": "B0123456780",  // Must match parent's ASIN
     "title": "Product Variant",
     "sku": "SKU-001-RED"
   }
   ```

3. **Check Database:**
   ```sql
   -- Find products with parent relationships
   SELECT p.sku, p.name, c.sku as child_sku, c.name as child_name
   FROM "Product" p
   LEFT JOIN "Product" c ON c."parentId" = p.id
   WHERE p."isParent" = true;
   ```

---

### 7. Fulfillment Channel Not Updating

**Symptoms:**
- FBA/FBM setting not applied
- Default FBA always used

**Causes:**
- `fulfillmentChannel` not provided in request
- Invalid fulfillment channel value

**Solutions:**

1. **Provide Fulfillment Channel:**
   ```json
   {
     "asin": "B0123456789",
     "title": "Product Name",
     "sku": "SKU-001",
     "fulfillmentChannel": "FBA"  // or "FBM"
   }
   ```

2. **Valid Values:**
   - `FBA` - Fulfillment by Amazon
   - `FBM` - Fulfillment by Merchant

3. **Default Behavior:**
   - If not provided, defaults to `FBA`

---

### 8. Shipping Template Not Applied

**Symptoms:**
- Shipping template field is null
- FBM products missing shipping info

**Causes:**
- `shippingTemplate` not provided
- Template name doesn't exist in Amazon

**Solutions:**

1. **Provide Shipping Template:**
   ```json
   {
     "asin": "B0123456789",
     "title": "Product Name",
     "sku": "SKU-001",
     "fulfillmentChannel": "FBM",
     "shippingTemplate": "Standard Shipping"
   }
   ```

2. **Verify Template Exists:**
   - Check Amazon Seller Central for available templates
   - Use exact template name from Amazon

3. **FBA Products:**
   - Shipping template is optional for FBA
   - Amazon handles shipping for FBA products

---

### 9. Database Connection Errors

**Error Message:**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Causes:**
- PostgreSQL not running
- Wrong database URL
- Network connectivity issue

**Solutions:**

1. **Check PostgreSQL Status:**
   ```bash
   # macOS
   brew services list | grep postgres
   
   # Linux
   sudo systemctl status postgresql
   ```

2. **Start PostgreSQL:**
   ```bash
   # macOS
   brew services start postgresql
   
   # Linux
   sudo systemctl start postgresql
   ```

3. **Verify Database URL:**
   ```bash
   # Check .env file
   cat apps/api/.env | grep DATABASE_URL
   ```

4. **Test Connection:**
   ```bash
   psql $DATABASE_URL -c "SELECT 1"
   ```

---

### 10. High Memory Usage During Sync

**Symptoms:**
- Server crashes during large syncs
- Out of memory errors
- Process killed

**Causes:**
- Too many products in single batch
- Memory leak in sync service
- Insufficient server memory

**Solutions:**

1. **Reduce Batch Size:**
   - Sync 100-200 products at a time
   - Implement queue-based processing

2. **Monitor Memory:**
   ```bash
   # Watch memory usage
   watch -n 1 'free -h'
   ```

3. **Increase Server Memory:**
   - Allocate more RAM to Node.js
   - Use `--max-old-space-size` flag:
   ```bash
   node --max-old-space-size=4096 server.js
   ```

4. **Enable Garbage Collection:**
   - Ensure Node.js GC is running
   - Monitor with: `node --expose-gc server.js`

---

## Performance Optimization

### Sync Performance Tips

1. **Batch Size Optimization:**
   - Small batches (50-100): Slower but more reliable
   - Medium batches (200-500): Balanced performance
   - Large batches (1000+): Faster but higher memory usage

2. **Parallel Processing:**
   - Don't sync multiple batches simultaneously
   - Queue syncs sequentially
   - Use worker threads for CPU-intensive operations

3. **Database Indexing:**
   ```sql
   -- Ensure indexes exist
   CREATE INDEX idx_product_sku ON "Product"(sku);
   CREATE INDEX idx_product_asin ON "Product"("amazonAsin");
   CREATE INDEX idx_product_parent ON "Product"("parentId");
   ```

4. **Connection Pooling:**
   - Use connection pool for database
   - Default pool size: 10 connections
   - Adjust based on load

---

## Monitoring and Logging

### Enable Debug Logging

```bash
# Set debug environment variable
DEBUG=nexus:* npm run dev
```

### Check Sync Logs

```bash
# View recent syncs
curl "http://localhost:3001/api/sync/amazon/catalog/history?limit=20"

# View specific sync
curl "http://localhost:3001/api/sync/amazon/catalog/sync-1713960000000-abc123def"
```

### Database Queries

```sql
-- Check sync status
SELECT * FROM "SyncLog" 
ORDER BY "startedAt" DESC 
LIMIT 10;

-- Check for errors
SELECT * FROM "SyncLog" 
WHERE status = 'FAILED' 
ORDER BY "startedAt" DESC;

-- Check product sync status
SELECT sku, name, "amazonSyncStatus", "lastAmazonSync"
FROM "Product"
WHERE "amazonSyncStatus" IS NOT NULL
ORDER BY "lastAmazonSync" DESC;
```

---

## Getting Help

If you encounter issues not covered here:

1. **Check Logs:**
   - Server logs: `apps/api/logs/`
   - Browser console: F12 → Console tab
   - Database logs: PostgreSQL logs

2. **Collect Debug Info:**
   - Sync ID
   - Product SKUs involved
   - Error messages
   - Server logs (last 100 lines)

3. **Contact Support:**
   - Include debug info above
   - Describe steps to reproduce
   - Provide expected vs actual behavior

---

## Quick Reference

| Issue | Solution |
|-------|----------|
| Validation failed | Check required fields (ASIN, SKU, title) |
| Partial sync | Check error details, retry failed items |
| Timeout | Reduce batch size, check server resources |
| Sync not found | Verify sync ID, check retention period |
| Parent-child broken | Sync parents first, then children |
| FBA/FBM not applied | Provide fulfillmentChannel in request |
| Database error | Check PostgreSQL connection |
| Memory issues | Reduce batch size, increase server RAM |
