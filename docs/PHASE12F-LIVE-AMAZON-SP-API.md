# Phase 12f: Live Amazon SP-API Connection

**Status**: ✅ Complete  
**Date**: April 26, 2026  
**Scope**: Replace sandbox logging with production HTTP client for Amazon Selling Partner API

## Overview

Phase 12f replaces the sandbox logging system with a production-ready Amazon SP-API client. The system now submits actual listing payloads to Amazon's production Listings Items v2021-08-01 endpoint with proper authentication, rate limiting, and error handling.

## Architecture

### Components

#### 1. **AmazonSpApiClient** (`apps/api/src/clients/amazon-sp-api.client.ts`)

Production HTTP client for Amazon SP-API with:

- **Login With Amazon (LWA) Authentication**
  - OAuth2 token endpoint: `https://api.amazon.com/auth/o2/token`
  - Token caching for 50 minutes to avoid auth spam
  - Automatic token refresh when expired

- **Rate Limiting**
  - 200ms delay between requests = 5 requests/second
  - Respects Amazon's rate limit policy
  - Applies before each request

- **Error Parsing**
  - SP-API returns 200/207 status even on errors
  - Errors buried in `issues` array
  - Formats errors as: `CODE: message (details)`

- **Batch Submission**
  - Submit multiple listings with rate limiting
  - Returns success/failure for each item

#### 2. **VariationSyncProcessor** (`apps/api/src/services/variation-sync-processor.service.ts`)

Processes LISTING_SYNC queue items for parent products:

- Validates product is a parent with variations
- Builds Amazon variation payload via `amazonMapperService`
- Submits each item (parent + children) to SP-API
- Handles errors with retry logic
- Marks sync as success/failed in queue

#### 3. **BullMQ Worker Integration** (`apps/api/src/workers/bullmq-sync.worker.ts`)

Routes sync jobs to appropriate processor:

```typescript
if (syncType === 'VARIATION_SYNC') {
  // Phase 12d: Variation Sync Engine
  syncResult = await variationSyncProcessor.processVariationSync(queueRecord)
} else {
  // Standard sync via OutboundSyncService
  syncResult = await OutboundSyncService.processPendingSyncs()
}
```

## Authentication Flow

### LWA Token Acquisition

```
1. Client sends refresh_token to https://api.amazon.com/auth/o2/token
2. Amazon returns access_token with expires_in (typically 3600 seconds)
3. Client caches token for 50 minutes (3000 seconds)
4. On expiry, automatically requests new token
```

**Environment Variables Required**:
```
AMAZON_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxxxxxxx
AMAZON_CLIENT_SECRET=xxxxxxxxxxxxx
AMAZON_REFRESH_TOKEN=Atzr|xxxxxxxxxxxxx
```

### SP-API Request

```
PATCH /listings/2021-08-01/items/{sellerId}/{sku}
Authorization: Bearer {accessToken}
Content-Type: application/json
x-amzn-requestid: nexus-{timestamp}

{
  "attributes": {
    "item_name": [{ "value": "Product Name" }],
    "item_type": [{ "value": "Variation Theme" }],
    "price": [{ "currency": "USD", "value": 29.99 }],
    "quantity": [{ "value": 100 }],
    "fulfillment_channel": [{ "value": "DEFAULT" }]
  }
}
```

## Error Handling

### SP-API Error Response Format

```json
{
  "sku": "PARENT-SKU",
  "issues": [
    {
      "code": "INVALID_ATTRIBUTE_VALUE",
      "message": "Invalid value for attribute",
      "details": "item_name must be between 1 and 200 characters"
    }
  ]
}
```

### Error Parsing

```typescript
private parseErrors(response: SPAPIResponse): string | null {
  if (!response.issues || response.issues.length === 0) {
    return null
  }

  const errorMessages = response.issues.map((issue) => {
    const code = issue.code || 'UNKNOWN'
    const message = issue.message || 'Unknown error'
    const details = issue.details ? ` (${issue.details})` : ''
    return `${code}: ${message}${details}`
  })

  return errorMessages.join(' | ')
}
```

### Retry Logic

- **Variation Sync Failures**: Marked as FAILED with error message
- **Transient Errors**: Retried with exponential backoff (5s, 10s, 20s, etc.)
- **Max Retries**: 3 attempts before permanent failure

## Data Flow

### Variation Sync Flow

```
1. BullMQ Worker receives LISTING_SYNC job
   ├─ Checks grace period (5 min undo window)
   ├─ Verifies listing is published (Phase 15)
   └─ Verifies offers are active (Phase 15)

2. VariationSyncProcessor.processVariationSync()
   ├─ Validates product is parent with variations
   ├─ Fetches channel listing with variation theme
   ├─ Builds variation payload via amazonMapperService
   │  ├─ Parent item with item_type = variation theme
   │  └─ Child items with variation attributes
   └─ Submits to SP-API

3. AmazonSpApiClient.submitListingPayload()
   ├─ Applies rate limiting (200ms delay)
   ├─ Gets/refreshes LWA token
   ├─ Submits PATCH request to SP-API
   ├─ Parses errors from issues array
   └─ Returns success/failure

4. Mark sync result
   ├─ Success: Update queue status to SUCCESS
   └─ Failure: Update queue status to FAILED with error message
```

## Configuration

### Environment Variables

```bash
# Amazon SP-API Credentials (Phase 12f)
AMAZON_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxxxxxxx
AMAZON_CLIENT_SECRET=xxxxxxxxxxxxx
AMAZON_REFRESH_TOKEN=Atzr|xxxxxxxxxxxxx
AMAZON_REGION=us-east-1
AMAZON_SELLER_ID=AXXXXXXXXXXXXX
```

### Rate Limiting

- **Request Delay**: 200ms (5 requests/second)
- **Token Cache**: 50 minutes
- **Concurrency**: 5 workers (BullMQ)

## Implementation Details

### Token Caching

```typescript
async getAccessToken(): Promise<string> {
  const now = Date.now()

  // Return cached token if still valid (50 minute cache)
  if (this.accessToken && now < this.tokenExpiresAt) {
    return this.accessToken
  }

  // Request new token from LWA
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    }).toString(),
  })

  const data = await response.json()
  this.accessToken = data.access_token
  this.tokenExpiresAt = now + 50 * 60 * 1000

  return this.accessToken
}
```

### Rate Limiting

```typescript
private async applyRateLimit(): Promise<void> {
  const now = Date.now()
  const timeSinceLastRequest = now - this.lastRequestTime

  if (timeSinceLastRequest < this.REQUEST_DELAY_MS) {
    const delayNeeded = this.REQUEST_DELAY_MS - timeSinceLastRequest
    await new Promise((resolve) => setTimeout(resolve, delayNeeded))
  }

  this.lastRequestTime = Date.now()
}
```

### Batch Submission

```typescript
async submitListingPayloadBatch(
  options: SubmitListingPayloadOptions[]
): Promise<Array<{ success: boolean; sku: string; error?: string }>> {
  const results = []

  for (const option of options) {
    const result = await this.submitListingPayload(option)
    results.push({
      success: result.success,
      sku: result.sku,
      error: result.error,
    })
  }

  return results
}
```

## Logging

### Log Levels

**INFO**: Token acquisition, submission start, completion
```
Requesting new LWA token
Submitting listing to Amazon SP-API
Listing submitted successfully to Amazon SP-API
✅ Variation sync completed successfully
```

**WARN**: Errors in issues array, partial failures
```
SP-API returned errors in issues array
Failed to submit item to Amazon SP-API
```

**ERROR**: Network failures, auth failures, critical errors
```
Failed to get LWA token
Failed to submit listing to Amazon SP-API
❌ Variation sync failed
```

**DEBUG**: Token caching, rate limiting, response details
```
Using cached LWA token
Rate limiting
SP-API response received
```

## Testing

### Manual Testing

1. **Verify credentials are configured**:
   ```bash
   echo $AMAZON_CLIENT_ID
   echo $AMAZON_CLIENT_SECRET
   echo $AMAZON_REFRESH_TOKEN
   ```

2. **Check API logs for token acquisition**:
   ```
   "Requesting new LWA token"
   "LWA token obtained successfully"
   ```

3. **Monitor sync submissions**:
   ```
   "Submitting listing to Amazon SP-API"
   "Listing submitted successfully to Amazon SP-API"
   ```

4. **Verify error handling**:
   - Invalid SKU → SP-API returns error in issues array
   - Missing attributes → Parsed and logged
   - Network failure → Caught and retried

### Integration Points

- **BullMQ Worker**: Routes VARIATION_SYNC jobs to processor
- **VariationSyncProcessor**: Builds payloads and submits
- **AmazonSpApiClient**: Handles HTTP communication
- **OutboundSyncQueue**: Tracks sync status and errors

## Monitoring

### Key Metrics

- **Token Cache Hit Rate**: Percentage of requests using cached token
- **Rate Limit Compliance**: All requests respect 200ms delay
- **Submission Success Rate**: Percentage of items submitted successfully
- **Error Categories**: INVALID_ATTRIBUTE_VALUE, INVALID_SKU, etc.

### Alerts

- **Auth Failures**: LWA token acquisition fails
- **Network Errors**: SP-API endpoint unreachable
- **Batch Failures**: Multiple items fail in single submission
- **Rate Limit Violations**: Requests sent too quickly

## Backward Compatibility

- **Phase 15 Integration**: Publishing controls still enforced
- **Grace Period**: 5-minute undo window still available
- **Retry Logic**: Exponential backoff for transient errors
- **Logging**: All submissions logged for audit trail

## Files Modified

1. **apps/api/src/clients/amazon-sp-api.client.ts** (NEW)
   - AmazonSpApiClient class
   - LWA authentication
   - Rate limiting
   - Error parsing

2. **apps/api/src/services/variation-sync-processor.service.ts** (UPDATED)
   - Import amazonSpApiClient
   - Submit payloads to SP-API instead of logging
   - Handle submission results

3. **apps/api/src/workers/bullmq-sync.worker.ts** (UPDATED)
   - Import variationSyncProcessor instance
   - Route VARIATION_SYNC jobs to processor

4. **apps/api/.env.example** (UPDATED)
   - Added AMAZON_CLIENT_ID
   - Added AMAZON_CLIENT_SECRET
   - Added AMAZON_REFRESH_TOKEN

## Next Steps

1. **Add Amazon credentials to .env**:
   ```bash
   AMAZON_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxxxxxxx
   AMAZON_CLIENT_SECRET=xxxxxxxxxxxxx
   AMAZON_REFRESH_TOKEN=Atzr|xxxxxxxxxxxxx
   ```

2. **Test with real Amazon account**:
   - Create test variation parent
   - Trigger sync via UI
   - Monitor logs for submission
   - Verify listing appears in Amazon Seller Central

3. **Monitor production submissions**:
   - Track token cache hit rate
   - Monitor error categories
   - Alert on auth failures

4. **Optimize payload building**:
   - Add more variation attributes
   - Implement attribute validation
   - Add payload size monitoring

## References

- [Amazon SP-API Documentation](https://developer.amazon.com/docs/selling-partner-api/sp-api-overview.html)
- [Listings Items API v2021-08-01](https://developer.amazon.com/docs/selling-partner-api/listings-items-api-v2021-08-01.html)
- [Login With Amazon](https://developer.amazon.com/docs/login-with-amazon/documentation-overview.html)
- [Phase 12d: Variation Sync Engine](./PHASE12D-VARIATION-SYNC-ENGINE.md)
- [Phase 15: Publishing Matrix](./PHASE15-PUBLISHING-MATRIX.md)
