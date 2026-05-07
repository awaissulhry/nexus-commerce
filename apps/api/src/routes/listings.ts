import type { FastifyInstance } from "fastify";
import { AmazonService } from "../services/marketplaces/amazon.service.js";
import { runSync } from "../jobs/sync.job.js";
import { GeminiService } from "../services/ai/gemini.service.js";
import { AiListingService } from "../services/ai/ai-listing.service.js";
import { EbayCategoryService } from "../services/ebay-category.service.js";
import { EbayService } from "../services/marketplaces/ebay.service.js";
import { EbayPublishService } from "../services/ebay-publish.service.js";
import prisma from "@nexus/database";

export async function listingsRoutes(app: FastifyInstance) {
  // POST /listings/sync-amazon-catalog
  // Pulls the full active catalog from Amazon via the SP-API Reports API,
  // upserts every SKU into our Product table, and optionally enriches each
  // product with detailed data from the Listings / Catalog Items APIs.
  app.post("/listings/sync-amazon-catalog", async (request, reply) => {
    try {
      const amazon = new AmazonService();

      // Step 1 — Fetch the lightweight catalog (report-based)
      const catalog = await amazon.fetchActiveCatalog();

      if (catalog.length === 0) {
        return reply.send({
          success: true,
          message: "No active listings found in Amazon catalog.",
          synced: 0,
        });
      }

      let created = 0;
      let updated = 0;
      let enriched = 0;

      for (const item of catalog) {
        // Step 2 — Upsert the basic product record
        const existing = await (prisma as any).product.findUnique({
          where: { sku: item.sku },
        });

        if (existing) {
          await (prisma as any).product.update({
            where: { sku: item.sku },
            data: {
              amazonAsin: item.asin,
              basePrice: item.price,
              totalStock: item.quantity,
              name: item.title || existing.name,
            },
          });
          updated++;
        } else {
          await (prisma as any).product.create({
            data: {
              sku: item.sku,
              name: item.title || item.sku,
              basePrice: item.price,
              totalStock: item.quantity,
              amazonAsin: item.asin,
            },
          });
          created++;
        }

        // Step 3 — Enrich with detailed data (title, brand, bullets, images…)
        try {
          const details = await amazon.fetchProductDetails(item.sku);

          const updateData: Record<string, any> = {};

          if (details.title) updateData.name = details.title;
          if (details.brand) updateData.brand = details.brand;
          if (details.manufacturer)
            updateData.manufacturer = details.manufacturer;
          if (details.upc) updateData.upc = details.upc;
          if (details.ean) updateData.ean = details.ean;
          if (details.bulletPoints.length > 0)
            updateData.bulletPoints = details.bulletPoints;
          if (details.keywords.length > 0)
            updateData.keywords = details.keywords;
          if (details.weightValue != null) {
            updateData.weightValue = details.weightValue;
            updateData.weightUnit = details.weightUnit;
          }
          if (details.dimLength != null) {
            updateData.dimLength = details.dimLength;
            updateData.dimWidth = details.dimWidth;
            updateData.dimHeight = details.dimHeight;
            updateData.dimUnit = details.dimUnit;
          }

          if (Object.keys(updateData).length > 0) {
            await (prisma as any).product.update({
              where: { sku: item.sku },
              data: updateData,
            });
          }

          // Upsert images
          if (details.images.length > 0) {
            const product = await (prisma as any).product.findUnique({
              where: { sku: item.sku },
            });

            if (product) {
              // Remove old images and insert fresh ones
              await (prisma as any).productImage.deleteMany({
                where: { productId: product.id },
              });

              await (prisma as any).productImage.createMany({
                data: details.images.map((img) => ({
                  productId: product.id,
                  url: img.url,
                  alt: img.alt,
                  type: img.type,
                })),
              });
            }
          }

          enriched++;
        } catch (enrichError: any) {
          // Enrichment is non-fatal — log and continue
          console.warn(
            `[Listings] Enrichment failed for SKU "${item.sku}":`,
            enrichError?.message ?? enrichError
          );
        }
      }

      return reply.send({
        success: true,
        message: "Amazon catalog synced successfully",
        total: catalog.length,
        created,
        updated,
        enriched,
      });
    } catch (error: any) {
      request.log.error(error, "sync-amazon-catalog failed");
      return reply.status(500).send({
        error: "Failed to sync Amazon catalog",
        message: error?.message ?? "Unknown error",
      });
    }
  });

  // POST /listings/force-sync-ebay
  // Manually triggers the Amazon → eBay sync without waiting for the cron schedule.
  app.post("/listings/force-sync-ebay", async (request, reply) => {
    try {
      await runSync();
      return reply.send({
        success: true,
        message: "Manual eBay sync executed",
      });
    } catch (error: any) {
      request.log.error(error, "force-sync-ebay failed");
      return reply.status(500).send({
        success: false,
        error: "Manual eBay sync failed",
        message: error?.message ?? "Unknown error",
      });
    }
  });

  // POST /listings/generate
  // Generate an AI-optimized eBay listing draft from a product using Gemini API
  app.post<{ Body: { productId: string; regenerate?: boolean } }>(
    "/listings/generate",
    async (request, reply) => {
      try {
        const { productId, regenerate = false } = request.body;

        // Validate request
        if (!productId || typeof productId !== "string") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "productId is required and must be a string",
            },
          });
        }

        if (typeof regenerate !== "boolean") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "regenerate must be a boolean",
            },
          });
        }

        // Initialize services
        const geminiService = new GeminiService();
        const ebayCategoryService = new EbayCategoryService();
        const aiListingService = new AiListingService(
          geminiService,
          ebayCategoryService,
          prisma
        );

        // Generate listing draft
        const draftListing = await aiListingService.generateListingDraft(
          productId,
          regenerate
        );

        return reply.status(200).send({
          success: true,
          data: draftListing,
        });
      } catch (error: any) {
        const message = error?.message ?? "Unknown error";

        // Handle specific error cases
        if (message.includes("Product not found")) {
          request.log.warn(error, "Product not found for listing generation");
          return reply.status(404).send({
            success: false,
            error: {
              code: "PRODUCT_NOT_FOUND",
              message: "Product not found",
              details: { productId: request.body.productId },
            },
          });
        }

        if (message.includes("Draft already exists")) {
          request.log.info(error, "Draft already exists");
          return reply.status(409).send({
            success: false,
            error: {
              code: "DRAFT_EXISTS",
              message: "Draft already exists for this product",
              details: {
                productId: request.body.productId,
                hint: "Use regenerate=true to overwrite",
              },
            },
          });
        }

        if (message.includes("Invalid product data")) {
          request.log.warn(error, "Invalid product data");
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_PRODUCT_DATA",
              message: message,
              details: { productId: request.body.productId },
            },
          });
        }

        // Generic error handling
        request.log.error(error, "Failed to generate listing");
        return reply.status(500).send({
          success: false,
          error: {
            code: "AI_GENERATION_FAILED",
            message: "Failed to generate listing draft",
            details: { error: message },
          },
        });
      }
    }
  );

  // POST /listings/:draftId/publish
  // Publishes a draft listing to eBay
  app.post<{ Params: { draftId: string } }>(
    "/listings/:draftId/publish",
    async (request, reply) => {
      try {
        const { draftId } = request.params;

        // Validate request
        if (!draftId || typeof draftId !== "string") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "draftId is required and must be a string",
            },
          });
        }

        // Initialize services
        const ebayService = new EbayService();
        const ebayPublishService = new EbayPublishService(
          ebayService,
          prisma
        );

        // publishDraft is now end-to-end: it calls eBay, updates the
        // DraftListing to PUBLISHED, upserts VariantChannelListing,
        // and emits `listing.created` so SSE consumers refresh. The
        // bulk-list worker shares the same path.
        const publishResult = await ebayPublishService.publishDraft(draftId);

        return reply.status(200).send({
          success: true,
          data: publishResult,
        });
      } catch (error: any) {
        const message = error?.message ?? "Unknown error";

        // Handle specific error cases
        if (message.includes("Draft not found")) {
          request.log.warn(error, "Draft not found");
          return reply.status(404).send({
            success: false,
            error: {
              code: "DRAFT_NOT_FOUND",
              message: "Draft not found",
              details: { draftId: request.params.draftId },
            },
          });
        }

        if (message.includes("not in DRAFT status")) {
          request.log.warn(error, "Draft already published");
          return reply.status(409).send({
            success: false,
            error: {
              code: "DRAFT_ALREADY_PUBLISHED",
              message: "Draft has already been published",
              details: { draftId: request.params.draftId },
            },
          });
        }

        if (message.includes("missing required field")) {
          request.log.warn(error, "Invalid draft data");
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_DRAFT_DATA",
              message: message,
              details: { draftId: request.params.draftId },
            },
          });
        }

        // eBay API errors
        if (message.includes("eBay")) {
          request.log.error(error, "eBay API error");
          return reply.status(502).send({
            success: false,
            error: {
              code: "EBAY_API_ERROR",
              message: "Failed to publish to eBay",
              details: { error: message },
            },
          });
        }

        // Generic error handling
        request.log.error(error, "Failed to publish draft");
        return reply.status(500).send({
          success: false,
          error: {
            code: "PUBLISH_FAILED",
            message: "Failed to publish draft",
            details: { error: message },
          },
        });
      }
    }
  );

 // GET /api/listings/products
 // Get all imported Amazon products (ready to list)
 app.get("/listings/products", async (request, reply) => {
   try {
     const products = await (prisma as any).product.findMany({
       where: {
         amazonAsin: { not: null },
       },
       select: {
         id: true,
         sku: true,
         name: true,
         basePrice: true,
         amazonAsin: true,
         ebayItemId: true,
         totalStock: true,
         brand: true,
       },
       orderBy: { createdAt: "desc" },
     });

     return reply.send({
       success: true,
       data: products,
     });
   } catch (error: any) {
     request.log.error(error, "Failed to fetch products");
     return reply.status(500).send({
       success: false,
       error: {
         code: "FETCH_FAILED",
         message: "Failed to fetch products",
       },
     });
   }
 });

 // GET /api/listings/published
 // Get products with ebayItemId (published to eBay)
 app.get("/listings/published", async (request, reply) => {
   try {
     const published = await (prisma as any).product.findMany({
       where: {
         ebayItemId: { not: null },
       },
       select: {
         id: true,
         sku: true,
         name: true,
         basePrice: true,
         amazonAsin: true,
         ebayItemId: true,
         totalStock: true,
         brand: true,
       },
       orderBy: { updatedAt: "desc" },
     });

     return reply.send({
       success: true,
       data: published,
     });
   } catch (error: any) {
     request.log.error(error, "Failed to fetch published listings");
     return reply.status(500).send({
       success: false,
       error: {
         code: "FETCH_FAILED",
         message: "Failed to fetch published listings",
       },
     });
   }
 });

 // POST /api/listings/bulk-publish-to-ebay
 // Queue a bulk publish job to eBay using BullMQ
 app.post<{
   Body: {
     productIds: string[];
     marketplaceId: "EBAY_IT" | "EBAY_US" | "EBAY_DE" | "EBAY_FR" | "EBAY_UK";
     pricingMarkupPercent?: number;
     dryRun?: boolean;
   };
 }>("/listings/bulk-publish-to-ebay", async (request, reply) => {
   try {
     const { productIds, marketplaceId, pricingMarkupPercent = 0, dryRun = false } = request.body;

     // Validate productIds
     if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
       return reply.status(400).send({
         success: false,
         error: {
           code: "INVALID_REQUEST",
           message: "productIds must be a non-empty array",
         },
       });
     }

     if (productIds.length > 1000) {
       return reply.status(400).send({
         success: false,
         error: {
           code: "INVALID_REQUEST",
           message: "Maximum 1000 products per bulk job",
         },
       });
     }

     // Validate marketplaceId
     const validMarketplaces = ["EBAY_IT", "EBAY_US", "EBAY_DE", "EBAY_FR", "EBAY_UK"];
     if (!validMarketplaces.includes(marketplaceId)) {
       return reply.status(400).send({
         success: false,
         error: {
           code: "INVALID_REQUEST",
           message: `Invalid marketplaceId. Must be one of: ${validMarketplaces.join(", ")}`,
         },
       });
     }

     // Validate pricingMarkupPercent
     if (pricingMarkupPercent < 0 || pricingMarkupPercent > 500) {
       return reply.status(400).send({
         success: false,
         error: {
           code: "INVALID_REQUEST",
           message: "pricingMarkupPercent must be between 0 and 500",
         },
       });
     }

     // Import BullMQ queue
     const { bulkListQueue } = await import("../services/bulk-list.service.js");

     // Enqueue the job
     const jobData = {
       productIds,
       marketplaceId,
       pricingMarkupPercent,
       dryRun,
     };

     const job = await bulkListQueue.add("bulk-publish", jobData, {
       jobId: `bulk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
     });

     return reply.status(202).send({
       success: true,
       data: {
         jobId: job.id,
         queued: productIds.length,
         status: "QUEUED",
       },
     });
   } catch (error: any) {
     request.log.error(error, "Failed to queue bulk publish job");
     return reply.status(500).send({
       success: false,
       error: {
         code: "JOB_CREATION_FAILED",
         message: "Failed to queue bulk publish job",
       },
     });
   }
 });

 // GET /api/listings/bulk-publish-to-ebay/:jobId
 // Poll job status using BullMQ
 app.get<{ Params: { jobId: string } }>(
   "/listings/bulk-publish-to-ebay/:jobId",
   async (request, reply) => {
     try {
       const { jobId } = request.params;

       // Import BullMQ queue
       const { bulkListQueue } = await import("../services/bulk-list.service.js");

       // Fetch job from queue
       const job = await bulkListQueue.getJob(jobId);

       if (!job) {
         return reply.status(404).send({
           success: false,
           error: {
             code: "JOB_NOT_FOUND",
             message: `Job ${jobId} not found`,
           },
         });
       }

       // Get job state
       const state = await job.getState();
       const progress = job.progress;
       const result = job.returnvalue;
       const failedReason = job.failedReason;

       return reply.send({
         success: true,
         data: {
           jobId,
           state,
           progress,
           result,
           failedReason,
         },
       });
     } catch (error: any) {
       request.log.error(error, "Failed to fetch job status");
       return reply.status(500).send({
         success: false,
         error: {
           code: "FETCH_FAILED",
           message: "Failed to fetch job status",
         },
       });
     }
   }
 );
}
