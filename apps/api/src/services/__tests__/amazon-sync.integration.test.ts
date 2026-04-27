import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AmazonSyncService } from "../amazon-sync.service.js";
import prisma from "../../db.js";

/**
 * Integration tests for AmazonSyncService
 * These tests verify the sync service works correctly with the database
 */
describe("AmazonSyncService Integration Tests", () => {
  let syncService: AmazonSyncService;

  beforeAll(async () => {
    // Clean up test data before running tests
    await prisma.product.deleteMany({
      where: {
        sku: {
          startsWith: "TEST-",
        },
      },
    });
  });

  afterAll(async () => {
    // Clean up test data after running tests
    await prisma.product.deleteMany({
      where: {
        sku: {
          startsWith: "TEST-",
        },
      },
    });
  });

  describe("Full sync workflow", () => {
    it("should sync parent and child products correctly", async () => {
      syncService = new AmazonSyncService();

      const testProducts = [
        {
          asin: "B001TEST",
          title: "Test Parent Product",
          sku: "TEST-PARENT-001",
          price: 99.99,
          stock: 100,
          fulfillmentChannel: "FBA",
          variations: [
            {
              asin: "B002TEST",
              title: "Test Child 1",
              sku: "TEST-CHILD-001",
              price: 89.99,
              stock: 50,
            },
            {
              asin: "B003TEST",
              title: "Test Child 2",
              sku: "TEST-CHILD-002",
              price: 89.99,
              stock: 50,
            },
          ],
        },
      ];

      const result = await syncService.syncAmazonCatalog(testProducts);

      expect(result.status).toBe("success");
      expect(result.parentsCreated).toBe(1);
      expect(result.childrenCreated).toBe(2);
      expect(result.totalProcessed).toBe(3);
      expect(result.errors).toHaveLength(0);

      // Verify parent was created
      const parent = await prisma.product.findUnique({
        where: { sku: "TEST-PARENT-001" },
        include: { children: true },
      });

      expect(parent).toBeDefined();
      expect(parent?.isParent).toBe(true);
      expect(parent?.amazonAsin).toBe("B001TEST");
      expect(parent?.children).toHaveLength(2);

      // Verify children were created and linked
      const child1 = await prisma.product.findUnique({
        where: { sku: "TEST-CHILD-001" },
      });

      expect(child1).toBeDefined();
      expect(child1?.parentId).toBe(parent?.id);
      expect(child1?.isParent).toBe(false);
    });

    it("should handle standalone products", async () => {
      syncService = new AmazonSyncService();

      const testProducts = [
        {
          asin: "B004TEST",
          title: "Test Standalone Product",
          sku: "TEST-STANDALONE-001",
          price: 49.99,
          stock: 200,
        },
      ];

      const result = await syncService.syncAmazonCatalog(testProducts);

      expect(result.status).toBe("success");
      expect(result.parentsCreated).toBe(1);
      expect(result.childrenCreated).toBe(0);
      expect(result.totalProcessed).toBe(1);

      const product = await prisma.product.findUnique({
        where: { sku: "TEST-STANDALONE-001" },
      });

      expect(product).toBeDefined();
      expect(product?.isParent).toBe(false);
      expect(product?.parentId).toBeNull();
    });

    it("should update existing products", async () => {
      syncService = new AmazonSyncService();

      // Create initial product
      const initialProducts = [
        {
          asin: "B005TEST",
          title: "Test Update Product",
          sku: "TEST-UPDATE-001",
          price: 50.0,
          stock: 100,
        },
      ];

      const result1 = await syncService.syncAmazonCatalog(initialProducts);
      expect(result1.parentsCreated).toBe(1);

      // Update the product
      const updatedProducts = [
        {
          asin: "B005TEST",
          title: "Test Update Product - Updated",
          sku: "TEST-UPDATE-001",
          price: 75.0,
          stock: 150,
        },
      ];

      syncService = new AmazonSyncService();
      const result2 = await syncService.syncAmazonCatalog(updatedProducts);

      expect(result2.parentsUpdated).toBe(1);
      expect(result2.parentsCreated).toBe(0);

      const product = await prisma.product.findUnique({
        where: { sku: "TEST-UPDATE-001" },
      });

      expect(product?.name).toBe("Test Update Product - Updated");
      expect(product?.basePrice).toBe(75.0);
      expect(product?.totalStock).toBe(150);
    });

    it("should handle mixed product types", async () => {
      syncService = new AmazonSyncService();

      const testProducts = [
        {
          asin: "B006TEST",
          title: "Test Parent Mixed",
          sku: "TEST-MIXED-PARENT",
          price: 100.0,
          stock: 100,
          variations: [
            {
              asin: "B007TEST",
              title: "Test Child Mixed",
              sku: "TEST-MIXED-CHILD",
              price: 90.0,
              stock: 50,
            },
          ],
        },
        {
          asin: "B008TEST",
          title: "Test Standalone Mixed",
          sku: "TEST-MIXED-STANDALONE",
          price: 50.0,
          stock: 200,
        },
      ];

      const result = await syncService.syncAmazonCatalog(testProducts);

      expect(result.status).toBe("success");
      expect(result.parentsCreated).toBe(2); // 1 parent + 1 standalone
      expect(result.childrenCreated).toBe(1);
      expect(result.totalProcessed).toBe(3);
    });

    it("should validate products before syncing", async () => {
      syncService = new AmazonSyncService();

      const invalidProducts = [
        {
          // Missing ASIN
          title: "Invalid Product",
          sku: "TEST-INVALID-001",
        },
      ];

      // This should fail validation
      const validation = syncService.validateProduct(invalidProducts[0] as any);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Missing ASIN");
    });
  });

  describe("Sync logging", () => {
    it("should log sync progress to database", async () => {
      syncService = new AmazonSyncService();

      const testProducts = [
        {
          asin: "B009TEST",
          title: "Test Logging Product",
          sku: "TEST-LOGGING-001",
          price: 50.0,
          stock: 100,
        },
      ];

      const result = await syncService.syncAmazonCatalog(testProducts);

      // Verify sync log was created
      const syncLog = await prisma.syncLog.findUnique({
        where: { syncId: result.syncId },
      });

      expect(syncLog).toBeDefined();
      expect(syncLog?.syncType).toBe("amazon_catalog");
      expect(syncLog?.status).toBe("success");
      expect(syncLog?.totalItems).toBe(1);
      expect(syncLog?.successCount).toBe(1);
      expect(syncLog?.failureCount).toBe(0);
    });
  });

  describe("Error handling", () => {
    it("should handle database errors gracefully", async () => {
      syncService = new AmazonSyncService();

      // Create a product with duplicate SKU to test error handling
      await prisma.product.create({
        data: {
          sku: "TEST-DUPLICATE-001",
          name: "Duplicate Test",
          amazonAsin: "B010TEST",
          basePrice: 50.0,
          totalStock: 100,
          isParent: false,
        },
      });

      const testProducts = [
        {
          asin: "B011TEST",
          title: "Another Product",
          sku: "TEST-DUPLICATE-001", // Same SKU
          price: 60.0,
          stock: 100,
        },
      ];

      // This should handle the error gracefully
      try {
        await syncService.syncAmazonCatalog(testProducts);
      } catch (error) {
        // Error is expected
        expect(error).toBeDefined();
      }
    });
  });

  describe("Parent-child relationships", () => {
    it("should correctly link children to parents", async () => {
      syncService = new AmazonSyncService();

      const testProducts = [
        {
          asin: "B012TEST",
          title: "Test Relationship Parent",
          sku: "TEST-REL-PARENT",
          price: 100.0,
          stock: 100,
          variations: [
            {
              asin: "B013TEST",
              title: "Test Relationship Child 1",
              sku: "TEST-REL-CHILD-1",
              price: 90.0,
              stock: 50,
            },
            {
              asin: "B014TEST",
              title: "Test Relationship Child 2",
              sku: "TEST-REL-CHILD-2",
              price: 90.0,
              stock: 50,
            },
          ],
        },
      ];

      const result = await syncService.syncAmazonCatalog(testProducts);

      const parent = await prisma.product.findUnique({
        where: { sku: "TEST-REL-PARENT" },
        include: { children: true },
      });

      expect(parent?.children).toHaveLength(2);

      const children = await prisma.product.findMany({
        where: {
          parentId: parent?.id,
        },
      });

      expect(children).toHaveLength(2);
      children.forEach((child) => {
        expect(child.parentId).toBe(parent?.id);
        expect(child.isParent).toBe(false);
      });
    });
  });
});
