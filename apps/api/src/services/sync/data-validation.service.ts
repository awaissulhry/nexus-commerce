import prisma from "../../db.js";

export interface ValidationReport {
  isValid: boolean;
  orphanedVariants: number;
  inconsistentThemes: number;
  missingAttributes: number;
  invalidChannelListings: number;
  issues: Array<{
    type: string;
    severity: "ERROR" | "WARNING";
    message: string;
    affectedIds?: string[];
  }>;
}

export interface RepairResult {
  success: boolean;
  fixed: number;
  failed: number;
  errors: string[];
}

/**
 * DataValidationService
 * Validates relational integrity of parent-child product structure
 */
export class DataValidationService {
  /**
   * Validate all products follow Rithum parent-child structure
   */
  async validateAllProducts(): Promise<ValidationReport> {
    const report: ValidationReport = {
      isValid: true,
      orphanedVariants: 0,
      inconsistentThemes: 0,
      missingAttributes: 0,
      invalidChannelListings: 0,
      issues: [],
    };

    try {
      // Check for orphaned variants (variants without parent)
      const orphanedVariants = await (prisma as any).productVariation.findMany({
        where: {
          product: null,
        },
      });

      if (orphanedVariants.length > 0) {
        report.orphanedVariants = orphanedVariants.length;
        report.isValid = false;
        report.issues.push({
          type: "ORPHANED_VARIANTS",
          severity: "ERROR",
          message: `Found ${orphanedVariants.length} variants without parent product`,
          affectedIds: orphanedVariants.map((v: any) => v.id),
        });
      }

      // Check for inconsistent variation themes
      const productsWithVariants = await (prisma as any).product.findMany({
        where: {
          variations: {
            some: {},
          },
        },
        include: {
          variations: true,
        },
      });

      for (const product of productsWithVariants) {
        if (!product.variationTheme) {
          report.inconsistentThemes++;
          report.isValid = false;
          report.issues.push({
            type: "MISSING_VARIATION_THEME",
            severity: "ERROR",
            message: `Product ${product.sku} has variants but no variationTheme`,
            affectedIds: [product.id],
          });
        }

        // Check for missing variation attributes
        for (const variant of product.variations) {
          if (!variant.variationAttributes || Object.keys(variant.variationAttributes).length === 0) {
            report.missingAttributes++;
            report.issues.push({
              type: "MISSING_ATTRIBUTES",
              severity: "WARNING",
              message: `Variant ${variant.sku} has no variationAttributes`,
              affectedIds: [variant.id],
            });
          }
        }
      }

      // Check for invalid channel listings
      const invalidListings = await (prisma as any).listing.findMany({
        where: {
          productId: null,
        },
      });

      if (invalidListings.length > 0) {
        report.invalidChannelListings = invalidListings.length;
        report.isValid = false;
        report.issues.push({
          type: "INVALID_CHANNEL_LISTINGS",
          severity: "ERROR",
          message: `Found ${invalidListings.length} listings without product reference`,
          affectedIds: invalidListings.map((l: any) => l.id),
        });
      }

      return report;
    } catch (error: any) {
      report.isValid = false;
      report.issues.push({
        type: "VALIDATION_ERROR",
        severity: "ERROR",
        message: error?.message || "Validation failed",
      });
      return report;
    }
  }

  /**
   * Validate a single product's parent-child structure
   */
  async validateProduct(productId: string): Promise<ValidationReport> {
    const report: ValidationReport = {
      isValid: true,
      orphanedVariants: 0,
      inconsistentThemes: 0,
      missingAttributes: 0,
      invalidChannelListings: 0,
      issues: [],
    };

    try {
      const product = await (prisma as any).product.findUnique({
        where: { id: productId },
        include: {
          variations: true,
          listings: true,
        },
      });

      if (!product) {
        report.isValid = false;
        report.issues.push({
          type: "PRODUCT_NOT_FOUND",
          severity: "ERROR",
          message: `Product ${productId} not found`,
        });
        return report;
      }

      // Check if product has variants
      if (product.variations.length > 0) {
        // Must have variation theme
        if (!product.variationTheme) {
          report.inconsistentThemes++;
          report.isValid = false;
          report.issues.push({
            type: "MISSING_VARIATION_THEME",
            severity: "ERROR",
            message: `Product has ${product.variations.length} variants but no variationTheme`,
          });
        }

        // Check each variant
        for (const variant of product.variations) {
          if (!variant.variationAttributes || Object.keys(variant.variationAttributes).length === 0) {
            report.missingAttributes++;
            report.issues.push({
              type: "MISSING_ATTRIBUTES",
              severity: "WARNING",
              message: `Variant ${variant.sku} has no variationAttributes`,
              affectedIds: [variant.id],
            });
          }
        }
      } else {
        // Standalone product must have null variation theme
        if (product.variationTheme) {
          report.inconsistentThemes++;
          report.isValid = false;
          report.issues.push({
            type: "INVALID_STANDALONE_THEME",
            severity: "ERROR",
            message: `Standalone product has variationTheme: ${product.variationTheme}`,
          });
        }
      }

      // Check listings
      for (const listing of product.listings) {
        if (!listing.productId) {
          report.invalidChannelListings++;
          report.isValid = false;
          report.issues.push({
            type: "INVALID_LISTING",
            severity: "ERROR",
            message: `Listing ${listing.id} has no product reference`,
            affectedIds: [listing.id],
          });
        }
      }

      return report;
    } catch (error: any) {
      report.isValid = false;
      report.issues.push({
        type: "VALIDATION_ERROR",
        severity: "ERROR",
        message: error?.message || "Validation failed",
      });
      return report;
    }
  }

  /**
   * Repair data integrity issues
   */
  async repairDataIntegrity(): Promise<RepairResult> {
    const result: RepairResult = {
      success: true,
      fixed: 0,
      failed: 0,
      errors: [],
    };

    try {
      // Remove orphaned variants
      const orphanedVariants = await (prisma as any).productVariation.findMany({
        where: {
          product: null,
        },
      });

      if (orphanedVariants.length > 0) {
        try {
          await (prisma as any).productVariation.deleteMany({
            where: {
              id: {
                in: orphanedVariants.map((v: any) => v.id),
              },
            },
          });
          result.fixed += orphanedVariants.length;
        } catch (error: any) {
          result.failed += orphanedVariants.length;
          result.errors.push(`Failed to delete orphaned variants: ${error?.message}`);
        }
      }

      // Fix products with variants but no theme
      const productsWithoutTheme = await (prisma as any).product.findMany({
        where: {
          variationTheme: null,
          variations: {
            some: {},
          },
        },
      });

      for (const product of productsWithoutTheme) {
        try {
          // Infer theme from variants
          const theme = this.inferThemeFromVariants(product.variations);
          if (theme) {
            await (prisma as any).product.update({
              where: { id: product.id },
              data: { variationTheme: theme },
            });
            result.fixed++;
          }
        } catch (error: any) {
          result.failed++;
          result.errors.push(`Failed to fix product ${product.id}: ${error?.message}`);
        }
      }

      // Remove invalid listings
      const invalidListings = await (prisma as any).listing.findMany({
        where: {
          productId: null,
        },
      });

      if (invalidListings.length > 0) {
        try {
          await (prisma as any).listing.deleteMany({
            where: {
              id: {
                in: invalidListings.map((l: any) => l.id),
              },
            },
          });
          result.fixed += invalidListings.length;
        } catch (error: any) {
          result.failed += invalidListings.length;
          result.errors.push(`Failed to delete invalid listings: ${error?.message}`);
        }
      }

      return result;
    } catch (error: any) {
      result.success = false;
      result.errors.push(error?.message || "Repair failed");
      return result;
    }
  }

  /**
   * Infer variation theme from variant attributes
   */
  private inferThemeFromVariants(variants: any[]): string | null {
    if (variants.length === 0) return null;

    const attributeKeys = new Set<string>();
    for (const variant of variants) {
      if (variant.variationAttributes) {
        Object.keys(variant.variationAttributes).forEach((key) => attributeKeys.add(key));
      }
    }

    const keys = Array.from(attributeKeys).sort().join("_");

    const themeMap: Record<string, string> = {
      Color: "COLOR",
      Size: "SIZE",
      "Color_Size": "SIZE_COLOR",
      "Size_Color": "SIZE_COLOR",
      "Material_Size": "SIZE_MATERIAL",
      "Size_Material": "SIZE_MATERIAL",
    };

    return themeMap[keys] || null;
  }

  /**
   * Generate detailed validation report
   */
  async generateReport(): Promise<string> {
    const report = await this.validateAllProducts();

    let output = "=== Product Sync Validation Report ===\n\n";
    output += `Status: ${report.isValid ? "✅ VALID" : "❌ INVALID"}\n\n`;
    output += `Summary:\n`;
    output += `  - Orphaned Variants: ${report.orphanedVariants}\n`;
    output += `  - Inconsistent Themes: ${report.inconsistentThemes}\n`;
    output += `  - Missing Attributes: ${report.missingAttributes}\n`;
    output += `  - Invalid Channel Listings: ${report.invalidChannelListings}\n\n`;

    if (report.issues.length > 0) {
      output += `Issues Found:\n`;
      for (const issue of report.issues) {
        output += `  [${issue.severity}] ${issue.type}: ${issue.message}\n`;
        if (issue.affectedIds) {
          output += `    Affected IDs: ${issue.affectedIds.join(", ")}\n`;
        }
      }
    }

    return output;
  }
}
