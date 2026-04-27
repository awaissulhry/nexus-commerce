import { PrismaClient } from "@prisma/client";
import { GeminiService, EbayListingData, ProductInput } from "./gemini.service.js";
import { EbayCategoryService } from "../ebay-category.service.js";

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

export interface DraftListingResponse {
  draftListingId: string;
  productId: string;
  productName: string;
  productSku: string;
  ebayTitle: string;
  categoryId: string;
  itemSpecifics: Record<string, string>;
  htmlDescription: string;
  status: "DRAFT";
  createdAt: string;
}

export interface ProductWithRelations {
  id: string;
  sku: string;
  name: string;
  basePrice: number;
  totalStock: number;
  upc?: string | null;
  ean?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  weightValue?: number | null;
  weightUnit?: string | null;
  dimLength?: number | null;
  dimWidth?: number | null;
  dimHeight?: number | null;
  dimUnit?: string | null;
  bulletPoints: string[];
  aPlusContent?: unknown | null;
  keywords: string[];
  variations: Array<{
    sku: string;
    name?: string | null;
    value?: string | null;
    price: number;
    stock: number;
  }>;
  images: Array<{
    url: string;
    alt?: string | null;
    type: string;
  }>;
}

/* ================================================================== */
/*  Service                                                            */
/* ================================================================== */

export class AiListingService {
  constructor(
    private geminiService: GeminiService,
    private ebayCategoryService: EbayCategoryService,
    private prisma: PrismaClient
  ) {}

  /**
   * Generate an eBay listing draft from a product
   *
   * Flow:
   * 1. Fetch product with relations (variations, images)
   * 2. Validate product has required data
   * 3. Check if draft already exists
   * 4. Resolve real eBay category via Taxonomy API
   * 5. Get category aspects (required/recommended)
   * 6. Call Gemini to generate eBay listing with category context
   * 7. Store draft in database
   * 8. Return generated content
   */
  async generateListingDraft(
    productId: string,
    regenerate: boolean = false,
    marketplaceId: string = "EBAY_IT"
  ): Promise<DraftListingResponse> {
    try {
      // Step 1: Fetch product with relations
      const product = await this.fetchProductForGeneration(productId);

      // Step 2: Validate product data
      this.validateProductData(product);

      // Step 3: Check existing draft
      const existingDraft = await this.checkExistingDraft(productId);
      if (existingDraft && !regenerate) {
        throw new Error(
          `Draft already exists for this product. Use regenerate=true to overwrite.`
        );
      }

      // If regenerating, delete old draft
      if (existingDraft && regenerate) {
        await (this.prisma as any).draftListing.delete({
          where: { id: existingDraft.id },
        });
      }

      // Step 4: Resolve real eBay category via Taxonomy API
      const categoryId = await this.ebayCategoryService.suggestCategoryId(
        product.name,
        marketplaceId
      );

      // Step 5: Get category aspects (required/recommended)
      const aspects = await this.ebayCategoryService.getCategoryAspects(
        categoryId,
        marketplaceId
      );

      // Step 6: Call Gemini to generate eBay listing with category context
      const generatedData = await this.callGeminiForGeneration(
        product,
        categoryId,
        aspects
      );

      // Step 5: Store draft in database
      const draft = await this.storeDraft(productId, generatedData);

      // Step 6: Format and return response
      return this.formatResponse(draft, product);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      console.error(`[AiListingService] Error generating listing:`, message);
      throw error;
    }
  }

  /**
   * Fetch product with all relations needed for AI generation
   */
  private async fetchProductForGeneration(
    productId: string
  ): Promise<ProductWithRelations> {
    const product = await (this.prisma as any).product.findUnique({
      where: { id: productId },
      include: {
        variations: {
          select: {
            sku: true,
            name: true,
            value: true,
            price: true,
            stock: true,
          },
        },
        images: {
          select: {
            url: true,
            alt: true,
            type: true,
          },
        },
      },
    });

    if (!product) {
      throw new Error(`Product not found: ${productId}`);
    }

    return product as ProductWithRelations;
  }

  /**
   * Validate product has minimum required data for AI generation
   */
  private validateProductData(product: ProductWithRelations): void {
    const errors: string[] = [];

    // Check required fields
    if (!product.name || product.name.trim().length === 0) {
      errors.push("Product name is required");
    }

    if (!product.basePrice || product.basePrice <= 0) {
      errors.push("Product base price is required and must be > 0");
    }

    if (!product.images || product.images.length === 0) {
      errors.push("Product must have at least one image");
    }

    if (
      (!product.bulletPoints || product.bulletPoints.length === 0) &&
      (!product.aPlusContent || Object.keys(product.aPlusContent).length === 0)
    ) {
      errors.push(
        "Product must have either bullet points or A+ content for description"
      );
    }

    if (errors.length > 0) {
      throw new Error(`Invalid product data: ${errors.join("; ")}`);
    }
  }

  /**
   * Check if draft already exists for this product
   */
  private async checkExistingDraft(
    productId: string
  ): Promise<{ id: string } | null> {
    const draft = await (this.prisma as any).draftListing.findFirst({
      where: { productId },
      select: { id: true },
    });

    return draft;
  }

  /**
   * Call Gemini API to generate eBay listing data
   */
  private async callGeminiForGeneration(
    product: ProductWithRelations,
    categoryId?: string,
    aspects?: Array<{ name: string; required: boolean; recommended: boolean }>
  ): Promise<EbayListingData> {
    // Format product data for Gemini
    const productInput: ProductInput = {
      sku: product.sku,
      name: product.name,
      basePrice: Number(product.basePrice),
      totalStock: product.totalStock,
      upc: product.upc,
      ean: product.ean,
      brand: product.brand,
      manufacturer: product.manufacturer,
      weightValue: product.weightValue ? Number(product.weightValue) : null,
      weightUnit: product.weightUnit,
      dimLength: product.dimLength ? Number(product.dimLength) : null,
      dimWidth: product.dimWidth ? Number(product.dimWidth) : null,
      dimHeight: product.dimHeight ? Number(product.dimHeight) : null,
      dimUnit: product.dimUnit,
      bulletPoints: product.bulletPoints || [],
      aPlusContent: product.aPlusContent,
      keywords: product.keywords || [],
      variations: product.variations.map((v) => ({
        sku: v.sku,
        name: v.name || "Variant",
        value: v.value || "Default",
        price: Number(v.price),
        stock: v.stock,
      })),
      images: product.images.map((img) => ({
        url: img.url,
        alt: img.alt,
        type: img.type,
      })),
    };

    // Call Gemini service with category context
    const generatedData = await this.geminiService.generateEbayListingData(
      productInput,
      categoryId,
      aspects
    );

    return generatedData;
  }

  /**
   * Store generated listing as draft in database
   */
  private async storeDraft(
    productId: string,
    generatedData: EbayListingData
  ): Promise<any> {
    const draft = await (this.prisma as any).draftListing.create({
      data: {
        productId,
        ebayTitle: generatedData.ebayTitle,
        categoryId: generatedData.categoryId,
        itemSpecifics: generatedData.itemSpecifics,
        htmlDescription: generatedData.htmlDescription,
        status: "DRAFT",
      },
    });

    return draft;
  }

  /**
   * Format response for API
   */
  private formatResponse(
    draft: any,
    product: ProductWithRelations
  ): DraftListingResponse {
    return {
      draftListingId: draft.id,
      productId: draft.productId,
      productName: product.name,
      productSku: product.sku,
      ebayTitle: draft.ebayTitle,
      categoryId: draft.categoryId,
      itemSpecifics: draft.itemSpecifics as Record<string, string>,
      htmlDescription: draft.htmlDescription,
      status: "DRAFT",
      createdAt: draft.createdAt.toISOString(),
    };
  }
}
