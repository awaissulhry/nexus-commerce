# Integration Testing Guide

**Version**: 1.0.0  
**Last Updated**: 2026-04-23

---

## Table of Contents

1. [Overview](#overview)
2. [Test Environment Setup](#test-environment-setup)
3. [Unit Tests](#unit-tests)
4. [Integration Tests](#integration-tests)
5. [End-to-End Tests](#end-to-end-tests)
6. [Performance Tests](#performance-tests)
7. [Test Data](#test-data)
8. [CI/CD Integration](#cicd-integration)

---

## Overview

The integration testing suite ensures that marketplace integrations work correctly across all channels. Tests cover:

- **Unit Tests**: Individual service methods
- **Integration Tests**: Multi-service interactions
- **End-to-End Tests**: Complete workflows
- **Performance Tests**: Load and stress testing

### Test Coverage Goals

- **Services**: 80%+ coverage
- **Routes**: 90%+ coverage
- **Critical paths**: 100% coverage

---

## Test Environment Setup

### Prerequisites

```bash
# Install testing dependencies
npm install --save-dev jest @types/jest ts-jest supertest @types/supertest

# Install test utilities
npm install --save-dev @testing-library/react @testing-library/jest-dom
```

### Jest Configuration

Create `jest.config.js`:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};
```

### Test Database Setup

```typescript
// tests/setup.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

beforeAll(async () => {
  // Run migrations
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  // Run migrations
});

afterAll(async () => {
  await prisma.$disconnect();
});

export { prisma };
```

---

## Unit Tests

### Marketplace Service Tests

Create `apps/api/src/services/marketplaces/__tests__/marketplace.service.test.ts`:

```typescript
import { MarketplaceService } from '../marketplace.service';
import { ShopifyService } from '../shopify.service';
import { WooCommerceService } from '../woocommerce.service';
import { EtsyService } from '../etsy.service';

describe('MarketplaceService', () => {
  let service: MarketplaceService;

  beforeEach(() => {
    service = new MarketplaceService();
  });

  describe('getService', () => {
    it('should return Shopify service for SHOPIFY channel', () => {
      const shopifyService = service.getService('SHOPIFY');
      expect(shopifyService).toBeInstanceOf(ShopifyService);
    });

    it('should return WooCommerce service for WOOCOMMERCE channel', () => {
      const wooService = service.getService('WOOCOMMERCE');
      expect(wooService).toBeInstanceOf(WooCommerceService);
    });

    it('should return Etsy service for ETSY channel', () => {
      const etsyService = service.getService('ETSY');
      expect(etsyService).toBeInstanceOf(EtsyService);
    });

    it('should throw error for unknown channel', () => {
      expect(() => service.getService('UNKNOWN')).toThrow();
    });
  });

  describe('isMarketplaceAvailable', () => {
    it('should return true for configured marketplace', () => {
      const isAvailable = service.isMarketplaceAvailable('SHOPIFY');
      expect(isAvailable).toBe(true);
    });

    it('should return false for unconfigured marketplace', () => {
      const isAvailable = service.isMarketplaceAvailable('UNKNOWN');
      expect(isAvailable).toBe(false);
    });
  });

  describe('getAvailableMarketplaces', () => {
    it('should return list of available marketplaces', () => {
      const marketplaces = service.getAvailableMarketplaces();
      expect(Array.isArray(marketplaces)).toBe(true);
      expect(marketplaces.length).toBeGreaterThan(0);
    });
  });

  describe('batchUpdatePrices', () => {
    it('should update prices across multiple channels', async () => {
      const updates = [
        {
          channel: 'SHOPIFY',
          channelVariantId: 'gid://shopify/ProductVariant/123',
          price: 29.99,
        },
        {
          channel: 'WOOCOMMERCE',
          channelVariantId: '456',
          channelProductId: '789',
          price: 29.99,
        },
      ];

      const result = await service.batchUpdatePrices(updates);

      expect(result.success).toBe(true);
      expect(result.summary.total).toBe(2);
      expect(result.summary.successful).toBeGreaterThan(0);
    });

    it('should handle partial failures', async () => {
      const updates = [
        {
          channel: 'SHOPIFY',
          channelVariantId: 'invalid',
          price: 29.99,
        },
        {
          channel: 'WOOCOMMERCE',
          channelVariantId: '456',
          channelProductId: '789',
          price: 29.99,
        },
      ];

      const result = await service.batchUpdatePrices(updates);

      expect(result.summary.total).toBe(2);
      expect(result.summary.failed).toBeGreaterThan(0);
    });

    it('should retry failed updates', async () => {
      const updates = [
        {
          channel: 'SHOPIFY',
          channelVariantId: 'gid://shopify/ProductVariant/123',
          price: 29.99,
        },
      ];

      const result = await service.batchUpdatePrices(updates, 3);

      expect(result.summary.total).toBe(1);
    });
  });

  describe('getMarketplaceHealthStatus', () => {
    it('should return health status for all marketplaces', async () => {
      const statuses = await service.getMarketplaceHealthStatus();

      expect(Array.isArray(statuses)).toBe(true);
      expect(statuses.length).toBeGreaterThan(0);

      statuses.forEach(status => {
        expect(status).toHaveProperty('channel');
        expect(status).toHaveProperty('isAvailable');
        expect(status).toHaveProperty('responseTime');
      });
    });

    it('should measure response time', async () => {
      const statuses = await service.getMarketplaceHealthStatus();

      statuses.forEach(status => {
        expect(typeof status.responseTime).toBe('number');
        expect(status.responseTime).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
```

### Shopify Service Tests

Create `apps/api/src/services/marketplaces/__tests__/shopify.service.test.ts`:

```typescript
import { ShopifyService } from '../shopify.service';

describe('ShopifyService', () => {
  let service: ShopifyService;

  beforeEach(() => {
    service = new ShopifyService();
  });

  describe('getProducts', () => {
    it('should fetch products from Shopify', async () => {
      const products = await service.getProducts();

      expect(Array.isArray(products)).toBe(true);
      products.forEach(product => {
        expect(product).toHaveProperty('id');
        expect(product).toHaveProperty('title');
        expect(product).toHaveProperty('variants');
      });
    });

    it('should handle pagination', async () => {
      const products = await service.getProducts({ limit: 10 });

      expect(products.length).toBeLessThanOrEqual(10);
    });
  });

  describe('updatePrice', () => {
    it('should update variant price', async () => {
      const result = await service.updatePrice({
        channelVariantId: 'gid://shopify/ProductVariant/123',
        price: 29.99,
      });

      expect(result.success).toBe(true);
      expect(result.newPrice).toBe(29.99);
    });

    it('should handle invalid variant ID', async () => {
      const result = await service.updatePrice({
        channelVariantId: 'invalid',
        price: 29.99,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('updateInventory', () => {
    it('should update inventory quantity', async () => {
      const result = await service.updateInventory({
        channelVariantId: 'gid://shopify/ProductVariant/123',
        quantity: 50,
      });

      expect(result.success).toBe(true);
      expect(result.newQuantity).toBe(50);
    });
  });
});
```

---

## Integration Tests

### Marketplace Routes Tests

Create `apps/api/src/routes/__tests__/marketplaces.test.ts`:

```typescript
import request from 'supertest';
import app from '../../index';

describe('Marketplace Routes', () => {
  describe('GET /marketplaces/health', () => {
    it('should return health status of all marketplaces', async () => {
      const response = await request(app)
        .get('/marketplaces/health')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('statuses');
      expect(Array.isArray(response.body.statuses)).toBe(true);

      response.body.statuses.forEach((status: any) => {
        expect(status).toHaveProperty('channel');
        expect(status).toHaveProperty('isAvailable');
        expect(status).toHaveProperty('responseTime');
      });
    });

    it('should include timestamp', async () => {
      const response = await request(app)
        .get('/marketplaces/health')
        .expect(200);

      expect(response.body).toHaveProperty('timestamp');
      expect(new Date(response.body.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe('POST /marketplaces/products/:productId/sync', () => {
    it('should sync product across channels', async () => {
      const response = await request(app)
        .post('/marketplaces/products/prod_123/sync')
        .send({
          channels: ['SHOPIFY', 'WOOCOMMERCE'],
        })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('productId', 'prod_123');
      expect(response.body).toHaveProperty('summary');
      expect(response.body.summary).toHaveProperty('total');
      expect(response.body.summary).toHaveProperty('successful');
      expect(response.body.summary).toHaveProperty('failed');
    });

    it('should validate channel list', async () => {
      const response = await request(app)
        .post('/marketplaces/products/prod_123/sync')
        .send({
          channels: [],
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });

    it('should handle invalid product ID', async () => {
      const response = await request(app)
        .post('/marketplaces/products/invalid/sync')
        .send({
          channels: ['SHOPIFY'],
        })
        .expect(404);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('POST /marketplaces/prices/update', () => {
    it('should update prices across channels', async () => {
      const response = await request(app)
        .post('/marketplaces/prices/update')
        .send({
          updates: [
            {
              channel: 'SHOPIFY',
              channelVariantId: 'gid://shopify/ProductVariant/123',
              price: 29.99,
            },
            {
              channel: 'WOOCOMMERCE',
              channelVariantId: '456',
              channelProductId: '789',
              price: 29.99,
            },
          ],
        })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('summary');
      expect(response.body).toHaveProperty('results');
    });

    it('should validate price format', async () => {
      const response = await request(app)
        .post('/marketplaces/prices/update')
        .send({
          updates: [
            {
              channel: 'SHOPIFY',
              channelVariantId: 'gid://shopify/ProductVariant/123',
              price: -10,
            },
          ],
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('POST /marketplaces/inventory/update', () => {
    it('should update inventory across channels', async () => {
      const response = await request(app)
        .post('/marketplaces/inventory/update')
        .send({
          updates: [
            {
              channel: 'SHOPIFY',
              channelVariantId: 'gid://shopify/ProductVariant/123',
              quantity: 50,
            },
            {
              channel: 'WOOCOMMERCE',
              channelVariantId: '456',
              channelProductId: '789',
              quantity: 50,
            },
          ],
        })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('summary');
    });

    it('should validate quantity', async () => {
      const response = await request(app)
        .post('/marketplaces/inventory/update')
        .send({
          updates: [
            {
              channel: 'SHOPIFY',
              channelVariantId: 'gid://shopify/ProductVariant/123',
              quantity: -5,
            },
          ],
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });
});
```

---

## End-to-End Tests

### Complete Workflow Tests

Create `apps/api/src/__tests__/e2e/marketplace-sync.e2e.test.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import { MarketplaceService } from '../../services/marketplaces/marketplace.service';
import { UnifiedSyncOrchestrator } from '../../services/sync/unified-sync-orchestrator';

describe('End-to-End: Marketplace Sync Workflow', () => {
  let prisma: PrismaClient;
  let marketplaceService: MarketplaceService;
  let syncOrchestrator: UnifiedSyncOrchestrator;

  beforeAll(async () => {
    prisma = new PrismaClient();
    marketplaceService = new MarketplaceService();
    syncOrchestrator = new UnifiedSyncOrchestrator();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Product Sync Workflow', () => {
    it('should sync product across all channels', async () => {
      // Create test product
      const product = await prisma.product.create({
        data: {
          title: 'Test Product',
          sku: 'TEST-001',
          description: 'Test Description',
          price: 29.99,
          quantity: 100,
        },
      });

      // Sync to all channels
      const result = await syncOrchestrator.syncProductAcrossChannels(
        product.id,
        ['SHOPIFY', 'WOOCOMMERCE', 'ETSY']
      );

      expect(result.success).toBe(true);
      expect(result.summary.total).toBe(3);
      expect(result.summary.successful).toBeGreaterThan(0);

      // Verify channel listings created
      const listings = await prisma.channelListing.findMany({
        where: { productId: product.id },
      });

      expect(listings.length).toBeGreaterThan(0);
    });

    it('should handle sync failures gracefully', async () => {
      const product = await prisma.product.create({
        data: {
          title: 'Test Product',
          sku: 'TEST-002',
          description: 'Test Description',
          price: 29.99,
          quantity: 100,
        },
      });

      const result = await syncOrchestrator.syncProductAcrossChannels(
        product.id,
        ['SHOPIFY', 'INVALID_CHANNEL']
      );

      expect(result.summary.total).toBe(2);
      expect(result.summary.failed).toBeGreaterThan(0);
    });
  });

  describe('Inventory Sync Workflow', () => {
    it('should sync inventory across channels', async () => {
      const product = await prisma.product.create({
        data: {
          title: 'Test Product',
          sku: 'TEST-003',
          description: 'Test Description',
          price: 29.99,
          quantity: 100,
        },
      });

      const variant = await prisma.productVariation.create({
        data: {
          productId: product.id,
          title: 'Default',
          sku: 'TEST-003-VAR',
          price: 29.99,
          quantity: 100,
        },
      });

      const result = await syncOrchestrator.syncInventoryAcrossChannels(
        variant.id,
        50
      );

      expect(result.success).toBe(true);
      expect(result.summary.successful).toBeGreaterThan(0);
    });
  });

  describe('Multi-Channel Sync Workflow', () => {
    it('should sync all products across all channels', async () => {
      // Create test products
      const products = await Promise.all([
        prisma.product.create({
          data: {
            title: 'Product 1',
            sku: 'TEST-004',
            description: 'Test',
            price: 29.99,
            quantity: 100,
          },
        }),
        prisma.product.create({
          data: {
            title: 'Product 2',
            sku: 'TEST-005',
            description: 'Test',
            price: 39.99,
            quantity: 50,
          },
        }),
      ]);

      const result = await syncOrchestrator.syncAllMarketplaces();

      expect(result.success).toBe(true);
      expect(result.summary.totalChannels).toBeGreaterThan(0);
    });
  });
});
```

---

## Performance Tests

### Load Testing

Create `apps/api/src/__tests__/performance/load.test.ts`:

```typescript
import { MarketplaceService } from '../../services/marketplaces/marketplace.service';

describe('Performance: Load Testing', () => {
  let service: MarketplaceService;

  beforeEach(() => {
    service = new MarketplaceService();
  });

  describe('Batch Price Updates', () => {
    it('should handle 1000 price updates', async () => {
      const updates = Array.from({ length: 1000 }, (_, i) => ({
        channel: 'SHOPIFY',
        channelVariantId: `gid://shopify/ProductVariant/${i}`,
        price: 29.99 + i * 0.01,
      }));

      const startTime = Date.now();
      const result = await service.batchUpdatePrices(updates);
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(30000); // Should complete in 30 seconds
    });
  });

  describe('Concurrent Requests', () => {
    it('should handle concurrent health checks', async () => {
      const requests = Array.from({ length: 100 }, () =>
        service.getMarketplaceHealthStatus()
      );

      const startTime = Date.now();
      const results = await Promise.all(requests);
      const duration = Date.now() - startTime;

      expect(results.length).toBe(100);
      expect(duration).toBeLessThan(10000); // Should complete in 10 seconds
    });
  });
});
```

---

## Test Data

### Fixtures

Create `apps/api/src/__tests__/fixtures/marketplace-data.ts`:

```typescript
export const shopifyProductFixture = {
  id: 632910392,
  title: 'Test Product',
  handle: 'test-product',
  vendor: 'Test Vendor',
  product_type: 'Test',
  created_at: '2023-01-01T12:00:00-05:00',
  updated_at: '2023-01-01T12:00:00-05:00',
  published_at: '2023-01-01T12:00:00-05:00',
  tags: 'test',
  status: 'active',
  variants: [
    {
      id: 808950810,
      product_id: 632910392,
      title: 'Default',
      price: '29.99',
      sku: 'TEST-001',
      position: 1,
      inventory_quantity: 100,
      inventory_management: 'shopify',
      inventory_policy: 'deny',
      barcode: '1234567890',
      compare_at_price: '39.99',
      weight: 0.5,
      weight_unit: 'kg',
    },
  ],
  images: [
    {
      id: 850703190,
      product_id: 632910392,
      position: 1,
      created_at: '2023-01-01T12:00:00-05:00',
      updated_at: '2023-01-01T12:00:00-05:00',
      alt: 'Test Product',
      width: 1024,
      height: 768,
      src: 'https://example.com/image.jpg',
      variant_ids: [808950810],
    },
  ],
};

export const wooProductFixture = {
  id: 794,
  name: 'Test Product',
  slug: 'test-product',
  type: 'simple',
  status: 'publish',
  description: '<p>Test Description</p>',
  short_description: '<p>Test</p>',
  sku: 'TEST-001',
  price: '29.99',
  regular_price: '29.99',
  sale_price: '',
  date_created: '2023-01-01T12:00:00',
  date_modified: '2023-01-01T12:00:00',
  parent_id: 0,
  images: [
    {
      id: 1234,
      src: 'https://example.com/image.jpg',
      alt: 'Test Product',
    },
  ],
};

export const etsyListingFixture = {
  listing_id: 1234567890,
  user_id: 123456,
  shop_id: 654321,
  title: 'Test Product',
  description: 'Test Description',
  state: 'active',
  creation_tsz: 1609459200,
  price: '29.99',
  currency_code: 'USD',
  quantity: 100,
  sku: 'TEST-001',
  tags: ['test'],
  category_id: 69150473,
  images: [
    {
      listing_image_id: 1234567890,
      url_570xN: 'https://example.com/image.jpg',
      is_primary: true,
    },
  ],
  has_variations: false,
  should_auto_renew: true,
  is_supply: false,
  non_taxable: false,
};
```

---

## CI/CD Integration

### GitHub Actions Workflow

Create `.github/workflows/test.yml`:

```yaml
name: Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: nexus_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Setup database
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/nexus_test
        run: npx prisma migrate deploy

      - name: Run unit tests
        run: npm run test:unit

      - name: Run integration tests
        run: npm run test:integration

      - name: Run e2e tests
        run: npm run test:e2e

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info

      - name: Comment PR with coverage
        if: github.event_name == 'pull_request'
        uses: romeovs/lcov-reporter-action@v0.3.1
        with:
          lcov-file: ./coverage/lcov.info
```

### NPM Scripts

Add to `package.json`:

```json
{
  "scripts": {
    "test": "jest",
    "test:unit": "jest --testPathPattern=__tests__ --testPathIgnorePatterns=e2e",
    "test:integration": "jest --testPathPattern=__tests__",
    "test:e2e": "jest --testPathPattern=e2e",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "test:performance": "jest --testPathPattern=performance"
  }
}
```

---

## Running Tests

### Local Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- marketplace.service.test.ts

# Run with coverage
npm run test:coverage

# Run in watch mode
npm run test:watch

# Run performance tests
npm run test:performance
```

### Test Results

Tests should produce output like:

```
PASS  src/services/marketplaces/__tests__/marketplace.service.test.ts
  MarketplaceService
    getService
      ✓ should return Shopify service for SHOPIFY channel (5ms)
      ✓ should return WooCommerce service for WOOCOMMERCE channel (2ms)
      ✓ should return Etsy service for ETSY channel (2ms)
      ✓ should throw error for unknown channel (1ms)
    isMarketplaceAvailable
      ✓ should return true for configured marketplace (1ms)
      ✓ should return false for unconfigured marketplace (1ms)

Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        2.345s
```

---

## Support

For testing questions:
- **Jest Documentation**: https://jestjs.io/
- **Supertest**: https://github.com/visionmedia/supertest
- **Testing Best Practices**: See project wiki

---

**Last Updated**: 2026-04-23  
**Version**: 1.0.0
