/**
 * Repricing Service — Rithum-style variant-level repricing engine
 *
 * Implements multiple repricing strategies:
 * - MATCH_LOW: Match the lowest competitor price
 * - PERCENTAGE_BELOW: Price at X% below competitor
 * - COST_PLUS_MARGIN: Price at cost + fixed margin
 * - FIXED_PRICE: Use a fixed price (no repricing)
 */

export type RepricingStrategy = "MATCH_LOW" | "PERCENTAGE_BELOW" | "COST_PLUS_MARGIN" | "FIXED_PRICE";

export interface RepricingRule {
  id: string;
  name: string;
  strategy: RepricingStrategy;
  isActive: boolean;
  parameters: RepricingParameters;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepricingParameters {
  // For MATCH_LOW
  matchLowOffset?: number; // e.g., -0.01 to undercut by $0.01

  // For PERCENTAGE_BELOW
  percentageBelow?: number; // e.g., 5 for 5% below competitor

  // For COST_PLUS_MARGIN
  costPlusMargin?: number; // e.g., 15 for $15 margin above cost

  // For FIXED_PRICE
  fixedPrice?: number;

  // Common constraints
  minPrice?: number; // Floor price (e.g., $10.00)
  maxPrice?: number; // Ceiling price (e.g., $500.00)
  mapPrice?: number; // Minimum Advertised Price (cannot go below)
}

export interface VariantPricingContext {
  variantId: string;
  variantSku: string;
  currentPrice: number;
  costPrice?: number;
  minPrice?: number;
  maxPrice?: number;
  mapPrice?: number;
  competitorPrice?: number; // Lowest competitor price
  buyBoxPrice?: number; // Current Buy Box price
}

export interface RepricingResult {
  variantId: string;
  variantSku: string;
  currentPrice: number;
  newPrice: number;
  strategy: RepricingStrategy;
  reason: string;
  shouldUpdate: boolean;
}

export class RepricingService {
  /**
   * Calculate new price for a variant based on repricing rule
   */
  calculatePrice(
    context: VariantPricingContext,
    rule: RepricingRule
  ): RepricingResult {
    const { strategy, parameters } = rule;
    let newPrice = context.currentPrice;
    let reason = "";

    switch (strategy) {
      case "MATCH_LOW":
        newPrice = this.matchLowStrategy(context, parameters);
        reason = `Matched lowest competitor price`;
        break;

      case "PERCENTAGE_BELOW":
        newPrice = this.percentageBelowStrategy(context, parameters);
        reason = `Priced ${parameters.percentageBelow}% below competitor`;
        break;

      case "COST_PLUS_MARGIN":
        newPrice = this.costPlusMarginStrategy(context, parameters);
        reason = `Cost + ${parameters.costPlusMargin} margin`;
        break;

      case "FIXED_PRICE":
        newPrice = parameters.fixedPrice ?? context.currentPrice;
        reason = `Fixed price rule`;
        break;

      default:
        reason = `Unknown strategy: ${strategy}`;
    }

    // Apply price constraints
    newPrice = this.applyConstraints(newPrice, context, parameters);

    // Determine if price should be updated (avoid unnecessary updates)
    const shouldUpdate = Math.abs(newPrice - context.currentPrice) >= 0.01; // Only update if diff >= $0.01

    return {
      variantId: context.variantId,
      variantSku: context.variantSku,
      currentPrice: context.currentPrice,
      newPrice,
      strategy,
      reason,
      shouldUpdate,
    };
  }

  /**
   * MATCH_LOW strategy: Match the lowest competitor price (with optional offset)
   */
  private matchLowStrategy(
    context: VariantPricingContext,
    params: RepricingParameters
  ): number {
    if (!context.competitorPrice) {
      return context.currentPrice; // No competitor data, keep current
    }

    const offset = params.matchLowOffset ?? 0;
    return context.competitorPrice + offset;
  }

  /**
   * PERCENTAGE_BELOW strategy: Price at X% below competitor
   */
  private percentageBelowStrategy(
    context: VariantPricingContext,
    params: RepricingParameters
  ): number {
    if (!context.competitorPrice) {
      return context.currentPrice; // No competitor data, keep current
    }

    const percentage = params.percentageBelow ?? 5;
    const discount = context.competitorPrice * (percentage / 100);
    return context.competitorPrice - discount;
  }

  /**
   * COST_PLUS_MARGIN strategy: Price at cost + fixed margin
   */
  private costPlusMarginStrategy(
    context: VariantPricingContext,
    params: RepricingParameters
  ): number {
    if (!context.costPrice) {
      return context.currentPrice; // No cost data, keep current
    }

    const margin = params.costPlusMargin ?? 15;
    return context.costPrice + margin;
  }

  /**
   * Apply price constraints (min, max, MAP)
   */
  private applyConstraints(
    price: number,
    context: VariantPricingContext,
    params: RepricingParameters
  ): number {
    let constrained = price;

    // Apply variant-level constraints first
    if (context.minPrice !== undefined) {
      constrained = Math.max(constrained, context.minPrice);
    }
    if (context.maxPrice !== undefined) {
      constrained = Math.min(constrained, context.maxPrice);
    }
    if (context.mapPrice !== undefined) {
      constrained = Math.max(constrained, context.mapPrice);
    }

    // Apply rule-level constraints
    if (params.minPrice !== undefined) {
      constrained = Math.max(constrained, params.minPrice);
    }
    if (params.maxPrice !== undefined) {
      constrained = Math.min(constrained, params.maxPrice);
    }
    if (params.mapPrice !== undefined) {
      constrained = Math.max(constrained, params.mapPrice);
    }

    return Math.round(constrained * 100) / 100; // Round to 2 decimals
  }

  /**
   * Validate repricing rule parameters
   */
  validateRule(rule: RepricingRule): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const { strategy, parameters } = rule;

    if (!strategy) {
      errors.push("Strategy is required");
    }

    switch (strategy) {
      case "MATCH_LOW":
        if (parameters.matchLowOffset === undefined) {
          errors.push("matchLowOffset is required for MATCH_LOW strategy");
        }
        break;

      case "PERCENTAGE_BELOW":
        if (parameters.percentageBelow === undefined) {
          errors.push("percentageBelow is required for PERCENTAGE_BELOW strategy");
        } else if (parameters.percentageBelow < 0 || parameters.percentageBelow > 100) {
          errors.push("percentageBelow must be between 0 and 100");
        }
        break;

      case "COST_PLUS_MARGIN":
        if (parameters.costPlusMargin === undefined) {
          errors.push("costPlusMargin is required for COST_PLUS_MARGIN strategy");
        } else if (parameters.costPlusMargin < 0) {
          errors.push("costPlusMargin cannot be negative");
        }
        break;

      case "FIXED_PRICE":
        if (parameters.fixedPrice === undefined) {
          errors.push("fixedPrice is required for FIXED_PRICE strategy");
        } else if (parameters.fixedPrice <= 0) {
          errors.push("fixedPrice must be greater than 0");
        }
        break;

      default:
        errors.push(`Unknown strategy: ${strategy}`);
    }

    // Validate constraints
    if (
      parameters.minPrice !== undefined &&
      parameters.maxPrice !== undefined &&
      parameters.minPrice > parameters.maxPrice
    ) {
      errors.push("minPrice cannot be greater than maxPrice");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get strategy description for UI
   */
  getStrategyDescription(strategy: RepricingStrategy): string {
    const descriptions: Record<RepricingStrategy, string> = {
      MATCH_LOW: "Match the lowest competitor price",
      PERCENTAGE_BELOW: "Price at X% below competitor",
      COST_PLUS_MARGIN: "Price at cost + fixed margin",
      FIXED_PRICE: "Use a fixed price (no repricing)",
    };
    return descriptions[strategy] || "Unknown strategy";
  }
}

export const repricingService = new RepricingService();
