import { describe, it, expect, beforeEach, vi } from "vitest";
import { AmazonSyncService } from "../amazon-sync.service.js";

describe("AmazonSyncService", () => {
  let syncService: AmazonSyncService;

  beforeEach(() => {
    syncService = new AmazonSyncService();
  });

  describe("identifyParentChildRelationships", () => {
    it("should identify parents with variations", () => {
      const products = [
        {
          asin: "B001",
          title: "Parent Product",
          sku: "PARENT-001",
          variations: [
            { asin: "B002", title: "Child 1", sku: "CHILD-001" },
            { asin: "B003", title: "Child 2", sku: "CHILD-002" },
          ],
        },
      ];

      const result = (syncService as any).identifyParentChildRelationships(products);

      expect(result.parents).toHaveLength(1);
      expect(result.children).toHaveLength(2);
      expect(result.standalones).toHaveLength(0);
    });

    it("should identify children with parentAsin", () => {
      const products = [
        {
          asin: "B001",
          title: "Parent Product",
          sku: "PARENT-001",
        },
        {
          asin: "B002",
          parentAsin: "B001",
          title: "Child Product",
          sku: "CHILD-001",
        },
      ];

      const result = (syncService as any).identifyParentChildRelationships(products);

      expect(result.parents).toHaveLength(1);
      expect(result.children).toHaveLength(1);
      expect(result.standalones).toHaveLength(0);
    });

    it("should identify standalone products", () => {
      const products = [
        {
          asin: "B001",
          title: "Standalone Product",
          sku: "STANDALONE-001",
        },
        {
          asin: "B002",
          title: "Another Standalone",
          sku: "STANDALONE-002",
        },
      ];

      const result = (syncService as any).identifyParentChildRelationships(products);

      expect(result.parents).toHaveLength(0);
      expect(result.children).toHaveLength(0);
      expect(result.standalones).toHaveLength(2);
    });

    it("should handle mixed product types", () => {
      const products = [
        {
          asin: "B001",
          title: "Parent 1",
          sku: "PARENT-001",
          variations: [{ asin: "B002", title: "Child 1", sku: "CHILD-001" }],
        },
        {
          asin: "B003",
          title: "Standalone",
          sku: "STANDALONE-001",
        },
        {
          asin: "B004",
          parentAsin: "B001",
          title: "Child 2",
          sku: "CHILD-002",
        },
      ];

      const result = (syncService as any).identifyParentChildRelationships(products);

      expect(result.parents).toHaveLength(1);
      expect(result.children).toHaveLength(2);
      expect(result.standalones).toHaveLength(1);
    });
  });

  describe("detectFulfillmentChannel", () => {
    it("should return fulfillment channel from product data", () => {
      const product = {
        asin: "B001",
        title: "Test Product",
        sku: "TEST-001",
        fulfillmentChannel: "FBM",
      };

      const result = (syncService as any).detectFulfillmentChannel(product);

      expect(result).toBe("FBM");
    });

    it("should default to FBA if not specified", () => {
      const product = {
        asin: "B001",
        title: "Test Product",
        sku: "TEST-001",
      };

      const result = (syncService as any).detectFulfillmentChannel(product);

      expect(result).toBe("FBA");
    });
  });

  describe("extractShippingTemplate", () => {
    it("should extract shipping template from product data", () => {
      const product = {
        asin: "B001",
        title: "Test Product",
        sku: "TEST-001",
        shippingTemplate: "STANDARD",
      };

      const result = (syncService as any).extractShippingTemplate(product);

      expect(result).toBe("STANDARD");
    });

    it("should return null if shipping template not available", () => {
      const product = {
        asin: "B001",
        title: "Test Product",
        sku: "TEST-001",
      };

      const result = (syncService as any).extractShippingTemplate(product);

      expect(result).toBeNull();
    });
  });

  describe("validateProduct", () => {
    it("should validate product with all required fields", () => {
      const product = {
        asin: "B001",
        title: "Test Product",
        sku: "TEST-001",
      };

      const result = syncService.validateProduct(product);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail validation if ASIN is missing", () => {
      const product = {
        title: "Test Product",
        sku: "TEST-001",
      };

      const result = syncService.validateProduct(product as any);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing ASIN");
    });

    it("should fail validation if SKU is missing", () => {
      const product = {
        asin: "B001",
        title: "Test Product",
      };

      const result = syncService.validateProduct(product as any);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing SKU");
    });

    it("should fail validation if title is missing", () => {
      const product = {
        asin: "B001",
        sku: "TEST-001",
      };

      const result = syncService.validateProduct(product as any);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing title");
    });

    it("should fail validation if multiple fields are missing", () => {
      const product = {
        asin: "B001",
      };

      const result = syncService.validateProduct(product as any);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  describe("syncId generation", () => {
    it("should generate unique sync IDs", () => {
      const service1 = new AmazonSyncService();
      const service2 = new AmazonSyncService();

      const syncId1 = (service1 as any).syncId;
      const syncId2 = (service2 as any).syncId;

      expect(syncId1).not.toBe(syncId2);
      expect(syncId1).toMatch(/^sync-\d+-[a-z0-9]+$/);
      expect(syncId2).toMatch(/^sync-\d+-[a-z0-9]+$/);
    });
  });

  describe("error tracking", () => {
    it("should track errors during sync", () => {
      const service = new AmazonSyncService();
      const errors = (service as any).errors;

      expect(errors).toEqual([]);
    });
  });

  describe("statistics tracking", () => {
    it("should initialize statistics", () => {
      const service = new AmazonSyncService();
      const stats = (service as any).stats;

      expect(stats.totalProcessed).toBe(0);
      expect(stats.parentsCreated).toBe(0);
      expect(stats.childrenCreated).toBe(0);
      expect(stats.parentsUpdated).toBe(0);
      expect(stats.childrenUpdated).toBe(0);
    });
  });
});
