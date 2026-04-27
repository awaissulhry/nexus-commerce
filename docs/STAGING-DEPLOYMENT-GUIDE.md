# Staging Deployment Guide

## Pre-Deployment Checklist

### Code Review
- [x] Amazon Sync Service implemented and tested
- [x] Monitoring and alerting system complete
- [x] API routes created and documented
- [x] Frontend components built and styled
- [x] Unit and integration tests written
- [x] Error handling and retry logic implemented
- [x] Database schema migrations created

### Environment Setup
- [ ] Staging database provisioned
- [ ] Environment variables configured
- [ ] Slack webhook URL obtained
- [ ] Email service credentials ready
- [ ] Amazon SP-API credentials configured
- [ ] SSL certificates installed

### Dependencies
- [ ] Node.js 18+ installed
- [ ] PostgreSQL 14+ running
- [ ] npm packages installed
- [ ] Prisma migrations applied
- [ ] Database seeded with test data

## Deployment Steps

### 1. Environment Configuration

Create `.env.staging` file:

```bash
# Database
DATABASE_URL=postgresql://user:password@staging-db.example.com:5432/nexus_staging

# Amazon SP-API
AMAZON_REGION=us-east-1
AMAZON_SELLER_ID=your-seller-id
AMAZON_ACCESS_KEY=your-access-key
AMAZON_SECRET_KEY=your-secret-key
AMAZON_REFRESH_TOKEN=your-refresh-token

# Monitoring & Alerts
ALERT_EMAIL=staging-alerts@example.com
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/STAGING/WEBHOOK
SLACK_CHANNEL=#staging-sync-alerts

# API Configuration
API_PORT=3001
API_HOST=0.0.0.0
NODE_ENV=staging

# Frontend
NEXT_PUBLIC_API_URL=https://api-staging.example.com
NEXT_PUBLIC_APP_URL=https://staging.example.com
```

### 2. Database Setup

```bash
# Navigate to database package
cd packages/database

# Apply migrations
npx prisma migrate deploy

# Seed test data (optional)
npx prisma db seed

# Verify schema
npx prisma studio
```

### 3. API Deployment

```bash
# Navigate to API
cd apps/api

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start API server
npm run dev

# Verify API is running
curl http://localhost:3001/api/monitoring/health
```

### 4. Frontend Deployment

```bash
# Navigate to frontend
cd apps/web

# Install dependencies
npm install

# Build Next.js
npm run build

# Start frontend
npm run start

# Verify frontend is running
curl http://localhost:3000
```

### 5. Register Monitoring Routes

Update `apps/api/src/routes/index.ts`:

```typescript
import { monitoringRoutes } from "./monitoring.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  // ... existing routes ...
  
  // Register monitoring routes
  await monitoringRoutes(app);
  
  console.log("✓ Monitoring routes registered");
}
```

### 6. Verify Monitoring System

```bash
# Check health status
curl http://localhost:3001/api/monitoring/health

# Get metrics
curl "http://localhost:3001/api/monitoring/metrics"

# Get alert configs
curl http://localhost:3001/api/monitoring/alert-configs

# Test Slack notification
curl -X POST http://localhost:3001/api/monitoring/test-alert \
  -H "Content-Type: application/json" \
  -d '{"configId": "alert-failure-rate", "severity": "warning"}'
```

### 7. Configure Slack Integration

1. Go to Slack workspace settings
2. Create incoming webhook for `#staging-sync-alerts` channel
3. Copy webhook URL
4. Add to `.env.staging`:
   ```
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
   ```
5. Test webhook:
   ```bash
   curl -X POST https://hooks.slack.com/services/YOUR/WEBHOOK/URL \
     -H 'Content-type: application/json' \
     -d '{"text":"Test message from Nexus Commerce"}'
   ```

### 8. Configure Email Alerts

1. Set up email service (SendGrid, AWS SES, etc.)
2. Add credentials to environment
3. Configure alert recipients:
   ```bash
   ALERT_EMAIL=staging-alerts@example.com
   ```

### 9. Load Test Data

```bash
# Create test products with parent-child relationships
cd packages/database

# Run seed script
npx ts-node seed.ts

# Verify data
npx prisma studio
```

## Staging Testing

### 1. Manual Testing

#### Test Sync Trigger
```bash
curl -X POST http://localhost:3001/api/sync/amazon/catalog \
  -H "Content-Type: application/json" \
  -d '{
    "products": [
      {
        "sku": "TEST-001",
        "name": "Test Product",
        "asin": "B123456789",
        "price": 29.99,
        "stock": 100
      }
    ]
  }'
```

#### Monitor Sync Progress
```bash
# Get sync status
curl http://localhost:3001/api/sync/amazon/catalog/sync-id

# Get sync history
curl http://localhost:3001/api/sync/amazon/catalog/history
```

#### Check Monitoring Dashboard
1. Open http://localhost:3000/monitoring
2. Verify health status displays
3. Check metrics are updating
4. Confirm alerts appear

### 2. Alert Testing

#### Test Failure Rate Alert
```bash
# Trigger sync with high failure rate
# Monitor should detect and send alert
```

#### Test Duration Alert
```bash
# Trigger long-running sync
# Monitor should detect and send alert
```

#### Test Error Count Alert
```bash
# Trigger sync with many errors
# Monitor should detect and send alert
```

### 3. Notification Testing

#### Slack Notifications
1. Check `#staging-sync-alerts` channel
2. Verify alert messages appear
3. Confirm color coding (danger/warning/good)
4. Test alert acknowledgment

#### Email Notifications
1. Check staging-alerts@example.com inbox
2. Verify alert emails received
3. Confirm email formatting
4. Test multiple recipients

### 4. Performance Testing

```bash
# Monitor API response times
curl -w "@curl-format.txt" -o /dev/null -s http://localhost:3001/api/monitoring/health

# Check database query performance
# Monitor CPU and memory usage
# Verify no memory leaks
```

## Staging Validation Checklist

### API Endpoints
- [ ] `GET /api/monitoring/health` returns 200
- [ ] `GET /api/monitoring/metrics` returns metrics
- [ ] `GET /api/monitoring/alerts` returns alerts
- [ ] `POST /api/monitoring/alerts/:id/acknowledge` works
- [ ] `GET /api/monitoring/alert-configs` returns configs
- [ ] `PATCH /api/monitoring/alert-configs/:id` updates config
- [ ] `POST /api/monitoring/test-alert` sends notification

### Frontend Components
- [ ] Dashboard loads without errors
- [ ] Health status displays correctly
- [ ] Metrics cards show data
- [ ] Auto-refresh works (30 seconds)
- [ ] Error handling displays gracefully
- [ ] Responsive design works on mobile

### Monitoring System
- [ ] Metrics recorded after sync
- [ ] Alerts triggered on threshold breach
- [ ] Slack notifications sent
- [ ] Email notifications sent
- [ ] Alerts stored in database
- [ ] Alert acknowledgment works
- [ ] Health status updates correctly

### Database
- [ ] Migrations applied successfully
- [ ] Test data loaded
- [ ] Parent-child relationships correct
- [ ] Sync logs created
- [ ] Alert records stored
- [ ] Indexes created

### Error Handling
- [ ] Invalid requests return 400
- [ ] Missing resources return 404
- [ ] Server errors return 500
- [ ] Error messages are helpful
- [ ] Logging captures errors

## Rollback Plan

If issues occur during staging deployment:

### Quick Rollback
```bash
# Stop services
docker-compose down

# Revert to previous version
git checkout previous-tag

# Restart services
docker-compose up -d
```

### Database Rollback
```bash
# Revert migrations
npx prisma migrate resolve --rolled-back migration-name

# Restore from backup
pg_restore -d nexus_staging backup.sql
```

## Monitoring During Staging

### Key Metrics to Watch
- API response times (target: < 200ms)
- Database query times (target: < 100ms)
- Error rate (target: < 1%)
- Alert notification latency (target: < 5s)
- Memory usage (target: < 500MB)
- CPU usage (target: < 50%)

### Logging
```bash
# View API logs
docker logs nexus-api

# View frontend logs
docker logs nexus-web

# View database logs
docker logs nexus-db
```

### Alerts to Monitor
- High failure rate (> 10%)
- Long sync duration (> 5 minutes)
- High error count (> 50)
- Low success rate (< 80%)

## Sign-Off

### Staging Validation Complete When:
- [ ] All API endpoints tested and working
- [ ] Frontend dashboard displays correctly
- [ ] Monitoring system captures metrics
- [ ] Alerts trigger on threshold breach
- [ ] Notifications sent through all channels
- [ ] Database operations verified
- [ ] Error handling tested
- [ ] Performance acceptable
- [ ] No critical issues found

### Approval Required From:
- [ ] Backend Lead
- [ ] Frontend Lead
- [ ] DevOps/Infrastructure
- [ ] QA Team

## Next Steps

Once staging validation is complete:

1. **Run Full Sync Test** - Execute comprehensive sync with real/mock data
2. **Performance Tuning** - Optimize based on staging metrics
3. **Security Review** - Verify authentication and authorization
4. **Documentation Review** - Ensure all docs are accurate
5. **Deploy to Production** - Follow production deployment guide

## Troubleshooting

### API Won't Start
```bash
# Check port is available
lsof -i :3001

# Check environment variables
env | grep DATABASE_URL

# Check database connection
psql $DATABASE_URL -c "SELECT 1"
```

### Monitoring Routes Not Found
```bash
# Verify routes are registered in index.ts
grep "monitoringRoutes" apps/api/src/routes/index.ts

# Check API logs for registration message
docker logs nexus-api | grep "Monitoring routes"
```

### Slack Notifications Not Sending
```bash
# Verify webhook URL
echo $SLACK_WEBHOOK_URL

# Test webhook directly
curl -X POST $SLACK_WEBHOOK_URL \
  -H 'Content-type: application/json' \
  -d '{"text":"Test"}'
```

### Database Migrations Failed
```bash
# Check migration status
npx prisma migrate status

# View migration history
npx prisma migrate history

# Reset database (WARNING: deletes data)
npx prisma migrate reset
```

## Support

For issues during staging deployment:
1. Check logs: `docker logs nexus-api`
2. Review error messages in monitoring dashboard
3. Check Slack #staging-sync-alerts channel
4. Consult troubleshooting guide above
5. Contact DevOps team if needed
