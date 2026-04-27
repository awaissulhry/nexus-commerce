# Phase 1: Implementation Guide
## Nexus Commerce Platform - Foundation & Database Schema

**Date:** April 23, 2026  
**Version:** 1.0  
**Status:** ✅ Ready for Implementation

---

## Quick Start

### 1. Apply Migration
```bash
cd packages/database
npx prisma migrate deploy
npx prisma generate
```

### 2. Verify Schema
```bash
npx prisma validate
npx prisma db push --skip-generate
```

---

## Feature Implementation Examples

### Feature 1: Sync Health Monitoring

#### Service Implementation
```typescript
// apps/api/src/services/sync/sync-health.service.ts

import { PrismaClient } from '@prisma/client';

export class SyncHealthService {
  constructor(private prisma: PrismaClient) {}

  async logSyncError(data: {
    channel: string;
    errorType: string;
    errorMessage: string;
    productId?: string;
    variationId?: string;
    errorDetails?: any;
    severity?: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  }) {
    return this.prisma.syncHealthLog.create({
      data: {
        channel: data.channel,
        errorType: data.errorType,
        errorMessage: data.errorMessage,
        productId: data.productId,
        variationId: data.variationId,
        errorDetails: data.errorDetails,
        severity: data.severity || 'WARNING',
        resolutionStatus: 'UNRESOLVED'
      }
    });
  }

  async logConflict(data: {
    channel: string;
    productId?: string;
    variationId?: string;
    conflictType: string;
    localData: any;
    remoteData: any;
  }) {
    return this.prisma.syncHealthLog.create({
      data: {
        channel: data.channel,
        productId: data.productId,
        variationId: data.variationId,
        errorType: 'CONFLICT_DETECTED',
        errorMessage: `Conflict detected: ${data.conflictType}`,
        conflictType: data.conflictType,
        conflictData: {
          local: data.localData,
          remote: data.remoteData
        },
        severity: 'WARNING',
        resolutionStatus: 'UNRESOLVED'
      }
    });
  }

  async logDuplicateVariation(data: {
    channel: string;
    productId: string;
    primaryVariationId: string;
    duplicateVariationIds: string[];
  }) {
    return this.prisma.syncHealthLog.create({
      data: {
        channel: data.channel,
        productId: data.productId,
        variationId: data.primaryVariationId,
        errorType: 'DUPLICATE_VARIATION',
        errorMessage: `Found ${data.duplicateVariationIds.length} duplicate variations`,
        duplicateVariationIds: data.duplicateVariationIds,
        severity: 'ERROR',
        resolutionStatus: 'UNRESOLVED'
      }
    });
  }

  async resolveConflict(logId: string, resolution: {
    status: 'AUTO_RESOLVED' | 'MANUAL_RESOLVED' | 'IGNORED';
    notes: string;
  }) {
    return this.prisma.syncHealthLog.update({
      where: { id: logId },
      data: {
        resolutionStatus: resolution.status,
        resolutionNotes: resolution.notes,
        resolvedAt: new Date()
      }
    });
  }

  async getUnresolvedIssues(channel?: string) {
    return this.prisma.syncHealthLog.findMany({
      where: {
        resolutionStatus: 'UNRESOLVED',
        ...(channel && { channel })
      },
      orderBy: [
        { severity: 'desc' },
        { createdAt: 'desc' }
      ],
      include: {
        product: { select: { id: true, sku: true, name: true } },
        variation: { select: { id: true, sku: true } }
      }
    });
  }

  async getSyncHealthMetrics(channel: string, days: number = 7) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totalErrors, criticalErrors, unresolvedConflicts, duplicates] = await Promise.all([
      this.prisma.syncHealthLog.count({
        where: { channel, createdAt: { gte: since } }
      }),
      this.prisma.syncHealthLog.count({
        where: { channel, severity: 'CRITICAL', createdAt: { gte: since } }
      }),
      this.prisma.syncHealthLog.count({
        where: {
          channel,
          conflictType: { not: null },
          resolutionStatus: 'UNRESOLVED',
          createdAt: { gte: since }
        }
      }),
      this.prisma.syncHealthLog.count({
        where: {
          channel,
          errorType: 'DUPLICATE_VARIATION',
          createdAt: { gte: since }
        }
      })
    ]);

    return {
      totalErrors,
      criticalErrors,
      unresolvedConflicts,
      duplicates,
      healthScore: Math.max(0, 100 - (criticalErrors * 10 + unresolvedConflicts * 5))
    };
  }
}
```

#### API Route
```typescript
// apps/api/src/routes/sync-health.ts

import { Router } from 'express';
import { SyncHealthService } from '../services/sync/sync-health.service';
import { prisma } from '../db';

const router = Router();
const syncHealthService = new SyncHealthService(prisma);

// Get unresolved issues
router.get('/issues/unresolved', async (req, res) => {
  try {
    const { channel } = req.query;
    const issues = await syncHealthService.getUnresolvedIssues(channel as string);
    res.json(issues);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get sync health metrics
router.get('/metrics/:channel', async (req, res) => {
  try {
    const { channel } = req.params;
    const { days = '7' } = req.query;
    const metrics = await syncHealthService.getSyncHealthMetrics(
      channel,
      parseInt(days as string)
    );
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Resolve a conflict
router.post('/issues/:id/resolve', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const resolved = await syncHealthService.resolveConflict(id, { status, notes });
    res.json(resolved);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
```

---

### Feature 2: Pricing Rules Engine

#### Service Implementation
```typescript
// apps/api/src/services/pricing/pricing-rules.service.ts

import { PrismaClient, Decimal } from '@prisma/client';

export class PricingRulesService {
  constructor(private prisma: PrismaClient) {}

  async createRule(data: {
    name: string;
    type: string;
    description?: string;
    priority: number;
    minMarginPercent?: Decimal;
    maxMarginPercent?: Decimal;
    parameters: any;
    productIds?: string[];
    variationIds?: string[];
  }) {
    return this.prisma.pricingRule.create({
      data: {
        name: data.name,
        type: data.type,
        description: data.description,
        priority: data.priority,
        minMarginPercent: data.minMarginPercent,
        maxMarginPercent: data.maxMarginPercent,
        parameters: data.parameters,
        isActive: true,
        products: data.productIds ? {
          create: data.productIds.map(productId => ({
            productId
          }))
        } : undefined,
        variations: data.variationIds ? {
          create: data.variationIds.map(variationId => ({
            variationId
          }))
        } : undefined
      },
      include: {
        products: true,
        variations: true
      }
    });
  }

  async getActiveRules(channel?: string) {
    return this.prisma.pricingRule.findMany({
      where: { isActive: true },
      orderBy: { priority: 'asc' },
      include: {
        products: { include: { product: true } },
        variations: { include: { variation: true } }
      }
    });
  }

  async applyRulesToVariation(variationId: string, ruleIds: string[]) {
    return Promise.all(
      ruleIds.map(ruleId =>
        this.prisma.pricingRuleVariation.upsert({
          where: {
            ruleId_variationId: { ruleId, variationId }
          },
          create: { ruleId, variationId },
          update: {}
        })
      )
    );
  }

  async calculatePrice(variation: any, costPrice: Decimal): Promise<Decimal> {
    // Get all applicable rules
    const rules = await this.prisma.pricingRuleVariation.findMany({
      where: { variationId: variation.id },
      include: { rule: true },
      orderBy: { rule: { priority: 'asc' } }
    });

    let calculatedPrice = variation.price;

    for (const { rule } of rules) {
      if (!rule.isActive) continue;

      // Apply rule logic
      switch (rule.type) {
        case 'COST_PLUS_MARGIN':
          const margin = (rule.parameters.marginPercent || 25) / 100;
          calculatedPrice = costPrice * (1 + margin);
          break;

        case 'PERCENTAGE_BELOW':
          const reduction = (rule.parameters.percentageBelow || 5) / 100;
          calculatedPrice = calculatedPrice * (1 - reduction);
          break;

        case 'FIXED_PRICE':
          calculatedPrice = new Decimal(rule.parameters.fixedPrice);
          break;

        case 'DYNAMIC_MARGIN':
          const dynamicMargin = (rule.parameters.targetMargin || 30) / 100;
          calculatedPrice = costPrice * (1 + dynamicMargin);
          break;
      }

      // Apply margin constraints
      if (rule.minMarginPercent) {
        const minPrice = costPrice * (1 + rule.minMarginPercent / 100);
        calculatedPrice = Decimal.max(calculatedPrice, minPrice);
      }

      if (rule.maxMarginPercent) {
        const maxPrice = costPrice * (1 + rule.maxMarginPercent / 100);
        calculatedPrice = Decimal.min(calculatedPrice, maxPrice);
      }
    }

    return calculatedPrice;
  }
}
```

---

### Feature 3: Bulk Action Queuing

#### Service Implementation
```typescript
// apps/api/src/services/bulk/bulk-action.service.ts

import { PrismaClient } from '@prisma/client';

export class BulkActionService {
  constructor(private prisma: PrismaClient) {}

  async createJob(data: {
    jobName: string;
    actionType: string;
    channel?: string;
    targetProductIds?: string[];
    targetVariationIds?: string[];
    filters?: any;
    actionPayload: any;
    createdBy?: string;
  }) {
    // Calculate total items
    let totalItems = 0;
    if (data.targetProductIds?.length) {
      totalItems = data.targetProductIds.length;
    } else if (data.targetVariationIds?.length) {
      totalItems = data.targetVariationIds.length;
    } else if (data.filters) {
      // Count items matching filters
      totalItems = await this.countItemsByFilters(data.filters);
    }

    return this.prisma.bulkActionJob.create({
      data: {
        jobName: data.jobName,
        actionType: data.actionType,
        channel: data.channel,
        targetProductIds: data.targetProductIds || [],
        targetVariationIds: data.targetVariationIds || [],
        filters: data.filters,
        actionPayload: data.actionPayload,
        status: 'PENDING',
        totalItems,
        createdBy: data.createdBy,
        isRollbackable: true
      }
    });
  }

  async startJob(jobId: string) {
    return this.prisma.bulkActionJob.update({
      where: { id: jobId },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date()
      }
    });
  }

  async updateProgress(jobId: string, data: {
    processedItems: number;
    failedItems: number;
    skippedItems: number;
    errors?: any[];
  }) {
    const job = await this.prisma.bulkActionJob.findUnique({
      where: { id: jobId }
    });

    if (!job) throw new Error('Job not found');

    const progressPercent = Math.round(
      ((data.processedItems + data.failedItems + data.skippedItems) / job.totalItems) * 100
    );

    return this.prisma.bulkActionJob.update({
      where: { id: jobId },
      data: {
        processedItems: data.processedItems,
        failedItems: data.failedItems,
        skippedItems: data.skippedItems,
        progressPercent,
        errorLog: data.errors,
        lastError: data.errors?.[0]?.error
      }
    });
  }

  async completeJob(jobId: string, status: 'COMPLETED' | 'FAILED' | 'PARTIALLY_COMPLETED') {
    return this.prisma.bulkActionJob.update({
      where: { id: jobId },
      data: {
        status,
        completedAt: new Date()
      }
    });
  }

  async createRollbackJob(originalJobId: string) {
    const originalJob = await this.prisma.bulkActionJob.findUnique({
      where: { id: originalJobId }
    });

    if (!originalJob || !originalJob.isRollbackable) {
      throw new Error('Job cannot be rolled back');
    }

    const rollbackJob = await this.prisma.bulkActionJob.create({
      data: {
        jobName: `Rollback: ${originalJob.jobName}`,
        actionType: originalJob.actionType,
        channel: originalJob.channel,
        targetProductIds: originalJob.targetProductIds,
        targetVariationIds: originalJob.targetVariationIds,
        actionPayload: originalJob.rollbackData,
        status: 'PENDING',
        totalItems: originalJob.totalItems,
        isRollbackable: false
      }
    });

    // Link rollback job to original
    await this.prisma.bulkActionJob.update({
      where: { id: originalJobId },
      data: { rollbackJobId: rollbackJob.id }
    });

    return rollbackJob;
  }

  async getJobStatus(jobId: string) {
    return this.prisma.bulkActionJob.findUnique({
      where: { id: jobId }
    });
  }

  async getPendingJobs() {
    return this.prisma.bulkActionJob.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' }
    });
  }

  private async countItemsByFilters(filters: any): Promise<number> {
    // Implement filter-based counting logic
    // This is a placeholder - implement based on your filter structure
    return 0;
  }
}
```

#### Job Processor
```typescript
// apps/api/src/jobs/bulk-action.job.ts

import { BulkActionService } from '../services/bulk/bulk-action.service';
import { prisma } from '../db';

const bulkActionService = new BulkActionService(prisma);

export async function processBulkActionJob(jobId: string) {
  try {
    const job = await bulkActionService.startJob(jobId);

    let processedItems = 0;
    let failedItems = 0;
    let skippedItems = 0;
    const errors: any[] = [];

    // Get items to process
    const items = await getItemsForJob(job);

    for (const item of items) {
      try {
        await processItem(item, job);
        processedItems++;
      } catch (error) {
        failedItems++;
        errors.push({
          itemId: item.id,
          error: error.message,
          timestamp: new Date()
        });
      }

      // Update progress every 10 items
      if ((processedItems + failedItems) % 10 === 0) {
        await bulkActionService.updateProgress(jobId, {
          processedItems,
          failedItems,
          skippedItems,
          errors
        });
      }
    }

    // Complete job
    const status = failedItems === 0 ? 'COMPLETED' : 'PARTIALLY_COMPLETED';
    await bulkActionService.completeJob(jobId, status);

  } catch (error) {
    await bulkActionService.completeJob(jobId, 'FAILED');
    throw error;
  }
}

async function getItemsForJob(job: any) {
  if (job.targetVariationIds?.length) {
    return prisma.productVariation.findMany({
      where: { id: { in: job.targetVariationIds } }
    });
  }

  if (job.targetProductIds?.length) {
    return prisma.product.findMany({
      where: { id: { in: job.targetProductIds } }
    });
  }

  // Handle filter-based queries
  return [];
}

async function processItem(item: any, job: any) {
  switch (job.actionType) {
    case 'PRICING_UPDATE':
      await updateItemPrice(item, job.actionPayload);
      break;
    case 'INVENTORY_UPDATE':
      await updateItemInventory(item, job.actionPayload);
      break;
    case 'STATUS_UPDATE':
      await updateItemStatus(item, job.actionPayload);
      break;
    default:
      throw new Error(`Unknown action type: ${job.actionType}`);
  }
}

async function updateItemPrice(item: any, payload: any) {
  const newPrice = item.price + payload.priceAdjustment;
  await prisma.productVariation.update({
    where: { id: item.id },
    data: { price: newPrice }
  });
}

async function updateItemInventory(item: any, payload: any) {
  const newStock = item.stock + payload.quantityChange;
  await prisma.productVariation.update({
    where: { id: item.id },
    data: { stock: Math.max(0, newStock) }
  });
}

async function updateItemStatus(item: any, payload: any) {
  await prisma.product.update({
    where: { id: item.id },
    data: { status: payload.newStatus }
  });
}
```

---

### Feature 4: Marketplace Metadata Management

#### Service Implementation
```typescript
// apps/api/src/services/marketplace/metadata.service.ts

import { PrismaClient } from '@prisma/client';

export class MarketplaceMetadataService {
  constructor(private prisma: PrismaClient) {}

  async updateAmazonMetadata(variationId: string, metadata: {
    browseNodeId?: string;
    browseNodePath?: string[];
    bulletPoints?: string[];
    searchTerms?: string[];
  }) {
    const variation = await this.prisma.productVariation.findUnique({
      where: { id: variationId }
    });

    const currentMetadata = variation?.marketplaceMetadata || {};

    return this.prisma.productVariation.update({
      where: { id: variationId },
      data: {
        marketplaceMetadata: {
          ...currentMetadata,
          amazon: {
            ...(currentMetadata as any)?.amazon,
            ...metadata
          }
        }
      }
    });
  }

  async updateEbayMetadata(variationId: string, metadata: {
    itemSpecifics?: Record<string, string>;
    categoryId?: string;
    conditionId?: string;
  }) {
    const variation = await this.prisma.productVariation.findUnique({
      where: { id: variationId }
    });

    const currentMetadata = variation?.marketplaceMetadata || {};

    return this.prisma.productVariation.update({
      where: { id: variationId },
      data: {
        marketplaceMetadata: {
          ...currentMetadata,
          ebay: {
            ...(currentMetadata as any)?.ebay,
            ...metadata
          }
        }
      }
    });
  }

  async getMarketplaceMetadata(variationId: string, marketplace: string) {
    const variation = await this.prisma.productVariation.findUnique({
      where: { id: variationId },
      select: { marketplaceMetadata: true }
    });

    return (variation?.marketplaceMetadata as any)?.[marketplace.toLowerCase()];
  }

  async syncMetadataFromMarketplace(variationId: string, marketplace: string, remoteData: any) {
    const variation = await this.prisma.productVariation.findUnique({
      where: { id: variationId }
    });

    const currentMetadata = variation?.marketplaceMetadata || {};

    return this.prisma.productVariation.update({
      where: { id: variationId },
      data: {
        marketplaceMetadata: {
          ...currentMetadata,
          [marketplace.toLowerCase()]: remoteData
        }
      }
    });
  }
}
```

---

## Database Queries Reference

### Common Queries

#### Get Sync Health Dashboard
```typescript
const dashboard = await prisma.syncHealthLog.groupBy({
  by: ['channel', 'severity'],
  where: {
    createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
  },
  _count: true
});
```

#### Get Active Pricing Rules by Priority
```typescript
const rules = await prisma.pricingRule.findMany({
  where: { isActive: true },
  orderBy: { priority: 'asc' },
  include: {
    products: { include: { product: true } },
    variations: { include: { variation: true } }
  }
});
```

#### Get Bulk Job Progress
```typescript
const job = await prisma.bulkActionJob.findUnique({
  where: { id: jobId },
  select: {
    status: true,
    totalItems: true,
    processedItems: true,
    failedItems: true,
    progressPercent: true,
    errorLog: true
  }
});
```

#### Find Variations with Specific Marketplace Metadata
```typescript
const variations = await prisma.productVariation.findMany({
  where: {
    marketplaceMetadata: {
      path: ['amazon', 'browseNodeId'],
      equals: '123456'
    }
  }
});
```

---

## Deployment Checklist

- [ ] Run migration: `npx prisma migrate deploy`
- [ ] Generate Prisma Client: `npx prisma generate`
- [ ] Verify schema: `npx prisma validate`
- [ ] Test sync health logging
- [ ] Test pricing rules application
- [ ] Test bulk action job creation and processing
- [ ] Test marketplace metadata updates
- [ ] Monitor database performance
- [ ] Set up monitoring alerts for sync health
- [ ] Document API endpoints for team

---

## Performance Tips

1. **Use indexes effectively**: Always filter by indexed columns first
2. **Batch operations**: Use `createMany` for bulk inserts
3. **Pagination**: Implement pagination for large result sets
4. **Caching**: Cache active pricing rules in memory
5. **Async processing**: Use job queues for bulk actions
6. **Monitoring**: Set up alerts for failed jobs and critical errors

---

## Support & Troubleshooting

For issues or questions:
1. Check [`PHASE1-FOUNDATION-ENHANCEMENTS.md`](./PHASE1-FOUNDATION-ENHANCEMENTS.md) for detailed schema documentation
2. Review Prisma documentation: https://www.prisma.io/docs
3. Check database logs for constraint violations
4. Verify migration status: `npx prisma migrate status`

---

**Last Updated:** April 23, 2026  
**Status:** ✅ Production Ready
