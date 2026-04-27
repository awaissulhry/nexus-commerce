/**
 * Amazon Variation Payload Builder Service
 * 
 * Translates the internal Hub & Spoke Matrix into Amazon SP-API Parent/Child payloads.
 * Handles variation theme mapping, attribute transformation, and parent/child relationships.
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

interface VariationAttribute {
  [key: string]: string;
}

interface AmazonItem {
  sku: string;
  parentage: 'parent' | 'child';
  parentSku?: string;
  variationTheme?: string;
  variationAttributes?: VariationAttribute;
  title?: string;
  description?: string;
  price?: number;
  quantity?: number;
  fulfillmentChannel?: string;
}

interface AmazonVariationPayload {
  items: AmazonItem[];
  variationTheme: string;
  parentSku: string;
  childCount: number;
  timestamp: string;
}

export class AmazonMapperService {
  /**
   * Build Amazon SP-API payload for a parent product with variations
   * 
   * @param channelListingId - The Amazon ChannelListing ID
   * @param productId - The master product ID
   * @returns Amazon variation payload ready for SP-API
   */
  async buildVariationPayload(
    channelListingId: string,
    productId: string
  ): Promise<AmazonVariationPayload> {
    try {
      logger.info('Building Amazon variation payload', {
        channelListingId,
        productId,
      });

      // Fetch the master product with all relations
      const product = await (prisma as any).product.findUnique({
        where: { id: productId },
        include: {
          masterVariations: {
            include: {
              channelListings: {
                where: { id: channelListingId },
              },
            },
          },
          channelListings: {
            where: { id: channelListingId },
            include: {
              offers: true,
            },
          },
        },
      });

      if (!product) {
        throw new Error(`Product not found: ${productId}`);
      }

      if (!product.isParent) {
        throw new Error(`Product is not a parent: ${productId}`);
      }

      const channelListing = product.channelListings[0];
      if (!channelListing) {
        throw new Error(`ChannelListing not found: ${channelListingId}`);
      }

      if (!channelListing.variationTheme) {
        throw new Error(`No variation theme set for listing: ${channelListingId}`);
      }

      // Build parent item
      const parentItem: AmazonItem = {
        sku: product.sku,
        parentage: 'parent',
        variationTheme: channelListing.variationTheme,
        title: channelListing.title || product.name,
        description: channelListing.description || '',
        price: channelListing.price ? Number(channelListing.price) : Number(product.basePrice),
        quantity: channelListing.quantity || product.totalStock,
        fulfillmentChannel: product.fulfillmentChannel || 'FBA',
      };

      // Build child items
      const childItems: AmazonItem[] = [];
      const variationMapping = channelListing.variationMapping as Record<string, any>;

      for (const child of product.masterVariations) {
        // Get the child's channel listing for this region (if it exists)
        const childChannelListing = child.channelListings[0];

        // Extract variation attributes from child's categoryAttributes
        const variationAttributes = this.extractVariationAttributes(
          child,
          variationMapping,
          channelListing.variationTheme
        );

        const childItem: AmazonItem = {
          sku: child.sku,
          parentage: 'child',
          parentSku: product.sku,
          variationAttributes,
          title: childChannelListing?.title || child.name,
          description: childChannelListing?.description || '',
          price: childChannelListing?.price ? Number(childChannelListing.price) : Number(child.basePrice),
          quantity: childChannelListing?.quantity || child.totalStock,
          fulfillmentChannel: child.fulfillmentChannel || product.fulfillmentChannel || 'FBA',
        };

        childItems.push(childItem);
      }

      // Construct the final payload
      const payload: AmazonVariationPayload = {
        items: [parentItem, ...childItems],
        variationTheme: channelListing.variationTheme,
        parentSku: product.sku,
        childCount: childItems.length,
        timestamp: new Date().toISOString(),
      };

      logger.info('Amazon variation payload built successfully', {
        parentSku: product.sku,
        childCount: childItems.length,
        variationTheme: channelListing.variationTheme,
      });

      return payload;
    } catch (error) {
      logger.error('Error building Amazon variation payload', {
        error: error instanceof Error ? error.message : String(error),
        channelListingId,
        productId,
      });
      throw error;
    }
  }

  /**
   * Extract and map variation attributes from child product to Amazon format
   * 
   * @param childProduct - The child product
   * @param variationMapping - The variation mapping configuration
   * @param variationTheme - The variation theme (e.g., "Color", "Size")
   * @returns Mapped variation attributes
   */
  private extractVariationAttributes(
    childProduct: any,
    variationMapping: Record<string, any>,
    variationTheme: string
  ): VariationAttribute {
    const attributes: VariationAttribute = {};

    // Get the mapping configuration for this theme
    const themeMapping = variationMapping[variationTheme];
    if (!themeMapping) {
      logger.warn('No mapping found for variation theme', {
        variationTheme,
        availableThemes: Object.keys(variationMapping),
      });
      return attributes;
    }

    // Extract the master attribute name
    const masterAttribute = themeMapping.masterAttribute;
    const platformAttribute = themeMapping.platformAttribute;
    const valueMap = themeMapping.values || {};

    // Get the value from child's categoryAttributes
    const categoryAttributes = childProduct.categoryAttributes as Record<string, any>;
    if (categoryAttributes && masterAttribute in categoryAttributes) {
      const masterValue = categoryAttributes[masterAttribute];
      // Map to platform-specific value (or use as-is if no mapping)
      const platformValue = valueMap[masterValue] || masterValue;
      attributes[platformAttribute] = platformValue;
    }

    return attributes;
  }

  /**
   * Validate that a product can be synced as a variation parent
   * 
   * @param productId - The product ID to validate
   * @returns true if valid, throws error otherwise
   */
  async validateVariationParent(productId: string): Promise<boolean> {
    const product = await (prisma as any).product.findUnique({
      where: { id: productId },
      include: {
        masterVariations: true,
        channelListings: true,
      },
    });

    if (!product) {
      throw new Error(`Product not found: ${productId}`);
    }

    if (!product.isParent) {
      throw new Error(`Product is not marked as parent: ${productId}`);
    }

    if (product.masterVariations.length === 0) {
      throw new Error(`Parent product has no children: ${productId}`);
    }

    const amazonListing = product.channelListings.find(
      (cl: any) => cl.channel === 'AMAZON'
    );
    if (!amazonListing) {
      throw new Error(`Parent product has no Amazon listing: ${productId}`);
    }

    if (!amazonListing.variationTheme) {
      throw new Error(`Amazon listing has no variation theme: ${amazonListing.id}`);
    }

    return true;
  }

  /**
   * PHASE 15: Build offer payload with isActive filtering
   * Only includes active offers in the payload
   *
   * @param channelListingId - The channel listing ID
   * @returns Offers payload with only active offers
   */
  async buildOfferPayload(channelListingId: string): Promise<any> {
    try {
      logger.info('Building offer payload', { channelListingId });

      const channelListing = await (prisma as any).channelListing.findUnique({
        where: { id: channelListingId },
        include: {
          offers: true,
          product: true,
        },
      });

      if (!channelListing) {
        throw new Error(`ChannelListing not found: ${channelListingId}`);
      }

      // PHASE 15: Filter only active offers
      const activeOffers = channelListing.offers.filter((offer: any) => offer.isActive !== false);

      if (activeOffers.length === 0) {
        logger.warn('No active offers found for channel listing', { channelListingId });
        return {
          channelListingId,
          offers: [],
          activeCount: 0,
          totalCount: channelListing.offers.length,
        };
      }

      // Build offer items
      const offerItems = activeOffers.map((offer: any) => ({
        sku: offer.sku,
        fulfillmentMethod: offer.fulfillmentMethod,
        price: offer.price ? Number(offer.price) : Number(channelListing.price),
        quantity: offer.quantity || channelListing.quantity,
        isActive: offer.isActive,
      }));

      logger.info('Offer payload built successfully', {
        channelListingId,
        activeCount: activeOffers.length,
        totalCount: channelListing.offers.length,
      });

      return {
        channelListingId,
        platformProductId: channelListing.platformProductId,
        offers: offerItems,
        activeCount: activeOffers.length,
        totalCount: channelListing.offers.length,
      };
    } catch (error) {
      logger.error('Error building offer payload', {
        error: error instanceof Error ? error.message : String(error),
        channelListingId,
      });
      throw error;
    }
  }

  /**
   * Get all parent products that need variation sync
   *
   * @returns Array of parent products with variation data
   */
  async getParentProductsForSync(): Promise<any[]> {
    const parents = await (prisma as any).product.findMany({
      where: {
        isParent: true,
        masterVariations: {
          some: {}, // Has at least one child
        },
        channelListings: {
          some: {
            channel: 'AMAZON',
            variationTheme: {
              not: null,
            },
          },
        },
      },
      include: {
        masterVariations: true,
        channelListings: {
          where: {
            channel: 'AMAZON',
          },
        },
      },
    });

    return parents;
  }
}

export const amazonMapperService = new AmazonMapperService();
