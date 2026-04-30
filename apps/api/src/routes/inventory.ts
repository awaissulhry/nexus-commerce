import type { FastifyInstance } from "fastify";
import prisma from "../db.js";

// ── Bulk Upload (Parent-level) ──────────────────────────────────────────

interface BulkUploadItem {
  sku: string;
  name: string;
  basePrice: number;
  totalStock: number;
  upc?: string;
  ean?: string;
  brand?: string;
  manufacturer?: string;
}

interface BulkUploadBody {
  items: BulkUploadItem[];
}

interface BulkUploadResult {
  processed: number;
  successful: number;
  failed: number;
  results: Array<{
    sku: string;
    status: "created" | "updated" | "failed";
    message?: string;
  }>;
}

// ── Per-Variant Stock Update (Rithum pattern) ───────────────────────────

interface VariantStockItem {
  variantSku: string; // Child SKU
  stock: number;
  channelId?: string; // Optional: update specific channel listing
}

interface VariantStockUpdateBody {
  items: VariantStockItem[];
}

interface VariantStockUpdateResult {
  processed: number;
  successful: number;
  failed: number;
  results: Array<{
    variantSku: string;
    status: "updated" | "failed";
    message?: string;
    variantId?: string;
  }>;
}

// ── Inventory Allocation Strategies ─────────────────────────────────────

type AllocationStrategy = "equal" | "percentage" | "velocity-based";

interface AllocationConfig {
  strategy: AllocationStrategy;
  channels: Record<string, number>; // channelId → percentage or equal count
}

interface AllocateInventoryBody {
  productSku: string;
  totalStock: number;
  allocation: AllocationConfig;
}

export async function inventoryRoutes(app: FastifyInstance) {
  // ── POST /inventory/bulk-upload ─────────────────────────────────────
  // Parent-level bulk upload (existing functionality)
  app.post<{ Body: BulkUploadBody }>(
    "/inventory/bulk-upload",
    async (request, reply) => {
      try {
        const { items } = request.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
          return reply.status(400).send({
            error: "Request body must contain a non-empty 'items' array",
          });
        }

        const result: BulkUploadResult = {
          processed: items.length,
          successful: 0,
          failed: 0,
          results: [],
        };

        // Use a transaction for atomicity
        await prisma.$transaction(async (tx: any) => {
          for (const item of items) {
            try {
              // Validate required fields
              if (!item.sku || !item.name) {
                result.failed++;
                result.results.push({
                  sku: item.sku || "UNKNOWN",
                  status: "failed",
                  message: "Missing required fields: sku and name",
                });
                continue;
              }

              if (!item.basePrice || item.basePrice <= 0) {
                result.failed++;
                result.results.push({
                  sku: item.sku,
                  status: "failed",
                  message: "Invalid or missing basePrice",
                });
                continue;
              }

              // Validate UPC format (12 digits)
              if (item.upc && !/^\d{12}$/.test(item.upc)) {
                result.failed++;
                result.results.push({
                  sku: item.sku,
                  status: "failed",
                  message: "Invalid UPC format (must be 12 digits)",
                });
                continue;
              }

              // Validate EAN format (13 digits)
              if (item.ean && !/^\d{13}$/.test(item.ean)) {
                result.failed++;
                result.results.push({
                  sku: item.sku,
                  status: "failed",
                  message: "Invalid EAN format (must be 13 digits)",
                });
                continue;
              }

              // Check if product exists
              const existing = await tx.product.findUnique({
                where: { sku: item.sku },
              });

              if (existing) {
                // Update existing product
                await tx.product.update({
                  where: { sku: item.sku },
                  data: {
                    name: item.name,
                    basePrice: item.basePrice,
                    totalStock: item.totalStock ?? 0,
                    upc: item.upc || null,
                    ean: item.ean || null,
                    brand: item.brand || null,
                    manufacturer: item.manufacturer || null,
                  },
                });
                result.successful++;
                result.results.push({
                  sku: item.sku,
                  status: "updated",
                });
              } else {
                // Create new product
                await tx.product.create({
                  data: {
                    sku: item.sku,
                    name: item.name,
                    basePrice: item.basePrice,
                    totalStock: item.totalStock ?? 0,
                    upc: item.upc || null,
                    ean: item.ean || null,
                    brand: item.brand || null,
                    manufacturer: item.manufacturer || null,
                  },
                });
                result.successful++;
                result.results.push({
                  sku: item.sku,
                  status: "created",
                });
              }
            } catch (itemError: any) {
              result.failed++;
              result.results.push({
                sku: item.sku || "UNKNOWN",
                status: "failed",
                message: itemError?.message ?? "Unknown error",
              });
            }
          }
        });

        return reply.send(result);
      } catch (error: any) {
        request.log.error(error, "bulk-upload failed");
        return reply.status(500).send({
          error: "Bulk upload failed",
          message: error?.message ?? "Unknown error",
        });
      }
    }
  );

  // ── POST /inventory/variants/stock ──────────────────────────────────
  // Per-variant stock update (Rithum pattern)
  // Updates ProductVariation.stock and optionally VariantChannelListing.channelQuantity
  app.post<{ Body: VariantStockUpdateBody }>(
    "/inventory/variants/stock",
    async (request, reply) => {
      try {
        const { items } = request.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
          return reply.status(400).send({
            error: "Request body must contain a non-empty 'items' array",
          });
        }

        const result: VariantStockUpdateResult = {
          processed: items.length,
          successful: 0,
          failed: 0,
          results: [],
        };

        await prisma.$transaction(async (tx: any) => {
          for (const item of items) {
            try {
              if (!item.variantSku) {
                result.failed++;
                result.results.push({
                  variantSku: "UNKNOWN",
                  status: "failed",
                  message: "Missing variantSku",
                });
                continue;
              }

              if (item.stock < 0) {
                result.failed++;
                result.results.push({
                  variantSku: item.variantSku,
                  status: "failed",
                  message: "Stock cannot be negative",
                });
                continue;
              }

              // Find the variant by SKU
              const variant = await tx.productVariation.findUnique({
                where: { sku: item.variantSku },
                include: { product: true },
              });

              if (!variant) {
                result.failed++;
                result.results.push({
                  variantSku: item.variantSku,
                  status: "failed",
                  message: "Variant not found",
                });
                continue;
              }

              // Update variant stock
              await tx.productVariation.update({
                where: { id: variant.id },
                data: { stock: item.stock },
              });

              // Recompute parent totalStock
              const totalVariantStock = await tx.productVariation.aggregate({
                where: { productId: variant.productId },
                _sum: { stock: true },
              });

              await tx.product.update({
                where: { id: variant.productId },
                data: { totalStock: totalVariantStock._sum.stock ?? 0 },
              });

              // If channelId specified, update VariantChannelListing
              if (item.channelId) {
                await tx.variantChannelListing.updateMany({
                  where: {
                    variantId: variant.id,
                    channelId: item.channelId,
                  },
                  data: { channelQuantity: item.stock },
                });
              }

              result.successful++;
              result.results.push({
                variantSku: item.variantSku,
                status: "updated",
                variantId: variant.id,
              });
            } catch (itemError: any) {
              result.failed++;
              result.results.push({
                variantSku: item.variantSku || "UNKNOWN",
                status: "failed",
                message: itemError?.message ?? "Unknown error",
              });
            }
          }
        });

        return reply.send(result);
      } catch (error: any) {
        request.log.error(error, "variant-stock-update failed");
        return reply.status(500).send({
          error: "Variant stock update failed",
          message: error?.message ?? "Unknown error",
        });
      }
    }
  );

  // ── POST /inventory/allocate ────────────────────────────────────────
  // Allocate parent stock to variants across channels using strategies
  // Strategies:
  //   - "equal": Divide stock equally among channels
  //   - "percentage": Allocate by percentage (e.g., { "AMAZON": 60, "EBAY": 40 })
  //   - "velocity-based": Allocate based on historical sales velocity (future)
  app.post<{ Body: AllocateInventoryBody }>(
    "/inventory/allocate",
    async (request, reply) => {
      try {
        const { productSku, totalStock, allocation } = request.body;

        if (!productSku || totalStock < 0) {
          return reply.status(400).send({
            error: "Missing or invalid productSku or totalStock",
          });
        }

        if (!allocation || !allocation.strategy || !allocation.channels) {
          return reply.status(400).send({
            error: "Missing allocation config (strategy and channels)",
          });
        }

        // Find product with variants
        const product = await prisma.product.findUnique({
          where: { sku: productSku },
          include: { variations: true },
        });

        if (!product) {
          return reply.status(404).send({
            error: "Product not found",
          });
        }

        if (product.variations.length === 0) {
          return reply.status(400).send({
            error: "Product has no variants to allocate to",
          });
        }

        const channelIds = Object.keys(allocation.channels);
        const variantCount = product.variations.length;

        let allocations: Record<string, number> = {};

        if (allocation.strategy === "equal") {
          // Divide stock equally among channels
          const perChannel = Math.floor(totalStock / channelIds.length);
          const remainder = totalStock % channelIds.length;
          for (let i = 0; i < channelIds.length; i++) {
            allocations[channelIds[i]] = perChannel + (i < remainder ? 1 : 0);
          }
        } else if (allocation.strategy === "percentage") {
          // Allocate by percentage
          const total = Object.values(allocation.channels).reduce((a, b) => a + b, 0);
          if (total !== 100) {
            return reply.status(400).send({
              error: "Percentages must sum to 100",
            });
          }
          for (const [channelId, percentage] of Object.entries(allocation.channels)) {
            allocations[channelId] = Math.floor((totalStock * percentage) / 100);
          }
        } else if (allocation.strategy === "velocity-based") {
          // TODO: Implement velocity-based allocation using historical sales data
          return reply.status(501).send({
            error: "Velocity-based allocation not yet implemented",
          });
        } else {
          return reply.status(400).send({
            error: `Unknown allocation strategy: ${allocation.strategy}`,
          });
        }

        // Distribute allocated stock evenly across variants per channel
        const result: Record<string, any> = {
          productSku,
          totalStock,
          strategy: allocation.strategy,
          allocations: {},
          variantAllocations: [],
        };

        await prisma.$transaction(async (tx: any) => {
          for (const [channelId, channelStock] of Object.entries(allocations)) {
            const perVariant = Math.floor(channelStock / variantCount);
            const remainder = channelStock % variantCount;

            result.allocations[channelId] = {
              total: channelStock,
              perVariant,
              remainder,
            };

            for (let i = 0; i < product.variations.length; i++) {
              const variant = product.variations[i];
              const variantStock = perVariant + (i < remainder ? 1 : 0);

              // Create or update VariantChannelListing
              const listing = await tx.variantChannelListing.upsert({
                where: {
                  variantId_channelId: {
                    variantId: variant.id,
                    channelId,
                  },
                },
                update: {
                  channelQuantity: variantStock,
                },
                create: {
                  variantId: variant.id,
                  channelId,
                  channelSku: variant.sku,
                  channelPrice: variant.price,
                  channelQuantity: variantStock,
                  listingStatus: "PENDING",
                },
              });

              result.variantAllocations.push({
                variantSku: variant.sku,
                channelId,
                allocatedStock: variantStock,
                listingId: listing.id,
              });
            }
          }
        });

        return reply.send(result);
      } catch (error: any) {
        request.log.error(error, "inventory-allocate failed");
        return reply.status(500).send({
          error: "Inventory allocation failed",
          message: error?.message ?? "Unknown error",
        });
      }
    }
  );

  // ── GET /inventory/top-level ──────────────────────────────────────
  // Get all top-level products (parents) with their children eagerly loaded
  // This is the primary endpoint for the inventory management UI
  app.get(
    "/inventory/top-level",
    async (request, reply) => {
      try {
        // Query ONLY top-level products (where parentId is null)
        const topLevelProducts = await prisma.product.findMany({
          where: { parentId: null },
          include: {
            variations: true,
          },
          orderBy: { createdAt: "desc" },
        });

        // Fetch children separately for each parent
        const productsWithChildren = await Promise.all(
          topLevelProducts.map(async (product: any) => {
            const children = await prisma.product.findMany({
              where: { parentId: { equals: product.id } },
              include: { variations: true },
            });

            return {
              id: product.id,
              sku: product.sku,
              name: product.name,
              basePrice: Number(product.basePrice),
              totalStock: product.totalStock,
              isParent: product.isParent,
              parentId: product.parentId,
              amazonAsin: product.amazonAsin,
              parentAsin: product.parentAsin,
              variationTheme: product.variationTheme,
              childCount: children.length,
              fulfillmentChannel: product.fulfillmentChannel,
              shippingTemplate: product.shippingTemplate,
              status: product.status,
              children: children.map((child: any) => ({
                id: child.id,
                sku: child.sku,
                name: child.name,
                basePrice: Number(child.basePrice),
                totalStock: child.totalStock,
                isParent: child.isParent,
                parentId: child.parentId,
                amazonAsin: child.amazonAsin,
                fulfillmentChannel: child.fulfillmentChannel,
                shippingTemplate: child.shippingTemplate,
                status: child.status,
                variations: child.variations.map((v: any) => ({
                  id: v.id,
                  sku: v.sku,
                  price: Number(v.price),
                  stock: v.stock,
                })),
              })),
              variations: product.variations.map((v: any) => ({
                id: v.id,
                sku: v.sku,
                price: Number(v.price),
                stock: v.stock,
              })),
            };
          })
        );

        return reply.send({
          products: productsWithChildren,
        });
      } catch (error: any) {
        request.log.error(error, "get-top-level-products failed");
        return reply.status(500).send({
          error: "Failed to fetch top-level products",
          message: error?.message ?? "Unknown error",
        });
      }
    }
  );

  // ── GET /inventory/variants/:productId ──────────────────────────────
  // Get all variants for a product with their channel listings
  app.get<{ Params: { productId: string } }>(
    "/inventory/variants/:productId",
    async (request, reply) => {
      try {
        const { productId } = request.params;

        const product = await prisma.product.findUnique({
          where: { id: productId },
          include: {
            variations: {
              include: {
                channelListings: true,
              },
            },
          },
        });

        if (!product) {
          return reply.status(404).send({
            error: "Product not found",
          });
        }

        return reply.send({
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            totalStock: product.totalStock,
            variationTheme: product.variationTheme,
          },
          variants: product.variations.map((v: any) => ({
            id: v.id,
            sku: v.sku,
            variationAttributes: v.variationAttributes,
            price: Number(v.price),
            stock: v.stock,
            isActive: v.isActive,
            channelListings: v.channelListings.map((cl: any) => ({
              id: cl.id,
              channelId: cl.channelId,
              channelSku: cl.channelSku,
              channelPrice: Number(cl.channelPrice),
              channelQuantity: cl.channelQuantity,
              listingStatus: cl.listingStatus,
              lastSyncedAt: cl.lastSyncedAt,
              lastSyncStatus: cl.lastSyncStatus,
            })),
          })),
        });
      } catch (error: any) {
        request.log.error(error, "get-variants failed");
        return reply.status(500).send({
          error: "Failed to fetch variants",
          message: error?.message ?? "Unknown error",
        });
      }
    }
  );
}
