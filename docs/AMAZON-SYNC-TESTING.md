# Amazon Sync Testing Guide

This document provides comprehensive testing guidance for the Amazon Sync feature.

## Test Files Created

### 1. Unit Tests
**File:** `apps/api/src/services/__tests__/amazon-sync.service.test.ts`

Tests for individual methods and functions:
- `identifyParentChildRelationships()` - Parent/child relationship detection
- `detectFulfillmentChannel()` - Fulfillment channel detection
- `extractShippingTemplate()` - Shipping template extraction
- `validateProduct()` - Product validation logic
- Sync ID generation
- Error tracking
- Statistics tracking

**Test Coverage:**
- ✅ Parent identification with variations
- ✅ Child identification with parentAsin
- ✅ Standalone product identification
- ✅ Mixed product type handling
- ✅ Fulfillment channel detection (FBA/FBM)
- ✅ Shipping template extraction
- ✅ Product validation (all required fields)
- ✅ Unique sync ID generation
- ✅ Error tracking initialization
- ✅ Statistics initialization

### 2. Integration Tests
**File:** `apps/api/src/services/__tests__/amazon-sync.integration.test.ts`

Tests for complete sync workflows with database:
- Full sync workflow with parents and children
- Standalone product syncing
- Product updates
- Mixed product type syncing
- Sync logging to database
- Error handling
- Parent-child relationship linking

**Test Coverage:**
- ✅ Parent and child product creation
- ✅ Standalone product creation
- ✅ Product updates (price, stock, name)
- ✅ Mixed product type handling
- ✅ Sync log creation and tracking
- ✅ Database error handling
- ✅ Parent-child relationship verification
- ✅ Child linking to parents

### 3. Mock Data
**File:** `apps/api/src/services/__tests__/mock-amazon-data.ts`

Comprehensive mock data for testing:

#### Basic Mock Products
- Premium Wireless Headphones (parent with 3 variations)
- Smart Watch Pro (parent with 2 variations)
- USB-C Cable 6ft (standalone)
- Phone Screen Protector (standalone)
- Phone Case Universal (parent with 5 variations)

#### Edge Case Products
- Very long product titles
- Very high prices
- Zero stock items
- Special characters in SKU
- Duplicate ASINs

#### Performance Testing
- `generateLargeDataset(count)` - Generate large datasets for performance testing
- Default: 1000 products with random parent/child distribution

## Running Tests

### Prerequisites
```bash
# Install test dependencies
npm install --save-dev vitest @vitest/ui

# Install database test utilities
npm install --save-dev @prisma/internals
```

### Run Unit Tests
```bash
# Run all unit tests
npm run test

# Run specific test file
npm run test amazon-sync.service.test.ts

# Run with coverage
npm run test -- --coverage

# Run in watch mode
npm run test -- --watch
```

### Run Integration Tests
```bash
# Run integration tests (requires database)
npm run test:integration

# Run specific integration test
npm run test:integration amazon-sync.integration.test.ts

# Run with verbose output
npm run test:integration -- --reporter=verbose
```

### Run All Tests
```bash
# Run all tests
npm run test:all

# Run with coverage report
npm run test:all -- --coverage
```

## Test Scenarios

### Scenario 1: Basic Parent-Child Sync
**Input:** 1 parent with 2 variations
**Expected Output:**
- 1 parent created with `isParent: true`
- 2 children created with `parentId` set
- Total processed: 3
- Errors: 0

### Scenario 2: Standalone Products
**Input:** 2 standalone products
**Expected Output:**
- 2 products created with `isParent: false`
- No parent-child relationships
- Total processed: 2
- Errors: 0

### Scenario 3: Mixed Products
**Input:** 2 parents (with variations) + 1 standalone
**Expected Output:**
- 2 parents created
- 3 children created
- 1 standalone created
- Total processed: 6
- Errors: 0

### Scenario 4: Product Updates
**Input:** Existing product with updated price/stock
**Expected Output:**
- Product updated (not created)
- Updated count incremented
- New values reflected in database

### Scenario 5: Invalid Products
**Input:** Products missing required fields
**Expected Output:**
- Validation fails
- Error messages returned
- No products created

### Scenario 6: Large Dataset
**Input:** 1000 products with random distribution
**Expected Output:**
- All products processed
- Performance metrics recorded
- Sync completes within acceptable time

## Performance Benchmarks

Expected performance metrics:

| Metric | Target | Acceptable Range |
|--------|--------|------------------|
| 100 products | < 2 seconds | < 3 seconds |
| 1000 products | < 15 seconds | < 20 seconds |
| 10000 products | < 120 seconds | < 150 seconds |
| Memory usage (1000 products) | < 100MB | < 150MB |

## Error Handling Tests

### Test Case 1: Missing Required Fields
```typescript
const product = {
  title: "Test Product",
  sku: "TEST-001"
  // Missing ASIN
};

// Expected: Validation error "Missing ASIN"
```

### Test Case 2: Database Constraint Violation
```typescript
// Create product with duplicate SKU
// Expected: Graceful error handling, sync continues
```

### Test Case 3: Transaction Rollback
```typescript
// Simulate database error during sync
// Expected: Transaction rolls back, no partial data
```

## Database Verification

After running tests, verify database state:

```sql
-- Check parent products
SELECT COUNT(*) as parent_count 
FROM "Product" 
WHERE "isParent" = true AND "parentId" IS NULL;

-- Check child products
SELECT COUNT(*) as child_count 
FROM "Product" 
WHERE "parentId" IS NOT NULL;

-- Check parent-child relationships
SELECT p.sku as parent_sku, COUNT(c.id) as child_count
FROM "Product" p
LEFT JOIN "Product" c ON c."parentId" = p.id
WHERE p."isParent" = true
GROUP BY p.id, p.sku
ORDER BY child_count DESC;

-- Check sync logs
SELECT * FROM "SyncLog" 
ORDER BY "createdAt" DESC 
LIMIT 10;
```

## Continuous Integration

### GitHub Actions Workflow
```yaml
name: Test Amazon Sync

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run unit tests
        run: npm run test
      
      - name: Run integration tests
        run: npm run test:integration
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

## Test Coverage Goals

- **Unit Tests:** 90%+ coverage
- **Integration Tests:** 80%+ coverage
- **Overall:** 85%+ coverage

## Debugging Tests

### Enable Debug Logging
```typescript
// In test file
import { logger } from "../../utils/logger.js";

beforeEach(() => {
  logger.setLevel("debug");
});
```

### Inspect Database State
```typescript
// In test
const product = await prisma.product.findUnique({
  where: { sku: "TEST-001" },
  include: { children: true }
});
console.log(JSON.stringify(product, null, 2));
```

### Check Sync Logs
```typescript
// In test
const syncLog = await prisma.syncLog.findUnique({
  where: { syncId: result.syncId }
});
console.log("Sync details:", syncLog.details);
```

## Known Issues and Workarounds

### Issue 1: Vitest Not Installed
**Solution:** Install vitest and related packages
```bash
npm install --save-dev vitest @vitest/ui
```

### Issue 2: Prisma Schema Missing Fields
**Solution:** Ensure Prisma schema has:
- `isParent` field on Product
- `parentId` field on Product
- `children` relation on Product
- `SyncLog` model

### Issue 3: Database Connection Issues
**Solution:** Verify DATABASE_URL is set correctly
```bash
echo $DATABASE_URL
```

## Next Steps

1. Install test dependencies
2. Run unit tests to verify logic
3. Run integration tests with test database
4. Generate coverage reports
5. Set up CI/CD pipeline
6. Monitor test performance

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Prisma Testing Guide](https://www.prisma.io/docs/guides/testing)
- [Jest Matchers](https://jestjs.io/docs/expect)
