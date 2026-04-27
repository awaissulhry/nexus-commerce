# Phase 12f: Quick Reference

## What Changed

**Before (Sandbox)**:
```typescript
logger.info('🎯 AMAZON SP-API VARIATION PAYLOAD (SANDBOX MODE)', {
  payload: variationPayload,
})
// Just logged, didn't submit
await outboundSyncServicePhase9.markSyncSuccess(queueItemId)
```

**After (Live)**:
```typescript
const sellerId = process.env.AMAZON_SELLER_ID
const submitResults = []

for (const item of variationPayload.items) {
  const result = await amazonSpApiClient.submitListingPayload({
    sellerId,
    sku: item.sku,
    payload: { attributes: { ... } },
  })
  submitResults.push(result)
}

if (!allSuccessful) {
  throw new Error(`Failed to submit ${failedCount} items to Amazon`)
}

await outboundSyncServicePhase9.markSyncSuccess(queueItemId)
```

## Key Components

### 1. AmazonSpApiClient
**File**: `apps/api/src/clients/amazon-sp-api.client.ts`

```typescript
// Get or refresh token (cached for 50 minutes)
const token = await amazonSpApiClient.getAccessToken()

// Submit single listing
const result = await amazonSpApiClient.submitListingPayload({
  sellerId: 'AXXXXXXXXXXXXX',
  sku: 'PARENT-SKU',
  payload: {
    attributes: {
      item_name: [{ value: 'Product Name' }],
      price: [{ currency: 'USD', value: 29.99 }],
      quantity: [{ value: 100 }],
    },
  },
})

// result = { success: true, sku: 'PARENT-SKU', status: 'ACCEPTED' }
// or { success: false, sku: 'PARENT-SKU', error: 'INVALID_ATTRIBUTE_VALUE: ...' }

// Submit batch
const results = await amazonSpApiClient.submitListingPayloadBatch([
  { sellerId, sku: 'SKU1', payload: {...} },
  { sellerId, sku: 'SKU2', payload: {...} },
])
```

### 2. VariationSyncProcessor
**File**: `apps/api/src/services/variation-sync-processor.service.ts`

```typescript
// Called by BullMQ worker for VARIATION_SYNC jobs
const success = await variationSyncProcessor.processVariationSync(queueItem)

// Returns: true if all items submitted successfully, false otherwise
// Marks queue item as SUCCESS or FAILED
```

### 3. BullMQ Worker Integration
**File**: `apps/api/src/workers/bullmq-sync.worker.ts`

```typescript
if (syncType === 'VARIATION_SYNC') {
  syncResult = await variationSyncProcessor.processVariationSync(queueRecord)
} else {
  syncResult = await OutboundSyncService.processPendingSyncs()
}
```

## Environment Variables

```bash
# Required for SP-API authentication
AMAZON_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxxxxxxx
AMAZON_CLIENT_SECRET=xxxxxxxxxxxxx
AMAZON_REFRESH_TOKEN=Atzr|xxxxxxxxxxxxx

# Already configured
AMAZON_REGION=us-east-1
AMAZON_SELLER_ID=AXXXXXXXXXXXXX
```

## How It Works

### 1. Token Acquisition
```
Request → https://api.amazon.com/auth/o2/token
         (with refresh_token, client_id, client_secret)
Response → { access_token, expires_in }
Cache    → 50 minutes
```

### 2. Rate Limiting
```
Before each request: Wait 200ms since last request
Result: 5 requests/second max
```

### 3. SP-API Submission
```
PATCH /listings/2021-08-01/items/{sellerId}/{sku}
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "attributes": {
    "item_name": [{ "value": "..." }],
    "price": [{ "currency": "USD", "value": 29.99 }],
    "quantity": [{ "value": 100 }],
    "fulfillment_channel": [{ "value": "DEFAULT" }]
  }
}
```

### 4. Error Handling
```
Response Status: 200 or 207 (even on errors!)
Check: response.issues array
Parse: CODE: message (details)
Example: INVALID_ATTRIBUTE_VALUE: Invalid value for attribute (item_name must be 1-200 chars)
```

## Logging

### Success Flow
```
INFO: Submitting listing to Amazon SP-API
      sku=PARENT-SKU, payloadSize=1234
INFO: Listing submitted successfully to Amazon SP-API
      sku=PARENT-SKU, status=ACCEPTED
INFO: ✅ Variation sync completed successfully
      itemsSubmitted=3, successCount=3
```

### Error Flow
```
WARN: SP-API returned errors in issues array
      sku=PARENT-SKU, errors=INVALID_ATTRIBUTE_VALUE: ...
ERROR: Failed to submit listing to Amazon SP-API
       sku=PARENT-SKU, error=Network timeout
ERROR: ❌ Variation sync failed
       productId=xxx, error=Failed to submit 1 items to Amazon
```

### Token Caching
```
DEBUG: Using cached LWA token
       expiresIn=2850 (seconds remaining)
INFO: Requesting new LWA token
INFO: LWA token obtained successfully
      expiresIn=3600, cacheUntil=2026-04-26T14:35:14.000Z
```

## Testing Checklist

- [ ] Credentials configured in .env
- [ ] API starts without auth errors
- [ ] Create variation parent product
- [ ] Create child products with variation attributes
- [ ] Create Amazon channel listing with variation theme
- [ ] Trigger sync from UI
- [ ] Check logs for "Submitting listing to Amazon SP-API"
- [ ] Verify listing appears in Amazon Seller Central
- [ ] Check sync status in UI (should show SUCCESS)

## Common Errors

### Missing Credentials
```
WARN: Amazon SP-API credentials not fully configured
      hasClientId=false, hasClientSecret=false, hasRefreshToken=true
```
**Fix**: Add AMAZON_CLIENT_ID and AMAZON_CLIENT_SECRET to .env

### Auth Failure
```
ERROR: Failed to get LWA token
       error=LWA auth failed: 401 - Invalid client credentials
```
**Fix**: Verify AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, AMAZON_REFRESH_TOKEN are correct

### Invalid Attribute
```
WARN: SP-API returned errors in issues array
      errors=INVALID_ATTRIBUTE_VALUE: Invalid value for attribute (item_name must be 1-200 chars)
```
**Fix**: Check payload building in amazonMapperService

### Network Error
```
ERROR: Failed to submit listing to Amazon SP-API
       error=fetch failed: ECONNREFUSED
```
**Fix**: Check internet connection, verify SP-API endpoint is accessible

## Performance

- **Token Cache**: 50 minutes (reduces auth calls by ~99%)
- **Rate Limiting**: 200ms delay (respects Amazon's 5 req/sec limit)
- **Batch Submission**: Submit multiple items with rate limiting
- **Concurrency**: 5 BullMQ workers (respects rate limits)

## Integration with Other Phases

- **Phase 12d**: Variation Sync Engine (builds payloads)
- **Phase 13**: BullMQ Worker (routes jobs)
- **Phase 15**: Publishing Matrix (enforces publishing controls)

## Files

| File | Purpose |
|------|---------|
| `apps/api/src/clients/amazon-sp-api.client.ts` | SP-API HTTP client |
| `apps/api/src/services/variation-sync-processor.service.ts` | Variation sync processor |
| `apps/api/src/workers/bullmq-sync.worker.ts` | BullMQ worker integration |
| `apps/api/.env.example` | Environment variable template |

## Next Steps

1. Add credentials to `.env`
2. Test with real Amazon account
3. Monitor submission logs
4. Verify listings in Seller Central
5. Set up alerts for auth failures
