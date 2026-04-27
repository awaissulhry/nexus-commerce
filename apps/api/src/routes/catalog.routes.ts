import type { FastifyInstance } from "fastify";
import { amazonCatalogService } from "../services/amazon-catalog.service.js";
import outboundSyncService from "../services/outbound-sync.service.js";
import prisma from "../db.js";
import { importEbayCatalog, getEbayImportStats } from "../services/ebay-import.service.js";
import { channelSyncQueue } from "../lib/queue.js";
import { logger } from "../utils/logger.js";

// ── Request/Response Types ───────────────────────────────────────────────

interface ValidateAttributesBody {
  productType: string;
  attributes: Record<string, any>;
}

interface CreateProductBody {
  sku: string;
  name: string;
  basePrice: number;
  productType: string;
  categoryAttributes: Record<string, any>;
}

interface GeneratedVariation {
  sku: string;
  quantity: number;
  price: number;
}

interface BulkCreateProductBody {
  master: {
    sku: string;
    name: string;
    basePrice: number;
    productType: string;
    categoryAttributes: Record<string, any>;
    isParent: boolean;
  };
  children: GeneratedVariation[];
  channelListings: Array<{
    channel: 'AMAZON' | 'SHOPIFY';
    title: string;
    priceOverride?: number;
    description: string;
    bulletPoints: string[];
    images: string[];
  }>;
}

// ── Catalog Routes ───────────────────────────────────────────────────────

export async function catalogRoutes(app: FastifyInstance) {
  /**
   * GET /api/catalog/product-types
   * Returns list of available Amazon product types for dropdown
   */
  app.get("/product-types", async (request, reply) => {
    try {
      const types = await amazonCatalogService.getAvailableProductTypes();
      return reply.send({
        success: true,
        data: types,
      });
    } catch (error) {
      console.error("Error fetching product types:", error);
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to fetch product types",
        },
      });
    }
  });

  /**
   * GET /api/catalog/product-types/:productType/schema
   * Returns parsed schema (required + optional fields) for a product type
   */
  app.get<{ Params: { productType: string } }>(
    "/product-types/:productType/schema",
    async (request, reply) => {
      try {
        const { productType } = request.params;

        // Validate product type
        if (!productType || productType.trim() === "") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Product type is required",
            },
          });
        }

        // Fetch schema
        const schema =
          await amazonCatalogService.getProductTypeSchema(productType);

        return reply.send({
          success: true,
          data: schema,
        });
      } catch (error: any) {
        console.error("Error fetching schema:", error);

        // Check if product type not found
        if (error.message.includes("not found")) {
          return reply.status(404).send({
            success: false,
            error: {
              code: "PRODUCT_TYPE_NOT_FOUND",
              message: `Product type "${request.params.productType}" not found`,
            },
          });
        }

        return reply.status(500).send({
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Failed to fetch schema",
          },
        });
      }
    }
  );

  /**
   * POST /api/catalog/validate
   * Validates product attributes against schema
   */
  app.post<{ Body: ValidateAttributesBody }>(
    "/validate",
    async (request, reply) => {
      try {
        const { productType, attributes } = request.body;

        // Validate request
        if (!productType || productType.trim() === "") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Product type is required",
            },
          });
        }

        if (!attributes || typeof attributes !== "object") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Attributes object is required",
            },
          });
        }

        // Validate attributes
        const result = await amazonCatalogService.validateAttributes(
          productType,
          attributes
        );

        return reply.send({
          success: true,
          data: result,
        });
      } catch (error: any) {
        console.error("Error validating attributes:", error);

        if (error.message.includes("not found")) {
          return reply.status(404).send({
            success: false,
            error: {
              code: "PRODUCT_TYPE_NOT_FOUND",
              message: `Product type not found`,
            },
          });
        }

        return reply.status(500).send({
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Validation failed",
          },
        });
      }
    }
  );

  /**
   * POST /api/products
   * Create product with dynamic attributes
   */
  app.post<{ Body: CreateProductBody }>(
    "/products",
    async (request, reply) => {
      try {
        const {
          sku,
          name,
          basePrice,
          productType,
          categoryAttributes,
        } = request.body;

        // Validate required fields
        if (!sku || sku.trim() === "") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "SKU is required",
            },
          });
        }

        if (!name || name.trim() === "") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Product name is required",
            },
          });
        }

        if (basePrice === undefined || basePrice === null) {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Base price is required",
            },
          });
        }

        if (!productType || productType.trim() === "") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Product type is required",
            },
          });
        }

        // Validate attributes against schema
        if (categoryAttributes) {
          const validationResult =
            await amazonCatalogService.validateAttributes(
              productType,
              categoryAttributes
            );

          if (!validationResult.valid) {
            return reply.status(422).send({
              success: false,
              error: {
                code: "VALIDATION_FAILED",
                message: "Attribute validation failed",
                details: validationResult.errors,
              },
            });
          }
        }

        // Check if SKU already exists
        const existingProduct = await prisma.product.findUnique({
          where: { sku },
        });

        if (existingProduct) {
          return reply.status(409).send({
            success: false,
            error: {
              code: "SKU_ALREADY_EXISTS",
              message: `Product with SKU "${sku}" already exists`,
            },
          });
        }

        // Create product with SSOT defaults
        const product = await prisma.product.create({
          data: {
            sku,
            name,
            basePrice,
            productType,
            categoryAttributes: categoryAttributes || {},
            status: "ACTIVE",
            // Phase 20: SSOT fields with defaults
            syncChannels: [],
            validationStatus: "VALID",
            validationErrors: [],
            hasChannelOverrides: false,
          },
        });

        return reply.status(201).send({
          success: true,
          data: product,
        });
      } catch (error: any) {
        console.error("[POST /products] Error creating product:", {
          message: error.message,
          code: error.code,
          meta: error.meta,
          stack: error.stack,
        });

        // Handle unique constraint violation
        if (error.code === "P2002") {
          return reply.status(409).send({
            success: false,
            error: {
              code: "SKU_ALREADY_EXISTS",
              message: "Product with this SKU already exists",
            },
          });
        }

        // Handle Prisma validation errors
        if (error.code === "P2022" || error.code === "P2025") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "SCHEMA_MISMATCH",
              message: "Database schema mismatch: " + error.message,
            },
          });
        }

        return reply.status(500).send({
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Failed to create product",
            details: error.message,
          },
        });
      }
    }
  );

  /**
   * POST /api/catalog/products/bulk
   * Create master product with variations and channel listings in a single transaction
   */
  app.post<{ Body: BulkCreateProductBody }>(
    "/products/bulk",
    async (request, reply) => {
      try {
        console.log("🔵 [BULK CREATE] Received request");
        console.log("🔵 [BULK CREATE] Request body:", JSON.stringify(request.body, null, 2));
        
        const { master, children, channelListings } = request.body;
        
        console.log("🔵 [BULK CREATE] Master:", master);
        console.log("🔵 [BULK CREATE] Children count:", children?.length);
        console.log("🔵 [BULK CREATE] Listings count:", channelListings?.length);

        // Validate master product
        if (!master.sku || master.sku.trim() === "") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Master SKU is required",
            },
          });
        }

        if (!master.name || master.name.trim() === "") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Master product name is required",
            },
          });
        }

        if (master.basePrice === undefined || master.basePrice === null) {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Master base price is required",
            },
          });
        }

        // Validate child SKUs are unique
        const childSkus = children.map((c) => c.sku);
        const uniqueChildSkus = new Set(childSkus);
        if (uniqueChildSkus.size !== childSkus.length) {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Child SKUs must be unique",
            },
          });
        }

        // Check if master SKU already exists
        const existingMaster = await prisma.product.findUnique({
          where: { sku: master.sku },
        });

        if (existingMaster) {
          return reply.status(409).send({
            success: false,
            error: {
              code: "SKU_ALREADY_EXISTS",
              message: `Product with SKU "${master.sku}" already exists`,
            },
          });
        }

        // Check if any child SKUs already exist
        if (children.length > 0) {
          const existingChildren = await prisma.product.findMany({
            where: { sku: { in: childSkus } },
            select: { sku: true },
          });

          if (existingChildren.length > 0) {
            return reply.status(409).send({
              success: false,
              error: {
                code: "SKU_ALREADY_EXISTS",
                message: `Child SKUs already exist: ${existingChildren.map((c) => c.sku).join(", ")}`,
              },
            });
          }
        }

        // Validate attributes against schema
        // For parent products (isParent=true or children.length > 0), relax validation
        // Variation attributes should be on children, not parent
        const isParentProduct = master.isParent || children.length > 0;
        
        if (master.categoryAttributes) {
          const validationResult =
            await amazonCatalogService.validateAttributes(
              master.productType,
              master.categoryAttributes
            );

          if (!validationResult.valid) {
            // For parent products, filter out variation attribute errors
            if (isParentProduct) {
              const variationAttributeNames = ['Color', 'Size', 'Style', 'Material', 'Pattern', 'Fit', 'Length', 'Width', 'Height', 'Weight', 'Flavor', 'Scent'];
              const nonVariationErrors = validationResult.errors.filter(
                (error: any) => !variationAttributeNames.some(attr =>
                  error.field.toLowerCase().includes(attr.toLowerCase())
                )
              );

              // Only fail if there are non-variation attribute errors
              if (nonVariationErrors.length > 0) {
                return reply.status(422).send({
                  success: false,
                  error: {
                    code: "VALIDATION_FAILED",
                    message: "Master product attribute validation failed",
                    details: nonVariationErrors,
                  },
                });
              }
              // Parent product validation passed (variation attributes ignored)
            } else {
              // For non-parent products, strict validation
              return reply.status(422).send({
                success: false,
                error: {
                  code: "VALIDATION_FAILED",
                  message: "Master product attribute validation failed",
                  details: validationResult.errors,
                },
              });
            }
          }
        }

        // Execute atomic transaction
        const result = await prisma.$transaction(async (tx: any) => {
          // 1. Create master product
          const masterProduct = await tx.product.create({
            data: {
              sku: master.sku,
              name: master.name,
              basePrice: master.basePrice,
              productType: master.productType,
              categoryAttributes: master.categoryAttributes || {},
              status: "ACTIVE",
              isMasterProduct: master.isParent,
              isParent: master.isParent,
            },
          });

          // 2. Create child products if variations exist
          // Children inherit master's categoryAttributes (which may include variation attributes)
          let createdChildren: any[] = [];
          if (children.length > 0) {
            createdChildren = await Promise.all(
              children.map((child) =>
                tx.product.create({
                  data: {
                    sku: child.sku,
                    name: `${master.name} - ${child.sku}`,
                    basePrice: child.price,
                    totalStock: child.quantity,
                    productType: master.productType,
                    // Children inherit parent's categoryAttributes
                    // In a real scenario, variation attributes would be added here per child
                    categoryAttributes: master.categoryAttributes || {},
                    status: "ACTIVE",
                    parentId: masterProduct.id,
                    masterProductId: masterProduct.id,
                    isParent: false,
                  },
                })
              )
            );
          }

          // 3. Create channel listings for master product
          let createdListings: any[] = [];
          if (channelListings.length > 0) {
            createdListings = await Promise.all(
              channelListings.map((listing) =>
                tx.channelListing.create({
                  data: {
                    productId: masterProduct.id,
                    channel: listing.channel,
                    channelMarket: `${listing.channel}_US`, // Default to US region
                    region: "US",
                    title: listing.title,
                    description: listing.description,
                    price: listing.priceOverride || master.basePrice,
                    platformAttributes: {
                      bulletPoints: listing.bulletPoints.filter((b) => b.trim()),
                      images: listing.images || [],
                    },
                  },
                })
              )
            );
          }

          return {
            master: masterProduct,
            children: createdChildren,
            listings: createdListings,
          };
        });

        return reply.status(201).send({
          success: true,
          data: {
            master: result.master,
            childrenCount: result.children.length,
            listingsCount: result.listings.length,
            message: `Created master product with ${result.children.length} variations and ${result.listings.length} channel listings`,
          },
        });
      } catch (error: any) {
        console.error("Error creating bulk product:", error);
        console.error("Error stack:", error.stack);
        console.error("Error details:", JSON.stringify(error, null, 2));

        // Handle unique constraint violation
        if (error.code === "P2002") {
          return reply.status(409).send({
            success: false,
            error: {
              code: "SKU_ALREADY_EXISTS",
              message: "One or more SKUs already exist",
            },
          });
        }

        // Handle Prisma validation errors
        if (error.code === "P2025") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Referenced record not found",
            },
          });
        }

        // Return detailed error for debugging
        return reply.status(500).send({
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: error.message || "Failed to create bulk product",
            details: process.env.NODE_ENV === 'development' ? {
              errorCode: error.code,
              errorName: error.name,
              stack: error.stack,
            } : undefined,
          },
        });
      }
    }
  );

  /**
   * PATCH /api/products/:id
   * Update product and queue syncs to marketplaces
   */
  app.patch<{
    Params: { id: string };
    Body: {
      basePrice?: number;
      totalStock?: number;
      categoryAttributes?: Record<string, any>;
      name?: string;
      syncChannels?: ("AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE")[];
    };
  }>("/products/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      const {
        basePrice,
        totalStock,
        categoryAttributes,
        name,
        syncChannels = ["AMAZON", "EBAY"],
      } = request.body;

      // Find product
      const product = await prisma.product.findUnique({
        where: { id },
      });

      if (!product) {
        return reply.status(404).send({
          success: false,
          error: {
            code: "PRODUCT_NOT_FOUND",
            message: `Product with ID "${id}" not found`,
          },
        });
      }

      // Track what changed
      const changes: Record<string, any> = {};
      if (basePrice !== undefined) changes.basePrice = basePrice;
      if (totalStock !== undefined) changes.totalStock = totalStock;
      if (categoryAttributes !== undefined)
        changes.categoryAttributes = categoryAttributes;
      if (name !== undefined) changes.name = name;

      // Update product
      const updatedProduct = await prisma.product.update({
        where: { id },
        data: changes,
      });

      // Queue syncs for changed fields
      const syncPayload: Record<string, any> = {};
      let shouldSync = false;

      if (
        basePrice !== undefined &&
        basePrice !== product.basePrice.toNumber()
      ) {
        syncPayload.price = basePrice;
        shouldSync = true;
      }

      if (totalStock !== undefined && totalStock !== product.totalStock) {
        syncPayload.quantity = totalStock;
        shouldSync = true;
      }

      if (categoryAttributes !== undefined) {
        syncPayload.categoryAttributes = categoryAttributes;
        shouldSync = true;
      }

      if (name !== undefined && name !== product.name) {
        syncPayload.title = name;
        shouldSync = true;
      }

      // Queue syncs if anything changed
      if (shouldSync) {
        const queueResults = [];
        for (const channel of syncChannels) {
          const result = await outboundSyncService.queueProductUpdate(
            id,
            channel,
            basePrice !== undefined && totalStock !== undefined
              ? "FULL_SYNC"
              : basePrice !== undefined
                ? "PRICE_UPDATE"
                : totalStock !== undefined
                  ? "QUANTITY_UPDATE"
                  : "ATTRIBUTE_UPDATE",
            syncPayload
          );
          queueResults.push({
            channel,
            queued: result.success,
            queueId: result.queueId,
          });
        }

        return reply.send({
          success: true,
          data: updatedProduct,
          syncs: queueResults,
          message: "Product updated and syncs queued",
        });
      }

      return reply.send({
        success: true,
        data: updatedProduct,
        message: "Product updated (no changes to sync)",
      });
    } catch (error: any) {
      console.error("Error updating product:", error);

      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to update product",
        },
      });
    }
  });

  /**
   * GET /api/catalog/cache-stats
   * Get cache statistics (for monitoring)
   */
  app.get("/cache-stats", async (request, reply) => {
    try {
      const stats = amazonCatalogService.getCacheStats();
      return reply.send({
        success: true,
        data: stats,
      });
    } catch (error) {
      console.error("Error getting cache stats:", error);
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to get cache stats",
        },
      });
    }
  });

  /**
   * POST /api/catalog/cache-clear
   * Clear schema cache (admin only)
   */
  app.post("/cache-clear", async (request, reply) => {
    try {
      amazonCatalogService.clearCache();
      return reply.send({
        success: true,
        message: "Cache cleared successfully",
      });
    } catch (error) {
      console.error("Error clearing cache:", error);
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to clear cache",
        },
      });
    }
  });

  /**
   * DELETE /api/catalog/products/:id
   * Delete a product and all associated data (cascading delete)
   */
  app.delete<{ Params: { id: string } }>(
    "/products/:id",
    async (request, reply) => {
      try {
        const { id } = request.params;

        if (!id || id.trim() === "") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Product ID is required",
            },
          });
        }

        // Execute cascading delete in a transaction
        const result = await prisma.$transaction(async (tx) => {
          // 1. Find the product to check if it's a parent
          const product = await tx.product.findUnique({
            where: { id },
            include: {
              children: { select: { id: true } },
            },
          });

          if (!product) {
            throw new Error("Product not found");
          }

          // 2. If product is a parent, delete all children's related data first
          if (product.isParent && product.children.length > 0) {
            const childIds = product.children.map((c) => c.id);

            // Delete child offers (via ChannelListings)
            const childListings = await tx.channelListing.findMany({
              where: { productId: { in: childIds } },
              select: { id: true },
            });
            const childListingIds = childListings.map((l) => l.id);

            if (childListingIds.length > 0) {
              await tx.offer.deleteMany({
                where: { channelListingId: { in: childListingIds } },
              });
            }

            // Delete child ChannelListingImages
            await tx.channelListingImage.deleteMany({
              where: { channelListingId: { in: childListingIds } },
            });

            // Delete child ChannelListings
            await tx.channelListing.deleteMany({
              where: { productId: { in: childIds } },
            });

            // Delete child ProductImages
            await tx.productImage.deleteMany({
              where: { productId: { in: childIds } },
            });

            // Delete child Products
            await tx.product.deleteMany({
              where: { id: { in: childIds } },
            });
          }

          // 3. Delete parent's ChannelListings and related data
          const parentListings = await tx.channelListing.findMany({
            where: { productId: id },
            select: { id: true },
          });
          const parentListingIds = parentListings.map((l) => l.id);

          if (parentListingIds.length > 0) {
            // Delete parent offers
            await tx.offer.deleteMany({
              where: { channelListingId: { in: parentListingIds } },
            });

            // Delete parent ChannelListingImages
            await tx.channelListingImage.deleteMany({
              where: { channelListingId: { in: parentListingIds } },
            });

            // Delete parent ChannelListings
            await tx.channelListing.deleteMany({
              where: { id: { in: parentListingIds } },
            });
          }

          // 4. Delete parent ProductImages
          await tx.productImage.deleteMany({
            where: { productId: id },
          });

          // 5. Delete parent Product
          const deletedProduct = await tx.product.delete({
            where: { id },
          });

          return deletedProduct;
        });

        return reply.send({
          success: true,
          data: result,
          message: `Product "${result.sku}" and all associated data deleted successfully`,
        });
      } catch (error: any) {
        console.error("Error deleting product:", error);

        // Check if it's a Prisma error
        if (error.code === "P2025") {
          return reply.status(404).send({
            success: false,
            error: {
              code: "NOT_FOUND",
              message: "Product not found",
            },
          });
        }

        return reply.status(500).send({
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: error.message || "Failed to delete product",
          },
        });
      }
    }
  );

  /**
   * POST /products/:parentId/children
   * Create a new child product (variation)
   */
  app.post<{
    Params: { parentId: string };
    Body: {
      sku: string;
      name: string;
      basePrice: number | string;
      totalStock: number | string;
    };
  }>("/products/:parentId/children", async (request, reply) => {
    try {
      const { parentId } = request.params;
      let { sku, name, basePrice, totalStock } = request.body;

      // Validate required fields
      if (!sku || !name) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "SKU and name are required",
          },
        });
      }

      // Parse numeric values
      const parsedBasePrice = parseFloat(String(basePrice)) || 0;
      const parsedTotalStock = parseInt(String(totalStock), 10) || 0;

      // Validate parent exists
      const parent = await prisma.product.findUnique({
        where: { id: parentId },
      });

      if (!parent) {
        return reply.status(404).send({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Parent product not found",
          },
        });
      }

      // Check if SKU already exists
      const existingSku = await prisma.product.findUnique({
        where: { sku },
      });

      if (existingSku) {
        return reply.status(409).send({
          success: false,
          error: {
            code: "DUPLICATE_SKU",
            message: `SKU "${sku}" already exists`,
          },
        });
      }

      // Create the child product
      const childProduct = await prisma.product.create({
        data: {
          sku,
          name,
          basePrice: parsedBasePrice,
          totalStock: parsedTotalStock,
          parentId,
          isMasterProduct: false,
          validationStatus: "VALID",
          syncChannels: parent.syncChannels || ["AMAZON", "EBAY"],
          status: "ACTIVE",
        },
      });

      return reply.status(201).send({
        success: true,
        data: childProduct,
        message: `Child product "${name}" created successfully`,
      });
    } catch (error: any) {
      logger.error("Failed to create child product", {
        error: error.message,
        parentId: request.params.parentId,
      });

      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error.message || "Failed to create child product",
        },
      });
    }
  });

  /**
   * POST /api/catalog/products/:parentId/bulk-variants
   * Phase 29: Bulk create variants from matrix builder
   * Generates all variations in a single transaction
   */
  app.post<{
    Params: { parentId: string };
    Body: {
      variations: Array<{
        sku: string;
        name: string;
        optionValues: Record<string, string>;
      }>;
      globalPrice: number;
      globalStock: number;
    };
  }>("/products/:parentId/bulk-variants", async (request, reply) => {
    try {
      const { parentId } = request.params;
      const { variations, globalPrice, globalStock } = request.body;

      console.log("[BULK VARIANTS] Starting bulk variant creation", {
        parentId,
        variationCount: variations.length,
        globalPrice,
        globalStock,
      });

      // Validate parent exists
      const parent = await prisma.product.findUnique({
        where: { id: parentId },
      });

      if (!parent) {
        return reply.status(404).send({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Parent product not found",
          },
        });
      }

      // Validate variations
      if (!variations || variations.length === 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "At least one variation is required",
          },
        });
      }

      // Validate global settings
      if (globalPrice <= 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Global price must be greater than 0",
          },
        });
      }

      if (globalStock < 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Global stock cannot be negative",
          },
        });
      }

      // Check for duplicate SKUs in request
      const skus = variations.map((v) => v.sku);
      const uniqueSkus = new Set(skus);
      if (uniqueSkus.size !== skus.length) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Variation SKUs must be unique",
          },
        });
      }

      // Check if any SKUs already exist in database
      const existingSkus = await prisma.product.findMany({
        where: { sku: { in: skus } },
        select: { sku: true },
      });

      if (existingSkus.length > 0) {
        return reply.status(409).send({
          success: false,
          error: {
            code: "SKU_ALREADY_EXISTS",
            message: `SKUs already exist: ${existingSkus.map((s) => s.sku).join(", ")}`,
          },
        });
      }

      // Create all variations in a transaction
      const result = await prisma.$transaction(async (tx: any) => {
        // Mark parent as parent if not already
        if (!parent.isParent) {
          await tx.product.update({
            where: { id: parentId },
            data: { isParent: true },
          });
        }

        // Create all child products
        const createdVariations = await Promise.all(
          variations.map((variation) =>
            tx.product.create({
              data: {
                sku: variation.sku,
                name: variation.name,
                basePrice: globalPrice,
                totalStock: globalStock,
                parentId,
                masterProductId: parentId,
                isParent: false,
                status: "ACTIVE",
                productType: parent.productType,
                categoryAttributes: {
                  ...parent.categoryAttributes,
                  ...variation.optionValues,
                },
                syncChannels: parent.syncChannels || ["AMAZON", "EBAY"],
                validationStatus: "VALID",
              },
            })
          )
        );

        return createdVariations;
      });

      console.log("[BULK VARIANTS] Successfully created", {
        count: result.length,
        parentId,
      });

      return reply.status(201).send({
        success: true,
        data: {
          parentId,
          createdCount: result.length,
          variations: result,
        },
        message: `Successfully created ${result.length} variations`,
      });
    } catch (error: any) {
      console.error("[BULK VARIANTS] Error:", error);

      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error.message || "Failed to create bulk variants",
        },
      });
    }
  });

  /**
   * PATCH /api/products/:parentId/children/:childId
   * Update a child product (variation)
   */
  app.patch<{
    Params: { parentId: string; childId: string };
    Body: {
      sku?: string;
      basePrice?: number | string;
      totalStock?: number | string;
      name?: string;
    };
  }>("/products/:parentId/children/:childId", async (request, reply) => {
    try {
      const { parentId, childId } = request.params;
      let { sku, basePrice, totalStock, name } = request.body;

      // 🔵 BACKEND TRACING: Log when endpoint is hit
      console.log('🔵 PATCH child endpoint hit', {
        parentId,
        childId,
        updates: { sku, basePrice, totalStock, name }
      });

      // Parse string values to proper types
      const parsedBasePrice = basePrice !== undefined ? parseFloat(String(basePrice)) : undefined;
      const parsedTotalStock = totalStock !== undefined ? parseInt(String(totalStock), 10) : undefined;

      // Validate parent exists and is a parent
      const parent = await prisma.product.findUnique({
        where: { id: parentId },
      });

      if (!parent) {
        return reply.status(404).send({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Parent product not found",
          },
        });
      }

      // Validate child exists and belongs to parent
      const child = await prisma.product.findUnique({
        where: { id: childId },
      });

      if (!child || child.parentId !== parentId) {
        return reply.status(404).send({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Child product not found or does not belong to this parent",
          },
        });
      }

      // Validate SKU uniqueness if changing SKU
      if (sku && sku !== child.sku) {
        const existingSku = await prisma.product.findUnique({
          where: { sku },
        });
        if (existingSku) {
          return reply.status(409).send({
            success: false,
            error: {
              code: "SKU_ALREADY_EXISTS",
              message: `SKU "${sku}" already exists`,
            },
          });
        }
      }

      // Validate price
      if (parsedBasePrice !== undefined && parsedBasePrice <= 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Price must be greater than 0",
          },
        });
      }

      // Validate stock
      if (parsedTotalStock !== undefined && parsedTotalStock < 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Stock cannot be negative",
          },
        });
      }

      // Update child product
      const updatedChild = await prisma.product.update({
        where: { id: childId },
        data: {
          ...(sku && { sku }),
          ...(parsedBasePrice !== undefined && { basePrice: parsedBasePrice }),
          ...(parsedTotalStock !== undefined && { totalStock: parsedTotalStock }),
          ...(name && { name }),
        },
      });

      return reply.status(200).send({
        success: true,
        data: updatedChild,
        message: "Child product updated successfully",
      });
    } catch (error: any) {
      console.error("Error updating child product:", error);

      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error.message || "Failed to update child product",
        },
      });
    }
  });

  /**
   * DELETE /api/products/:parentId/children/:childId
   * Delete a child product (variation)
   */
  app.delete<{
    Params: { parentId: string; childId: string };
  }>("/products/:parentId/children/:childId", async (request, reply) => {
    try {
      const { parentId, childId } = request.params;

      // Validate parent exists
      const parent = await prisma.product.findUnique({
        where: { id: parentId },
      });

      if (!parent) {
        return reply.status(404).send({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Parent product not found",
          },
        });
      }

      // Validate child exists and belongs to parent
      const child = await prisma.product.findUnique({
        where: { id: childId },
      });

      if (!child || child.parentId !== parentId) {
        return reply.status(404).send({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Child product not found or does not belong to this parent",
          },
        });
      }

      // Delete child product
      await prisma.product.delete({
        where: { id: childId },
      });

      // Check if parent still has children
      const remainingChildren = await prisma.product.count({
        where: { parentId },
      });

      // If no children left, update parent's isParent flag
      if (remainingChildren === 0) {
        await prisma.product.update({
          where: { id: parentId },
          data: { isParent: false },
        });
      }

      return reply.status(200).send({
        success: true,
        message: "Child product deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting child product:", error);

      if (error.code === "P2025") {
        return reply.status(404).send({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Child product not found",
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error.message || "Failed to delete child product",
        },
      });
    }
  });


  /**
   * POST /api/catalog/sync/bulk
   * Phase 25: Bulk sync all products to specified channel(s)
   * Queues jobs to the channel-sync BullMQ queue
   */
  app.post<{ Body: { targetChannel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ALL' } }>(
    "/sync/bulk",
    async (request, reply) => {
      try {
        const { targetChannel } = request.body;

        console.log(`[BULK SYNC] Starting bulk sync to channel: ${targetChannel}`);

        // Fetch all products
        const allProducts = await prisma.product.findMany({
          select: {
            id: true,
            sku: true,
            name: true,
            syncChannels: true,
            isMasterProduct: true,
          },
        });

        console.log(`[BULK SYNC] Found ${allProducts.length} products to sync`);

        let queued = 0;

        // Queue sync jobs for each product
        for (const product of allProducts) {
          const channels = product.syncChannels || ['AMAZON'];
          
          // Determine which channels to sync to
          const targetChannels = targetChannel === 'ALL'
            ? channels
            : [targetChannel];

          for (const channel of targetChannels) {
            // Queue a sync job to the channel-sync queue
            try {
              await channelSyncQueue.add(
                'channel-sync',
                {
                  productId: product.id,
                  targetChannel: channel,
                },
                {
                  attempts: 3,
                  backoff: {
                    type: 'exponential',
                    delay: 2000,
                  },
                }
              );
              console.log(`[BULK SYNC] Queued ${product.sku} for ${channel} sync`);
              queued++;
            } catch (queueError) {
              console.error(`[BULK SYNC] Failed to queue ${product.sku}:`, queueError);
            }
          }
        }

        console.log(`[BULK SYNC] Bulk sync complete: ${queued} jobs queued`);

        return reply.status(202).send({
          success: true,
          data: {
            queued,
            targetChannel,
            totalProducts: allProducts.length,
          },
          message: `Successfully queued ${queued} sync jobs for channel: ${targetChannel}`,
        });
      } catch (error: any) {
        console.error("[BULK SYNC] Error:", error);

        return reply.status(500).send({
          success: false,
          error: {
            code: "BULK_SYNC_FAILED",
            message: error.message || "Failed to queue bulk sync",
          },
        });
      }
    }
  );

  /**
   * POST /api/catalog/ebay/import
   * Phase 25: Import eBay catalog and save as Master Products
   */
  app.post("/ebay/import", async (request, reply) => {
    try {
      console.log("[EBAY IMPORT] Starting import...");

      // Call the import service
      const result = await importEbayCatalog();

      console.log("[EBAY IMPORT] Import complete:", result);

      return reply.status(201).send({
        success: true,
        data: {
          created: result.created,
          updated: result.updated,
          total: result.total,
          products: result.products,
        },
        message: `Successfully imported ${result.total} products from eBay (${result.created} created, ${result.updated} updated)`,
      });
    } catch (error: any) {
      console.error("[EBAY IMPORT] Error:", error);

      return reply.status(500).send({
        success: false,
        error: {
          code: "IMPORT_FAILED",
          message: error.message || "Failed to import eBay catalog",
        },
      });
    }
  });

  /**
   * GET /api/catalog/ebay/stats
   * Get eBay import statistics
   */
  app.get("/ebay/stats", async (request, reply) => {
    try {
      const stats = await getEbayImportStats();

      return reply.status(200).send({
        success: true,
        data: stats,
      });
    } catch (error: any) {
      console.error("[EBAY STATS] Error:", error);

      return reply.status(500).send({
        success: false,
        error: {
          code: "STATS_FAILED",
          message: error.message || "Failed to get eBay import statistics",
        },
      });
    }
  });
}
