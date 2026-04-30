import { SellingPartner } from "amazon-sp-api";
import { parse } from "csv-parse/sync";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

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
  async fetchActiveCatalog(): Promise<CatalogItem[]> {
    try {
      console.log("[Amazon] Requesting GET_MERCHANT_LISTINGS_ALL_DATA report…");

      const sp = await this.getClient();

      // Step 1 — Create the report
      const createRes: any = await sp.callAPI({
        operation: "createReport",
        endpoint: "reports",
        body: {
          reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
          marketplaceIds: [
            process.env.AMAZON_MARKETPLACE_ID ?? "APJ6JRA9NG5V4", // Italy default
          ],
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
}
