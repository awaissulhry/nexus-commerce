import prisma from "../db.js";
import { ebayAuthService } from "./ebay-auth.service.js";
import { logger } from "../utils/logger.js";
import { recordApiCall } from "./outbound-api-call-log.service.js";

/**
 * eBay Listing from API
 */
interface EbayListing {
  itemId: string;
  title: string;
  sku?: string;
  customLabel?: string;
  price?: number;
  quantity?: number;
  quantitySold?: number;
  listingStatus?: string;
  categoryId?: string;
  description?: string;
  pictureDetails?: {
    pictureUrl?: string[];
  };
}

/**
 * Auto-match result
 */
interface MatchResult {
  ebayItemId: string;
  ebayTitle: string;
  ebaySku?: string;
  matchType: "SKU" | "UPC" | "EAN" | "TITLE" | "MANUAL" | "NONE";
  matchedProductId?: string;
  matchedVariationId?: string;
  confidence: number; // 0-100
  reason: string;
}

/**
 * Sync result
 */
interface SyncResult {
  syncId: string;
  connectionId: string;
  status: "SUCCESS" | "FAILED" | "PARTIAL";
  listingsFetched: number;
  listingsMatched: number;
  listingsUnmatched: number;
  listingsCreated: number;
  listingsUpdated: number;
  errors: Array<{ itemId: string; error: string }>;
  matches: MatchResult[];
  startedAt: Date;
  completedAt: Date;
}

export class EbaySyncService {
  private stats = {
    listingsFetched: 0,
    listingsMatched: 0,
    listingsUnmatched: 0,
    listingsCreated: 0,
    listingsUpdated: 0,
  };

  private errors: Array<{ itemId: string; error: string }> = [];
  private matches: MatchResult[] = [];

  constructor() {
    this.resetStats();
  }

  private resetStats() {
    this.stats = {
      listingsFetched: 0,
      listingsMatched: 0,
      listingsUnmatched: 0,
      listingsCreated: 0,
      listingsUpdated: 0,
    };
    this.errors = [];
    this.matches = [];
  }

  /**
   * Fetch all active eBay listings for a seller
   */
  async fetchEbayListings(accessToken: string, connectionId?: string): Promise<EbayListing[]> {
    try {
      logger.info("Fetching eBay listings from Inventory API");

      // Using eBay Inventory API to get active listings
      const data = await recordApiCall<any>(
        {
          channel: 'EBAY',
          operation: 'listInventoryItems',
          endpoint: '/sell/inventory/v1/inventory',
          method: 'GET',
          connectionId,
          triggeredBy: 'cron',
        },
        async () => {
          const response = await fetch(
            "https://api.ebay.com/sell/inventory/v1/inventory",
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            }
          );

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            logger.error("Failed to fetch eBay listings", {
              status: response.status,
              error: errorBody,
            });
            const err = new Error(
              `eBay API error ${response.status}: ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = response.status;
            err.body = errorBody;
            throw err;
          }

          return (await response.json()) as any;
        },
      );
      const listings: EbayListing[] = [];

      // Parse inventory items
      if (data.inventories && Array.isArray(data.inventories)) {
        for (const item of data.inventories) {
          listings.push({
            itemId: item.sku || item.inventoryItemId || "",
            title: item.title || "",
            sku: item.sku,
            customLabel: item.customLabel,
            price: item.price?.value ? parseFloat(item.price.value) : undefined,
            quantity: item.quantity,
            quantitySold: item.quantitySold,
            listingStatus: "ACTIVE",
          });
        }
      }

      logger.info("Fetched eBay listings", { count: listings.length });
      return listings;
    } catch (error) {
      logger.error("Error fetching eBay listings", { error });
      throw error;
    }
  }

  /**
   * Auto-match eBay listing to Nexus product
   * Tries multiple matching strategies in order of confidence
   */
  async autoMatchListing(listing: EbayListing): Promise<MatchResult> {
    try {
      const ebaySku = listing.sku || listing.customLabel;

      // Strategy 1: Match by SKU (highest confidence)
      if (ebaySku) {
        const productBySku = await prisma.product.findFirst({
          where: {
            sku: {
              equals: ebaySku,
              mode: "insensitive",
            },
          },
          include: {
            variations: true,
          },
        });

        if (productBySku) {
          logger.info("Matched eBay listing by SKU", {
            itemId: listing.itemId,
            sku: ebaySku,
            productId: productBySku.id,
          });

          return {
            ebayItemId: listing.itemId,
            ebayTitle: listing.title,
            ebaySku,
            matchType: "SKU",
            matchedProductId: productBySku.id,
            matchedVariationId: productBySku.variations[0]?.id,
            confidence: 95,
            reason: `Exact SKU match: ${ebaySku}`,
          };
        }
      }

      // Strategy 2: Match by UPC (high confidence)
      if (listing.sku) {
        const productByUpc = await prisma.product.findFirst({
          where: {
            upc: {
              equals: listing.sku,
              mode: "insensitive",
            },
          },
          include: {
            variations: true,
          },
        });

        if (productByUpc) {
          logger.info("Matched eBay listing by UPC", {
            itemId: listing.itemId,
            upc: listing.sku,
            productId: productByUpc.id,
          });

          return {
            ebayItemId: listing.itemId,
            ebayTitle: listing.title,
            ebaySku,
            matchType: "UPC",
            matchedProductId: productByUpc.id,
            matchedVariationId: productByUpc.variations[0]?.id,
            confidence: 85,
            reason: `UPC match: ${listing.sku}`,
          };
        }
      }

      // Strategy 3: Match by EAN (high confidence)
      if (listing.sku) {
        const productByEan = await prisma.product.findFirst({
          where: {
            ean: {
              equals: listing.sku,
              mode: "insensitive",
            },
          },
          include: {
            variations: true,
          },
        });

        if (productByEan) {
          logger.info("Matched eBay listing by EAN", {
            itemId: listing.itemId,
            ean: listing.sku,
            productId: productByEan.id,
          });

          return {
            ebayItemId: listing.itemId,
            ebayTitle: listing.title,
            ebaySku,
            matchType: "EAN",
            matchedProductId: productByEan.id,
            matchedVariationId: productByEan.variations[0]?.id,
            confidence: 85,
            reason: `EAN match: ${listing.sku}`,
          };
        }
      }

      // Strategy 4: Match by title (lower confidence)
      const titleWords = listing.title.toLowerCase().split(" ").slice(0, 3);
      if (titleWords.length > 0) {
        const productByTitle = await prisma.product.findFirst({
          where: {
            name: {
              contains: titleWords.join(" "),
              mode: "insensitive",
            },
          },
        });

        if (productByTitle) {
          logger.info("Matched eBay listing by title", {
            itemId: listing.itemId,
            title: listing.title,
            productId: productByTitle.id,
          });

          // Get first variation for this product
          const variation = await prisma.productVariation.findFirst({
            where: {
              productId: productByTitle.id,
            },
          });

          return {
            ebayItemId: listing.itemId,
            ebayTitle: listing.title,
            ebaySku,
            matchType: "TITLE",
            matchedProductId: productByTitle.id,
            matchedVariationId: variation?.id,
            confidence: 60,
            reason: `Title match: ${listing.title}`,
          };
        }
      }

      // No match found
      logger.warn("No match found for eBay listing", {
        itemId: listing.itemId,
        title: listing.title,
        sku: ebaySku,
      });

      return {
        ebayItemId: listing.itemId,
        ebayTitle: listing.title,
        ebaySku,
        matchType: "NONE",
        confidence: 0,
        reason: "No matching product found in Nexus database",
      };
    } catch (error) {
      logger.error("Error auto-matching eBay listing", {
        itemId: listing.itemId,
        error,
      });

      return {
        ebayItemId: listing.itemId,
        ebayTitle: listing.title,
        ebaySku: listing.sku || listing.customLabel,
        matchType: "NONE",
        confidence: 0,
        reason: `Error during matching: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Create or update VariantChannelListing record
   */
  async createOrUpdateChannelListing(
    match: MatchResult,
    listing: EbayListing,
    channelConnectionId: string
  ): Promise<boolean> {
    try {
      if (!match.matchedVariationId) {
        logger.warn("Cannot create listing without matched variation", {
          itemId: match.ebayItemId,
        });
        return false;
      }

      // Check if listing already exists
      const existing = await prisma.variantChannelListing.findFirst({
        where: {
          variantId: match.matchedVariationId,
          channelConnectionId,
        },
      });

      if (existing) {
        // Update existing listing
        await prisma.variantChannelListing.update({
          where: { id: existing.id },
          data: {
            externalListingId: match.ebayItemId,
            externalSku: match.ebaySku,
            listingUrl: `https://www.ebay.com/itm/${match.ebayItemId}`,
            currentPrice: listing.price ? String(listing.price) : undefined,
            quantity: listing.quantity,
            quantitySold: listing.quantitySold,
            listingStatus: "ACTIVE",
          },
        });

        this.stats.listingsUpdated++;
        logger.info("Updated VariantChannelListing", {
          id: existing.id,
          itemId: match.ebayItemId,
        });

        // CS.2 — record a ChannelStockEvent so any drift between
        // eBay-reported quantity and our local StockLevel surfaces
        // for operator triage (or self-heals when within threshold).
        // Only fires when listing.quantity is a real number; eBay
        // sometimes returns null on private/best-offer listings.
        if (typeof listing.quantity === 'number' && match.matchedVariationId) {
          try {
            const variant = await prisma.productVariation.findUnique({
              where: { id: match.matchedVariationId },
              select: { productId: true },
            });
            if (variant?.productId) {
              const { recordChannelStockEvent } = await import(
                './channel-stock-event.service.js'
              );
              await recordChannelStockEvent({
                channel: 'EBAY',
                // eBay listing-id is the natural channel key; sync runs
                // multiple times — suffix with the ISO hour so a
                // multi-tick steady state collapses but real edits
                // produce distinct events.
                channelEventId: `${match.ebayItemId}:${new Date().toISOString().slice(0, 13)}`,
                productId: variant.productId,
                variationId: match.matchedVariationId,
                channelReportedQty: listing.quantity,
                rawPayload: {
                  ebayItemId: match.ebayItemId,
                  sku: match.ebaySku,
                  quantity: listing.quantity,
                  quantitySold: listing.quantitySold,
                },
              });
            }
          } catch (e) {
            logger.warn('eBay → ChannelStockEvent record failed (sync continues)', {
              ebayItemId: match.ebayItemId,
              err: e instanceof Error ? e.message : String(e),
            });
          }
        }
      } else {
        // Create new listing
        const createData: any = {
          variantId: match.matchedVariationId,
          externalListingId: match.ebayItemId,
          externalSku: match.ebaySku,
          listingUrl: `https://www.ebay.com/itm/${match.ebayItemId}`,
          channelPrice: listing.price ? listing.price : 0,
          currentPrice: listing.price ? listing.price : undefined,
          quantity: listing.quantity,
          quantitySold: listing.quantitySold || 0,
          listingStatus: "ACTIVE",
        };

        if (channelConnectionId) {
          createData.channelConnectionId = channelConnectionId;
        }

        await prisma.variantChannelListing.create({
          data: createData,
        });

        this.stats.listingsCreated++;
        logger.info("Created VariantChannelListing", {
          variantId: match.matchedVariationId,
          itemId: match.ebayItemId,
        });
      }

      return true;
    } catch (error) {
      logger.error("Error creating/updating VariantChannelListing", {
        itemId: match.ebayItemId,
        error,
      });
      return false;
    }
  }

  /**
   * Main sync method - orchestrates the entire process
   */
  async syncEbayInventory(connectionId: string): Promise<SyncResult> {
    const syncId = `ebay-sync-${Date.now()}`;
    const startedAt = new Date();

    try {
      this.resetStats();

      logger.info("Starting eBay inventory sync", { syncId, connectionId });

      // Get valid token
      const accessToken = await ebayAuthService.getValidToken(connectionId);

      // Fetch eBay listings
      const listings = await this.fetchEbayListings(accessToken, connectionId);
      this.stats.listingsFetched = listings.length;

      logger.info("Processing eBay listings", {
        syncId,
        count: listings.length,
      });

      // Process each listing
      for (const listing of listings) {
        try {
          // Auto-match listing
          const match = await this.autoMatchListing(listing);
          this.matches.push(match);

          if (match.matchType !== "NONE") {
            this.stats.listingsMatched++;

            // Create or update channel listing
            const success = await this.createOrUpdateChannelListing(
              match,
              listing,
              connectionId
            );

            if (!success) {
              this.errors.push({
                itemId: listing.itemId,
                error: "Failed to create/update channel listing",
              });
            }
          } else {
            this.stats.listingsUnmatched++;
            logger.warn("Unmatched eBay listing", {
              itemId: listing.itemId,
              title: listing.title,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.errors.push({
            itemId: listing.itemId,
            error: message,
          });
          logger.error("Error processing eBay listing", {
            itemId: listing.itemId,
            error: message,
          });
        }
      }

      const completedAt = new Date();
      const status =
        this.errors.length === 0
          ? "SUCCESS"
          : this.stats.listingsMatched > 0
            ? "PARTIAL"
            : "FAILED";

      const result: SyncResult = {
        syncId,
        connectionId,
        status,
        listingsFetched: this.stats.listingsFetched,
        listingsMatched: this.stats.listingsMatched,
        listingsUnmatched: this.stats.listingsUnmatched,
        listingsCreated: this.stats.listingsCreated,
        listingsUpdated: this.stats.listingsUpdated,
        errors: this.errors,
        matches: this.matches,
        startedAt,
        completedAt,
      };

      logger.info("eBay inventory sync completed", {
        syncId,
        status,
        ...this.stats,
        errorCount: this.errors.length,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("eBay inventory sync failed", { syncId, error: message });

      return {
        syncId,
        connectionId,
        status: "FAILED",
        listingsFetched: this.stats.listingsFetched,
        listingsMatched: this.stats.listingsMatched,
        listingsUnmatched: this.stats.listingsUnmatched,
        listingsCreated: this.stats.listingsCreated,
        listingsUpdated: this.stats.listingsUpdated,
        errors: [
          ...this.errors,
          {
            itemId: "SYNC_ERROR",
            error: message,
          },
        ],
        matches: this.matches,
        startedAt: new Date(),
        completedAt: new Date(),
      };
    }
  }

  /**
   * Get sync status
   */
  async getSyncStatus(syncId: string): Promise<any> {
    try {
      // In a real implementation, store sync results in database
      // For now, return empty result
      logger.info("Fetching sync status", { syncId });
      return {
        syncId,
        status: "UNKNOWN",
        message: "Sync status not found",
      };
    } catch (error) {
      logger.error("Error fetching sync status", { syncId, error });
      throw error;
    }
  }
}

// Export singleton instance
export const ebaySyncService = new EbaySyncService();
