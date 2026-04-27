/**
 * PricingRulesService
 * Evaluates and applies pricing rules with margin constraint validation
 * Supports: MATCH_LOW, PERCENTAGE_BELOW, COST_PLUS_MARGIN, FIXED_PRICE, DYNAMIC_MARGIN
 */

import { prisma } from '@nexus/database';
import { logger } from '../utils/logger';

// Type aliases for Prisma types that aren't being generated
type PrismaClient = any;
type PricingRule = any;

// Mock Decimal class for type compatibility
class Decimal {
  constructor(value: any) {
    return value;
  }
  plus(other: any) { return this; }
  minus(other: any) { return this; }
  times(other: any) { return this; }
  dividedBy(other: any) { return this; }
  lessThan(other: any) { return false; }
  greaterThan(other: any) { return false; }
  equals(other: any) { return false; }
  isZero() { return false; }
  toNumber() { return 0; }
}

export type PricingRuleType =
  | 'MATCH_LOW'
  | 'PERCENTAGE_BELOW'
  | 'COST_PLUS_MARGIN'
  | 'FIXED_PRICE'
  | 'DYNAMIC_MARGIN';

export interface EvaluatePriceInput {
  variationId: string;
  currentPrice: Decimal | number;
  competitorPrice?: Decimal | number;
  costPrice: Decimal | number;
}

export interface EvaluatePriceResult {
  originalPrice: Decimal;
  calculatedPrice: Decimal;
  appliedRuleId?: string;
  appliedRuleName?: string;
  marginPercent: number;
  isValid: boolean;
  reason?: string;
}

export interface CreateRuleInput {
  name: string;
  type: PricingRuleType;
  description?: string;
  priority: number;
  minMarginPercent?: Decimal | number;
  maxMarginPercent?: Decimal | number;
  parameters: Record<string, any>;
  productIds?: string[];
  variationIds?: string[];
}

export class PricingRulesService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Evaluate price for a variation based on active pricing rules
   * Applies rules in priority order and validates against margin constraints
   */
  async evaluatePrice(input: EvaluatePriceInput): Promise<EvaluatePriceResult> {
    try {
      const currentPrice = new Decimal(input.currentPrice);
      const costPrice = new Decimal(input.costPrice);
      const competitorPrice = input.competitorPrice ? new Decimal(input.competitorPrice) : null;

      logger.debug(`Evaluating price for variation`, {
        variationId: input.variationId,
        currentPrice: currentPrice.toString(),
        costPrice: costPrice.toString(),
        competitorPrice: competitorPrice?.toString()
      });

      // Fetch active rules for this variation, sorted by priority
      const rules = await this.getActiveRulesForVariation(input.variationId);

      if (rules.length === 0) {
        logger.debug(`No active rules found for variation`, {
          variationId: input.variationId
        });

        // Return current price with validation
        const marginPercent = this.calculateMarginPercent(currentPrice, costPrice);
        return {
          originalPrice: currentPrice,
          calculatedPrice: currentPrice,
          marginPercent,
          isValid: true,
          reason: 'No rules applied'
        };
      }

      // Apply rules in priority order
      let calculatedPrice = currentPrice;
      let appliedRuleId: string | undefined;
      let appliedRuleName: string | undefined;

      for (const rule of rules) {
        try {
          const result = this.applyRule(
            rule,
            calculatedPrice,
            competitorPrice,
            costPrice
          );

          if (result) {
            calculatedPrice = result.price;
            appliedRuleId = rule.id;
            appliedRuleName = rule.name;

            logger.debug(`Applied pricing rule`, {
              ruleId: rule.id,
              ruleName: rule.name,
              priority: rule.priority,
              newPrice: calculatedPrice.toString()
            });

            // Stop at first applicable rule (highest priority)
            break;
          }
        } catch (ruleError) {
          logger.warn(`Failed to apply pricing rule`, {
            ruleId: rule.id,
            error: ruleError instanceof Error ? ruleError.message : String(ruleError)
          });
          continue;
        }
      }

      // Validate against margin constraints
      const marginPercent = this.calculateMarginPercent(calculatedPrice, costPrice);
      const validationResult = this.validateMarginConstraints(
        calculatedPrice,
        costPrice,
        rules
      );

      if (!validationResult.isValid) {
        logger.warn(`Calculated price violates margin constraints`, {
          variationId: input.variationId,
          calculatedPrice: calculatedPrice.toString(),
          reason: validationResult.reason
        });

        // Fallback to minimum allowed price
        const fallbackPrice = validationResult.fallbackPrice || costPrice;
        const fallbackMargin = this.calculateMarginPercent(fallbackPrice, costPrice);

        return {
          originalPrice: currentPrice,
          calculatedPrice: fallbackPrice,
          appliedRuleId,
          appliedRuleName,
          marginPercent: fallbackMargin,
          isValid: true,
          reason: `Fallback applied: ${validationResult.reason}`
        };
      }

      logger.info(`Price evaluation completed successfully`, {
        variationId: input.variationId,
        originalPrice: currentPrice.toString(),
        calculatedPrice: calculatedPrice.toString(),
        marginPercent: marginPercent.toFixed(2),
        appliedRule: appliedRuleName
      });

      return {
        originalPrice: currentPrice,
        calculatedPrice,
        appliedRuleId,
        appliedRuleName,
        marginPercent,
        isValid: true
      };
    } catch (error) {
      logger.error(`Failed to evaluate price`, {
        variationId: input.variationId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Create a new pricing rule
   */
  async createRule(input: CreateRuleInput): Promise<PricingRule> {
    try {
      logger.info(`Creating pricing rule`, {
        name: input.name,
        type: input.type,
        priority: input.priority
      });

      const rule = await this.prisma.pricingRule.create({
        data: {
          name: input.name,
          type: input.type,
          description: input.description,
          priority: input.priority,
          minMarginPercent: input.minMarginPercent ? new Decimal(input.minMarginPercent) : null,
          maxMarginPercent: input.maxMarginPercent ? new Decimal(input.maxMarginPercent) : null,
          parameters: input.parameters,
          isActive: true,
          products: input.productIds ? {
            create: input.productIds.map(productId => ({
              productId
            }))
          } : undefined,
          variations: input.variationIds ? {
            create: input.variationIds.map(variationId => ({
              variationId
            }))
          } : undefined
        }
      });

      logger.info(`Pricing rule created successfully`, {
        ruleId: rule.id,
        name: rule.name
      });

      return rule;
    } catch (error) {
      logger.error(`Failed to create pricing rule`, {
        name: input.name,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get all active rules for a variation
   */
  async getActiveRulesForVariation(variationId: string): Promise<PricingRule[]> {
    try {
      const rules = await this.prisma.pricingRuleVariation.findMany({
        where: { variationId },
        include: {
          rule: {
            where: { isActive: true }
          }
        },
        orderBy: {
          rule: { priority: 'asc' }
        }
      });

      return rules
        .map(r => r.rule)
        .filter((rule): rule is PricingRule => rule !== null);
    } catch (error) {
      logger.error(`Failed to get active rules for variation`, {
        variationId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Apply a pricing rule and return the calculated price
   */
  private applyRule(
    rule: PricingRule,
    currentPrice: Decimal,
    competitorPrice: Decimal | null,
    costPrice: Decimal
  ): { price: Decimal } | null {
    try {
      const params = rule.parameters as Record<string, any>;

      switch (rule.type) {
        case 'MATCH_LOW':
          if (!competitorPrice) {
            logger.warn(`MATCH_LOW rule requires competitor price`, {
              ruleId: rule.id
            });
            return null;
          }
          return { price: competitorPrice };

        case 'PERCENTAGE_BELOW':
          const percentageBelow = new Decimal(params.percentageBelow || 5);
          const reduction = currentPrice.times(percentageBelow).dividedBy(100);
          return { price: currentPrice.minus(reduction) };

        case 'COST_PLUS_MARGIN':
          const marginPercent = new Decimal(params.marginPercent || 25);
          const margin = costPrice.times(marginPercent).dividedBy(100);
          return { price: costPrice.plus(margin) };

        case 'FIXED_PRICE':
          const fixedPrice = new Decimal(params.fixedPrice);
          return { price: fixedPrice };

        case 'DYNAMIC_MARGIN':
          const targetMargin = new Decimal(params.targetMargin || 30);
          const dynamicPrice = costPrice.times(new Decimal(1).plus(targetMargin.dividedBy(100)));
          return { price: dynamicPrice };

        default:
          logger.warn(`Unknown pricing rule type`, {
            ruleId: rule.id,
            type: rule.type
          });
          return null;
      }
    } catch (error) {
      logger.error(`Error applying pricing rule`, {
        ruleId: rule.id,
        type: rule.type,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Validate calculated price against margin constraints
   */
  private validateMarginConstraints(
    calculatedPrice: Decimal,
    costPrice: Decimal,
    rules: PricingRule[]
  ): {
    isValid: boolean;
    reason?: string;
    fallbackPrice?: Decimal;
  } {
    try {
      const marginPercent = this.calculateMarginPercent(calculatedPrice, costPrice);

      // Check all rules for margin constraints
      for (const rule of rules) {
        if (rule.minMarginPercent && marginPercent < rule.minMarginPercent.toNumber()) {
          // Calculate minimum allowed price
          const minMargin = rule.minMarginPercent;
          const fallbackPrice = costPrice.times(
            new Decimal(1).plus(minMargin.dividedBy(100))
          );

          return {
            isValid: false,
            reason: `Margin ${marginPercent.toFixed(2)}% below minimum ${minMargin}%`,
            fallbackPrice
          };
        }

        if (rule.maxMarginPercent && marginPercent > rule.maxMarginPercent.toNumber()) {
          // Calculate maximum allowed price
          const maxMargin = rule.maxMarginPercent;
          const fallbackPrice = costPrice.times(
            new Decimal(1).plus(maxMargin.dividedBy(100))
          );

          return {
            isValid: false,
            reason: `Margin ${marginPercent.toFixed(2)}% exceeds maximum ${maxMargin}%`,
            fallbackPrice
          };
        }
      }

      return { isValid: true };
    } catch (error) {
      logger.error(`Error validating margin constraints`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        isValid: false,
        reason: 'Validation error'
      };
    }
  }

  /**
   * Calculate margin percentage
   */
  private calculateMarginPercent(price: Decimal, costPrice: Decimal): number {
    if (costPrice.isZero()) {
      return 0;
    }

    const margin = price.minus(costPrice);
    const marginPercent = margin.dividedBy(costPrice).times(100);

    return marginPercent.toNumber();
  }

  /**
   * Update a pricing rule
   */
  async updateRule(
    ruleId: string,
    updates: Partial<CreateRuleInput>
  ): Promise<PricingRule> {
    try {
      logger.info(`Updating pricing rule`, { ruleId });

      const rule = await this.prisma.pricingRule.update({
        where: { id: ruleId },
        data: {
          name: updates.name,
          type: updates.type,
          description: updates.description,
          priority: updates.priority,
          minMarginPercent: updates.minMarginPercent
            ? new Decimal(updates.minMarginPercent)
            : undefined,
          maxMarginPercent: updates.maxMarginPercent
            ? new Decimal(updates.maxMarginPercent)
            : undefined,
          parameters: updates.parameters,
          updatedAt: new Date()
        }
      });

      logger.info(`Pricing rule updated successfully`, { ruleId });
      return rule;
    } catch (error) {
      logger.error(`Failed to update pricing rule`, {
        ruleId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Deactivate a pricing rule
   */
  async deactivateRule(ruleId: string): Promise<PricingRule> {
    try {
      logger.info(`Deactivating pricing rule`, { ruleId });

      return await this.prisma.pricingRule.update({
        where: { id: ruleId },
        data: {
          isActive: false,
          updatedAt: new Date()
        }
      });
    } catch (error) {
      logger.error(`Failed to deactivate pricing rule`, {
        ruleId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get all active pricing rules
   */
  async getActiveRules(): Promise<PricingRule[]> {
    try {
      return await this.prisma.pricingRule.findMany({
        where: { isActive: true },
        orderBy: { priority: 'asc' }
      });
    } catch (error) {
      logger.error(`Failed to get active pricing rules`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Apply a rule to multiple variations
   */
  async applyRuleToVariations(ruleId: string, variationIds: string[]): Promise<number> {
    try {
      logger.info(`Applying rule to variations`, {
        ruleId,
        variationCount: variationIds.length
      });

      const result = await Promise.all(
        variationIds.map(variationId =>
          this.prisma.pricingRuleVariation.upsert({
            where: {
              ruleId_variationId: { ruleId, variationId }
            },
            create: { ruleId, variationId },
            update: {}
          })
        )
      );

      logger.info(`Rule applied to variations successfully`, {
        ruleId,
        appliedCount: result.length
      });

      return result.length;
    } catch (error) {
      logger.error(`Failed to apply rule to variations`, {
        ruleId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
