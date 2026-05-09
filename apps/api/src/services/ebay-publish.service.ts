import { PrismaClient } from "@prisma/client";
import { EbayService } from "./marketplaces/ebay.service.js";
import prisma from "@nexus/database";
import { publishListingEvent } from "./listing-events.service.js";

export interface PublishResult {
  success: boolean;
  draftId: string;
  productId: string;
  /** eBay's external item ID returned by the Trading API. */
  listingId: string;
  listingUrl: string;
  publishedAt: string;
  message: string;
  /** Internal VariantChannelListing.id created/updated by the publish. Absent when the product has no variations — in that case no internal listing row is persisted yet (a known gap; see TECH_DEBT for the variation-mechanism cleanup). */
  variantChannelListingId?: string;
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
   * Publishes a draft listing to eBay end-to-end:
   *   1. Fetch draft + product + variations
   *   2. Validate draft data
   *   3. Call eBay Trading API
   *   4. Update DraftListing → PUBLISHED
   *   5. Upsert VariantChannelListing (when the product has variations)
   *   6. Emit `listing.created` so SSE consumers refresh within ~200ms
   *
   * Both call sites (POST /api/listings/:draftId/publish and the
   * bulk-list BullMQ worker) go through this single method so the
   * recording + emit step never gets accidentally skipped.
   */
  async publishDraft(draftId: string, options?: PublishOptions): Promise<PublishResult> {
    const draft = await this.fetchDraftWithRelations(draftId);
    this.validateDraftData(draft);

    const finalPrice = options?.overridePrice ?? Number(draft.product.basePrice);

    const listingId = await this.ebayService.publishNewListing(
      draft.product.sku,
      {
        ebayTitle: draft.ebayTitle,
        categoryId: draft.categoryId,
        itemSpecifics: draft.itemSpecifics as Record<string, string>,
        htmlDescription: draft.htmlDescription,
      },
      finalPrice,
      draft.product.totalStock,
      draft.productId,
    );

    const listingUrl = `https://www.ebay.com/itm/${listingId}`;

    await (this.prisma as any).draftListing.update({
      where: { id: draftId },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });

    let variantChannelListingId: string | undefined;
    if (draft.product.variations && draft.product.variations.length > 0) {
      const variant = draft.product.variations[0];
      const vcl = await (this.prisma as any).variantChannelListing.upsert({
        where: {
          variantId_channelId: { variantId: variant.id, channelId: "EBAY" },
        },
        update: {
          externalListingId: listingId,
          listingStatus: "ACTIVE",
          listingUrl,
          lastSyncedAt: new Date(),
          lastSyncStatus: "SUCCESS",
        },
        create: {
          variantId: variant.id,
          channel: "EBAY",
          channelSku: draft.product.sku,
          externalListingId: listingId,
          externalSku: draft.product.sku,
          channelPrice: finalPrice,
          channelQuantity: draft.product.totalStock,
          listingStatus: "ACTIVE",
          listingUrl,
          lastSyncedAt: new Date(),
          lastSyncStatus: "SUCCESS",
        },
      });
      variantChannelListingId = vcl.id;
    }

    // Cross-process refresh signal — both the originating tab (via
    // SSE roundtrip) and any other open session pick this up and
    // refetch within ~200ms instead of waiting for the next 30s
    // polling tick. We pass the internal id when we have one and
    // fall back to the eBay external id so the event always carries
    // a stable identifier.
    publishListingEvent({
      type: "listing.created",
      listingId: variantChannelListingId ?? listingId,
      ts: Date.now(),
    });

    return {
      success: true,
      draftId,
      productId: draft.productId,
      listingId,
      listingUrl,
      publishedAt: new Date().toISOString(),
      message: "Listing published successfully",
      variantChannelListingId,
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
