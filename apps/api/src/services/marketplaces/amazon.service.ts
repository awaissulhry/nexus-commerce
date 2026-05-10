import { SellingPartner } from "amazon-sp-api";
import { parse } from "csv-parse/sync";
import { instrumentSellingPartner } from "../outbound-api-call-log.service.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Maps 2-letter marketplace code to Amazon marketplace ID string. */
export const AMAZON_MARKETPLACE_CODE_TO_ID: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
  NL: 'A1805IZSGTT6HS',
  SE: 'A2NODRKZP88ZB9',
  PL: 'A1C3SOZRARQ6R3',
  US: 'ATVPDKIKX0DER',
}

/** Active EU marketplaces for Xavia — used for "run all" reconciliation. */
export const XAVIA_ACTIVE_MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK']

const MARKETPLACE_CURRENCY: Record<string, string> = {
  APJ6JRA9NG5V4: "EUR", // Italy
  A1PA6795UKMFR9: "EUR", // Germany
  A13V1IB3VIYZZH: "EUR", // France
  A1RKKUPIHCS9HS: "EUR", // Spain
  A1F83G8C2ARO7P: "GBP", // United Kingdom
  ATVPDKIKX0DER: "USD",  // United States
  A2EUQ1WTGCTBG2: "CAD", // Canada
  A1AM78C64UM0Y8: "MXN", // Mexico
};

function getCurrencyForMarketplace(marketplaceId: string): string {
  return MARKETPLACE_CURRENCY[marketplaceId] ?? "EUR";
}

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/** Lightweight catalog row returned by the merchant listings report. */
export interface CatalogItem {
  sku: string;
  asin: string;
  /** Parent ASIN if this is a variation child; null for standalone products. */
  parentAsin: string | null;
  /** Variation theme extracted from the report (e.g. "SizeColor"); null if not present. */
  variationTheme: string | null;
  price: number;
  quantity: number;
  title: string;
  status: string;
}

/** Image mapped to our Prisma ProductImage shape. */
export interface ProductImageData {
  url: string;
  alt: string | null;
  type: "MAIN" | "ALT" | "LIFESTYLE";
}

/** Order returned from SP-API getOrders. Field names match Amazon's PascalCase wire format. */
export interface AmazonOrderRaw {
  AmazonOrderId: string
  PurchaseDate: string
  LastUpdateDate?: string
  OrderStatus: string
  FulfillmentChannel?: 'AFN' | 'MFN' | string
  SalesChannel?: string
  OrderTotal?: { CurrencyCode: string; Amount: string }
  NumberOfItemsShipped?: number
  NumberOfItemsUnshipped?: number
  MarketplaceId?: string
  ShipmentServiceLevelCategory?: string
  BuyerInfo?: {
    BuyerEmail?: string
    BuyerName?: string
  }
  ShippingAddress?: {
    Name?: string
    AddressLine1?: string
    AddressLine2?: string
    AddressLine3?: string
    City?: string
    StateOrRegion?: string
    PostalCode?: string
    CountryCode?: string
    Phone?: string
  }
  EarliestShipDate?: string
  LatestShipDate?: string
  EarliestDeliveryDate?: string
  LatestDeliveryDate?: string
  IsBusinessOrder?: boolean
  IsPrime?: boolean
}

/** Order item returned from SP-API getOrderItems. */
export interface AmazonOrderItemRaw {
  ASIN: string
  SellerSKU?: string
  OrderItemId: string
  Title?: string
  QuantityOrdered: number
  QuantityShipped?: number
  ItemPrice?: { CurrencyCode: string; Amount: string }
  ShippingPrice?: { CurrencyCode: string; Amount: string }
  ItemTax?: { CurrencyCode: string; Amount: string }
  ShippingTax?: { CurrencyCode: string; Amount: string }
  PromotionDiscount?: { CurrencyCode: string; Amount: string }
}

/** Single FBA inventory row mapped from getInventorySummaries.
 *  All quantity buckets are summed across conditions for the same SKU
 *  in `fetchFBAInventory` (most sellers run "New" only; if not, we
 *  prefer "more stock" over "lose stock"). */
export interface FBAInventoryRow {
  sku: string                  // sellerSKU (the merchant's SKU, our join key)
  asin: string | null
  fnsku: string | null
  fulfillableQuantity: number  // what Amazon will actually ship today
  inboundQuantity: number      // working + shipped + receiving (in-flight to FC)
  reservedQuantity: number     // pending orders + transshipment + FC processing
  unfulfillableQuantity: number
  totalQuantity: number        // sum of all buckets — equals SP-API field
  lastUpdatedTime: string | null
}

/** Charge/fee component from financial events. */
export interface AmazonMoneyType { Amount: string; CurrencyCode: string }
export interface AmazonChargeComponent { ChargeType: string; ChargeAmount: AmazonMoneyType }
export interface AmazonFeeComponent { FeeType: string; FeeAmount: AmazonMoneyType }
export interface AmazonShipmentItem {
  SellerSKU?: string
  ASIN?: string
  QuantityShipped?: number
  ItemChargeList?: AmazonChargeComponent[]
  ItemFeeList?: AmazonFeeComponent[]
  ShipmentItemId?: string
}
export interface AmazonOrderFinancialEvent {
  AmazonOrderId?: string
  PostedDate?: string
  ShipmentItemList?: AmazonShipmentItem[]
  OrderChargeList?: AmazonChargeComponent[]
  OrderFeeList?: AmazonFeeComponent[]
}
export interface AmazonRefundEvent {
  AmazonOrderId?: string
  PostedDate?: string
  SellerOrderId?: string
  ShipmentItemAdjustmentList?: Array<{
    ShipmentItemId?: string
    SellerSKU?: string
    ItemChargeAdjustmentList?: AmazonChargeComponent[]
    ItemFeeAdjustmentList?: AmazonFeeComponent[]
  }>
}
export interface AmazonServiceFeeEvent {
  AmazonOrderId?: string
  Reason?: string
  StoreName?: string
  FeeList?: AmazonFeeComponent[]
}
export interface FinancialEventsPayload {
  orderEvents: AmazonOrderFinancialEvent[]
  refundEvents: AmazonRefundEvent[]
  serviceFeeEvents: AmazonServiceFeeEvent[]
}

/** Options accepted by `fetchOrders`. Mutually-exclusive cursors:
 *  - `since`: fetch orders with `LastUpdatedAfter >= since` (incremental polling)
 *  - `daysBack`: fetch `CreatedAfter >= now - daysBack days` (initial backfill)
 *  Pass exactly one. */
export interface FetchOrdersOptions {
  since?: Date
  daysBack?: number
  limit?: number          // hard cap on total orders returned (default 1000)
  marketplaceId?: string  // defaults to env AMAZON_MARKETPLACE_ID
}

/** Rich product details aligned with the Prisma Product schema. */
export interface ProductDetails {
  sku: string;
  asin: string;
  title: string;
  brand: string | null;
  manufacturer: string | null;
  bulletPoints: string[];
  description: string | null;
  upc: string | null;
  ean: string | null;
  weightValue: number | null;
  weightUnit: string | null;
  dimLength: number | null;
  dimWidth: number | null;
  dimHeight: number | null;
  dimUnit: string | null;
  images: ProductImageData[];
  keywords: string[];
  price: number | null;
  quantity: number | null;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Safely extract a deeply-nested Amazon error message for logging. */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const nested = (error as any)?.body?.errors ?? (error as any)?.errors;
    if (Array.isArray(nested) && nested.length > 0) {
      return nested
        .map(
          (e: any) =>
            `[${e.code ?? "UNKNOWN"}] ${e.message ?? JSON.stringify(e)}`
        )
        .join(" | ");
    }
    return error.message;
  }
  return String(error);
}

/** Pause execution for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class AmazonService {
  private sp: SellingPartner | null = null;

  constructor() {
    // Constructor does nothing — validation is deferred to getClient()
  }

  /**
   * Lazy-initialize the SellingPartner client.
   * Validates env vars only when actually needed (first API call).
   * Throws if credentials are missing.
   */
  private async getClient(): Promise<SellingPartner> {
    if (this.sp) {
      return this.sp;
    }

    const clientId = process.env.AMAZON_LWA_CLIENT_ID;
    const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
    const refreshToken = process.env.AMAZON_REFRESH_TOKEN;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const roleArn = process.env.AWS_ROLE_ARN;

    if (
      !clientId ||
      !clientSecret ||
      !refreshToken ||
      !accessKeyId ||
      !secretAccessKey ||
      !roleArn
    ) {
      throw new Error(
        "Missing one or more required Amazon SP-API environment variables: " +
          "AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, " +
          "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ROLE_ARN"
      );
    }

    // The library accepts AWS credentials in the config at runtime,
    // but the bundled typings only declare the LWA client fields.
    // We cast to `any` to pass the full credential set.
    this.sp = new SellingPartner({
      region: "eu",
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: clientId,
        SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
      },
      options: {
        auto_request_tokens: true,
        auto_request_throttled: true,
      },
    } as any);

    // L.3.2 — every sp.callAPI(...) call now writes an
    // OutboundApiCallLog row via the patched callAPI. Idempotent.
    instrumentSellingPartner(this.sp as never, {
      channel: 'AMAZON',
      marketplace: process.env.AMAZON_MARKETPLACE_ID ?? undefined,
    });

    return this.sp;
  }

  /**
   * Check if Amazon credentials are configured.
   * Returns true if all required env vars are present.
   */
  isConfigured(): boolean {
    return !!(
      process.env.AMAZON_LWA_CLIENT_ID &&
      process.env.AMAZON_LWA_CLIENT_SECRET &&
      process.env.AMAZON_REFRESH_TOKEN &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_ROLE_ARN
    );
  }

  /* ────────────────────────────────────────────────────────────── */
  /*  fetchActiveCatalog                                            */
  /* ────────────────────────────────────────────────────────────── */

  /**
   * Requests the GET_MERCHANT_LISTINGS_ALL_DATA report from Amazon,
   * waits for it to finish, downloads the TSV document, and parses
   * it into an array of {@link CatalogItem} objects.
   */
  async fetchActiveCatalog(marketplaceId?: string): Promise<CatalogItem[]> {
    const mpId = marketplaceId ?? process.env.AMAZON_MARKETPLACE_ID ?? "APJ6JRA9NG5V4"
    try {
      console.log(`[Amazon] Requesting GET_MERCHANT_LISTINGS_ALL_DATA report for ${mpId}…`);

      const sp = await this.getClient();

      // Step 1 — Create the report
      const createRes: any = await sp.callAPI({
        operation: "createReport",
        endpoint: "reports",
        body: {
          reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
          marketplaceIds: [mpId],
        },
      });

      const reportId: string = createRes.reportId;
      console.log(`[Amazon] Report created: ${reportId}`);

      // Step 2 — Poll until the report is DONE
      let reportDocumentId: string | null = null;
      const maxAttempts = 30; // ~5 minutes at 10 s intervals

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await sleep(10_000); // 10 seconds between polls

        const statusRes: any = await sp.callAPI({
          operation: "getReport",
          endpoint: "reports",
          path: { reportId },
        });

        const status: string = statusRes.processingStatus;
        console.log(
          `[Amazon] Report ${reportId} status: ${status} (attempt ${attempt}/${maxAttempts})`
        );

        if (status === "DONE") {
          reportDocumentId = statusRes.reportDocumentId ?? null;
          break;
        }

        if (status === "CANCELLED" || status === "FATAL") {
          throw new Error(
            `Report ${reportId} ended with status ${status}`
          );
        }
      }

      if (!reportDocumentId) {
        throw new Error(
          `Report ${reportId} did not complete within ${maxAttempts} polling attempts`
        );
      }

      // Step 3 — Download & decompress the report document
      const docRes: any = await sp.callAPI({
        operation: "getReportDocument",
        endpoint: "reports",
        path: { reportDocumentId },
      });

      // amazon-sp-api automatically downloads + decompresses the document
      // and returns the content as a string when using `download`
      const reportContent: string =
        typeof docRes === "string"
          ? docRes
          : await (sp as any).download(docRes);

      console.log(
        `[Amazon] Report document downloaded (${reportContent.length} chars)`
      );

      // Step 4 — Parse the TSV
      const records: Record<string, string>[] = parse(reportContent, {
        columns: true,
        delimiter: "\t",
        skip_empty_lines: true,
        relax_column_count: true,
      });

      // Log all column names from the first row so we can see what Amazon sends
      if (records.length > 0) {
        console.log(
          "[Amazon] Report columns:",
          Object.keys(records[0]).join(" | ")
        );
      }

      // Amazon uses different column name variants across marketplaces/report versions
      const PARENT_ASIN_COLS = [
        "parent-asin",
        "parent_asin",
        "Parent ASIN",
        "parentasin",
        "parent-asin1",
      ];
      const VARIATION_THEME_COLS = [
        "variation-theme",
        "variation_theme",
        "Variation Theme",
        "variationtheme",
      ];

      const findCol = (
        row: Record<string, string>,
        candidates: string[]
      ): string | null => {
        for (const col of candidates) {
          const val = row[col];
          if (val && val.trim() !== "") return val.trim();
        }
        return null;
      };

      const items: CatalogItem[] = records
        .filter((row) => row["seller-sku"] && row["asin1"])
        .map((row) => {
          const rawParentAsin = findCol(row, PARENT_ASIN_COLS);
          // Ignore parent-asin if it equals the child's own ASIN (some reports do this)
          const parentAsin =
            rawParentAsin && rawParentAsin !== row["asin1"]
              ? rawParentAsin
              : null;
          return {
            sku: row["seller-sku"],
            asin: row["asin1"],
            parentAsin,
            variationTheme: findCol(row, VARIATION_THEME_COLS),
            price: parseFloat(row["price"] ?? "0") || 0,
            quantity: parseInt(row["quantity"] ?? "0", 10) || 0,
            title: row["item-name"] ?? "",
            status: row["status"] ?? "Unknown",
          };
        });

      const parentCount = items.filter((i) => i.parentAsin).length;
      console.log(
        `[Amazon] Parsed ${items.length} active listing(s) from report. ` +
          `${parentCount} have a parent ASIN (variation children).`
      );

      return items;
    } catch (error) {
      console.error(
        "[Amazon] fetchActiveCatalog failed:",
        extractErrorMessage(error)
      );
      if ((error as any)?.body) {
        console.error(
          "[Amazon] Full error body:",
          JSON.stringify((error as any).body, null, 2)
        );
      }
      throw error;
    }
  }

  /* ────────────────────────────────────────────────────────────── */
  /*  fetchProductDetails                                           */
  /* ────────────────────────────────────────────────────────────── */

  /**
   * Fetches rich product data for a single SKU using the Listings
   * Items API and the Catalog Items API, then maps the result to
   * our Prisma-aligned {@link ProductDetails} shape.
   */
  async fetchProductDetails(sku: string): Promise<ProductDetails> {
    const sellerId =
      process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? "";
    const marketplaceId =
      process.env.AMAZON_MARKETPLACE_ID ?? "APJ6JRA9NG5V4";

    let title: string = "";
    let brand: string | null = null;
    let manufacturer: string | null = null;
    let bulletPoints: string[] = [];
    let description: string | null = null;
    let upc: string | null = null;
    let ean: string | null = null;
    let weightValue: number | null = null;
    let weightUnit: string | null = null;
    let dimLength: number | null = null;
    let dimWidth: number | null = null;
    let dimHeight: number | null = null;
    let dimUnit: string | null = null;
    let images: ProductImageData[] = [];
    let keywords: string[] = [];
    let price: number | null = null;
    let quantity: number | null = null;
    let asin: string = "";

    const sp = await this.getClient();

    /* ── Listings Items API ─────────────────────────────────── */
    try {
      console.log(`[Amazon] Fetching listings item for SKU "${sku}"…`);

      const listingRes: any = await sp.callAPI({
        operation: "getListingsItem",
        endpoint: "listingsItems",
        path: {
          sellerId,
          sku,
        },
        query: {
          marketplaceIds: [marketplaceId],
          includedData: [
            "summaries",
            "attributes",
            "issues",
            "offers",
            "identifiers",
            "images",
          ],
        },
      });

      asin = listingRes?.asin ?? "";

      // ── Summaries ──
      const summaries = listingRes?.summaries;
      if (Array.isArray(summaries) && summaries.length > 0) {
        const summary = summaries[0];
        title = summary?.itemName ?? "";
        brand = summary?.brand ?? null;
      }

      // ── Attributes (bullet points, description, manufacturer) ──
      const attrs = listingRes?.attributes;
      if (attrs) {
        // Bullet points
        const bullets = attrs.bullet_point;
        if (Array.isArray(bullets)) {
          bulletPoints = bullets
            .map((b: any) => b?.value ?? "")
            .filter(Boolean);
        }

        // Description
        const descArr = attrs.product_description;
        if (Array.isArray(descArr) && descArr.length > 0) {
          description = descArr[0]?.value ?? null;
        }

        // Manufacturer
        const mfgArr = attrs.manufacturer;
        if (Array.isArray(mfgArr) && mfgArr.length > 0) {
          manufacturer = mfgArr[0]?.value ?? null;
        }

        // Brand fallback
        if (!brand) {
          const brandArr = attrs.brand;
          if (Array.isArray(brandArr) && brandArr.length > 0) {
            brand = brandArr[0]?.value ?? null;
          }
        }

        // Keywords
        const kwArr = attrs.generic_keyword ?? attrs.search_terms;
        if (Array.isArray(kwArr)) {
          keywords = kwArr
            .map((k: any) => k?.value ?? "")
            .filter(Boolean);
        }

        // Weight
        const weightArr = attrs.item_package_weight ?? attrs.item_weight;
        if (Array.isArray(weightArr) && weightArr.length > 0) {
          const w = weightArr[0];
          weightValue = parseFloat(w?.value ?? "0") || null;
          weightUnit = w?.unit ?? null;
        }

        // Dimensions
        const dimArr = attrs.item_package_dimensions ?? attrs.item_dimensions;
        if (dimArr) {
          const extractDim = (key: string): number | null => {
            const val = (dimArr as any)[key];
            if (Array.isArray(val) && val.length > 0) {
              return parseFloat(val[0]?.value ?? "0") || null;
            }
            if (val?.value) return parseFloat(val.value) || null;
            return null;
          };

          dimLength =
            extractDim("length") ??
            (Array.isArray(dimArr) && dimArr[0]?.length?.value
              ? parseFloat(dimArr[0].length.value)
              : null);
          dimWidth =
            extractDim("width") ??
            (Array.isArray(dimArr) && dimArr[0]?.width?.value
              ? parseFloat(dimArr[0].width.value)
              : null);
          dimHeight =
            extractDim("height") ??
            (Array.isArray(dimArr) && dimArr[0]?.height?.value
              ? parseFloat(dimArr[0].height.value)
              : null);
          dimUnit =
            (Array.isArray(dimArr) && dimArr[0]?.length?.unit) ??
            (dimArr as any)?.unit ??
            null;
        }
      }

      // ── Identifiers ──
      const identifiers = listingRes?.identifiers;
      if (Array.isArray(identifiers)) {
        for (const group of identifiers) {
          const ids = group?.identifiers ?? [];
          for (const id of ids) {
            const idType: string = id?.identifierType ?? "";
            const idVal: string = id?.identifier ?? "";
            if (idType === "UPC" && idVal) upc = idVal;
            if (idType === "EAN" && idVal) ean = idVal;
          }
        }
      }

      // ── Images ──
      const imgData = listingRes?.images;
      if (Array.isArray(imgData)) {
        images = imgData.map((img: any, idx: number) => ({
          url: img?.link ?? img?.url ?? "",
          alt: img?.variant ?? null,
          type: (idx === 0 ? "MAIN" : "ALT") as "MAIN" | "ALT" | "LIFESTYLE",
        }));
      }

      // ── Offers (price & quantity) ──
      const offers = listingRes?.offers;
      if (Array.isArray(offers) && offers.length > 0) {
        const offer = offers[0];
        price =
          parseFloat(offer?.buyingPrice?.listingPrice?.amount ?? "0") || null;
        quantity = parseInt(offer?.quantity ?? "0", 10) || null;
      }

      console.log(
        `[Amazon] Listings item fetched for SKU "${sku}" (ASIN: ${asin})`
      );
    } catch (error) {
      console.error(
        `[Amazon] getListingsItem failed for SKU "${sku}":`,
        extractErrorMessage(error)
      );
      if ((error as any)?.body) {
        console.error(
          "[Amazon] Full error body:",
          JSON.stringify((error as any).body, null, 2)
        );
      }
    }

    /* ── Catalog Items API (fallback / enrichment) ──────────── */
    if (asin) {
      try {
        console.log(
          `[Amazon] Enriching via Catalog Items API for ASIN "${asin}"…`
        );

        const catalogRes: any = await (sp as any).callAPI({
          operation: "getCatalogItem",
          endpoint: "catalogItems",
          version: "2022-04-01",
          path: { asin },
          query: {
            marketplaceIds: [marketplaceId],
            includedData: [
              "summaries",
              "attributes",
              "dimensions",
              "identifiers",
              "images",
            ],
          },
        });

        // ── Summaries fallback ──
        const catSummaries = catalogRes?.summaries;
        if (Array.isArray(catSummaries) && catSummaries.length > 0) {
          const s: any = catSummaries[0];
          if (!title) title = s?.itemName ?? "";
          if (!brand) brand = s?.brand ?? null;
          if (!manufacturer) manufacturer = s?.manufacturer ?? null;
        }

        // ── Images fallback ──
        if (images.length === 0) {
          const catImages = catalogRes?.images;
          if (Array.isArray(catImages) && catImages.length > 0) {
            const imgSet = catImages[0]?.images ?? catImages;
            if (Array.isArray(imgSet)) {
              images = imgSet.map((img: any, idx: number) => ({
                url: img?.link ?? img?.url ?? "",
                alt: img?.variant ?? null,
                type: (idx === 0 ? "MAIN" : "ALT") as
                  | "MAIN"
                  | "ALT"
                  | "LIFESTYLE",
              }));
            }
          }
        }

        // ── Dimensions fallback ──
        if (dimLength === null) {
          const catDims = catalogRes?.dimensions;
          if (Array.isArray(catDims) && catDims.length > 0) {
            const d: any = catDims[0]?.package ?? catDims[0]?.item;
            if (d) {
              dimLength = parseFloat(d?.length?.value ?? "0") || null;
              dimWidth = parseFloat(d?.width?.value ?? "0") || null;
              dimHeight = parseFloat(d?.height?.value ?? "0") || null;
              dimUnit = d?.length?.unit ?? null;
            }
          }
        }

        // ── Weight fallback ──
        if (weightValue === null) {
          const catDims = catalogRes?.dimensions;
          if (Array.isArray(catDims) && catDims.length > 0) {
            const w: any =
              catDims[0]?.package?.weight ?? catDims[0]?.item?.weight;
            if (w) {
              weightValue = parseFloat(w?.value ?? "0") || null;
              weightUnit = w?.unit ?? null;
            }
          }
        }

        // ── Identifiers fallback ──
        if (!upc || !ean) {
          const catIds = catalogRes?.identifiers;
          if (Array.isArray(catIds)) {
            for (const group of catIds) {
              const ids = group?.identifiers ?? [];
              for (const id of ids) {
                const idType: string = id?.identifierType ?? "";
                const idVal: string = id?.identifier ?? "";
                if (idType === "UPC" && idVal && !upc) upc = idVal;
                if (idType === "EAN" && idVal && !ean) ean = idVal;
              }
            }
          }
        }

        console.log(
          `[Amazon] Catalog enrichment complete for ASIN "${asin}".`
        );
      } catch (error) {
        console.error(
          `[Amazon] getCatalogItem failed for ASIN "${asin}":`,
          extractErrorMessage(error)
        );
        if ((error as any)?.body) {
          console.error(
            "[Amazon] Full error body:",
            JSON.stringify((error as any).body, null, 2)
          );
        }
        // Non-fatal — we still have data from the Listings API
      }
    }

    return {
      sku,
      asin,
      title,
      brand,
      manufacturer,
      bulletPoints,
      description,
      upc,
      ean,
      weightValue,
      weightUnit,
      dimLength,
      dimWidth,
      dimHeight,
      dimUnit,
      images,
      keywords,
      price,
      quantity,
    };
  }

  /**
   * Update the price of a variant on Amazon
   * @param asin The ASIN of the variant to update
   * @param newPrice The new price to set
   */
  async updateVariantPrice(asin: string, newPrice: number): Promise<void> {
    const marketplaceId =
      process.env.AMAZON_MARKETPLACE_ID ?? "APJ6JRA9NG5V4";
    const currency = getCurrencyForMarketplace(marketplaceId);

    try {
      console.log(
        `[AmazonService] Updating price for ASIN ${asin} to ${newPrice.toFixed(2)} ${currency}…`
      );

      const sp = await this.getClient();

      const response = await sp.callAPI({
        operation: "updatePricing",
        endpoint: "productPricing",
        body: {
          pricelist: [
            {
              asin,
              standardPrice: {
                currency,
                amount: newPrice.toFixed(2),
              },
            },
          ],
        },
      });

      if (response.errors && response.errors.length > 0) {
        throw new Error(
          `Failed to update Amazon price: ${response.errors[0].message}`
        );
      }

      console.log(
        `[AmazonService] ✓ Updated price for ASIN ${asin} to ${newPrice.toFixed(2)} ${currency}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[AmazonService] ✗ Failed to update variant price for ${asin}:`,
        message
      );
      throw error;
    }
  }

  /* ────────────────────────────────────────────────────────────── */
  /*  fetchOrders                                                   */
  /* ────────────────────────────────────────────────────────────── */

  /**
   * Fetch orders from SP-API Orders v0.
   *
   * Supports two cursor modes (mutually exclusive):
   *   - `options.since`     → incremental poll (uses `LastUpdatedAfter`)
   *   - `options.daysBack`  → initial backfill (uses `CreatedAfter`)
   *
   * Pagination is handled internally via `NextToken` until either:
   *   - Amazon returns no NextToken, or
   *   - the running total reaches `options.limit` (default 1000).
   *
   * Amazon's getOrders enforces a 60-second minimum cursor — passing
   * `since` < 60s ago raises InvalidInput. The caller should clamp.
   *
   * Returns raw payloads; mapping to the Phase-26 `Order` schema lives
   * in `amazon-orders.service.ts`.
   */
  async fetchOrders(options: FetchOrdersOptions = {}): Promise<AmazonOrderRaw[]> {
    const sp = await this.getClient()
    const marketplaceId =
      options.marketplaceId ??
      process.env.AMAZON_MARKETPLACE_ID ??
      'APJ6JRA9NG5V4'
    const limit = options.limit ?? 1000

    // Build the query — exactly one of CreatedAfter / LastUpdatedAfter.
    // SP-API docs: at least one of CreatedAfter or LastUpdatedAfter is required.
    const query: Record<string, unknown> = {
      MarketplaceIds: [marketplaceId],
      MaxResultsPerPage: 100, // SP-API max
    }
    if (options.since) {
      // Clamp to 60s ago to avoid InvalidInput.
      const minAgo = new Date(Date.now() - 60_000)
      const cursor = options.since.getTime() > minAgo.getTime() ? minAgo : options.since
      query.LastUpdatedAfter = cursor.toISOString()
    } else {
      const days = options.daysBack ?? 30
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      query.CreatedAfter = cutoff.toISOString()
    }

    const collected: AmazonOrderRaw[] = []
    let nextToken: string | undefined

    while (true) {
      try {
        const callQuery: Record<string, unknown> = nextToken
          ? { MarketplaceIds: [marketplaceId], NextToken: nextToken }
          : query

        const res: any = await sp.callAPI({
          operation: 'getOrders',
          endpoint: 'orders',
          query: callQuery,
        })

        const payload = res?.payload ?? res
        const orders: AmazonOrderRaw[] = payload?.Orders ?? []
        collected.push(...orders)

        if (collected.length >= limit) {
          return collected.slice(0, limit)
        }

        nextToken = payload?.NextToken
        if (!nextToken) {
          return collected
        }

        // Be a polite citizen — getOrders is rate-limited to 0.0167 req/s
        // burst 20. The library throttles for us when auto_request_throttled
        // is on, but a small pause keeps log noise down.
        await sleep(250)
      } catch (error) {
        console.error(
          '[Amazon] fetchOrders failed:',
          extractErrorMessage(error)
        )
        throw error
      }
    }
  }

  /* ────────────────────────────────────────────────────────────── */
  /*  fetchFBAInventory                                             */
  /* ────────────────────────────────────────────────────────────── */

  /**
   * Fetch real-time FBA inventory via SP-API getInventorySummaries.
   *
   * Two callers:
   *   - The /api/amazon/inventory/sync route (manual)
   *   - The 15-min amazon-inventory-sync.job cron
   *
   * Coverage caveat: this endpoint ONLY returns FBA-managed inventory.
   * MFN/FBM SKUs are absent from the response — the caller MUST treat
   * "absent" as "no information" (NOT zero), so MFN stock numbers are
   * preserved by the cron. Sellers running mixed FBA+FBM cannot infer
   * total stock from this endpoint alone; the catalog refresh report
   * (GET_MERCHANT_LISTINGS_ALL_DATA) carries MFN numbers.
   *
   * Multi-condition handling: if a SKU has rows for multiple conditions
   * (e.g. New + Used), we SUM the quantities. Most sellers run "New"
   * only; the SUM is the safe default — better to overstate by a few
   * than starve a listing.
   *
   * Pagination via nextToken (camelCase, unlike Orders V0). Library
   * throttles for us; a 250 ms pause keeps log noise down.
   */
  async fetchFBAInventory(
    options: { marketplaceId?: string; sellerSkus?: string[] } = {},
  ): Promise<FBAInventoryRow[]> {
    const sp = await this.getClient()
    const marketplaceId =
      options.marketplaceId ??
      process.env.AMAZON_MARKETPLACE_ID ??
      'APJ6JRA9NG5V4'

    const baseQuery: Record<string, unknown> = {
      details: true,
      granularityType: 'Marketplace',
      granularityId: marketplaceId,
      marketplaceIds: [marketplaceId],
    }
    if (options.sellerSkus && options.sellerSkus.length > 0) {
      // SP-API caps sellerSkus per request at 50; caller is responsible
      // for chunking if they want more than that.
      baseQuery.sellerSkus = options.sellerSkus.slice(0, 50)
    }

    // Group by SKU as we paginate so multi-condition rows for the same
    // SKU can be summed in one pass.
    const bySku = new Map<string, FBAInventoryRow>()
    let nextToken: string | undefined

    while (true) {
      try {
        const callQuery: Record<string, unknown> = nextToken
          ? { ...baseQuery, nextToken }
          : baseQuery

        const res: any = await (sp as any).callAPI({
          operation: 'getInventorySummaries',
          endpoint: 'fbaInventory',
          query: callQuery,
        })

        const payload = res?.payload ?? res
        const summaries = payload?.inventorySummaries ?? []

        for (const s of summaries as Array<{
          sellerSku?: string
          asin?: string
          fnSku?: string
          totalQuantity?: number
          lastUpdatedTime?: string
          inventoryDetails?: {
            fulfillableQuantity?: number
            inboundWorkingQuantity?: number
            inboundShippedQuantity?: number
            inboundReceivingQuantity?: number
            unfulfillableQuantity?: { totalUnfulfillableQuantity?: number } | number
            reservedQuantity?: { totalReservedQuantity?: number }
          }
        }>) {
          if (!s.sellerSku) continue
          const det = s.inventoryDetails ?? {}
          const fulfillable = det.fulfillableQuantity ?? 0
          const inbound =
            (det.inboundWorkingQuantity ?? 0) +
            (det.inboundShippedQuantity ?? 0) +
            (det.inboundReceivingQuantity ?? 0)
          const reserved = det.reservedQuantity?.totalReservedQuantity ?? 0
          // unfulfillableQuantity in the SP-API model is sometimes an
          // object with totalUnfulfillableQuantity, sometimes a number.
          // Normalize.
          const unfulfillable =
            typeof det.unfulfillableQuantity === 'object'
              ? det.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0
              : (det.unfulfillableQuantity as number | undefined) ?? 0

          const existing = bySku.get(s.sellerSku)
          if (existing) {
            existing.fulfillableQuantity += fulfillable
            existing.inboundQuantity += inbound
            existing.reservedQuantity += reserved
            existing.unfulfillableQuantity += unfulfillable
            existing.totalQuantity += s.totalQuantity ?? 0
            // Keep the most recent lastUpdatedTime
            if (
              s.lastUpdatedTime &&
              (!existing.lastUpdatedTime ||
                s.lastUpdatedTime > existing.lastUpdatedTime)
            ) {
              existing.lastUpdatedTime = s.lastUpdatedTime
            }
          } else {
            bySku.set(s.sellerSku, {
              sku: s.sellerSku,
              asin: s.asin ?? null,
              fnsku: s.fnSku ?? null,
              fulfillableQuantity: fulfillable,
              inboundQuantity: inbound,
              reservedQuantity: reserved,
              unfulfillableQuantity: unfulfillable,
              totalQuantity: s.totalQuantity ?? 0,
              lastUpdatedTime: s.lastUpdatedTime ?? null,
            })
          }
        }

        nextToken = payload?.nextToken
        if (!nextToken) {
          return Array.from(bySku.values())
        }
        await sleep(250)
      } catch (error) {
        console.error(
          '[Amazon] fetchFBAInventory failed:',
          extractErrorMessage(error),
        )
        throw error
      }
    }
  }

  /**
   * Fetch line items for a single order. SP-API getOrderItems is
   * paginated separately from getOrders and uses its own NextToken.
   * Order item arrays are usually small (<10) — pagination only kicks
   * in for bulk B2B shipments.
   */
  async fetchOrderItems(amazonOrderId: string): Promise<AmazonOrderItemRaw[]> {
    const sp = await this.getClient()
    const collected: AmazonOrderItemRaw[] = []
    let nextToken: string | undefined

    while (true) {
      try {
        const res: any = await sp.callAPI({
          operation: 'getOrderItems',
          endpoint: 'orders',
          path: { orderId: amazonOrderId },
          query: nextToken ? { nextToken } : undefined,
        })

        const payload = res?.payload ?? res
        const items: AmazonOrderItemRaw[] = payload?.OrderItems ?? []
        collected.push(...items)

        nextToken = payload?.NextToken
        if (!nextToken) {
          return collected
        }
        await sleep(250)
      } catch (error) {
        console.error(
          `[Amazon] fetchOrderItems failed for ${amazonOrderId}:`,
          extractErrorMessage(error)
        )
        throw error
      }
    }
  }

  /* ────────────────────────────────────────────────────────────── */
  /*  S.0 / C-3 — getListingState                                   */
  /*  Minimal primitive used by the /api/listings/:id/resync inline */
  /*  pull path. Distinct from fetchProductDetails which is a full  */
  /*  catalog import (title/brand/dims/identifiers/images). Resync  */
  /*  only needs the live state fields a marketplace might have     */
  /*  drifted on: price, quantity, listingStatus, title.            */
  /*                                                                */
  /*  Unlike fetchProductDetails, this takes an explicit            */
  /*  marketplaceId (SP-API ID like A1RKKUPIHCS9HS) — Resync hits   */
  /*  one specific marketplace per call, not whatever              */
  /*  AMAZON_MARKETPLACE_ID happens to be set to in env.            */
  /* ────────────────────────────────────────────────────────────── */
  async getListingState(
    sku: string,
    marketplaceId: string,
  ): Promise<{
    price: number | null
    quantity: number | null
    listingStatus: string | null
    title: string | null
    asin: string | null
  }> {
    const sellerId =
      process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
    if (!sellerId) {
      throw new Error(
        'AMAZON_SELLER_ID (or AMAZON_MERCHANT_ID) env var not set; cannot call getListingsItem.',
      )
    }

    const sp = await this.getClient()
    const res: any = await sp.callAPI({
      operation: 'getListingsItem',
      endpoint: 'listingsItems',
      path: { sellerId, sku },
      query: {
        marketplaceIds: [marketplaceId],
        includedData: ['summaries', 'attributes', 'offers'],
      },
    })

    const summaries = res?.summaries
    const summary =
      Array.isArray(summaries) && summaries.length > 0 ? summaries[0] : null

    // Listing status surfaces under different keys on different SP-API
    // shapes. `status` carries a string array (e.g. ['BUYABLE']) on
    // recent versions; older shapes use itemStatus. Default to null
    // rather than guessing — the route will leave the field unchanged
    // if the marketplace doesn't return it.
    const rawStatus =
      (Array.isArray(summary?.status) ? summary.status[0] : summary?.status) ??
      summary?.itemStatus ??
      null

    let price: number | null = null
    let quantity: number | null = null
    const offers = res?.offers
    if (Array.isArray(offers) && offers.length > 0) {
      const offer = offers[0]
      const amount = offer?.buyingPrice?.listingPrice?.amount
      const parsedPrice = amount != null ? parseFloat(amount) : NaN
      price = Number.isFinite(parsedPrice) ? parsedPrice : null
      const parsedQty = parseInt(offer?.quantity ?? '', 10)
      quantity = Number.isFinite(parsedQty) ? parsedQty : null
    }

    return {
      price,
      quantity,
      listingStatus: typeof rawStatus === 'string' ? rawStatus : null,
      title: typeof summary?.itemName === 'string' ? summary.itemName : null,
      asin: typeof res?.asin === 'string' ? res.asin : null,
    }
  }

  /**
   * GTIN.2 — infer brand-level GTIN exemption from existing Amazon
   * listings for the seller. Amazon doesn't expose a "do I have GTIN
   * exemption" endpoint cleanly; the strongest available signal is
   * "this seller has an active listing under this brand without a
   * GTIN," because Amazon would have rejected the listing creation
   * if the brand wasn't exempt.
   *
   * Picks one ACTIVE Amazon ChannelListing for the brand from local
   * DB, calls getListingsItem on its SKU, and inspects the
   * `attributes.gtin` + `externally_assigned_product_identifier`
   * keys. Absence implies exemption.
   *
   * Returns:
   *   - inferred: 'exempt' when the listing has no GTIN attribute
   *   - inferred: 'not_exempt' when a GTIN is present
   *   - inferred: 'unknown' when no listings exist for the brand,
   *     SP-API isn't configured, or the call fails
   *
   * Cached in-process for 5 minutes per (brand, marketplaceId) to
   * avoid burning rate limits on every wizard mount.
   */
  async inferBrandGtinExemption(
    brand: string,
    countryCode: string,
  ): Promise<{
    inferred: 'exempt' | 'not_exempt' | 'unknown'
    evidenceSku?: string
    evidenceAsin?: string
    reason: string
  }> {
    const trimmedBrand = brand.trim()
    const cc = countryCode.trim().toUpperCase()
    if (!trimmedBrand || !cc) {
      return { inferred: 'unknown', reason: 'brand and country required' }
    }
    if (!this.isConfigured()) {
      return { inferred: 'unknown', reason: 'SP-API not configured' }
    }
    const cacheKey = `${trimmedBrand}|${cc}`
    const cached = AmazonService._exemptionCache.get(cacheKey)
    if (cached && Date.now() - cached.at < AmazonService.EXEMPTION_TTL_MS) {
      return cached.value
    }
    // Country code → SP-API marketplaceId. The map mirrors the one in
    // tracking-pushback.job; lifting both into a shared module is
    // tracked in TECH_DEBT but not blocking this fix.
    const marketplaceId = AmazonService._countryToMarketplace[cc]
    if (!marketplaceId) {
      const value = {
        inferred: 'unknown' as const,
        reason: `no SP-API marketplaceId for country ${cc}`,
      }
      AmazonService._exemptionCache.set(cacheKey, { at: Date.now(), value })
      return value
    }
    // Lazy require to avoid a circular import — prisma client is a
    // sibling concern to the SP-API client class.
    const prismaMod = await import('../../db.js')
    const prisma = prismaMod.default
    const listing = await prisma.channelListing.findFirst({
      where: {
        channel: 'AMAZON',
        marketplace: cc,
        listingStatus: 'ACTIVE',
        product: { brand: trimmedBrand },
      },
      include: {
        product: { select: { sku: true } },
      },
    })
    if (!listing || !listing.product?.sku) {
      const value = {
        inferred: 'unknown' as const,
        reason: 'no existing Amazon listings under this brand',
      }
      AmazonService._exemptionCache.set(cacheKey, { at: Date.now(), value })
      return value
    }
    const evidenceSku = listing.product.sku
    let res: any
    try {
      const sp = await this.getClient()
      res = await sp.callAPI({
        operation: 'getListingsItem',
        endpoint: 'listingsItems',
        path: { sellerId: process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? '', sku: evidenceSku },
        query: {
          marketplaceIds: [marketplaceId],
          includedData: ['summaries', 'attributes', 'identifiers'],
        },
      })
    } catch (err) {
      // SP-API failure — return unknown but don't cache the failure
      // for the full TTL; let the next wizard mount retry.
      return {
        inferred: 'unknown',
        reason: `SP-API getListingsItem failed: ${
          err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
        }`,
      }
    }
    // Inspect the listing for GTIN absence. SP-API responses use a
    // few different shapes across marketplace versions; we check both
    // attributes.gtin and identifiers[].identifierType === 'GTIN'.
    const attrs = res?.attributes ?? {}
    const hasGtinAttr =
      Array.isArray(attrs.gtin) && attrs.gtin.length > 0 && attrs.gtin[0]?.value
    const identifiers = res?.identifiers
    let hasGtinIdentifier = false
    if (Array.isArray(identifiers)) {
      for (const block of identifiers) {
        const codes = block?.identifiers
        if (!Array.isArray(codes)) continue
        if (codes.some((c: any) => c?.identifierType?.toString().toUpperCase().includes('GTIN'))) {
          hasGtinIdentifier = true
          break
        }
      }
    }
    const summary = Array.isArray(res?.summaries) ? res.summaries[0] : null
    const asin = typeof res?.asin === 'string' ? res.asin : summary?.asin
    let value: {
      inferred: 'exempt' | 'not_exempt' | 'unknown'
      evidenceSku?: string
      evidenceAsin?: string
      reason: string
    }
    if (!hasGtinAttr && !hasGtinIdentifier) {
      value = {
        inferred: 'exempt',
        evidenceSku: evidenceSku,
        evidenceAsin: typeof asin === 'string' ? asin : undefined,
        reason: 'existing listing accepted by Amazon without a GTIN',
      }
    } else {
      value = {
        inferred: 'not_exempt',
        evidenceSku: evidenceSku,
        evidenceAsin: typeof asin === 'string' ? asin : undefined,
        reason: 'existing listing carries a GTIN — exemption not required / not granted',
      }
    }
    AmazonService._exemptionCache.set(cacheKey, { at: Date.now(), value })
    return value
  }

  // ── GTIN.2 — in-process exemption-inference cache ────────────
  private static _exemptionCache = new Map<
    string,
    {
      at: number
      value: {
        inferred: 'exempt' | 'not_exempt' | 'unknown'
        evidenceSku?: string
        evidenceAsin?: string
        reason: string
      }
    }
  >()
  private static EXEMPTION_TTL_MS = 5 * 60 * 1000
  private static _countryToMarketplace: Record<string, string> = {
    IT: 'APJ6JRA9NG5V4',
    DE: 'A1PA6795UKMFR9',
    FR: 'A13V1IB3VIYZZH',
    ES: 'A1RKKUPIHCS9HS',
    UK: 'A1F83G8C2ARO7P',
    GB: 'A1F83G8C2ARO7P',
    NL: 'A1805IZSGTT6HS',
    SE: 'A2NODRKZP88ZB9',
    PL: 'A1C3SOZRARQ6R3',
    US: 'ATVPDKIKX0DER',
  }

  /**
   * Pull financial events for a date window from /finances/v0/financialEvents.
   * Returns the raw FinancialEvents payload. Handles NextToken pagination.
   * Rate limit: 0.5 req/s — caller must sleep between chunks.
   */
  async fetchFinancialEvents(postedAfter: Date, postedBefore: Date): Promise<FinancialEventsPayload> {
    const sp = await this.getClient()
    const allOrderEvents: AmazonOrderFinancialEvent[] = []
    const allRefundEvents: AmazonRefundEvent[] = []
    const allServiceFeeEvents: AmazonServiceFeeEvent[] = []
    let nextToken: string | undefined

    do {
      const res: any = await sp.callAPI({
        operation: 'listFinancialEvents',
        endpoint: 'finances',
        query: {
          PostedAfter: postedAfter.toISOString(),
          PostedBefore: postedBefore.toISOString(),
          MaxResultsPerPage: 100,
          ...(nextToken ? { NextToken: nextToken } : {}),
        },
      })

      const fe = res?.FinancialEvents ?? {}
      if (Array.isArray(fe.OrderFinancialEventList)) allOrderEvents.push(...fe.OrderFinancialEventList)
      if (Array.isArray(fe.RefundEventList)) allRefundEvents.push(...fe.RefundEventList)
      if (Array.isArray(fe.ServiceFeeEventList)) allServiceFeeEvents.push(...fe.ServiceFeeEventList)
      nextToken = res?.NextToken ?? undefined

      if (nextToken) await sleep(2100)
    } while (nextToken)

    return { orderEvents: allOrderEvents, refundEvents: allRefundEvents, serviceFeeEvents: allServiceFeeEvents }
  }

  /**
   * Pull financial events for a single order from /finances/v0/orders/{orderId}/financialEvents.
   * Used for targeted backfill when we have the Amazon order ID.
   */
  async fetchFinancialEventsByOrderId(amazonOrderId: string): Promise<AmazonOrderFinancialEvent | null> {
    const sp = await this.getClient()
    try {
      const res: any = await sp.callAPI({
        operation: 'listFinancialEventsByOrderId',
        endpoint: 'finances',
        path: { orderId: amazonOrderId },
      })
      const events = res?.FinancialEvents?.OrderFinancialEventList ?? []
      return events[0] ?? null
    } catch (err) {
      console.warn('[amazon] fetchFinancialEventsByOrderId failed', amazonOrderId, err instanceof Error ? err.message : String(err))
      return null
    }
  }
}
