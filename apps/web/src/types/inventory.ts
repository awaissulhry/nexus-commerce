/**
 * Channel-specific pricing and inventory data
 */
export interface ChannelData {
  channel: 'amazon' | 'ebay' | 'shopify' | 'woocommerce';
  price: number;
  stock: number;
  listingId?: string;
  lastSyncedAt?: string;
  syncStatus?: 'SUCCESS' | 'FAILED' | 'PENDING' | string;
}

/**
 * Unified inventory row type used by TanStack Table.
 *
 * A **parent** row represents a Master SKU (Product) and may contain `subRows`
 * (one per ProductVariation). A **child** row represents a single
 * variation and never has `subRows`.
 *
 * This shape is intentionally flat so that both parents and children
 * can share the same column definitions.
 */
export interface InventoryItem {
   /** Product or Variation ID */
   id: string;

   /** SKU (product-level or variation-level) — Master SKU for parents */
   sku: string;

   /** Display name — product title for parents, "Color: Red / Size: XL" for children */
   name: string;

   /** Amazon ASIN (parent only) */
   asin: string | null;

   /** eBay Item ID (parent only) */
   ebayItemId: string | null;

   /** First image URL (thumbnail) */
   imageUrl: string | null;

   /** Price — basePrice for parents, variation price for children */
   price: number;

   /** Stock — Global Available (total across all warehouses) for parents, variation stock for children */
   stock: number;

   /** Status derived from stock level */
   status: "Active" | "Inactive" | "Out of Stock";

   /** Whether this row is a parent (product) or child (variation) */
   isParent: boolean;

   /** Variation attribute name (e.g. "Color") — children only */
   variationName: string | null;

   /** Variation attribute value (e.g. "Red") — children only */
   variationValue: string | null;

   /** Brand (parent only) */
   brand: string | null;

   /** Fulfillment method (legacy) */
   fulfillment: string | null;

   /** Fulfillment channel (FBA or FBM) — from database */
   fulfillmentChannel?: "FBA" | "FBM" | null;

   /** Shipping template for FBM items */
   shippingTemplate?: string | null;

   /** Parent ID for child products */
   parentId?: string | null;

   /** Date the item was created */
   createdAt: string | null;

   /** Condition label (e.g. "New") */
   condition: string;

   /** Channels this item is listed on (parent only) */
   channels?: ('amazon' | 'ebay' | 'shopify' | 'woocommerce')[];

   /** Channel-specific data for multi-channel pricing/inventory (parent only) */
   channelData?: ChannelData[];

   /**
    * TanStack Table uses this property for row expansion / nesting.
    * Parents populate this with their variations; children leave it undefined.
    */
   subRows?: InventoryItem[];

   /** Children products (for parent rows) */
   children?: InventoryItem[];
}
