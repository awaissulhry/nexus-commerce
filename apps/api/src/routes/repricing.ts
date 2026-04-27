import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { repricingService, type RepricingRule, type RepricingParameters } from "../services/repricing.service.js";

// ── Repricing Rule Management ───────────────────────────────────────

interface CreateRepricingRuleBody {
  name: string;
  strategy: "MATCH_LOW" | "PERCENTAGE_BELOW" | "COST_PLUS_MARGIN" | "FIXED_PRICE";
  parameters: RepricingParameters;
  isActive?: boolean;
}

interface UpdateRepricingRuleBody {
  name?: string;
  strategy?: "MATCH_LOW" | "PERCENTAGE_BELOW" | "COST_PLUS_MARGIN" | "FIXED_PRICE";
  parameters?: RepricingParameters;
  isActive?: boolean;
}

interface ApplyRepricingBody {
  ruleId: string;
  variantIds?: string[]; // If empty, apply to all variants
  dryRun?: boolean; // If true, return proposed prices without updating
}

export async function repricingRoutes(app: FastifyInstance) {
  // ── GET /repricing/rules ────────────────────────────────────────
  // List all repricing rules
  app.get("/repricing/rules", async (request, reply) => {
    try {
      const rules = await (prisma as any).pricingRule.findMany({
        orderBy: { createdAt: "desc" },
      });

      return reply.send({
        rules: rules.map((r: any) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          parameters: r.parameters,
          isActive: r.isActive,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      });
    } catch (error: any) {
      request.log.error(error, "get-rules failed");
      return reply.status(500).send({
        error: "Failed to fetch repricing rules",
        message: error?.message ?? "Unknown error",
      });
    }
  });

  // ── POST /repricing/rules ───────────────────────────────────────
  // Create a new repricing rule
  app.post<{ Body: CreateRepricingRuleBody }>(
    "/repricing/rules",
    async (request, reply) => {
      try {
        const { name, strategy, parameters, isActive = true } = request.body;

        if (!name || !strategy) {
          return reply.status(400).send({
            error: "Missing required fields: name, strategy",
          });
        }

        // Validate rule
        const mockRule = { id: "", name, strategy, isActive, parameters, createdAt: new Date(), updatedAt: new Date() };
        const validation = repricingService.validateRule(mockRule);
        if (!validation.valid) {
          return reply.status(400).send({
            error: "Invalid repricing rule",
            details: validation.errors,
          });
        }

        const rule = await (prisma as any).pricingRule.create({
          data: {
            name,
            type: strategy,
            parameters,
            isActive,
          },
        });

        return reply.status(201).send({
          id: rule.id,
          name: rule.name,
          strategy: rule.type,
          parameters: rule.parameters,
          isActive: rule.isActive,
          createdAt: rule.createdAt,
          updatedAt: rule.updatedAt,
        });
      } catch (error: any) {
        request.log.error(error, "create-rule failed");
        return reply.status(500).send({
          error: "Failed to create repricing rule",
          message: error?.message ?? "Unknown error",
        });
      }
    }
  );

  // ── PUT /repricing/rules/:ruleId ────────────────────────────────
  // Update a repricing rule
  app.put<{ Params: { ruleId: string }; Body: UpdateRepricingRuleBody }>(
    "/repricing/rules/:ruleId",
    async (request, reply) => {
      try {
        const { ruleId } = request.params;
        const { name, strategy, parameters, isActive } = request.body;

        const existing = await (prisma as any).pricingRule.findUnique({
          where: { id: ruleId },
        });

        if (!existing) {
          return reply.status(404).send({
            error: "Repricing rule not found",
          });
        }

        // Validate if strategy/parameters changed
        if (strategy || parameters) {
          const mockRule = {
            id: ruleId,
            name: name ?? existing.name,
            strategy: strategy ?? existing.type,
            isActive: isActive ?? existing.isActive,
            parameters: parameters ?? existing.parameters,
            createdAt: existing.createdAt,
            updatedAt: new Date(),
          };
          const validation = repricingService.validateRule(mockRule);
          if (!validation.valid) {
            return reply.status(400).send({
              error: "Invalid repricing rule",
              details: validation.errors,
            });
          }
        }

        const updated = await (prisma as any).pricingRule.update({
          where: { id: ruleId },
          data: {
            name: name ?? undefined,
            type: strategy ?? undefined,
            parameters: parameters ?? undefined,
            isActive: isActive ?? undefined,
          },
        });

        return reply.send({
          id: updated.id,
          name: updated.name,
          strategy: updated.type,
          parameters: updated.parameters,
          isActive: updated.isActive,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        });
      } catch (error: any) {
        request.log.error(error, "update-rule failed");
        return reply.status(500).send({
          error: "Failed to update repricing rule",
          message: error?.message ?? "Unknown error",
        });
      }
    }
  );

  // ── DELETE /repricing/rules/:ruleId ─────────────────────────────
  // Delete a repricing rule
  app.delete<{ Params: { ruleId: string } }>(
    "/repricing/rules/:ruleId",
    async (request, reply) => {
      try {
        const { ruleId } = request.params;

        await (prisma as any).pricingRule.delete({
          where: { id: ruleId },
        });

        return reply.send({ success: true });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.status(404).send({
            error: "Repricing rule not found",
          });
        }
        request.log.error(error, "delete-rule failed");
        return reply.status(500).send({
          error: "Failed to delete repricing rule",
          message: error?.message ?? "Unknown error",
        });
      }
    }
  );

  // ── POST /repricing/apply ───────────────────────────────────────
  // Apply a repricing rule to variants (with optional dry-run)
  app.post<{ Body: ApplyRepricingBody }>(
    "/repricing/apply",
    async (request, reply) => {
      try {
        const { ruleId, variantIds, dryRun = false } = request.body;

        if (!ruleId) {
          return reply.status(400).send({
            error: "Missing ruleId",
          });
        }

        // Fetch the rule
        const rule = await (prisma as any).pricingRule.findUnique({
          where: { id: ruleId },
        });

        if (!rule) {
          return reply.status(404).send({
            error: "Repricing rule not found",
          });
        }

        // Fetch variants to reprice
        const whereClause: any = { isActive: true };
        if (variantIds && variantIds.length > 0) {
          whereClause.id = { in: variantIds };
        }

        const variants = await (prisma as any).productVariation.findMany({
          where: whereClause,
          include: {
            product: true,
            channelListings: true,
          },
        });

        if (variants.length === 0) {
          return reply.send({
            message: "No variants found to reprice",
            results: [],
          });
        }

        // Calculate new prices for each variant
        const results = variants.map((variant: any) => {
          const context = {
            variantId: variant.id,
            variantSku: variant.sku,
            currentPrice: Number(variant.price),
            costPrice: variant.costPrice ? Number(variant.costPrice) : undefined,
            minPrice: variant.minPrice ? Number(variant.minPrice) : undefined,
            maxPrice: variant.maxPrice ? Number(variant.maxPrice) : undefined,
            mapPrice: variant.mapPrice ? Number(variant.mapPrice) : undefined,
            competitorPrice: undefined, // TODO: Fetch from competitor data
            buyBoxPrice: undefined, // TODO: Fetch from Amazon
          };

          const mockRule = {
            id: rule.id,
            name: rule.name,
            strategy: rule.type,
            isActive: rule.isActive,
            parameters: rule.parameters,
            createdAt: rule.createdAt,
            updatedAt: rule.updatedAt,
          };

          return repricingService.calculatePrice(context, mockRule);
        });

        // If not dry-run, update the database
        if (!dryRun) {
          for (const result of results) {
            if (result.shouldUpdate) {
              await (prisma as any).productVariation.update({
                where: { id: result.variantId },
                data: { price: result.newPrice },
              });

              // Also update VariantChannelListing prices
              const variant = variants.find((v: any) => v.id === result.variantId);
              if (variant && variant.channelListings) {
                for (const listing of variant.channelListings) {
                  await (prisma as any).variantChannelListing.update({
                    where: { id: listing.id },
                    data: { channelPrice: result.newPrice },
                  });
                }
              }
            }
          }
        }

        return reply.send({
          ruleId,
          dryRun,
          variantsProcessed: results.length,
          variantsUpdated: results.filter((r) => r.shouldUpdate).length,
          results,
        });
      } catch (error: any) {
        request.log.error(error, "apply-repricing failed");
        return reply.status(500).send({
          error: "Failed to apply repricing rule",
          message: error?.message ?? "Unknown error",
        });
      }
    }
  );

  // ── GET /repricing/strategies ───────────────────────────────────
  // Get available repricing strategies with descriptions
  app.get("/repricing/strategies", async (request, reply) => {
    const strategies = [
      {
        value: "MATCH_LOW",
        label: "Match Lowest",
        description: repricingService.getStrategyDescription("MATCH_LOW"),
        parameters: {
          matchLowOffset: { type: "number", description: "Offset from competitor price (e.g., -0.01)" },
          minPrice: { type: "number", description: "Minimum price floor" },
          maxPrice: { type: "number", description: "Maximum price ceiling" },
          mapPrice: { type: "number", description: "Minimum Advertised Price" },
        },
      },
      {
        value: "PERCENTAGE_BELOW",
        label: "Percentage Below",
        description: repricingService.getStrategyDescription("PERCENTAGE_BELOW"),
        parameters: {
          percentageBelow: { type: "number", description: "Percentage below competitor (0-100)" },
          minPrice: { type: "number", description: "Minimum price floor" },
          maxPrice: { type: "number", description: "Maximum price ceiling" },
          mapPrice: { type: "number", description: "Minimum Advertised Price" },
        },
      },
      {
        value: "COST_PLUS_MARGIN",
        label: "Cost Plus Margin",
        description: repricingService.getStrategyDescription("COST_PLUS_MARGIN"),
        parameters: {
          costPlusMargin: { type: "number", description: "Fixed margin above cost (e.g., 15 for $15)" },
          minPrice: { type: "number", description: "Minimum price floor" },
          maxPrice: { type: "number", description: "Maximum price ceiling" },
          mapPrice: { type: "number", description: "Minimum Advertised Price" },
        },
      },
      {
        value: "FIXED_PRICE",
        label: "Fixed Price",
        description: repricingService.getStrategyDescription("FIXED_PRICE"),
        parameters: {
          fixedPrice: { type: "number", description: "Fixed price (no repricing)" },
        },
      },
    ];

    return reply.send({ strategies });
  });
}
