import type { FastifyInstance } from "fastify";
import prisma from "../db.js";

export async function listingHealthRoutes(app: FastifyInstance) {
  /**
   * GET /api/catalog/:productId/listing-health
   * Get listing health and readiness scores for all channels
   */
  app.get<{
    Params: {
      productId: string;
    };
  }>("/api/catalog/:productId/listing-health", async (request, reply) => {
    try {
      const { productId } = request.params;

      // Fetch product with all related data
      const product = await prisma.product.findUnique({
        where: { id: productId },
        include: {
          variations: true,
          images: true,
        },
      });

      if (!product) {
        return reply.status(404).send({
          success: false,
          error: "Product not found",
        });
      }

      // Calculate readiness scores for each channel
      const channels = [
        { channel: "amazon", name: "Amazon" },
        { channel: "ebay", name: "eBay" },
        { channel: "shopify", name: "Shopify" },
        { channel: "etsy", name: "Etsy" },
        { channel: "woocommerce", name: "WooCommerce" },
      ];

      const channelReadiness = channels.map((ch) => {
        const validationResults = {
          title: !!product.name && product.name.length >= 10,
          description: true, // Simplified for now
          price: Number(product.basePrice) > 0,
          inventory: (product.variations?.length || 0) > 0,
          images: (product.images?.length || 0) > 0,
          attributes: (product.variations?.length || 0) > 0,
        };

        const validFields = Object.values(validationResults).filter(
          Boolean
        ).length;
        const readinessScore = Math.round((validFields / 6) * 100);

        const missingFields = Object.entries(validationResults)
          .filter(([_, isValid]) => !isValid)
          .map(([field]) => {
            const fieldNames: Record<string, string> = {
              title: "Product Title",
              description: "Product Description",
              price: "Pricing Information",
              inventory: "Inventory/Variations",
              images: "Product Images",
              attributes: "Product Attributes",
            };
            return fieldNames[field] || field;
          });

        const status =
          readinessScore >= 80
            ? "ready"
            : readinessScore >= 60
              ? "warning"
              : "critical";

        return {
          channel: ch.channel,
          name: ch.name,
          readinessScore,
          status,
          validationResults,
          missingFields,
          lastValidated: new Date(),
        };
      });

      return reply.send({
        success: true,
        data: {
          productId,
          channels: channelReadiness,
        },
      });
    } catch (error) {
      console.error("Error getting listing health:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get listing health",
      });
    }
  });

  /**
   * GET /api/catalog/marketplace-presence
   * Get marketplace presence and listing counts
   */
  app.get("/api/catalog/marketplace-presence", async (request, reply) => {
    try {
      // Get counts from products
      const amazonCount = await prisma.product.count({
        where: { amazonAsin: { not: null } },
      });
      const ebayCount = await prisma.product.count({
        where: { ebayItemId: { not: null } },
      });
      const shopifyCount = await prisma.product.count({
        where: { shopifyProductId: { not: null } },
      });
      const woocommerceCount = await prisma.product.count({
        where: { woocommerceProductId: { not: null } },
      });

      const marketplaces = [
        {
          channel: "amazon",
          name: "Amazon",
          icon: "🔶",
          isActive: amazonCount > 0,
          listingCount: amazonCount,
          syncStatus: "synced" as const,
        },
        {
          channel: "ebay",
          name: "eBay",
          icon: "🔴",
          isActive: ebayCount > 0,
          listingCount: ebayCount,
          syncStatus: "synced" as const,
        },
        {
          channel: "shopify",
          name: "Shopify",
          icon: "🟢",
          isActive: shopifyCount > 0,
          listingCount: shopifyCount,
          syncStatus: "synced" as const,
        },
        {
          channel: "etsy",
          name: "Etsy",
          icon: "🟡",
          isActive: false,
          listingCount: 0,
          syncStatus: "synced" as const,
        },
        {
          channel: "woocommerce",
          name: "WooCommerce",
          icon: "🟣",
          isActive: woocommerceCount > 0,
          listingCount: woocommerceCount,
          syncStatus: "synced" as const,
        },
      ];

      return reply.send({
        success: true,
        data: {
          marketplaces,
        },
      });
    } catch (error) {
      console.error("Error getting marketplace presence:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get marketplace presence",
      });
    }
  });

  /**
   * GET /api/catalog/stock-alerts
   * Get stock alerts for low and out-of-stock items
   */
  app.get("/api/catalog/stock-alerts", async (request, reply) => {
    try {
      const lowStockThreshold = 10;

      // Get products with low stock
      const lowStockProducts = await prisma.product.findMany({
        where: {
          variations: {
            some: {
              stock: {
                lte: lowStockThreshold,
                gt: 0,
              },
            },
          },
        },
        include: {
          variations: {
            where: {
              stock: {
                lte: lowStockThreshold,
                gt: 0,
              },
            },
          },
        },
        take: 50,
      });

      // Get out of stock products
      const outOfStockProducts = await prisma.product.findMany({
        where: {
          variations: {
            some: {
              stock: 0,
            },
          },
        },
        include: {
          variations: {
            where: {
              stock: 0,
            },
          },
        },
        take: 50,
      });

      const alerts = [
        ...lowStockProducts.flatMap((product) =>
          product.variations.map((variation) => ({
            productId: product.id,
            productName: product.name || "Unknown",
            channel: "all",
            currentStock: variation.stock,
            threshold: lowStockThreshold,
            status: "low" as const,
          }))
        ),
        ...outOfStockProducts.flatMap((product) =>
          product.variations.map((variation) => ({
            productId: product.id,
            productName: product.name || "Unknown",
            channel: "all",
            currentStock: variation.stock,
            threshold: 0,
            status: "out-of-stock" as const,
          }))
        ),
      ];

      return reply.send({
        success: true,
        data: {
          alerts,
        },
      });
    } catch (error) {
      console.error("Error getting stock alerts:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get stock alerts",
      });
    }
  });
}
