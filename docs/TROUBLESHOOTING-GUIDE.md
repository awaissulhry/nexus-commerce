# Troubleshooting Guide

**Version**: 1.0.0  
**Last Updated**: 2026-04-23

---

## Table of Contents

1. [Common Issues](#common-issues)
2. [Authentication Issues](#authentication-issues)
3. [Sync Issues](#sync-issues)
4. [Webhook Issues](#webhook-issues)
5. [Data Consistency Issues](#data-consistency-issues)
6. [Performance Issues](#performance-issues)
7. [Debugging Tools](#debugging-tools)
8. [Support Resources](#support-resources)

---

## Common Issues

### Issue: "Marketplace not available" error

**Symptoms**:
- Health check shows marketplace as unavailable
- API returns 502 Bad Gateway
- Sync jobs fail silently

**Diagnosis**:
```bash
# Check marketplace connectivity
curl -X GET http://localhost:3001/marketplaces/health

# Check environment variables
echo $SHOPIFY_SHOP_NAME
echo $WOOCOMMERCE_STORE_URL
echo $ETSY_SHOP_ID
```

**Solutions**:

1. **Verify environment variables**:
   ```bash
   # Ensure all required variables are set
   env | grep SHOPIFY
   env | grep WOOCOMMERCE
   env | grep ETSY
   ```

2. **Check API credentials**:
   - Shopify: Verify access token hasn't expired
   - WooCommerce: Verify consumer key/secret are correct
   - Etsy: Check if access token needs refresh

3. **Test marketplace connectivity**:
   ```bash
   # Shopify
   curl -X GET https://your-shop.myshopify.com/admin/api/2024-01/products.json \
     -H "X-Shopify-Access-Token: your-token"
   
   # WooCommerce
   curl -X GET https://your-store.com/wp-json/wc/v3/products \
     -u "consumer_key:consumer_secret"
   
   # Etsy
   curl -X GET https://openapi.etsy.com/v3/application/shops/your-shop-id \
     -H "Authorization: Bearer your-token" \
     -H "x-api-key: your-api-key"
   ```

4. **Check firewall/network**:
   - Ensure outbound HTTPS connections are allowed
   - Verify no proxy is blocking requests
   - Check DNS resolution

---

## Authentication Issues

### Issue: "Invalid access token" (Shopify)

**Symptoms**:
- 401 Unauthorized errors
- "Invalid API credentials" in logs
- Products fail to sync

**Solutions**:

1. **Regenerate access token**:
   - Go to Shopify Admin → Settings → Apps and integrations
   - Find your app and click it
   - Go to API credentials tab
   - Click "Reveal token" and copy the new token
   - Update `SHOPIFY_ACCESS_TOKEN` in environment

2. **Verify token permissions**:
   - Ensure all required scopes are enabled
   - Check if token has been revoked

3. **Check token expiration**:
   - Shopify tokens don't expire, but may be revoked
   - Regenerate if unsure

### Issue: "401 Unauthorized" (WooCommerce)

**Symptoms**:
- Basic auth failures
- "Invalid consumer key" errors
- Cannot fetch products

**Solutions**:

1. **Verify credentials format**:
   ```bash
   # Should be base64(consumer_key:consumer_secret)
   echo -n "consumer_key:consumer_secret" | base64
   ```

2. **Regenerate API key**:
   - Go to WooCommerce Settings → Advanced → REST API
   - Delete the old key
   - Create a new key with Read/Write permissions
   - Update environment variables

3. **Check API key status**:
   - Ensure the key is active (not revoked)
   - Verify the user account still exists

4. **Enable REST API**:
   - Go to WooCommerce Settings → Advanced → REST API
   - Ensure "Enable the REST API" is checked

### Issue: "Token expired" (Etsy)

**Symptoms**:
- 401 Unauthorized errors
- "Access token expired" in logs
- Listings fail to sync

**Solutions**:

1. **Implement automatic token refresh**:
   ```typescript
   async function refreshEtsyToken() {
     const response = await fetch('https://api.etsy.com/v3/oauth/token', {
       method: 'POST',
       headers: {
         'Content-Type': 'application/x-www-form-urlencoded',
       },
       body: new URLSearchParams({
         grant_type: 'refresh_token',
         client_id: process.env.ETSY_API_KEY!,
         client_secret: process.env.ETSY_API_SECRET!,
         refresh_token: process.env.ETSY_REFRESH_TOKEN!,
       }),
     });

     const data = await response.json();
     
     if (data.access_token) {
       process.env.ETSY_ACCESS_TOKEN = data.access_token;
       process.env.ETSY_REFRESH_TOKEN = data.refresh_token;
       
       // Update in database if storing tokens there
       await db.settings.update({
         where: { key: 'etsy_tokens' },
         data: { value: JSON.stringify(data) },
       });
     }
   }
   ```

2. **Manual token refresh**:
   - Go to Etsy Developer Portal
   - Revoke the current token
   - Re-authorize the application
   - Update `ETSY_ACCESS_TOKEN` and `ETSY_REFRESH_TOKEN`

3. **Check token expiration time**:
   - Etsy tokens expire after 3600 seconds
   - Implement refresh before expiration

---

## Sync Issues

### Issue: "Products not syncing"

**Symptoms**:
- Sync job runs but no products are updated
- Sync logs show 0 products processed
- Database shows no recent updates

**Diagnosis**:
```bash
# Check sync logs
curl -X GET http://localhost:3001/logs?type=sync

# Check database for sync records
SELECT * FROM "SyncLog" ORDER BY "createdAt" DESC LIMIT 10;

# Check for errors in application logs
tail -f logs/app.log | grep -i sync
```

**Solutions**:

1. **Verify products exist in marketplace**:
   ```bash
   # Shopify
   curl -X GET https://your-shop.myshopify.com/admin/api/2024-01/products.json \
     -H "X-Shopify-Access-Token: your-token"
   
   # WooCommerce
   curl -X GET https://your-store.com/wp-json/wc/v3/products \
     -u "consumer_key:consumer_secret"
   ```

2. **Check sync job configuration**:
   - Verify cron schedule is correct
   - Check if sync job is enabled
   - Review sync job logs

3. **Check database connectivity**:
   ```bash
   # Test database connection
   psql $DATABASE_URL -c "SELECT 1"
   ```

4. **Review sync service logs**:
   ```typescript
   // Add detailed logging to sync service
   console.log('Starting sync for channel:', channel);
   console.log('Products found:', products.length);
   console.log('Sync results:', results);
   ```

### Issue: "Inventory not updating"

**Symptoms**:
- Inventory changes in marketplace but not in database
- Sync shows success but quantities unchanged
- Webhook events not processed

**Solutions**:

1. **Verify inventory tracking is enabled**:
   - Shopify: Check if inventory management is enabled
   - WooCommerce: Verify stock tracking is enabled
   - Etsy: Check if inventory is being tracked

2. **Check webhook configuration**:
   - Verify inventory webhooks are created
   - Test webhook delivery
   - Check webhook logs

3. **Verify inventory field mapping**:
   ```typescript
   // Ensure correct field mapping
   const inventory = {
     shopify: 'inventory_quantity',
     woocommerce: 'stock_quantity',
     etsy: 'quantity',
   };
   ```

4. **Check for inventory conflicts**:
   - Multiple sources updating inventory simultaneously
   - Race conditions in concurrent updates
   - Implement locking mechanism

### Issue: "Price updates not propagating"

**Symptoms**:
- Price changes in one marketplace don't sync to others
- Sync shows success but prices unchanged
- Price history shows no updates

**Solutions**:

1. **Verify price field mapping**:
   ```typescript
   // Ensure correct field mapping
   const priceFields = {
     shopify: 'price',
     woocommerce: 'regular_price',
     etsy: 'price',
   };
   ```

2. **Check for price validation**:
   - Ensure prices are valid numbers
   - Check for currency conversion issues
   - Verify minimum/maximum price constraints

3. **Review price update logs**:
   ```bash
   # Check for price update errors
   tail -f logs/app.log | grep -i price
   ```

4. **Test price update manually**:
   ```bash
   curl -X POST http://localhost:3001/marketplaces/prices/update \
     -H "Content-Type: application/json" \
     -d '{
       "updates": [
         {
           "channel": "SHOPIFY",
           "channelVariantId": "gid://shopify/ProductVariant/123",
           "price": 29.99
         }
       ]
     }'
   ```

---

## Webhook Issues

### Issue: "Webhooks not being received"

**Symptoms**:
- Webhook endpoint not being called
- Marketplace shows webhook as inactive
- No webhook logs in database

**Diagnosis**:
```bash
# Check webhook configuration
curl -X GET https://your-shop.myshopify.com/admin/api/2024-01/webhooks.json \
  -H "X-Shopify-Access-Token: your-token"

# Check webhook delivery logs
SELECT * FROM "WebhookLog" ORDER BY "createdAt" DESC LIMIT 20;
```

**Solutions**:

1. **Verify webhook URL is publicly accessible**:
   ```bash
   # Test from external machine
   curl -X POST https://your-api.com/webhooks/shopify/products \
     -H "Content-Type: application/json" \
     -d '{"id": 123}'
   ```

2. **Check webhook secret configuration**:
   - Ensure webhook secret matches in environment
   - Verify signature verification is correct
   - Check for encoding issues

3. **Verify webhook is active**:
   - Shopify: Check webhook status in admin
   - WooCommerce: Verify webhook is active
   - Etsy: Check webhook registration

4. **Check firewall/network**:
   - Ensure inbound HTTPS is allowed
   - Verify no WAF is blocking requests
   - Check for IP whitelisting

5. **Test webhook manually**:
   ```bash
   # Generate valid signature
   PAYLOAD='{"id": 123}'
   SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "secret" -binary | base64)
   
   curl -X POST http://localhost:3001/webhooks/shopify/products \
     -H "Content-Type: application/json" \
     -H "X-Shopify-HMAC-SHA256: $SIGNATURE" \
     -d "$PAYLOAD"
   ```

### Issue: "Webhook signature verification failing"

**Symptoms**:
- 401 Unauthorized responses to webhooks
- "Invalid signature" errors in logs
- Webhooks not being processed

**Solutions**:

1. **Verify webhook secret is correct**:
   - Shopify: Copy from webhook configuration
   - WooCommerce: Copy from webhook settings
   - Etsy: Copy from webhook registration

2. **Check signature calculation**:
   ```typescript
   // Verify signature calculation is correct
   const crypto = require('crypto');
   
   function verifySignature(payload, signature, secret) {
     const hmac = crypto
       .createHmac('sha256', secret)
       .update(payload, 'utf8')
       .digest('base64');
     
     return hmac === signature;
   }
   ```

3. **Ensure raw request body is used**:
   - Don't parse JSON before verification
   - Use raw request body string
   - Preserve exact formatting

4. **Check for encoding issues**:
   - Verify UTF-8 encoding
   - Check for BOM characters
   - Ensure no whitespace modifications

---

## Data Consistency Issues

### Issue: "Duplicate products across channels"

**Symptoms**:
- Same product appears multiple times
- SKU conflicts between channels
- Inventory tracking issues

**Solutions**:

1. **Implement SKU-based deduplication**:
   ```typescript
   // Find products by SKU
   const existingProduct = await db.product.findUnique({
     where: { sku: product.sku },
   });
   
   if (existingProduct) {
     // Update existing product
     await db.product.update({
       where: { id: existingProduct.id },
       data: { /* ... */ },
     });
   } else {
     // Create new product
     await db.product.create({
       data: { /* ... */ },
     });
   }
   ```

2. **Implement channel-specific IDs**:
   ```typescript
   // Store channel-specific IDs
   const channelListing = await db.channelListing.upsert({
     where: {
       productId_channel: {
         productId: product.id,
         channel: 'SHOPIFY',
       },
     },
     update: { channelProductId: shopifyId },
     create: {
       productId: product.id,
       channel: 'SHOPIFY',
       channelProductId: shopifyId,
     },
   });
   ```

3. **Run deduplication script**:
   ```typescript
   // Find and merge duplicates
   const duplicates = await db.product.groupBy({
     by: ['sku'],
     having: {
       id: {
         _count: {
           gt: 1,
         },
       },
     },
   });
   
   for (const group of duplicates) {
     const products = await db.product.findMany({
       where: { sku: group.sku },
     });
     
     // Merge products
     const primary = products[0];
     for (const duplicate of products.slice(1)) {
       // Move channel listings to primary
       await db.channelListing.updateMany({
         where: { productId: duplicate.id },
         data: { productId: primary.id },
       });
       
       // Delete duplicate
       await db.product.delete({
         where: { id: duplicate.id },
       });
     }
   }
   ```

### Issue: "Data out of sync between channels"

**Symptoms**:
- Product information differs between channels
- Inventory quantities don't match
- Prices are inconsistent

**Solutions**:

1. **Implement data validation**:
   ```typescript
   // Validate data consistency
   async function validateDataConsistency(productId: string) {
     const product = await db.product.findUnique({
       where: { id: productId },
       include: { channelListings: true },
     });
     
     const issues: string[] = [];
     
     // Check inventory consistency
     const inventories = product.channelListings.map(cl => cl.inventory);
     if (new Set(inventories).size > 1) {
       issues.push('Inventory mismatch across channels');
     }
     
     // Check price consistency
     const prices = product.channelListings.map(cl => cl.price);
     if (new Set(prices).size > 1) {
       issues.push('Price mismatch across channels');
     }
     
     return issues;
   }
   ```

2. **Implement reconciliation job**:
   ```typescript
   // Run periodic reconciliation
   async function reconcileData() {
     const products = await db.product.findMany({
       include: { channelListings: true },
     });
     
     for (const product of products) {
       const issues = await validateDataConsistency(product.id);
       
       if (issues.length > 0) {
         // Log issues
         await db.dataIssue.create({
           data: {
             productId: product.id,
             issues: issues.join('; '),
             detectedAt: new Date(),
           },
         });
       }
     }
   }
   ```

3. **Implement conflict resolution**:
   - Define priority order (e.g., Shopify > WooCommerce > Etsy)
   - Use most recent update
   - Manual review for critical conflicts

---

## Performance Issues

### Issue: "Sync jobs running slowly"

**Symptoms**:
- Sync jobs take longer than expected
- High CPU/memory usage
- Database queries are slow

**Solutions**:

1. **Optimize database queries**:
   ```typescript
   // Use batch operations
   const products = await db.product.findMany({
     where: { channel: 'SHOPIFY' },
     select: { id: true, sku: true }, // Only select needed fields
   });
   
   // Batch update
   await db.product.updateMany({
     data: { lastSyncedAt: new Date() },
     where: { id: { in: products.map(p => p.id) } },
   });
   ```

2. **Implement pagination**:
   ```typescript
   // Process products in batches
   const pageSize = 100;
   let page = 0;
   
   while (true) {
     const products = await db.product.findMany({
       skip: page * pageSize,
       take: pageSize,
     });
     
     if (products.length === 0) break;
     
     await processProducts(products);
     page++;
   }
   ```

3. **Add database indexes**:
   ```sql
   -- Index frequently queried fields
   CREATE INDEX idx_product_sku ON "Product"(sku);
   CREATE INDEX idx_product_channel ON "Product"(channel);
   CREATE INDEX idx_channel_listing_product ON "ChannelListing"("productId");
   ```

4. **Monitor performance**:
   ```typescript
   // Add performance monitoring
   const startTime = Date.now();
   
   await syncProducts();
   
   const duration = Date.now() - startTime;
   console.log(`Sync completed in ${duration}ms`);
   
   // Alert if slow
   if (duration > 60000) {
     await alertSlowSync(duration);
   }
   ```

### Issue: "Rate limiting errors"

**Symptoms**:
- 429 Too Many Requests errors
- Sync jobs fail with rate limit exceeded
- Marketplace API returns throttling errors

**Solutions**:

1. **Implement rate limiting**:
   ```typescript
   // Use rate limiter
   const limiter = new RateLimiter({
     shopify: { requestsPerSecond: 2 },
     woocommerce: { requestsPerSecond: 10 },
     etsy: { requestsPerSecond: 10 },
   });
   
   await limiter.acquire('shopify');
   const response = await shopifyService.getProducts();
   ```

2. **Implement exponential backoff**:
   ```typescript
   // Retry with exponential backoff
   async function retryWithBackoff(fn, maxRetries = 3) {
     for (let attempt = 1; attempt <= maxRetries; attempt++) {
       try {
         return await fn();
       } catch (error) {
         if (error.status === 429 && attempt < maxRetries) {
           const delay = Math.pow(2, attempt) * 1000;
           await new Promise(resolve => setTimeout(resolve, delay));
         } else {
           throw error;
         }
       }
     }
   }
   ```

3. **Reduce request frequency**:
   - Increase sync interval
   - Use batch operations
   - Implement incremental sync

---

## Debugging Tools

### Enable Debug Logging

```typescript
// Add debug logging
import debug from 'debug';

const log = debug('nexus:marketplace');

log('Starting sync for channel:', channel);
log('Products found:', products.length);
log('Sync results:', results);
```

### Database Inspection

```bash
# Connect to database
psql $DATABASE_URL

# View recent sync logs
SELECT * FROM "SyncLog" ORDER BY "createdAt" DESC LIMIT 20;

# View webhook logs
SELECT * FROM "WebhookLog" ORDER BY "createdAt" DESC LIMIT 20;

# View products by channel
SELECT id, sku, title, channel FROM "Product" WHERE channel = 'SHOPIFY';

# View channel listings
SELECT * FROM "ChannelListing" WHERE channel = 'SHOPIFY';
```

### API Testing Tools

```bash
# Use curl for API testing
curl -X GET http://localhost:3001/marketplaces/health

# Use Postman for complex requests
# Import collection from docs/postman-collection.json

# Use httpie for readable output
http GET http://localhost:3001/marketplaces/health
```

---

## Support Resources

- **Documentation**: https://docs.nexus-commerce.com
- **API Reference**: See MARKETPLACE-API-DOCUMENTATION.md
- **Setup Guides**: See SETUP-GUIDES.md
- **Webhook Docs**: See WEBHOOK-DOCUMENTATION.md
- **GitHub Issues**: https://github.com/nexus-commerce/issues
- **Email Support**: support@nexus-commerce.com
- **Slack Community**: #marketplace-integrations

---

**Last Updated**: 2026-04-23  
**Version**: 1.0.0
