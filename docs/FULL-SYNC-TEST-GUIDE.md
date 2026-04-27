# Full Sync Test Guide

## Overview

This guide provides comprehensive testing procedures for the Amazon Catalog Sync feature. It covers unit tests, integration tests, end-to-end tests, and performance benchmarks.

## Test Environment Setup

### Prerequisites
- Staging environment deployed and running
- Test database with sample data
- Mock Amazon API data available
- Monitoring system active
- Slack/Email notifications configured

### Test Data Preparation

```bash
# Navigate to database package
cd packages/database

# Seed test data
npx prisma db seed

# Verify test data
npx prisma studio
```

## Unit Tests

### Running Unit Tests

```bash
# Navigate to API
cd apps/api

# Run unit tests
npm test -- amazon-sync.service.test.ts

# Run with coverage
npm test -- amazon-sync.service.test.ts --coverage

# Run specific test
npm test -- amazon-sync.service.test.ts -t "identifyParentChildRelationships"
```

### Unit Test Coverage

**Parent/Child Identification:**
```bash
npm test -- amazon-sync.service.test.ts -t "identifyParentChildRelationships"
```
Expected: ✓ Correctly identifies parent products
Expected: ✓ Correctly identifies child variations
Expected: ✓ Handles standalone products

**Fulfillment Detection:**
```bash
npm test -- amazon-sync.service.test.ts -t "detectFulfillmentChannel"
```
Expected: ✓ Detects FBA fulfillment
Expected: ✓ Detects FBM fulfillment
Expected: ✓ Defaults to FBA when not specified

**Shipping Template Extraction:**
```bash
npm test -- amazon-sync.service.test.ts -t "extractShippingTemplate"
```
Expected: ✓ Extracts shipping template name
Expected: ✓ Returns null when not available
Expected: ✓ Handles special characters

**Product Validation:**
```bash
npm test -- amazon-sync.service.test.ts -t "validateProduct"
```
Expected: ✓ Validates required fields
Expected: ✓ Detects invalid data
Expected: ✓ Returns helpful error messages

## Integration Tests

### Running Integration Tests

```bash
# Navigate to API
cd apps/api

# Run integration tests
npm test -- amazon-sync.integration.test.ts

# Run with coverage
npm test -- amazon-sync.integration.test.ts --coverage

# Run specific test
npm test -- amazon-sync.integration.test.ts -t "Full sync workflow"
```

### Integration Test Scenarios

**Scenario 1: Full Sync Workflow**
```bash
npm test -- amazon-sync.integration.test.ts -t "Full sync workflow"
```

Test Steps:
1. Create 5 parent products with variations
2. Trigger sync
3. Verify parents created with `isParent = true`
4. Verify children created with `parentId` set
5. Verify `subRows` populated correctly
6. Verify sync log created

Expected Results:
- ✓ 5 parents created
- ✓ 10 children created
- ✓ All relationships correct
- ✓ Sync log status = SUCCESS

**Scenario 2: Standalone Products**
```bash
npm test -- amazon-sync.integration.test.ts -t "Standalone products"
```

Test Steps:
1. Create 3 standalone products (no variations)
2. Trigger sync
3. Verify products created with `isParent = false`
4. Verify no `parentId` set
5. Verify no children created

Expected Results:
- ✓ 3 products created
- ✓ All have `isParent = false`
- ✓ No parent-child relationships

**Scenario 3: Product Updates**
```bash
npm test -- amazon-sync.integration.test.ts -t "Product updates"
```

Test Steps:
1. Create initial products
2. Update product data
3. Trigger sync again
4. Verify products updated (not duplicated)
5. Verify relationships maintained

Expected Results:
- ✓ Products updated, not duplicated
- ✓ Relationships preserved
- ✓ Sync log shows updates

**Scenario 4: Mixed Product Types**
```bash
npm test -- amazon-sync.integration.test.ts -t "Mixed product types"
```

Test Steps:
1. Create mix of parents, children, and standalone
2. Trigger sync
3. Verify all types handled correctly
4. Verify relationships correct

Expected Results:
- ✓ All product types synced
- ✓ Relationships correct
- ✓ No data loss

**Scenario 5: Error Handling**
```bash
npm test -- amazon-sync.integration.test.ts -t "Error handling"
```

Test Steps:
1. Create products with invalid data
2. Trigger sync
3. Verify errors captured
4. Verify partial sync continues
5. Verify error log created

Expected Results:
- ✓ Errors captured
- ✓ Sync continues
- ✓ Error details logged

## End-to-End Tests

### Manual E2E Testing

#### Test 1: Trigger Sync via API

```bash
# Trigger sync
curl -X POST http://localhost:3001/api/sync/amazon/catalog \
  -H "Content-Type: application/json" \
  -d '{
    "products": [
      {
        "sku": "TEST-PARENT-001",
        "name": "Test Parent Product",
        "asin": "B001",
        "price": 99.99,
        "stock": 100,
        "variations": [
          {
            "sku": "TEST-CHILD-001",
            "name": "Size",
            "value": "Large",
            "asin": "B001-L",
            "price": 99.99,
            "stock": 50
          },
          {
            "sku": "TEST-CHILD-002",
            "name": "Size",
            "value": "Small",
            "asin": "B001-S",
            "price": 99.99,
            "stock": 50
          }
        ]
      }
    ]
  }'

# Expected Response:
# {
#   "success": true,
#   "syncId": "sync-abc123",
#   "message": "Sync started",
#   "status": "PENDING"
# }
```

#### Test 2: Monitor Sync Progress

```bash
# Get sync status
curl http://localhost:3001/api/sync/amazon/catalog/sync-abc123

# Expected Response:
# {
#   "success": true,
#   "data": {
#     "id": "sync-abc123",
#     "status": "IN_PROGRESS",
#     "itemsProcessed": 3,
#     "itemsSuccessful": 3,
#     "itemsFailed": 0,
#     "progress": 100
#   }
# }
```

#### Test 3: Check Monitoring Dashboard

1. Open http://localhost:3000/monitoring
2. Verify health status shows "healthy"
3. Verify metrics updated:
   - Total syncs: 1
   - Successful syncs: 1
   - Products processed: 3
   - Success rate: 100%

#### Test 4: Verify Database

```bash
# Check parent products
psql $DATABASE_URL -c "SELECT id, sku, name, isParent FROM Product WHERE isParent = true;"

# Check child products
psql $DATABASE_URL -c "SELECT id, sku, parentId FROM Product WHERE parentId IS NOT NULL;"

# Check sync logs
psql $DATABASE_URL -c "SELECT id, status, itemsProcessed, itemsSuccessful FROM SyncLog ORDER BY createdAt DESC LIMIT 5;"
```

#### Test 5: Verify Frontend Display

1. Navigate to Inventory page
2. Verify 216 rows displayed (or your test count)
3. Verify expander arrows on parents only
4. Click expander arrow
5. Verify children display under parent
6. Verify child rows indented

#### Test 6: Test Alerts

Trigger failure rate alert:
```bash
# Create sync with high failure rate
curl -X POST http://localhost:3001/api/sync/amazon/catalog \
  -H "Content-Type: application/json" \
  -d '{
    "products": [
      {
        "sku": "INVALID-001",
        "name": null,  // Invalid: required field
        "asin": "B999"
      }
    ]
  }'

# Check Slack channel #staging-sync-alerts
# Expected: Alert message about high failure rate
```

## Performance Testing

### Load Testing

```bash
# Install Apache Bench
brew install httpd

# Test API response time
ab -n 100 -c 10 http://localhost:3001/api/monitoring/health

# Expected: < 200ms average response time
```

### Sync Performance Benchmark

```bash
# Test with 100 products
time curl -X POST http://localhost:3001/api/sync/amazon/catalog \
  -H "Content-Type: application/json" \
  -d @test-data-100.json

# Test with 500 products
time curl -X POST http://localhost:3001/api/sync/amazon/catalog \
  -H "Content-Type: application/json" \
  -d @test-data-500.json

# Test with 1000 products
time curl -X POST http://localhost:3001/api/sync/amazon/catalog \
  -H "Content-Type: application/json" \
  -d @test-data-1000.json
```

### Expected Performance Metrics

| Metric | Target | Acceptable |
|--------|--------|-----------|
| API Response Time | < 100ms | < 200ms |
| Sync Duration (100 items) | < 5s | < 10s |
| Sync Duration (500 items) | < 20s | < 30s |
| Sync Duration (1000 items) | < 40s | < 60s |
| Memory Usage | < 300MB | < 500MB |
| CPU Usage | < 30% | < 50% |
| Database Query Time | < 50ms | < 100ms |

### Monitor Performance

```bash
# Watch system resources during sync
watch -n 1 'ps aux | grep node'

# Monitor database connections
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity;"

# Check slow queries
psql $DATABASE_URL -c "SELECT query, mean_time FROM pg_stat_statements ORDER BY mean_time DESC LIMIT 10;"
```

## Regression Testing

### Test Existing Features

Verify that new sync feature doesn't break existing functionality:

```bash
# Test inventory page still works
curl http://localhost:3000/inventory

# Test product details page
curl http://localhost:3000/products/product-id

# Test bulk actions
curl -X POST http://localhost:3001/api/bulk-actions \
  -H "Content-Type: application/json" \
  -d '{"action": "update", "productIds": ["id1", "id2"]}'

# Test pricing rules
curl http://localhost:3001/api/pricing-rules
```

## Test Results Documentation

### Test Report Template

```markdown
# Sync Feature Test Report
Date: 2026-04-24
Environment: Staging
Tester: [Name]

## Unit Tests
- Parent/Child Identification: ✓ PASS
- Fulfillment Detection: ✓ PASS
- Shipping Template: ✓ PASS
- Product Validation: ✓ PASS

## Integration Tests
- Full Sync Workflow: ✓ PASS
- Standalone Products: ✓ PASS
- Product Updates: ✓ PASS
- Mixed Types: ✓ PASS
- Error Handling: ✓ PASS

## E2E Tests
- API Trigger: ✓ PASS
- Progress Monitoring: ✓ PASS
- Dashboard Display: ✓ PASS
- Database Verification: ✓ PASS
- Frontend Display: ✓ PASS
- Alert Triggering: ✓ PASS

## Performance Tests
- API Response Time: 85ms (Target: < 100ms) ✓ PASS
- Sync 100 items: 4.2s (Target: < 5s) ✓ PASS
- Sync 500 items: 18.5s (Target: < 20s) ✓ PASS
- Memory Usage: 280MB (Target: < 300MB) ✓ PASS

## Issues Found
None

## Sign-Off
- Backend Lead: ___________
- QA Lead: ___________
- DevOps: ___________
```

## Continuous Testing

### Automated Test Suite

```bash
# Run all tests
npm test

# Run tests with coverage
npm test -- --coverage

# Run tests in watch mode
npm test -- --watch

# Run tests with specific pattern
npm test -- --testPathPattern="sync"
```

### CI/CD Integration

Add to `.github/workflows/test.yml`:

```yaml
name: Test Suite

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v2
      
      - name: Setup Node
        uses: actions/setup-node@v2
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm install
      
      - name: Run unit tests
        run: npm test -- amazon-sync.service.test.ts
      
      - name: Run integration tests
        run: npm test -- amazon-sync.integration.test.ts
      
      - name: Upload coverage
        uses: codecov/codecov-action@v2
```

## Troubleshooting Test Failures

### Test Timeout
```bash
# Increase timeout
npm test -- --testTimeout=10000

# Check for hanging connections
psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity WHERE state = 'idle in transaction';"
```

### Database Connection Errors
```bash
# Verify database is running
psql $DATABASE_URL -c "SELECT 1;"

# Check connection string
echo $DATABASE_URL

# Reset database
npx prisma migrate reset
```

### Mock Data Issues
```bash
# Verify mock data file
cat apps/api/src/services/__tests__/mock-amazon-data.ts

# Check data format
npm test -- amazon-sync.service.test.ts -t "validateProduct"
```

## Sign-Off Checklist

- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] All E2E tests passing
- [ ] Performance benchmarks met
- [ ] No regressions detected
- [ ] Monitoring system working
- [ ] Alerts triggering correctly
- [ ] Database integrity verified
- [ ] Frontend displays correctly
- [ ] Documentation accurate
- [ ] Test report completed
- [ ] Approved by QA Lead
- [ ] Approved by Backend Lead
- [ ] Approved by DevOps

## Next Steps

Once all tests pass:
1. Review test results with team
2. Address any issues found
3. Update documentation if needed
4. Proceed to production deployment
5. Set up production monitoring
6. Schedule post-deployment review
