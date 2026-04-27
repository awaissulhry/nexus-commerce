import prisma from "../db.js";

// ── Data Structures ──────────────────────────────────────────────────────

interface AmazonAttributeRequirement {
  required: boolean;
  dataType: string;
  description: string;
  enumValues?: string[];
  minValue?: number;
  maxValue?: number;
  maxLength?: number;
}

interface ProductTypeSchema {
  productType: string;
  requirements: {
    [attributeName: string]: AmazonAttributeRequirement;
  };
}

interface FieldDefinition {
  name: string;
  label: string;
  dataType: "STRING" | "INT" | "DECIMAL" | "BOOLEAN" | "ENUM" | "DATE";
  required: boolean;
  description: string;
  enumValues?: string[];
  minValue?: number;
  maxValue?: number;
  maxLength?: number;
  placeholder?: string;
}

interface ParsedSchema {
  productType: string;
  requiredFields: FieldDefinition[];
  optionalFields: FieldDefinition[];
}

interface CachedSchema {
  schema: ProductTypeSchema;
  parsedSchema: ParsedSchema;
  cachedAt: Date;
  expiresAt: Date;
}

interface ValidationError {
  field: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ── Mock Product Types (for testing without real Amazon API) ──────────────

const MOCK_PRODUCT_TYPES: Record<string, ProductTypeSchema> = {
  LUGGAGE: {
    productType: "LUGGAGE",
    requirements: {
      material: {
        required: true,
        dataType: "ENUM",
        description: "Material of the luggage",
        enumValues: ["Nylon", "Leather", "Canvas", "Polycarbonate", "ABS"],
      },
      dimensions: {
        required: true,
        dataType: "STRING",
        description: "Dimensions in format: LxWxH (e.g., 20x14x9)",
        maxLength: 50,
      },
      weight: {
        required: true,
        dataType: "DECIMAL",
        description: "Weight in pounds",
        minValue: 0,
        maxValue: 100,
      },
      color: {
        required: false,
        dataType: "STRING",
        description: "Color of the luggage",
        maxLength: 50,
      },
      warranty: {
        required: false,
        dataType: "STRING",
        description: "Warranty information",
        maxLength: 200,
      },
    },
  },
  OUTERWEAR: {
    productType: "OUTERWEAR",
    requirements: {
      material: {
        required: true,
        dataType: "ENUM",
        description: "Primary material",
        enumValues: ["Cotton", "Polyester", "Wool", "Silk", "Synthetic"],
      },
      size: {
        required: true,
        dataType: "ENUM",
        description: "Clothing size",
        enumValues: ["XS", "S", "M", "L", "XL", "XXL"],
      },
      color: {
        required: true,
        dataType: "STRING",
        description: "Color",
        maxLength: 50,
      },
      care_instructions: {
        required: false,
        dataType: "STRING",
        description: "Care instructions",
        maxLength: 500,
      },
      gender: {
        required: false,
        dataType: "ENUM",
        description: "Gender",
        enumValues: ["Men", "Women", "Unisex"],
      },
    },
  },
  ELECTRONICS: {
    productType: "ELECTRONICS",
    requirements: {
      voltage: {
        required: true,
        dataType: "ENUM",
        description: "Operating voltage",
        enumValues: ["110V", "220V", "110-220V"],
      },
      wattage: {
        required: true,
        dataType: "INT",
        description: "Power consumption in watts",
        minValue: 1,
        maxValue: 10000,
      },
      warranty_months: {
        required: false,
        dataType: "INT",
        description: "Warranty period in months",
        minValue: 0,
        maxValue: 60,
      },
      color: {
        required: false,
        dataType: "STRING",
        description: "Color",
        maxLength: 50,
      },
    },
  },
};

// ── Amazon Catalog Service ───────────────────────────────────────────────

export class AmazonCatalogService {
  private schemaCache: Map<string, CachedSchema> = new Map();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly USE_MOCK_DATA = true; // Set to false when real Amazon API is ready

  /**
   * Get product type schema (with caching)
   */
  async getProductTypeSchema(productType: string): Promise<ParsedSchema> {
    // Validate product type format
    if (!this.isValidProductType(productType)) {
      throw new Error(`Invalid product type format: ${productType}`);
    }

    // Check cache first
    const cached = this.schemaCache.get(productType);
    if (cached && cached.expiresAt > new Date()) {
      console.log(`[Cache HIT] Schema for ${productType}`);
      return cached.parsedSchema;
    }

    console.log(`[Cache MISS] Fetching schema for ${productType}`);

    // Fetch from Amazon API (or mock)
    const schema = await this.fetchSchema(productType);

    // Parse schema
    const parsedSchema = this.parseSchema(schema);

    // Store in cache
    this.schemaCache.set(productType, {
      schema,
      parsedSchema,
      cachedAt: new Date(),
      expiresAt: new Date(Date.now() + this.CACHE_TTL_MS),
    });

    return parsedSchema;
  }

  /**
   * Fetch schema from Amazon API or mock data
   */
  private async fetchSchema(productType: string): Promise<ProductTypeSchema> {
    if (this.USE_MOCK_DATA) {
      // Use mock data for testing
      const mockSchema = MOCK_PRODUCT_TYPES[productType];
      if (!mockSchema) {
        throw new Error(`Product type "${productType}" not found in catalog`);
      }
      return mockSchema;
    }

    // Real Amazon SP-API call (when credentials are available)
    return this.fetchFromAmazonAPI(productType);
  }

  /**
   * Fetch from real Amazon SP-API
   */
  private async fetchFromAmazonAPI(
    productType: string
  ): Promise<ProductTypeSchema> {
    const accessToken = process.env.AMAZON_SP_API_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("Amazon SP-API access token not configured");
    }

    const region = process.env.AMAZON_SP_API_REGION || "na";
    const endpoint = `https://sellingpartnerapi-${region}.amazon.com/catalogs/2022-04-01/productTypes/${productType}`;

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Amazon API error: ${response.status} ${response.statusText}`
        );
      }

      return (await response.json()) as ProductTypeSchema;
    } catch (error) {
      console.error(`Failed to fetch schema from Amazon API:`, error);
      throw error;
    }
  }

  /**
   * Parse Amazon schema to extract required vs optional fields
   */
  private parseSchema(schema: ProductTypeSchema): ParsedSchema {
    const requiredFields: FieldDefinition[] = [];
    const optionalFields: FieldDefinition[] = [];

    for (const [fieldName, requirement] of Object.entries(
      schema.requirements
    )) {
      const field = this.convertToFieldDefinition(fieldName, requirement);

      if (requirement.required) {
        requiredFields.push(field);
      } else {
        optionalFields.push(field);
      }
    }

    return {
      productType: schema.productType,
      requiredFields: requiredFields.sort((a, b) =>
        a.label.localeCompare(b.label)
      ),
      optionalFields: optionalFields.sort((a, b) =>
        a.label.localeCompare(b.label)
      ),
    };
  }

  /**
   * Convert Amazon attribute to FieldDefinition
   */
  private convertToFieldDefinition(
    name: string,
    requirement: AmazonAttributeRequirement
  ): FieldDefinition {
    return {
      name,
      label: this.formatLabel(name),
      dataType: this.mapDataType(requirement.dataType),
      required: requirement.required,
      description: requirement.description,
      enumValues: requirement.enumValues,
      minValue: requirement.minValue,
      maxValue: requirement.maxValue,
      maxLength: requirement.maxLength,
      placeholder: this.generatePlaceholder(name, requirement),
    };
  }

  /**
   * Format field name to label (e.g., "material" -> "Material")
   */
  private formatLabel(name: string): string {
    return name
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  /**
   * Map Amazon data types to our types
   */
  private mapDataType(
    amazonType: string
  ): "STRING" | "INT" | "DECIMAL" | "BOOLEAN" | "ENUM" | "DATE" {
    const typeMap: Record<string, any> = {
      STRING: "STRING",
      INT: "INT",
      INTEGER: "INT",
      DECIMAL: "DECIMAL",
      FLOAT: "DECIMAL",
      BOOLEAN: "BOOLEAN",
      ENUM: "ENUM",
      DATE: "DATE",
      DATETIME: "DATE",
    };

    return typeMap[amazonType.toUpperCase()] || "STRING";
  }

  /**
   * Generate placeholder text based on field type
   */
  private generatePlaceholder(
    name: string,
    requirement: AmazonAttributeRequirement
  ): string {
    if (requirement.enumValues) {
      return `Select ${this.formatLabel(name).toLowerCase()}`;
    }

    if (requirement.dataType === "INT" || requirement.dataType === "DECIMAL") {
      const min = requirement.minValue ? `min: ${requirement.minValue}` : "";
      const max = requirement.maxValue ? `max: ${requirement.maxValue}` : "";
      const range = [min, max].filter(Boolean).join(", ");
      return range ? `Enter number (${range})` : "Enter number";
    }

    return `Enter ${this.formatLabel(name).toLowerCase()}`;
  }

  /**
   * Validate product attributes against schema
   */
  async validateAttributes(
    productType: string,
    attributes: Record<string, any>
  ): Promise<ValidationResult> {
    const schema = await this.getProductTypeSchema(productType);
    const errors: ValidationError[] = [];

    // Check required fields
    for (const field of schema.requiredFields) {
      if (!(field.name in attributes) || attributes[field.name] === null || attributes[field.name] === "") {
        errors.push({
          field: field.name,
          message: `${field.label} is required`,
        });
      }
    }

    // Validate field values
    for (const field of [...schema.requiredFields, ...schema.optionalFields]) {
      const value = attributes[field.name];

      if (value === null || value === undefined || value === "") {
        continue; // Skip validation for empty optional fields
      }

      // Validate enum values
      if (field.enumValues && !field.enumValues.includes(value)) {
        errors.push({
          field: field.name,
          message: `${field.label} must be one of: ${field.enumValues.join(", ")}`,
        });
      }

      // Validate numeric ranges
      if (field.dataType === "INT" || field.dataType === "DECIMAL") {
        const numValue = Number(value);
        if (isNaN(numValue)) {
          errors.push({
            field: field.name,
            message: `${field.label} must be a number`,
          });
        } else {
          if (
            field.minValue !== undefined &&
            numValue < field.minValue
          ) {
            errors.push({
              field: field.name,
              message: `${field.label} must be at least ${field.minValue}`,
            });
          }
          if (
            field.maxValue !== undefined &&
            numValue > field.maxValue
          ) {
            errors.push({
              field: field.name,
              message: `${field.label} must be at most ${field.maxValue}`,
            });
          }
        }
      }

      // Validate string length
      if (field.dataType === "STRING" && field.maxLength) {
        if (String(value).length > field.maxLength) {
          errors.push({
            field: field.name,
            message: `${field.label} must be at most ${field.maxLength} characters`,
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get list of available product types
   */
  async getAvailableProductTypes(): Promise<string[]> {
    if (this.USE_MOCK_DATA) {
      return Object.keys(MOCK_PRODUCT_TYPES).sort();
    }

    // TODO: Fetch from Amazon API when available
    return [];
  }

  /**
   * Get required fields for a product type
   */
  async getRequiredFields(productType: string): Promise<string[]> {
    const schema = await this.getProductTypeSchema(productType);
    return schema.requiredFields.map((f) => f.name);
  }

  /**
   * Get all fields for a product type
   */
  async getAllFields(productType: string): Promise<FieldDefinition[]> {
    const schema = await this.getProductTypeSchema(productType);
    return [...schema.requiredFields, ...schema.optionalFields];
  }

  /**
   * Validate product type format
   */
  private isValidProductType(type: string): boolean {
    return /^[A-Z_]{3,50}$/.test(type);
  }

  /**
   * Clear cache (for admin/testing)
   */
  clearCache(): void {
    this.schemaCache.clear();
    console.log("Schema cache cleared");
  }

  /**
   * Get cache stats (for monitoring)
   */
  getCacheStats(): {
    size: number;
    entries: Array<{ productType: string; expiresAt: Date }>;
  } {
    const entries = Array.from(this.schemaCache.entries()).map(
      ([productType, cached]) => ({
        productType,
        expiresAt: cached.expiresAt,
      })
    );

    return {
      size: this.schemaCache.size,
      entries,
    };
  }
}

// Export singleton instance
export const amazonCatalogService = new AmazonCatalogService();
