# Production Deployment Guide

## Pre-Production Checklist

### Code Quality
- [x] All unit tests passing
- [x] All integration tests passing
- [x] Code review completed
- [x] No critical security issues
- [x] Error handling implemented
- [x] Logging configured
- [x] Documentation complete

### Staging Validation
- [x] Staging deployment successful
- [x] All features tested in staging
- [x] Performance benchmarks met
- [x] Monitoring system verified
- [x] Alerts tested and working
- [x] No regressions detected
- [x] Sign-off from QA team

### Infrastructure
- [ ] Production database provisioned
- [ ] Production API server configured
- [ ] Production frontend server configured
- [ ] SSL certificates installed
- [ ] Load balancer configured
- [ ] CDN configured (if applicable)
- [ ] Backup strategy in place

### Security
- [ ] Secrets management configured
- [ ] API authentication enabled
- [ ] Rate limiting configured
- [ ] CORS properly configured
- [ ] SQL injection prevention verified
- [ ] XSS protection enabled
- [ ] CSRF tokens implemented

### Monitoring & Alerting
- [ ] Production monitoring configured
- [ ] Alert channels verified
- [ ] Slack webhook configured
- [ ] Email alerts configured
- [ ] PagerDuty integration (if applicable)
- [ ] Log aggregation configured
- [ ] APM tool configured (if applicable)

## Production Environment Setup

### 1. Environment Configuration

Create `.env.production` file:

```bash
# Database
DATABASE_URL=postgresql://user:password@prod-db.example.com:5432/nexus_production

# Amazon SP-API
AMAZON_REGION=us-east-1
AMAZON_SELLER_ID=your-seller-id
AMAZON_ACCESS_KEY=your-access-key
AMAZON_SECRET_KEY=your-secret-key
AMAZON_REFRESH_TOKEN=your-refresh-token

# Monitoring & Alerts
ALERT_EMAIL=alerts@example.com
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/PRODUCTION/WEBHOOK
SLACK_CHANNEL=#production-sync-alerts

# API Configuration
API_PORT=3001
API_HOST=0.0.0.0
NODE_ENV=production
API_LOG_LEVEL=info

# Frontend
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_APP_URL=https://app.example.com

# Security
JWT_SECRET=your-jwt-secret-key
SESSION_SECRET=your-session-secret-key

# Performance
NODE_OPTIONS=--max-old-space-size=2048
```

### 2. Database Setup

```bash
# Connect to production database
psql $DATABASE_URL

# Apply migrations
npx prisma migrate deploy

# Verify schema
npx prisma studio

# Create backups
pg_dump $DATABASE_URL > backup-$(date +%Y%m%d).sql
```

### 3. API Deployment

```bash
# Navigate to API
cd apps/api

# Install production dependencies
npm install --production

# Build TypeScript
npm run build

# Start API with PM2
pm2 start "npm run start" --name "nexus-api" --instances max

# Verify API is running
curl https://api.example.com/api/monitoring/health
```

### 4. Frontend Deployment

```bash
# Navigate to frontend
cd apps/web

# Install production dependencies
npm install --production

# Build Next.js
npm run build

# Start frontend with PM2
pm2 start "npm run start" --name "nexus-web" --instances max

# Verify frontend is running
curl https://app.example.com
```

### 5. Configure Reverse Proxy

**Nginx Configuration:**

```nginx
upstream api_backend {
    server localhost:3001;
    server localhost:3002;
    server localhost:3003;
}

upstream web_backend {
    server localhost:3000;
    server localhost:3010;
    server localhost:3020;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;
    
    ssl_certificate /etc/ssl/certs/api.example.com.crt;
    ssl_certificate_key /etc/ssl/private/api.example.com.key;
    
    location / {
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    server_name app.example.com;
    
    ssl_certificate /etc/ssl/certs/app.example.com.crt;
    ssl_certificate_key /etc/ssl/private/app.example.com.key;
    
    location / {
        proxy_pass http://web_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 6. Configure Monitoring

```bash
# Install monitoring agent
curl -sSL https://monitoring-agent.example.com/install.sh | bash

# Configure log aggregation
cat > /etc/logstash/conf.d/nexus.conf << EOF
input {
  file {
    path => "/var/log/nexus-api/*.log"
    type => "api"
  }
  file {
    path => "/var/log/nexus-web/*.log"
    type => "web"
  }
}

output {
  elasticsearch {
    hosts => ["elasticsearch.example.com:9200"]
    index => "nexus-%{+YYYY.MM.dd}"
  }
}
EOF

# Restart logstash
systemctl restart logstash
```

### 7. Configure Alerts

```bash
# Slack webhook for production
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/PRODUCTION/WEBHOOK

# Test webhook
curl -X POST $SLACK_WEBHOOK_URL \
  -H 'Content-type: application/json' \
  -d '{"text":"Production deployment successful"}'

# Configure PagerDuty (if applicable)
# Add integration key to environment
export PAGERDUTY_INTEGRATION_KEY=your-key
```

## Deployment Process

### Phase 1: Pre-Deployment (Day Before)

1. **Final Testing**
   ```bash
   # Run full test suite
   npm test
   
   # Run performance tests
   npm run test:performance
   ```

2. **Backup Current Production**
   ```bash
   # Database backup
   pg_dump $DATABASE_URL > backup-pre-deployment.sql
   
   # Application backup
   tar -czf app-backup-pre-deployment.tar.gz apps/
   ```

3. **Notify Team**
   - Send deployment notification to Slack
   - Notify support team
   - Update status page

### Phase 2: Deployment (Scheduled Window)

1. **Blue-Green Deployment**
   ```bash
   # Deploy to green environment
   cd /opt/nexus-green
   git pull origin main
   npm install --production
   npm run build
   
   # Run smoke tests
   npm run test:smoke
   
   # Switch traffic to green
   # Update load balancer to point to green
   ```

2. **Database Migration**
   ```bash
   # Apply migrations
   npx prisma migrate deploy
   
   # Verify schema
   npx prisma studio
   ```

3. **Verify Deployment**
   ```bash
   # Check API health
   curl https://api.example.com/api/monitoring/health
   
   # Check frontend
   curl https://app.example.com
   
   # Check monitoring
   curl https://api.example.com/api/monitoring/metrics
   ```

### Phase 3: Post-Deployment (1 Hour)

1. **Monitor Metrics**
   - Watch error rates
   - Monitor response times
   - Check database performance
   - Verify alert system

2. **Smoke Tests**
   ```bash
   # Test critical paths
   npm run test:smoke:production
   
   # Test sync functionality
   curl -X POST https://api.example.com/api/sync/amazon/catalog \
     -H "Content-Type: application/json" \
     -d @test-data.json
   ```

3. **User Acceptance Testing**
   - Test inventory page
   - Test sync trigger
   - Test monitoring dashboard
   - Test alert notifications

## Rollback Plan

### Quick Rollback (< 5 minutes)

```bash
# Switch traffic back to blue environment
# Update load balancer configuration
# Verify traffic is flowing to blue

# Check health
curl https://api.example.com/api/monitoring/health
```

### Full Rollback (< 15 minutes)

```bash
# Stop green environment
pm2 stop nexus-api-green
pm2 stop nexus-web-green

# Restore database from backup
psql $DATABASE_URL < backup-pre-deployment.sql

# Verify rollback
curl https://api.example.com/api/monitoring/health

# Notify team
# Post to Slack #incidents channel
```

### Database Rollback

```bash
# If migrations caused issues
npx prisma migrate resolve --rolled-back migration-name

# Restore from backup
pg_restore -d nexus_production backup-pre-deployment.sql

# Verify data integrity
psql $DATABASE_URL -c "SELECT COUNT(*) FROM Product;"
```

## Production Monitoring

### Key Metrics to Monitor

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| API Response Time | < 100ms | > 500ms |
| Error Rate | < 0.1% | > 1% |
| Sync Success Rate | > 95% | < 80% |
| Database Query Time | < 50ms | > 200ms |
| Memory Usage | < 60% | > 80% |
| CPU Usage | < 40% | > 70% |
| Disk Usage | < 70% | > 85% |

### Monitoring Dashboard

Access production monitoring:
```
https://app.example.com/monitoring
```

### Log Aggregation

View logs in Elasticsearch:
```
https://kibana.example.com/app/kibana#/discover
```

### Alerts

Configure alerts in Slack:
```bash
# Critical alerts
#production-critical-alerts

# Warning alerts
#production-alerts

# Info alerts
#production-info
```

## Post-Deployment Tasks

### Day 1
- [ ] Monitor error rates
- [ ] Check sync performance
- [ ] Verify alert system
- [ ] Review logs for issues
- [ ] Confirm user feedback

### Day 3
- [ ] Review performance metrics
- [ ] Check database growth
- [ ] Verify backup completion
- [ ] Update documentation
- [ ] Team retrospective

### Week 1
- [ ] Analyze sync metrics
- [ ] Optimize slow queries
- [ ] Review alert thresholds
- [ ] Plan next improvements
- [ ] Update runbooks

## Incident Response

### If Issues Occur

1. **Assess Severity**
   - Critical: Immediate rollback
   - High: Investigate, may rollback
   - Medium: Monitor, fix in next release
   - Low: Document, fix in next release

2. **Communicate**
   - Post to #incidents channel
   - Notify on-call engineer
   - Update status page
   - Inform customers if needed

3. **Investigate**
   - Check logs
   - Review metrics
   - Check recent changes
   - Identify root cause

4. **Resolve**
   - Apply fix or rollback
   - Verify resolution
   - Monitor for recurrence
   - Document incident

## Maintenance Windows

### Scheduled Maintenance

```bash
# Update status page
# Notify users 24 hours in advance
# Schedule during low-traffic period

# Perform maintenance
# Monitor closely
# Verify all systems

# Post-maintenance verification
# Update status page
# Send completion notification
```

### Database Maintenance

```bash
# Weekly
VACUUM ANALYZE;
REINDEX;

# Monthly
pg_dump > backup-monthly.sql;
```

## Security Hardening

### API Security
```bash
# Enable rate limiting
# Configure CORS
# Enable HTTPS only
# Set security headers
```

### Database Security
```bash
# Enable SSL connections
# Configure firewall rules
# Enable audit logging
# Regular backups
```

### Application Security
```bash
# Enable authentication
# Implement authorization
# Validate all inputs
# Sanitize outputs
```

## Performance Optimization

### Caching Strategy
```bash
# Redis for session cache
# CDN for static assets
# Database query caching
# API response caching
```

### Database Optimization
```bash
# Create indexes
# Optimize queries
# Archive old data
# Monitor slow queries
```

### Application Optimization
```bash
# Code splitting
# Lazy loading
# Image optimization
# Minification
```

## Sign-Off Checklist

- [ ] All pre-deployment checks passed
- [ ] Staging validation complete
- [ ] Database backup created
- [ ] Monitoring configured
- [ ] Alerts tested
- [ ] Rollback plan documented
- [ ] Team trained on deployment
- [ ] Deployment window scheduled
- [ ] Status page updated
- [ ] Customers notified
- [ ] Deployment approved by:
  - [ ] Backend Lead
  - [ ] Frontend Lead
  - [ ] DevOps Lead
  - [ ] Product Manager

## Support Contacts

**On-Call Engineer:** [Name] - [Phone]
**DevOps Lead:** [Name] - [Phone]
**Product Manager:** [Name] - [Phone]

**Escalation:**
1. On-call engineer
2. DevOps lead
3. Engineering manager
4. VP Engineering

## Documentation

- [Monitoring Guide](./SYNC-MONITORING-GUIDE.md)
- [Troubleshooting Guide](./AMAZON-SYNC-TROUBLESHOOTING.md)
- [API Documentation](./AMAZON-SYNC-API.md)
- [Architecture Guide](./AMAZON-SYNC-IMPLEMENTATION.md)

## Post-Deployment Review

Schedule review meeting 1 week after deployment:
- Review metrics and performance
- Discuss any issues encountered
- Plan improvements
- Update documentation
- Celebrate successful deployment
