# Sync Monitoring and Alerting Guide

## Overview

The Sync Monitoring system provides real-time visibility into Amazon catalog sync operations with comprehensive alerting capabilities. It tracks sync metrics, health status, and sends notifications through multiple channels.

## Architecture

### Components

1. **SyncMonitoringService** (`apps/api/src/services/sync-monitoring.service.ts`)
   - Core monitoring logic
   - Metrics recording and aggregation
   - Alert evaluation and creation
   - Notification dispatch

2. **Monitoring API Routes** (`apps/api/src/routes/monitoring.routes.ts`)
   - REST endpoints for monitoring data
   - Alert management
   - Configuration updates

3. **Frontend Dashboard** (`apps/web/src/components/monitoring/SyncHealthDashboard.tsx`)
   - Real-time health status display
   - Metrics visualization
   - Alert summary

## API Endpoints

### Health Status

**GET `/api/monitoring/health`**

Returns current sync health status.

```bash
curl http://localhost:3001/api/monitoring/health
```

Response:
```json
{
  "success": true,
  "data": {
    "status": "healthy|degraded|critical",
    "lastSyncTime": "2026-04-24T09:40:00Z",
    "lastSyncStatus": "SUCCESS",
    "recentFailureRate": 2.5,
    "activeAlerts": 0,
    "message": "All systems operational"
  }
}
```

### Metrics

**GET `/api/monitoring/metrics?startDate=2026-04-17&endDate=2026-04-24`**

Get aggregated sync metrics for a time period.

```bash
curl "http://localhost:3001/api/monitoring/metrics?startDate=2026-04-17&endDate=2026-04-24"
```

Response:
```json
{
  "success": true,
  "data": {
    "period": {
      "start": "2026-04-17T00:00:00Z",
      "end": "2026-04-24T00:00:00Z"
    },
    "metrics": {
      "totalSyncs": 48,
      "successfulSyncs": 46,
      "failedSyncs": 2,
      "averageSuccessRate": 97.5,
      "averageDuration": 45000,
      "totalProductsProcessed": 12000,
      "totalProductsFailed": 150
    }
  }
}
```

### Alerts

**GET `/api/monitoring/alerts?limit=50`**

Get recent alerts.

```bash
curl "http://localhost:3001/api/monitoring/alerts?limit=50"
```

Response:
```json
{
  "success": true,
  "data": {
    "count": 3,
    "alerts": [
      {
        "id": "alert-1234567890-abc123",
        "configId": "alert-failure-rate",
        "syncId": "sync-xyz789",
        "severity": "warning",
        "message": "Sync failure rate 12.5% exceeds threshold of 10%",
        "metadata": {
          "metrics": { ... },
          "threshold": 10
        },
        "acknowledged": false,
        "createdAt": "2026-04-24T09:30:00Z"
      }
    ]
  }
}
```

**POST `/api/monitoring/alerts/:alertId/acknowledge`**

Acknowledge an alert.

```bash
curl -X POST http://localhost:3001/api/monitoring/alerts/alert-123/acknowledge \
  -H "Content-Type: application/json" \
  -d '{"acknowledgedBy": "admin@example.com"}'
```

### Alert Configurations

**GET `/api/monitoring/alert-configs`**

Get all alert configurations.

```bash
curl http://localhost:3001/api/monitoring/alert-configs
```

**GET `/api/monitoring/alert-configs/:configId`**

Get a specific alert configuration.

```bash
curl http://localhost:3001/api/monitoring/alert-configs/alert-failure-rate
```

**PATCH `/api/monitoring/alert-configs/:configId`**

Update an alert configuration.

```bash
curl -X PATCH http://localhost:3001/api/monitoring/alert-configs/alert-failure-rate \
  -H "Content-Type: application/json" \
  -d '{
    "threshold": 15,
    "enabled": true,
    "channels": ["slack", "email"],
    "slackChannel": "#sync-alerts",
    "emailRecipients": ["admin@example.com"]
  }'
```

**POST `/api/monitoring/test-alert`**

Send a test alert to verify notification channels.

```bash
curl -X POST http://localhost:3001/api/monitoring/test-alert \
  -H "Content-Type: application/json" \
  -d '{
    "configId": "alert-failure-rate",
    "severity": "warning"
  }'
```

## Alert Types

### 1. Failure Rate Alert

**Type:** `failure_rate`  
**Default Threshold:** 10%  
**Severity:** Warning (10-50%), Critical (>50%)

Triggered when sync failure rate exceeds threshold.

```
Sync failure rate 12.5% exceeds threshold of 10%
```

### 2. Duration Alert

**Type:** `duration`  
**Default Threshold:** 300,000ms (5 minutes)  
**Severity:** Warning

Triggered when sync takes longer than threshold.

```
Sync duration 450000ms exceeds threshold of 300000ms
```

### 3. Error Count Alert

**Type:** `error_count`  
**Default Threshold:** 50 products  
**Severity:** Warning (50-100), Critical (>100)

Triggered when failed product count exceeds threshold.

```
Failed products 75 exceeds threshold of 50
```

### 4. Success Threshold Alert

**Type:** `success_threshold`  
**Default Threshold:** 80%  
**Severity:** Critical

Triggered when success rate falls below threshold.

```
Success rate 75.5% below threshold of 80%
```

## Notification Channels

### Email

Sends alerts via email. Requires email service configuration.

**Configuration:**
```json
{
  "channels": ["email"],
  "emailRecipients": ["admin@example.com", "ops@example.com"]
}
```

### Slack

Sends alerts to Slack channel. Requires `SLACK_WEBHOOK_URL` environment variable.

**Configuration:**
```json
{
  "channels": ["slack"],
  "slackChannel": "#sync-alerts"
}
```

**Environment Variable:**
```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

### Webhook

Sends alerts to custom webhook endpoint.

**Configuration:**
```json
{
  "channels": ["webhook"],
  "webhookUrl": "https://your-system.com/webhooks/sync-alerts"
}
```

**Payload:**
```json
{
  "message": "[WARNING] Sync failure rate 12.5% exceeds threshold of 10% (2026-04-24T09:30:00Z)",
  "severity": "warning",
  "timestamp": "2026-04-24T09:30:00Z"
}
```

### Database

Alerts are always stored in the database for historical tracking.

## Health Status Levels

### Healthy ✓

- Failure rate < 10%
- Active alerts ≤ 5
- All systems operational

### Degraded ⚠️

- Failure rate 10-50%
- Active alerts 5-10
- Some issues detected, monitoring recommended

### Critical 🔴

- Failure rate > 50%
- Active alerts > 10
- Immediate action required

## Integration with Sync Service

The monitoring service is automatically called after each sync completes:

```typescript
// In amazon-sync.service.ts
const metrics = {
  totalProducts: products.length,
  successfulProducts: successCount,
  failedProducts: failureCount,
  successRate: (successCount / products.length) * 100,
  duration: endTime - startTime,
  startTime: new Date(startTime),
  endTime: new Date(endTime),
  averageTimePerProduct: (endTime - startTime) / products.length,
  errorCategories: errorMap,
};

await syncMonitoringService.recordSyncMetrics(syncId, metrics);
```

## Frontend Integration

### Dashboard Component

Add the monitoring dashboard to your page:

```tsx
import SyncHealthDashboard from "@/components/monitoring/SyncHealthDashboard";

export default function MonitoringPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Sync Monitoring</h1>
      <SyncHealthDashboard />
    </div>
  );
}
```

The dashboard automatically:
- Fetches health status and metrics
- Displays real-time status with color coding
- Refreshes every 30 seconds
- Shows failure rates, alert counts, and success metrics

## Configuration

### Default Alert Configurations

```typescript
[
  {
    id: "alert-failure-rate",
    name: "High Failure Rate",
    type: "failure_rate",
    threshold: 10,
    enabled: true,
    channels: ["slack", "email"],
    slackChannel: "#sync-alerts",
    emailRecipients: ["admin@example.com"]
  },
  {
    id: "alert-duration",
    name: "Long Sync Duration",
    type: "duration",
    threshold: 300000,
    enabled: true,
    channels: ["slack"],
    slackChannel: "#sync-alerts"
  },
  {
    id: "alert-error-count",
    name: "High Error Count",
    type: "error_count",
    threshold: 50,
    enabled: true,
    channels: ["slack", "email"],
    slackChannel: "#sync-alerts",
    emailRecipients: ["admin@example.com"]
  },
  {
    id: "alert-success-threshold",
    name: "Low Success Rate",
    type: "success_threshold",
    threshold: 80,
    enabled: true,
    channels: ["slack", "email"],
    slackChannel: "#sync-alerts",
    emailRecipients: ["admin@example.com"]
  }
]
```

### Environment Variables

```bash
# Email alerts
ALERT_EMAIL=admin@example.com

# Slack integration
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Custom webhook
ALERT_WEBHOOK_URL=https://your-system.com/webhooks/sync-alerts
```

## Monitoring Best Practices

### 1. Set Appropriate Thresholds

- **Failure Rate:** 5-15% depending on data quality
- **Duration:** Based on your typical sync time + 50%
- **Error Count:** 5-10% of typical product count
- **Success Rate:** 85-95% depending on requirements

### 2. Configure Multiple Channels

- Use Slack for real-time notifications
- Use email for critical alerts
- Use webhooks for integration with other systems

### 3. Regular Review

- Review alert history weekly
- Adjust thresholds based on patterns
- Acknowledge resolved alerts
- Monitor false positive rate

### 4. Escalation Policy

- Warning alerts: Monitor and investigate
- Critical alerts: Immediate action required
- Multiple consecutive failures: Escalate to team lead

## Troubleshooting

### Alerts Not Sending

1. Check alert configuration is enabled
2. Verify notification channel credentials
3. Test with `/api/monitoring/test-alert` endpoint
4. Check server logs for errors

### High False Positive Rate

1. Review alert thresholds
2. Analyze historical metrics
3. Adjust thresholds based on baseline
4. Consider time-based thresholds

### Missing Metrics

1. Ensure sync service calls `recordSyncMetrics()`
2. Check database connectivity
3. Verify sync logs are being created
4. Review error logs for issues

## Examples

### Monitor Sync Health

```bash
# Check current health
curl http://localhost:3001/api/monitoring/health | jq .

# Get last 7 days metrics
curl "http://localhost:3001/api/monitoring/metrics" | jq .

# Get last 30 days metrics
curl "http://localhost:3001/api/monitoring/metrics?startDate=2026-03-25&endDate=2026-04-24" | jq .
```

### Manage Alerts

```bash
# Get recent alerts
curl http://localhost:3001/api/monitoring/alerts | jq .

# Acknowledge an alert
curl -X POST http://localhost:3001/api/monitoring/alerts/alert-123/acknowledge \
  -H "Content-Type: application/json" \
  -d '{"acknowledgedBy": "admin@example.com"}'

# Test Slack integration
curl -X POST http://localhost:3001/api/monitoring/test-alert \
  -H "Content-Type: application/json" \
  -d '{"configId": "alert-failure-rate", "severity": "warning"}'
```

### Update Configuration

```bash
# Increase failure rate threshold to 15%
curl -X PATCH http://localhost:3001/api/monitoring/alert-configs/alert-failure-rate \
  -H "Content-Type: application/json" \
  -d '{"threshold": 15}'

# Disable email notifications
curl -X PATCH http://localhost:3001/api/monitoring/alert-configs/alert-failure-rate \
  -H "Content-Type: application/json" \
  -d '{"channels": ["slack"]}'
```

## Next Steps

1. Configure Slack webhook URL in environment
2. Set up email service integration
3. Deploy monitoring routes to API
4. Add dashboard to monitoring page
5. Test alert notifications
6. Set up escalation policies
7. Monitor and adjust thresholds
