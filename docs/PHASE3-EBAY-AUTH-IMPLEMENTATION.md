# Phase 3.2: eBay Auth Service & Routes Implementation

**Status:** ✅ COMPLETED
**Date:** April 24, 2026
**Duration:** Phase 3.1 + 3.2 Combined Implementation

## Overview

Phase 3.2 implements the complete eBay OAuth2 authentication system, including:
- Backend authentication service with token management
- API routes for OAuth2 flow
- Frontend UI for marketplace connections
- Callback handling and token storage

## Architecture

### Backend Components

#### 1. eBay Auth Service (`apps/api/src/services/ebay-auth.service.ts`)

**Purpose:** Manages OAuth2 authentication and token lifecycle for eBay seller accounts

**Key Methods:**

- **`generateAuthorizationUrl(state, redirectUri)`**
  - Generates eBay OAuth2 authorization URL
  - Includes required scopes for seller operations
  - Returns URL for user consent flow

- **`exchangeCodeForToken(code, redirectUri)`**
  - Exchanges authorization code for access token
  - Called after user grants permission
  - Returns access token, refresh token, and expiration

- **`refreshAccessToken(refreshToken)`**
  - Refreshes expired access tokens
  - Uses long-lived refresh token
  - Returns new access token with updated expiration

- **`getValidToken(connectionId)`**
  - Main method for API calls
  - Automatically refreshes if token expired or expiring soon (5-minute buffer)
  - Updates database with new token
  - Handles error cases gracefully

- **`saveTokens(connectionId, accessToken, refreshToken, expiresIn, sellerInfo)`**
  - Persists tokens to ChannelConnection model
  - Stores seller information (username, store name, URL)
  - Sets connection as active

- **`revokeTokens(connectionId)`**
  - Calls eBay revocation endpoint
  - Clears tokens from database
  - Deactivates connection

- **`getSellerInfo(accessToken)`**
  - Fetches seller account information from eBay API
  - Returns username, store name, and store URL
  - Used during OAuth callback

**Token Management:**

```
OAuth2 Flow:
1. User clicks "Connect eBay"
2. Frontend calls POST /api/ebay/auth/initiate
3. Service generates authorization URL with state token
4. User redirected to eBay for consent
5. eBay redirects to callback with authorization code
6. Frontend calls POST /api/ebay/auth/callback
7. Service exchanges code for tokens
8. Tokens saved to ChannelConnection model
9. Connection marked as active

Token Refresh:
- Automatic: When getValidToken() detects expiration
- Manual: POST /api/ebay/auth/refresh endpoint
- Refresh tokens are long-lived (typically 18 months)
- Access tokens expire in ~2 hours
```

#### 2. eBay Auth Routes (`apps/api/src/routes/ebay-auth.ts`)

**Purpose:** Fastify route handlers for OAuth2 flow and token management

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/ebay/auth/create-connection` | Create new ChannelConnection record |
| POST | `/api/ebay/auth/initiate` | Generate authorization URL |
| POST | `/api/ebay/auth/callback` | Handle OAuth callback and exchange code |
| GET | `/api/ebay/auth/connection/:connectionId` | Get connection status |
| POST | `/api/ebay/auth/revoke` | Revoke connection and clear tokens |
| POST | `/api/ebay/auth/refresh` | Manually refresh access token |
| GET | `/api/ebay/auth/test` | Test API connectivity |

**Request/Response Examples:**

```bash
# 1. Create Connection
POST /api/ebay/auth/create-connection
{
  "channelType": "EBAY"
}
Response: { "success": true, "connectionId": "cuid..." }

# 2. Initiate OAuth
POST /api/ebay/auth/initiate
{
  "redirectUri": "http://localhost:3000/settings/channels/ebay-callback"
}
Response: {
  "success": true,
  "authUrl": "https://auth.ebay.com/oauth/authorize?...",
  "state": "random_state_token",
  "expiresIn": 600
}

# 3. Handle Callback
POST /api/ebay/auth/callback
{
  "code": "auth_code_from_ebay",
  "state": "state_token",
  "connectionId": "cuid...",
  "redirectUri": "http://localhost:3000/settings/channels/ebay-callback"
}
Response: {
  "success": true,
  "connection": {
    "id": "cuid...",
    "channelType": "EBAY",
    "isActive": true,
    "sellerName": "seller_username"
  }
}

# 4. Get Connection Status
GET /api/ebay/auth/connection/cuid...
Response: {
  "success": true,
  "connection": {
    "id": "cuid...",
    "isActive": true,
    "sellerName": "seller_username",
    "tokenExpiresAt": "2026-04-24T23:00:00Z",
    "lastSyncAt": "2026-04-24T22:00:00Z"
  }
}

# 5. Test Connection
GET /api/ebay/auth/test?connectionId=cuid...
Response: {
  "success": true,
  "seller": {
    "signInName": "seller_username",
    "storeName": "My eBay Store",
    "storeFrontUrl": "https://stores.ebay.com/..."
  }
}
```

### Frontend Components

#### 1. Channels Settings Page (`apps/web/src/app/settings/channels/page.tsx`)

Server component that renders the marketplace channels management interface.

#### 2. Channels Client Component (`apps/web/src/app/settings/channels/ChannelsClient.tsx`)

**Features:**

- **Channel Cards Grid**
  - Displays 5 marketplace platforms (eBay, Amazon, Shopify, WooCommerce, Etsy)
  - Color-coded by platform
  - Shows connection status with visual indicator

- **Connection Management**
  - Connect button for disconnected channels
  - Test button to verify connectivity
  - Disconnect button to revoke access
  - Displays seller info, store name, token expiration

- **OAuth Flow Integration**
  - Calls `/api/ebay/auth/initiate` to get authorization URL
  - Stores state token in sessionStorage
  - Redirects to eBay authorization page
  - Handles callback response

- **Error Handling**
  - Displays error messages in alert box
  - Gracefully handles network failures
  - Validates state token on callback

#### 3. eBay Callback Handler (`apps/web/src/app/settings/channels/ebay-callback/page.tsx`)

**Purpose:** Handles OAuth2 callback from eBay

**Flow:**

1. Receives authorization code and state from eBay
2. Validates state token against stored value (CSRF protection)
3. Creates ChannelConnection via `/api/ebay/auth/create-connection`
4. Exchanges code for tokens via `/api/ebay/auth/callback`
5. Displays success/error message
6. Redirects to channels page after 2 seconds

**UI States:**

- **Loading:** Shows spinner while processing
- **Success:** Shows checkmark with seller info
- **Error:** Shows error message with back button

## Database Schema

### ChannelConnection Model

```prisma
model ChannelConnection {
  id                    String    @id @default(cuid())
  
  // Channel Type
  channelType           String    // "AMAZON", "EBAY", "SHOPIFY", "WOOCOMMERCE", "ETSY"
  
  // eBay OAuth2 Credentials
  ebayAccessToken       String?   // Current access token
  ebayRefreshToken      String?   // Refresh token (long-lived)
  ebayTokenExpiresAt    DateTime? // Token expiration timestamp
  ebayDevId             String?   // eBay Developer ID
  ebayAppId             String?   // eBay App ID
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
  
  // Relations
  variantListings       VariantChannelListing[]
  
  @@index([channelType])
  @@index([isActive])
}
```

## Security Considerations

### OAuth2 Security

1. **State Token Validation**
   - Generated as random 32-byte hex string
   - Stored in sessionStorage on client
   - Validated on callback to prevent CSRF attacks
   - Expires after 10 minutes

2. **Token Storage**
   - Access tokens stored in database (encrypted in production)
   - Refresh tokens stored securely
   - Tokens never exposed in API responses (partial tokens only)
   - Automatic refresh prevents token expiration

3. **HTTPS Requirement**
   - All OAuth2 flows must use HTTPS in production
   - Redirect URIs must be HTTPS
   - eBay API calls use HTTPS

4. **Scope Limitation**
   - Only request necessary scopes:
     - `https://api.ebay.com/oauth/api_scope` (basic)
     - `https://api.ebay.com/oauth/api_scope/sell.account` (account info)
     - `https://api.ebay.com/oauth/api_scope/sell.inventory` (inventory)
     - `https://api.ebay.com/oauth/api_scope/sell.fulfillment` (orders)

## Environment Variables

Required in `.env`:

```bash
# eBay OAuth2 Credentials
EBAY_CLIENT_ID=your_client_id
EBAY_CLIENT_SECRET=your_client_secret
EBAY_ENVIRONMENT=PRODUCTION  # or SANDBOX for testing
```

## Testing

### Manual Testing Steps

1. **Connect eBay Account**
   - Navigate to Settings > Marketplace Channels
   - Click "Connect" on eBay card
   - Authorize on eBay website
   - Verify connection shows seller info

2. **Test Connection**
   - Click "Test" button on connected eBay card
   - Should display seller information

3. **Disconnect**
   - Click "Disconnect" button
   - Confirm revocation
   - Connection should be removed

4. **Token Refresh**
   - Wait for token to expire (or manually trigger)
   - Next API call should automatically refresh
   - New token should be saved to database

### API Testing

```bash
# Create connection
curl -X POST http://localhost:3001/api/ebay/auth/create-connection \
  -H "Content-Type: application/json" \
  -d '{"channelType":"EBAY"}'

# Initiate OAuth
curl -X POST http://localhost:3001/api/ebay/auth/initiate \
  -H "Content-Type: application/json" \
  -d '{"redirectUri":"http://localhost:3000/settings/channels/ebay-callback"}'

# Test connection
curl "http://localhost:3001/api/ebay/auth/test?connectionId=YOUR_CONNECTION_ID"
```

## Files Created/Modified

### New Files

- `apps/api/src/services/ebay-auth.service.ts` - OAuth2 service
- `apps/api/src/routes/ebay-auth.ts` - API routes
- `apps/web/src/app/settings/channels/page.tsx` - Settings page
- `apps/web/src/app/settings/channels/ChannelsClient.tsx` - Client component
- `apps/web/src/app/settings/channels/ebay-callback/page.tsx` - Callback handler

### Modified Files

- `apps/api/src/index.ts` - Registered ebayAuthRoutes
- `packages/database/prisma/schema.prisma` - Added ChannelConnection model

## Next Steps (Phase 3.3)

1. **Initial Inventory Pull**
   - Fetch existing eBay listings
   - Implement auto-matching algorithm
   - Create VariantChannelListing records

2. **Listing Management**
   - Create new listings on eBay
   - Update existing listings
   - Sync inventory levels

3. **Order Sync**
   - Fetch eBay orders
   - Map to internal Order model
   - Sync fulfillment status

## Completion Checklist

- [x] Database schema with ChannelConnection model
- [x] eBay Auth Service with OAuth2 logic
- [x] Token management with auto-refresh
- [x] API routes for OAuth flow
- [x] Frontend UI for channel management
- [x] OAuth callback handler
- [x] Connection status display
- [x] Token revocation
- [x] Error handling and logging
- [x] Security considerations (CSRF, token storage)
- [x] Documentation

## Summary

Phase 3.2 successfully implements a complete, production-ready eBay OAuth2 authentication system. The implementation includes:

- **Secure OAuth2 flow** with state token validation
- **Automatic token refresh** with 5-minute expiration buffer
- **User-friendly UI** for managing marketplace connections
- **Comprehensive error handling** and logging
- **Database persistence** of tokens and connection metadata
- **API endpoints** for all authentication operations

The system is ready for Phase 3.3 (Initial Inventory Pull) and subsequent marketplace integration phases.
