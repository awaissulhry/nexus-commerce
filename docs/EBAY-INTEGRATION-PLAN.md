# Phase 3: eBay API Integration Plan

## Overview

Phase 3 focuses on integrating eBay as a second marketplace channel. This plan outlines the architecture for OAuth2 authentication, token management, inventory synchronization, and order management with eBay.

## 1. Database Schema Updates

### 1.1 ChannelConnection Model Enhancement

The existing `ChannelConnection` model needs eBay-specific fields:

```prisma
model ChannelConnection {
  id                    String    @id @default(cuid())
  
  // Channel Type
  channelType           String    // "AMAZON", "EBAY", "SHOPIFY", "WOOCOMMERCE", "ETSY"
  
  // eBay OAuth2 Credentials
  ebayAccessToken       String?   // Current access token
  ebayRefreshToken      String?   // Refresh token (long-lived)
  ebayTokenExpiresAt    DateTime? // Token expiration timestamp
  ebayDevId             String?   // eBay Developer ID (from app)
  ebayAppId             String?   // eBay App ID (from app)
  ebaySignInName        String?   // eBay seller username
  ebayStoreName         String?   // eBay store name
  ebayStoreFrontUrl     String?   // eBay store URL
  
  // Connection Status
  isActive              Boolean   @default(false)
  lastSyncAt            DateTime?
  lastSyncStatus        String?   // "SUCCESS", "FAILED", "PARTIAL"
  lastSyncError         String?
  
  // Metadata
  connectionMetadata    Json?     // Additional eBay-specific data
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  
  @@index([channelType])
  @@index([isActive])
}
```

### 1.2 VariantChannelListing Model Enhancement

Ensure the model supports eBay ItemID linking:

```prisma
model VariantChannelListing {
  id                    String    @id @default(cuid())
  
  // Product Reference
  productVariation      ProductVariation @relation(fields: [variationId], references: [id], onDelete: Cascade)
  variationId           String
  
  // Channel Reference
  channel               String    // "AMAZON", "EBAY", "SHOPIFY", etc.
  
  // External Listing IDs
  externalListingId     String?   // eBay ItemID (12-digit number)
  externalSku           String?   // eBay custom SKU
  
  // Listing Status
  listingStatus         String    // "ACTIVE", "ENDED", "UNSOLD", "SOLD"
  listingUrl            String?
  
  // Pricing & Inventory
  currentPrice          Decimal   @db.Decimal(10, 2)
  quantity              Int
  quantitySold          Int       @default(0)
  
  // Metadata
  channelMetadata       Json?     // Channel-specific data
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  
  @@unique([variationId, channel])
  @@index([externalListingId])
  @@index([channel])
}
```

## 2. eBay Auth Service Architecture

### 2.1 OAuth2 Flow Overview

**eBay uses OAuth2 with two flows:**

1. **User Consent Flow** (for seller authentication)
   - Redirect user to eBay login
   - User grants permission to access their account
   - eBay returns authorization code
   - Exchange code for access token + refresh token

2. **Client Credentials Flow** (for app-to-app communication)
   - Used for API calls that don't require user context
   - Direct token exchange using app credentials

### 2.2 Token Management Strategy

```typescript
// apps/api/src/services/ebay-auth.service.ts

interface EbayTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface EbayAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: 'SANDBOX' | 'PRODUCTION';
}

class EbayAuthService {
  // 1. Generate OAuth2 authorization URL
  generateAuthUrl(state: string): string
  
  // 2. Exchange authorization code for tokens
  exchangeCodeForToken(code: string): Promise<EbayTokenResponse>
  
  // 3. Refresh expired access token
  refreshAccessToken(refreshToken: string): Promise<EbayTokenResponse>
  
  // 4. Validate token expiration and auto-refresh
  ensureValidToken(connection: ChannelConnection): Promise<string>
  
  // 5. Revoke token on disconnect
  revokeToken(accessToken: string): Promise<void>
}
```

### 2.3 Token Refresh Mechanism

- **Automatic Refresh**: Check token expiration before each API call
- **Scheduled Refresh**: Background job to refresh tokens 1 hour before expiration
- **Error Handling**: Graceful degradation if refresh fails
- **Audit Trail**: Log all token operations for security

## 3. Connection UI & Callback Flow

### 3.1 Settings Page Structure

```
/settings/channels
├── Connected Channels (list)
│   ├── Amazon (connected)
│   ├── eBay (not connected)
│   └── Shopify (not connected)
└── Connect eBay Button
    └── Redirects to: /api/auth/ebay/authorize
```

### 3.2 OAuth2 Callback Flow

```
1. User clicks "Connect eBay"
   ↓
2. Redirect to /api/auth/ebay/authorize
   ↓
3. Generate state token (CSRF protection)
   ↓
4. Redirect to eBay login portal
   ↓
5. User logs in and grants permission
   ↓
6. eBay redirects to /api/auth/ebay/callback?code=XXX&state=YYY
   ↓
7. Validate state token
   ↓
8. Exchange code for access token
   ↓
9. Save tokens to ChannelConnection
   ↓
10. Redirect to /settings/channels?success=true
```

### 3.3 API Routes

```typescript
// apps/api/src/routes/ebay-auth.routes.ts

POST /api/auth/ebay/authorize
  - Generate state token
  - Redirect to eBay OAuth URL

GET /api/auth/ebay/callback
  - Validate state token
  - Exchange code for tokens
  - Save to database
  - Redirect to settings

POST /api/auth/ebay/disconnect
  - Revoke token
  - Delete ChannelConnection
  - Clean up listings

GET /api/auth/ebay/status
  - Check connection status
  - Return token expiration info
```

## 4. Initial Inventory Pull & Auto-Matching

### 4.1 eBay Inventory Sync Service

```typescript
// apps/api/src/services/ebay-inventory.service.ts

class EbayInventoryService {
  // 1. Fetch all active eBay listings
  async fetchAllListings(connection: ChannelConnection): Promise<EbayListing[]>
  
  // 2. Auto-match listings to products by SKU
  async autoMatchListings(listings: EbayListing[]): Promise<MatchResult[]>
  
  // 3. Create VariantChannelListing records
  async createChannelListings(matches: MatchResult[]): Promise<void>
  
  // 4. Sync inventory quantities
  async syncInventoryQuantities(connection: ChannelConnection): Promise<void>
  
  // 5. Update pricing from eBay
  async syncPricing(connection: ChannelConnection): Promise<void>
}
```

### 4.2 Auto-Matching Algorithm

**Priority Order:**
1. **Exact SKU Match**: ProductVariation.sku === eBay custom SKU
2. **UPC Match**: Product.upc === eBay UPC
3. **EAN Match**: Product.ean === eBay EAN
4. **Title Similarity**: Fuzzy match on product name (>85% confidence)
5. **Manual Review**: Unmatched listings flagged for user review

### 4.3 Matching Result Types

```typescript
interface MatchResult {
  ebayListing: EbayListing;
  matchedVariation?: ProductVariation;
  matchType: 'SKU' | 'UPC' | 'EAN' | 'TITLE' | 'MANUAL';
  confidence: number; // 0-100
  status: 'MATCHED' | 'PARTIAL' | 'UNMATCHED';
}
```

## 5. Data Synchronization Strategy

### 5.1 Inventory Sync

**Direction**: eBay → Database (read-only initially)

- Fetch active listings from eBay
- Update quantity in VariantChannelListing
- Alert if quantity differs from expected stock
- Track quantity sold

### 5.2 Order Sync

**Direction**: eBay → Database (read-only)

- Fetch completed orders from eBay
- Create Order records linked to VariantChannelListing
- Track buyer information
- Monitor fulfillment status

### 5.3 Pricing Sync

**Direction**: Database → eBay (write)

- Push price updates from our system to eBay
- Support bulk price updates
- Handle currency conversion
- Respect eBay pricing rules

## 6. Error Handling & Resilience

### 6.1 Token Expiration Handling

```
If token expired:
  1. Attempt refresh
  2. If refresh fails → Mark connection as inactive
  3. Notify user to reconnect
  4. Pause all eBay operations
```

### 6.2 API Rate Limiting

- eBay has strict rate limits (100 calls/hour for some endpoints)
- Implement exponential backoff
- Queue requests if rate limit approached
- Log rate limit violations

### 6.3 Data Validation

- Validate all eBay responses against schema
- Handle missing/null fields gracefully
- Log validation errors for debugging
- Fallback to cached data if API fails

## 7. Security Considerations

### 7.1 Token Storage

- Store tokens in database with encryption at rest
- Never log tokens
- Use environment variables for app credentials
- Implement token rotation

### 7.2 CSRF Protection

- Generate random state token for OAuth flow
- Validate state token in callback
- Use secure session management

### 7.3 API Key Management

- Store eBay App ID and Client Secret in environment variables
- Rotate credentials periodically
- Audit all API access

## 8. Implementation Phases

### Phase 3.1: Database & Auth (Week 1)
- [ ] Update ChannelConnection schema
- [ ] Update VariantChannelListing schema
- [ ] Create EbayAuthService
- [ ] Implement OAuth2 routes

### Phase 3.2: UI & Connection (Week 2)
- [ ] Create /settings/channels page
- [ ] Implement "Connect eBay" button
- [ ] Build callback handler
- [ ] Add connection status display

### Phase 3.3: Inventory Sync (Week 3)
- [ ] Create EbayInventoryService
- [ ] Implement listing fetch
- [ ] Build auto-matching algorithm
- [ ] Create VariantChannelListing records

### Phase 3.4: Order Sync (Week 4)
- [ ] Create EbayOrderService
- [ ] Implement order fetch
- [ ] Link orders to products
- [ ] Build order management UI

## 9. Testing Strategy

### 9.1 Unit Tests
- Token refresh logic
- Auto-matching algorithm
- Data validation

### 9.2 Integration Tests
- OAuth2 flow (sandbox)
- Listing fetch and matching
- Order sync

### 9.3 End-to-End Tests
- Full connection flow
- Inventory sync
- Order management

## 10. Monitoring & Logging

### 10.1 Key Metrics
- Token refresh success rate
- API call latency
- Listing match rate
- Order sync success rate

### 10.2 Logging
- All OAuth2 events
- API errors and retries
- Matching results
- Sync status updates

## 11. eBay API Endpoints Used

### Authentication
- `POST https://api.ebay.com/identity/v1/oauth2/token` - Get/refresh tokens

### Inventory
- `GET https://api.ebay.com/sell/inventory/v1/inventory_item` - Get listings
- `GET https://api.ebay.com/sell/inventory/v1/inventory_item/{sku}` - Get specific listing

### Orders
- `GET https://api.ebay.com/sell/fulfillment/v1/order` - Get orders
- `GET https://api.ebay.com/sell/fulfillment/v1/order/{orderId}` - Get order details

### Pricing
- `POST https://api.ebay.com/sell/inventory/v1/inventory_item/{sku}/offer` - Update pricing

## 12. Environment Variables Required

```
EBAY_CLIENT_ID=your_app_id
EBAY_CLIENT_SECRET=your_client_secret
EBAY_REDIRECT_URI=http://localhost:3000/api/auth/ebay/callback
EBAY_ENVIRONMENT=SANDBOX (or PRODUCTION)
EBAY_ENCRYPTION_KEY=for_token_encryption
```

## 13. Success Criteria

- ✅ Users can connect eBay account via OAuth2
- ✅ Tokens are securely stored and auto-refreshed
- ✅ Listings are fetched and auto-matched to products
- ✅ Inventory quantities sync from eBay
- ✅ Orders are fetched and linked to products
- ✅ Connection status is visible in settings
- ✅ All operations are logged and monitored
- ✅ Error handling is graceful and user-friendly

---

**Next Steps**: Proceed with Phase 3.1 implementation (Database & Auth)
