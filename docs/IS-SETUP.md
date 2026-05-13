# IS.2 — Real-Time Cross-Channel Inventory Sync Setup

When a FBM order lands on Amazon or eBay, stock on all other channels (eBay, Shopify, Amazon) is updated within 30–90 seconds.

---

## How it works

| Channel | Order in | Method | Cascade out |
|---------|----------|--------|-------------|
| Amazon FBM | SP-API Notifications → SQS → poll every 30s | `reserveOpenOrder` → IS.2 cascade | eBay + Shopify |
| eBay | eBay Notification Platform push webhook | `applyStockMovement(-qty)` → existing cascade | Amazon + Shopify |
| Shopify | Shopify webhook `orders/create` | `reserveOpenOrder` → IS.1 cascade | eBay + Amazon |
| Cancellation (any) | Channel-specific → `handleOrderCancelled` | release reservation → IS.2 cascade | All other channels |

---

## Amazon SQS Setup (one-time)

### 1. Create an SQS Standard Queue in AWS

```
Queue name: nexus-sp-api-notifications
Type: Standard (not FIFO)
Region: eu-west-1 (or wherever your API runs)
```

### 2. Add SQS permission for SP-API to publish

Attach this policy to the queue (replace `<accountId>` and `<region>`):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Service": "sqs.amazonaws.com"
    },
    "Action": "SQS:SendMessage",
    "Resource": "arn:aws:sqs:<region>:<accountId>:nexus-sp-api-notifications",
    "Condition": {
      "ArnLike": {
        "aws:SourceArn": "arn:aws:sns:*:*:*"
      }
    }
  }]
}
```

### 3. Set environment variables

```bash
AMAZON_SQS_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/<accountId>/nexus-sp-api-notifications
NEXUS_ENABLE_AMAZON_SQS_POLL=1
```

The AWS credentials already in use (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) also need `sqs:ReceiveMessage` and `sqs:DeleteMessage` on this queue.

### 4. Register the subscription with SP-API

Call this endpoint once (idempotent):

```bash
curl -X POST https://<your-api>/api/admin/setup-amazon-notifications
```

This registers the SQS queue ARN as an SP-API notification destination and subscribes to `ORDER_CHANGE`.

---

## eBay Notification Platform Setup (one-time)

### 1. Set environment variables

```bash
EBAY_NOTIFICATION_VERIFICATION_TOKEN=<random-secret-string-you-choose>
EBAY_NOTIFICATION_ENDPOINT_URL=https://<your-api>/api/webhooks/ebay-notification
```

### 2. Register webhook in eBay Developer Console

1. Go to [developer.ebay.com](https://developer.ebay.com) → Application Keys
2. Click on your Production application
3. Go to the **Notifications** tab
4. Under "Notification Delivery Method" select **Webhook**
5. Enter your endpoint URL: `https://<your-api>/api/webhooks/ebay-notification`
6. Enter your verification token (same as `EBAY_NOTIFICATION_VERIFICATION_TOKEN`)
7. Subscribe to topics:
   - `marketplace.order.created`
   - `marketplace.order.cancelled`

eBay will send a challenge GET request to your endpoint automatically. The endpoint handles it.

---

## Verification

After setup, place a test order on each channel and check:

```bash
# Check that OutboundSyncQueue rows were created
# (requires DB access)
SELECT targetChannel, syncType, syncStatus, createdAt
FROM "OutboundSyncQueue"
WHERE payload->>'source' IN ('AMAZON_ORDER_PLACED', 'ORDER_CANCELLED')
ORDER BY createdAt DESC
LIMIT 20;
```

Check Railway logs for:
- `[SQS poll] processed ORDER_CHANGE` — Amazon real-time working
- `[eBay notification] order sync complete` — eBay push working
- `[amazon-orders] IS.2 cascade failed` — cascade error (check OutboundSyncQueue worker)
