# Marketplace Setup Guides

**Version**: 1.0.0  
**Last Updated**: 2026-04-23

---

## Table of Contents

1. [Shopify Setup Guide](#shopify-setup-guide)
2. [WooCommerce Setup Guide](#woocommerce-setup-guide)
3. [Etsy Setup Guide](#etsy-setup-guide)
4. [Environment Configuration](#environment-configuration)
5. [Verification Checklist](#verification-checklist)

---

## Shopify Setup Guide

### Prerequisites

- Shopify store account
- Admin access to your Shopify store
- Ability to create custom apps

### Step 1: Create a Custom App

1. Log in to your Shopify Admin Dashboard
2. Navigate to **Settings** → **Apps and integrations**
3. Click **Develop apps** (or **Create an app** if you haven't created one before)
4. Click **Create an app**
5. Enter app name: `Nexus Commerce Integration`
6. Choose your app type: **Custom app**
7. Click **Create app**

### Step 2: Configure Admin API Scopes

1. In your app settings, go to the **Configuration** tab
2. Under **Admin API access scopes**, select the following scopes:

**Required Scopes**:
```
write_products
read_products
write_inventory
read_inventory
write_orders
read_orders
write_fulfillments
read_fulfillments
write_locations
read_locations
```

**Optional Scopes** (for enhanced features):
```
write_price_rules
read_price_rules
write_discounts
read_discounts
```

3. Click **Save**

### Step 3: Generate Access Token

1. Go to the **API credentials** tab
2. Under **Admin API access token**, click **Reveal token**
3. Copy the access token (you'll need this for environment variables)
4. Store it securely - you won't be able to see it again

### Step 4: Set Up Webhooks

1. In your app settings, go to the **Configuration** tab
2. Scroll to **Webhooks**
3. Click **Create webhook**
4. Configure the following webhooks:

**Product Updates**:
- Topic: `products/update`
- URL: `https://your-api.com/webhooks/shopify/products`
- API version: Latest stable

**Inventory Updates**:
- Topic: `inventory_levels/update`
- URL: `https://your-api.com/webhooks/shopify/inventory`
- API version: Latest stable

**Order Updates**:
- Topic: `orders/updated`
- URL: `https://your-api.com/webhooks/shopify/orders`
- API version: Latest stable

5. For each webhook, copy the webhook signing secret and store it securely

### Step 5: Environment Configuration

Add to your `.env` file:

```bash
# Shopify Configuration
SHOPIFY_SHOP_NAME=your-shop-name
SHOPIFY_ACCESS_TOKEN=your-access-token
SHOPIFY_WEBHOOK_SECRET=your-webhook-secret
SHOPIFY_API_VERSION=2024-01
```

**Where to find values**:
- `SHOPIFY_SHOP_NAME`: Your store URL (e.g., `mystore` from `mystore.myshopify.com`)
- `SHOPIFY_ACCESS_TOKEN`: From API credentials tab
- `SHOPIFY_WEBHOOK_SECRET`: From webhook configuration

### Step 6: Test Connection

```bash
curl -X GET https://your-api.com/marketplaces/health \
  -H "Authorization: Bearer your-token"
```

Expected response should show Shopify as available.

### Troubleshooting

**Issue**: "Invalid access token"
- **Solution**: Verify the token is correct and hasn't expired. Regenerate if needed.

**Issue**: "Webhook not receiving events"
- **Solution**: Ensure your webhook URL is publicly accessible and returns a 200 status code.

**Issue**: "Rate limit exceeded"
- **Solution**: Implement exponential backoff. Shopify allows 2 requests/second.

---

## WooCommerce Setup Guide

### Prerequisites

- WooCommerce store (WordPress with WooCommerce plugin)
- Admin access to your WooCommerce store
- WooCommerce version 3.0 or higher

### Step 1: Generate API Credentials

1. Log in to your WordPress Admin Dashboard
2. Navigate to **WooCommerce** → **Settings**
3. Go to the **Advanced** tab
4. Click **REST API**
5. Click **Create an API key**

### Step 2: Configure API Key

1. **Description**: Enter `Nexus Commerce Integration`
2. **User**: Select the user account to associate with this key
3. **Permissions**: Select **Read/Write**
4. Click **Generate API key**

### Step 3: Copy Credentials

You'll see:
- **Consumer Key**: Copy this value
- **Consumer Secret**: Copy this value

Store these securely - you won't be able to see the secret again.

### Step 4: Set Up Webhooks

1. In WooCommerce Settings, go to **Advanced** → **Webhooks**
2. Click **Add webhook**

**Product Update Webhook**:
- **Name**: `Product Updated`
- **Status**: Active
- **Topic**: `product.updated`
- **Delivery URL**: `https://your-api.com/webhooks/woocommerce/products`
- **Secret**: Generate a secure secret and store it

3. Click **Save webhook**

**Repeat for these topics**:
- `product.created`
- `product.deleted`
- `order.created`
- `order.updated`
- `order.completed`

### Step 5: Enable REST API

1. In WooCommerce Settings, go to **Advanced** → **REST API**
2. Ensure **Enable the REST API** is checked
3. Verify your API key is active

### Step 6: Environment Configuration

Add to your `.env` file:

```bash
# WooCommerce Configuration
WOOCOMMERCE_STORE_URL=https://your-store.com
WOOCOMMERCE_CONSUMER_KEY=your-consumer-key
WOOCOMMERCE_CONSUMER_SECRET=your-consumer-secret
WOOCOMMERCE_WEBHOOK_SECRET=your-webhook-secret
```

**Where to find values**:
- `WOOCOMMERCE_STORE_URL`: Your WordPress site URL
- `WOOCOMMERCE_CONSUMER_KEY`: From API key generation
- `WOOCOMMERCE_CONSUMER_SECRET`: From API key generation
- `WOOCOMMERCE_WEBHOOK_SECRET`: From webhook configuration

### Step 7: Test Connection

```bash
curl -X GET https://your-store.com/wp-json/wc/v3/products \
  -u "consumer_key:consumer_secret"
```

Expected response should return a list of products.

### Step 8: Configure CORS (if needed)

If you're making requests from a different domain, you may need to configure CORS:

1. Add to your WordPress `wp-config.php`:

```php
define('JETPACK_FORCE_2FA', false);
```

2. Or use a CORS plugin like **CORS Enabler**

### Troubleshooting

**Issue**: "Invalid consumer key"
- **Solution**: Verify the key is correct and the API key is active in WooCommerce settings.

**Issue**: "401 Unauthorized"
- **Solution**: Ensure you're using Basic Auth with the correct consumer key and secret.

**Issue**: "Webhook not triggering"
- **Solution**: Check that the webhook is active and your delivery URL is publicly accessible.

---

## Etsy Setup Guide

### Prerequisites

- Etsy seller account
- Etsy shop created and active
- Ability to create OAuth applications

### Step 1: Create an Etsy App

1. Go to [Etsy Developer Portal](https://www.etsy.com/developers)
2. Click **Sign in** and log in with your Etsy account
3. Click **Create an app**
4. Fill in the app details:
   - **App name**: `Nexus Commerce Integration`
   - **App description**: `Multi-channel marketplace integration`
   - **App URL**: `https://your-api.com`
   - **Redirect URI**: `https://your-api.com/auth/etsy/callback`
5. Accept the terms and click **Create app**

### Step 2: Get API Credentials

1. In your app settings, you'll see:
   - **API Key**: Copy this value
   - **API Secret**: Copy this value (store securely)
2. Also note your **Shop ID** (visible in your Etsy shop settings)

### Step 3: Set Up OAuth Flow

The Etsy API uses OAuth 2.0. You'll need to implement the authorization flow:

**Authorization URL**:
```
https://www.etsy.com/oauth/connect?response_type=code&client_id={API_KEY}&redirect_uri={REDIRECT_URI}&scope={SCOPES}
```

**Required Scopes**:
```
listings_r
listings_w
inventory_r
inventory_w
orders_r
orders_w
shops_r
```

**Token Exchange**:
```bash
POST https://api.etsy.com/v3/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
client_id={API_KEY}
client_secret={API_SECRET}
code={AUTHORIZATION_CODE}
redirect_uri={REDIRECT_URI}
```

### Step 4: Store Tokens

After successful authorization, you'll receive:
- **Access Token**: Valid for 3600 seconds
- **Refresh Token**: Use to get new access tokens
- **Expires In**: Token expiration time

Store these securely in your database or environment variables.

### Step 5: Set Up Webhooks

1. In your app settings, go to **Webhooks**
2. Click **Add webhook**

**Listing Update Webhook**:
- **Event**: `listing.updated`
- **Delivery URL**: `https://your-api.com/webhooks/etsy/listings`

3. Repeat for these events:
- `listing.created`
- `listing.deleted`
- `inventory.updated`
- `order.created`
- `order.updated`

### Step 6: Environment Configuration

Add to your `.env` file:

```bash
# Etsy Configuration
ETSY_SHOP_ID=your-shop-id
ETSY_API_KEY=your-api-key
ETSY_ACCESS_TOKEN=your-access-token
ETSY_REFRESH_TOKEN=your-refresh-token
ETSY_WEBHOOK_SECRET=your-webhook-secret
```

**Where to find values**:
- `ETSY_SHOP_ID`: From your Etsy shop settings
- `ETSY_API_KEY`: From app credentials
- `ETSY_ACCESS_TOKEN`: From OAuth token exchange
- `ETSY_REFRESH_TOKEN`: From OAuth token exchange
- `ETSY_WEBHOOK_SECRET`: From webhook configuration

### Step 7: Implement Token Refresh

Etsy tokens expire after 3600 seconds. Implement automatic refresh:

```typescript
async function refreshEtsyToken() {
  const response = await fetch('https://api.etsy.com/v3/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ETSY_API_KEY,
      client_secret: process.env.ETSY_API_SECRET,
      refresh_token: process.env.ETSY_REFRESH_TOKEN,
    }),
  });

  const data = await response.json();
  
  // Update tokens in environment or database
  process.env.ETSY_ACCESS_TOKEN = data.access_token;
  process.env.ETSY_REFRESH_TOKEN = data.refresh_token;
}
```

### Step 8: Test Connection

```bash
curl -X GET https://openapi.etsy.com/v3/application/shops/{shop_id} \
  -H "Authorization: Bearer your-access-token" \
  -H "x-api-key: your-api-key"
```

Expected response should return your shop information.

### Troubleshooting

**Issue**: "Invalid API key"
- **Solution**: Verify the API key is correct and the app is active.

**Issue**: "Token expired"
- **Solution**: Implement automatic token refresh using the refresh token.

**Issue**: "Insufficient permissions"
- **Solution**: Ensure all required scopes are requested during OAuth flow.

---

## Environment Configuration

### Complete .env Template

```bash
# ─────────────────────────────────────────────────────────────
# Shopify Configuration
# ─────────────────────────────────────────────────────────────
SHOPIFY_SHOP_NAME=your-shop-name
SHOPIFY_ACCESS_TOKEN=your-access-token
SHOPIFY_WEBHOOK_SECRET=your-webhook-secret
SHOPIFY_API_VERSION=2024-01

# ─────────────────────────────────────────────────────────────
# WooCommerce Configuration
# ─────────────────────────────────────────────────────────────
WOOCOMMERCE_STORE_URL=https://your-store.com
WOOCOMMERCE_CONSUMER_KEY=your-consumer-key
WOOCOMMERCE_CONSUMER_SECRET=your-consumer-secret
WOOCOMMERCE_WEBHOOK_SECRET=your-webhook-secret

# ─────────────────────────────────────────────────────────────
# Etsy Configuration
# ─────────────────────────────────────────────────────────────
ETSY_SHOP_ID=your-shop-id
ETSY_API_KEY=your-api-key
ETSY_ACCESS_TOKEN=your-access-token
ETSY_REFRESH_TOKEN=your-refresh-token
ETSY_WEBHOOK_SECRET=your-webhook-secret

# ─────────────────────────────────────────────────────────────
# Amazon Configuration (existing)
# ─────────────────────────────────────────────────────────────
AMAZON_SELLER_ID=your-seller-id
AMAZON_MWS_AUTH_TOKEN=your-auth-token
AMAZON_REGION=us-east-1

# ─────────────────────────────────────────────────────────────
# eBay Configuration (existing)
# ─────────────────────────────────────────────────────────────
EBAY_OAUTH_TOKEN=your-oauth-token
EBAY_ENVIRONMENT=production

# ─────────────────────────────────────────────────────────────
# API Configuration
# ─────────────────────────────────────────────────────────────
API_PORT=3001
API_HOST=localhost
NODE_ENV=production

# ─────────────────────────────────────────────────────────────
# Database Configuration
# ─────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/nexus_commerce

# ─────────────────────────────────────────────────────────────
# Webhook Configuration
# ─────────────────────────────────────────────────────────────
WEBHOOK_BASE_URL=https://your-api.com
WEBHOOK_TIMEOUT=30000
WEBHOOK_RETRY_ATTEMPTS=3
```

### Validation Script

Create a script to validate your configuration:

```bash
#!/bin/bash

echo "Validating Marketplace Configuration..."

# Check Shopify
if [ -z "$SHOPIFY_SHOP_NAME" ] || [ -z "$SHOPIFY_ACCESS_TOKEN" ]; then
  echo "❌ Shopify: Missing required variables"
else
  echo "✅ Shopify: Configured"
fi

# Check WooCommerce
if [ -z "$WOOCOMMERCE_STORE_URL" ] || [ -z "$WOOCOMMERCE_CONSUMER_KEY" ]; then
  echo "❌ WooCommerce: Missing required variables"
else
  echo "✅ WooCommerce: Configured"
fi

# Check Etsy
if [ -z "$ETSY_SHOP_ID" ] || [ -z "$ETSY_API_KEY" ]; then
  echo "❌ Etsy: Missing required variables"
else
  echo "✅ Etsy: Configured"
fi

echo "Configuration validation complete!"
```

---

## Verification Checklist

### Pre-Deployment Checklist

- [ ] **Shopify**
  - [ ] API credentials generated and stored securely
  - [ ] Admin API scopes configured correctly
  - [ ] Webhooks created and receiving events
  - [ ] Test product sync successful
  - [ ] Inventory updates working
  - [ ] Price updates working

- [ ] **WooCommerce**
  - [ ] API key generated and stored securely
  - [ ] REST API enabled
  - [ ] Webhooks created and active
  - [ ] Test product sync successful
  - [ ] Stock updates working
  - [ ] Price updates working

- [ ] **Etsy**
  - [ ] OAuth app created and credentials stored
  - [ ] Authorization flow tested
  - [ ] Access token and refresh token obtained
  - [ ] Webhooks configured
  - [ ] Test listing sync successful
  - [ ] Inventory updates working

- [ ] **Environment**
  - [ ] All environment variables set correctly
  - [ ] Webhook URLs are publicly accessible
  - [ ] SSL certificates valid
  - [ ] Rate limiting configured
  - [ ] Error logging enabled

- [ ] **Testing**
  - [ ] Health check endpoint returns all marketplaces available
  - [ ] Product sync across all channels successful
  - [ ] Price updates propagate correctly
  - [ ] Inventory updates propagate correctly
  - [ ] Webhook events processed correctly
  - [ ] Error handling working as expected

### Post-Deployment Checklist

- [ ] Monitor webhook delivery logs
- [ ] Verify sync job execution
- [ ] Check error logs for issues
- [ ] Monitor API rate limits
- [ ] Verify data consistency across channels
- [ ] Test failover scenarios
- [ ] Document any custom configurations

---

## Support Resources

- **Shopify API Docs**: https://shopify.dev/api/admin-rest
- **WooCommerce API Docs**: https://woocommerce.com/document/woocommerce-rest-api/
- **Etsy API Docs**: https://developers.etsy.com/documentation
- **Nexus Commerce Docs**: https://docs.nexus-commerce.com

---

**Last Updated**: 2026-04-23  
**Version**: 1.0.0
