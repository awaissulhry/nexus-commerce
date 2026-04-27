import { PrismaClient } from "@prisma/client";
import { EbayService } from "./marketplaces/ebay.service.js";
import prisma from "@nexus/database";

export interface PublishResult {
  success: boolean;
  draftId: string;
  productId: string;
  listingId: string;
  listingUrl: string;
  publishedAt: string;
  message: string;
}

export interface PublishError {
  code: string;
  message: string;
  details?: Record<string, any>;
}

export interface PublishOptions {
  overridePrice?: number;
  marketplaceId?: string;
}

export class EbayPublishService {
  constructor(
    private ebayService: EbayService,
    private prisma: PrismaClient = prisma as any
  ) {}

  /**
   * Publishes a draft listing to eBay
   * 1. Fetches draft with product relations
   * 2. Validates draft data
   * 3. Calls eBay API to publish
   * 4. Returns publish result with metadata
   */
  async publishDraft(draftId: string, options?: PublishOptions): Promise<PublishResult> {
    // Step 1: Fetch draft with product relations
    const draft = await this.fetchDraftWithRelations(draftId);

    // Step 2: Validate draft data
    this.validateDraftData(draft);

    // Step 3: Determine final price (use override if provided)
    const finalPrice = options?.overridePrice ?? Number(draft.product.basePrice);

    // Step 4: Call eBay API to publish
    const listingId = await this.ebayService.publishNewListing(
      draft.product.sku,
      {
        ebayTitle: draft.ebayTitle,
        categoryId: draft.categoryId,
        itemSpecifics: draft.itemSpecifics as Record<string, string>,
        htmlDescription: draft.htmlDescription,
      },
      finalPrice,
      draft.product.totalStock
    );

    // Step 5: Return result
    return {
      success: true,
      draftId,
      productId: draft.productId,
      listingId,
      listingUrl: `https://www.ebay.com/itm/${listingId}`,
      publishedAt: new Date().toISOString(),
      message: "Listing published successfully",
    };
  }

  /**
   * Fetches a draft listing with all required relations
   */
  private async fetchDraftWithRelations(draftId: string) {
    const draft = await (this.prisma as any).draftListing.findUnique({
      where: { id: draftId },
      include: {
        product: {
          include: {
            variations: true,
            images: true,
          },
        },
      },
    });

    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`);
    }

    return draft;
  }

  /**
   * Validates that draft has all required fields for publishing
   */
  private validateDraftData(draft: any) {
    if (draft.status !== "DRAFT") {
      throw new Error(`Draft is not in DRAFT status: ${draft.status}`);
    }

    if (!draft.ebayTitle || draft.ebayTitle.length === 0) {
      throw new Error("Draft missing required field: ebayTitle");
    }

    if (!draft.categoryId || draft.categoryId.length === 0) {
      throw new Error("Draft missing required field: categoryId");
    }

    if (!draft.htmlDescription || draft.htmlDescription.length === 0) {
      throw new Error("Draft missing required field: htmlDescription");
    }

    if (!draft.product) {
      throw new Error("Product not found for draft");
    }

    if (!draft.product.sku) {
      throw new Error("Product missing SKU");
    }
  }
}
