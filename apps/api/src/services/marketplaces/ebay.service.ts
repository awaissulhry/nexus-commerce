import type { EbayListingData } from "../ai/gemini.service.js";
import { recordApiCall } from "../outbound-api-call-log.service.js";

const EBAY_API_BASE = process.env.EBAY_API_BASE ?? "https://api.ebay.com";
const EBAY_AUTH_URL = process.env.EBAY_AUTH_URL ?? "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID ?? "EBAY_IT";
const EBAY_CURRENCY = process.env.EBAY_CURRENCY ?? "EUR";
const EBAY_MERCHANT_LOCATION_KEY = process.env.EBAY_MERCHANT_LOCATION_KEY ?? "xavia-riccione-warehouse";

interface EbayTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface EbayOfferResponse {
  offerId: string;
}

interface EbayGetOffersResponse {
  offers: Array<{
    offerId: string;
    sku: string;
    pricingSummary: {
      price: {
        value: string;
        currency: string;
      };
    };
    [key: string]: unknown;
  }>;
}

interface EbayPublishResponse {
  listingId: string;
}

export class EbayService {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  /**
   * Fetches an OAuth2 access token from eBay using the client_credentials grant.
   * Caches the token until it expires.
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }

    const appId = process.env.EBAY_APP_ID;
    const certId = process.env.EBAY_CERT_ID;

    if (!appId || !certId) {
      throw new Error(
        "EBAY_APP_ID and EBAY_CERT_ID environment variables must be set"
      );
    }

    const credentials = Buffer.from(`${appId}:${certId}`).toString("base64");

    try {
      const data = await recordApiCall<EbayTokenResponse>(
        {
          channel: 'EBAY',
          operation: 'clientCredentialsToken',
          endpoint: '/identity/v1/oauth2/token',
          method: 'POST',
          triggeredBy: 'api',
        },
        async () => {
          const response = await fetch(EBAY_AUTH_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: `Basic ${credentials}`,
            },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              scope: "https://api.ebay.com/oauth/api_scope",
            }).toString(),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            const err = new Error(
              `eBay OAuth token request failed (${response.status}): ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = response.status;
            err.body = errorBody;
            throw err;
          }

          return (await response.json()) as EbayTokenResponse;
        },
      );
      this.cachedToken = data.access_token;
      this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

      return this.cachedToken;
    } catch (error) {
      console.error("[EbayService] Failed to obtain access token:", error);
      throw error;
    }
  }

  /**
   * Updates the available quantity for an existing inventory item on eBay.
   */
  async updateInventory(sku: string, quantity: number): Promise<void> {
    const token = await this.getAccessToken();
    const url = `${EBAY_API_BASE}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;

    try {
      // First, GET the current inventory item to preserve existing data.
      // Use a separate try so a missing item (404) doesn't bubble — we
      // still want to PUT the new payload below. recordApiCall logs the
      // failure separately.
      let existingItem: Record<string, unknown> = {};
      try {
        existingItem = await recordApiCall<Record<string, unknown>>(
          {
            channel: 'EBAY',
            operation: 'getInventoryItem',
            endpoint: '/sell/inventory/v1/inventory_item',
            method: 'GET',
            marketplace: EBAY_MARKETPLACE_ID,
            triggeredBy: 'api',
          },
          async () => {
            const getResponse = await fetch(url, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            });
            if (!getResponse.ok) {
              const errorBody = await getResponse.text().catch(() => "");
              const err = new Error(
                `eBay API error ${getResponse.status}: ${errorBody.slice(0, 500)}`,
              ) as Error & { statusCode: number; body: string };
              err.statusCode = getResponse.status;
              err.body = errorBody;
              throw err;
            }
            return (await getResponse.json()) as Record<string, unknown>;
          },
        );
      } catch {
        // Missing inventory item is fine — we'll create on the PUT below.
        existingItem = {};
      }

      // Update the availability with the new quantity
      const payload = {
        ...existingItem,
        availability: {
          shipToLocationAvailability: {
            quantity,
          },
        },
      };

      await recordApiCall<void>(
        {
          channel: 'EBAY',
          operation: 'createOrReplaceInventoryItem',
          endpoint: '/sell/inventory/v1/inventory_item',
          method: 'PUT',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const putResponse = await fetch(url, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Language": "en-US",
            },
            body: JSON.stringify(payload),
          });

          if (!putResponse.ok) {
            const errorBody = await putResponse.text().catch(() => "");
            const err = new Error(
              `eBay inventory update failed for SKU "${sku}" (${putResponse.status}): ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = putResponse.status;
            err.body = errorBody;
            throw err;
          }
        },
      );

      console.log(
        `[EbayService] Inventory updated: SKU=${sku}, quantity=${quantity}`
      );
    } catch (error) {
      console.error(
        `[EbayService] Failed to update inventory for SKU "${sku}":`,
        error
      );
      throw error;
    }
  }

  /**
   * Updates the price of an existing eBay offer for a given SKU.
   * Finds the active offer by SKU, then updates its pricing.
   */
  async updatePrice(sku: string, newPrice: number): Promise<void> {
    const token = await this.getAccessToken();

    try {
      // Step 1: Find the offer for this SKU
      const offersUrl = `${EBAY_API_BASE}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`;

      const offersData = await recordApiCall<EbayGetOffersResponse>(
        {
          channel: 'EBAY',
          operation: 'getOffers',
          endpoint: '/sell/inventory/v1/offer',
          method: 'GET',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const offersResponse = await fetch(offersUrl, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          });

          if (!offersResponse.ok) {
            const errorBody = await offersResponse.text().catch(() => "");
            const err = new Error(
              `eBay get offers failed for SKU "${sku}" (${offersResponse.status}): ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = offersResponse.status;
            err.body = errorBody;
            throw err;
          }

          return (await offersResponse.json()) as EbayGetOffersResponse;
        },
      );

      if (!offersData.offers || offersData.offers.length === 0) {
        throw new Error(`No eBay offers found for SKU "${sku}"`);
      }

      // Use the first offer (typically one offer per SKU)
      const offer = offersData.offers[0];
      const offerId = offer.offerId;

      // Step 2: Update the offer with the new price
      const updateUrl = `${EBAY_API_BASE}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;

      // Build the updated offer payload — preserve existing fields, update price
      const updatePayload = {
        ...offer,
        pricingSummary: {
          price: {
            value: newPrice.toFixed(2),
            currency: EBAY_CURRENCY,
          },
        },
      };

      await recordApiCall<void>(
        {
          channel: 'EBAY',
          operation: 'updateOffer',
          endpoint: '/sell/inventory/v1/offer',
          method: 'PUT',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const updateResponse = await fetch(updateUrl, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Language": "en-US",
            },
            body: JSON.stringify(updatePayload),
          });

          if (!updateResponse.ok) {
            const errorBody = await updateResponse.text().catch(() => "");
            const err = new Error(
              `eBay update offer price failed for SKU "${sku}" offerId "${offerId}" (${updateResponse.status}): ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = updateResponse.status;
            err.body = errorBody;
            throw err;
          }
        },
      );

      console.log(
        `[EbayService] Price updated: SKU=${sku}, offerId=${offerId}, newPrice=${newPrice.toFixed(2)} ${EBAY_CURRENCY}`
      );
    } catch (error) {
      console.error(
        `[EbayService] Failed to update price for SKU "${sku}":`,
        error
      );
      throw error;
    }
  }

  /**
   * Publishes a new listing on eBay by:
   * 1. Creating/updating the Inventory Item
   * 2. Creating an Offer
   * 3. Publishing the Offer
   *
   * Returns the eBay listing ID.
   */
  async publishNewListing(
    sku: string,
    ebayData: EbayListingData,
    price: number,
    quantity: number
  ): Promise<string> {
    const token = await this.getAccessToken();

    // Step 0: Ensure merchant location is configured
    await this.ensureMerchantLocation();

    // Step 1: Create / update the Inventory Item
    await this.createInventoryItem(token, sku, ebayData, quantity);

    // Step 2: Create the Offer
    const offerId = await this.createOffer(token, sku, ebayData, price, quantity);

    // Step 3: Publish the Offer
    const listingId = await this.publishOffer(token, offerId);

    console.log(
      `[EbayService] Listing published: SKU=${sku}, offerId=${offerId}, listingId=${listingId}`
    );

    return listingId;
  }

  /**
   * Creates or replaces an inventory item on eBay.
   */
  private async createInventoryItem(
    token: string,
    sku: string,
    ebayData: EbayListingData,
    quantity: number
  ): Promise<void> {
    const url = `${EBAY_API_BASE}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;

    // Build item specifics as eBay expects them (name/value pairs)
    const aspects: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(ebayData.itemSpecifics)) {
      aspects[key] = [value];
    }

    const payload = {
      product: {
        title: ebayData.ebayTitle,
        description: ebayData.htmlDescription,
        aspects,
      },
      availability: {
        shipToLocationAvailability: {
          quantity,
        },
      },
      condition: "NEW",
    };

    try {
      await recordApiCall<void>(
        {
          channel: 'EBAY',
          operation: 'createInventoryItem',
          endpoint: '/sell/inventory/v1/inventory_item',
          method: 'PUT',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const response = await fetch(url, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Language": "en-US",
            },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            const err = new Error(
              `eBay create inventory item failed for SKU "${sku}" (${response.status}): ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = response.status;
            err.body = errorBody;
            throw err;
          }
        },
      );

      console.log(`[EbayService] Inventory item created/updated: SKU=${sku}`);
    } catch (error) {
      console.error(
        `[EbayService] Failed to create inventory item for SKU "${sku}":`,
        error
      );
      throw error;
    }
  }

  /**
   * Creates an offer for an existing inventory item.
   * Returns the offerId.
   */
  private async createOffer(
    token: string,
    sku: string,
    ebayData: EbayListingData,
    price: number,
    quantity: number
  ): Promise<string> {
    const url = `${EBAY_API_BASE}/sell/inventory/v1/offer`;

    const payload = {
      sku,
      marketplaceId: EBAY_MARKETPLACE_ID,
      format: "FIXED_PRICE",
      listingDescription: ebayData.htmlDescription,
      categoryId: ebayData.categoryId,
      availableQuantity: quantity,
      merchantLocationKey: EBAY_MERCHANT_LOCATION_KEY,
      pricingSummary: {
        price: {
          value: price.toFixed(2),
          currency: EBAY_CURRENCY,
        },
      },
      listingPolicies: {
        fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID ?? "",
        paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID ?? "",
        returnPolicyId: process.env.EBAY_RETURN_POLICY_ID ?? "",
      },
    };

    try {
      const data = await recordApiCall<EbayOfferResponse>(
        {
          channel: 'EBAY',
          operation: 'createOffer',
          endpoint: '/sell/inventory/v1/offer',
          method: 'POST',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Language": "en-US",
            },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            const err = new Error(
              `eBay create offer failed for SKU "${sku}" (${response.status}): ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = response.status;
            err.body = errorBody;
            throw err;
          }

          return (await response.json()) as EbayOfferResponse;
        },
      );

      console.log(
        `[EbayService] Offer created: SKU=${sku}, offerId=${data.offerId}`
      );

      return data.offerId;
    } catch (error) {
      console.error(
        `[EbayService] Failed to create offer for SKU "${sku}":`,
        error
      );
      throw error;
    }
  }

  /**
   * Ensures the merchant location is configured on eBay.
   * Idempotent: 204 if already exists, that's fine.
   */
  async ensureMerchantLocation(): Promise<void> {
    const token = await this.getAccessToken();
    const url = `${EBAY_API_BASE}/sell/inventory/v1/location/${encodeURIComponent(EBAY_MERCHANT_LOCATION_KEY)}`;

    const payload = {
      merchantLocationStatus: "ENABLED",
      locationTypes: ["WAREHOUSE"],
      location: {
        address: {
          country: "IT",
          city: "Riccione",
          stateOrProvince: "Emilia-Romagna",
          postalCode: process.env.EBAY_LOCATION_POSTAL_CODE ?? "47838",
          addressLine1: process.env.EBAY_LOCATION_ADDRESS ?? "",
        },
      },
    };

    try {
      await recordApiCall<void>(
        {
          channel: 'EBAY',
          operation: 'createInventoryLocation',
          endpoint: '/sell/inventory/v1/location',
          method: 'PUT',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const response = await fetch(url, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Language": "en-US",
            },
            body: JSON.stringify(payload),
          });

          // 204 No Content (already exists) or 200 OK (created/updated) are both fine
          if (response.status === 204 || response.status === 200) {
            return;
          }

          const errorBody = await response.text().catch(() => "");
          const err = new Error(
            `eBay ensure merchant location failed (${response.status}): ${errorBody.slice(0, 500)}`,
          ) as Error & { statusCode: number; body: string };
          err.statusCode = response.status;
          err.body = errorBody;
          throw err;
        },
      );
      console.log(
        `[EbayService] Merchant location ensured: ${EBAY_MERCHANT_LOCATION_KEY}`
      );
    } catch (error) {
      console.error(
        `[EbayService] Failed to ensure merchant location:`,
        error
      );
      throw error;
    }
  }

  /**
   * Publishes an existing offer, making it live on eBay.
   * Returns the eBay listing ID.
   */
  /**
   * Update the price of an existing eBay offer
   * @param variantSku The SKU of the variant to update
   * @param newPrice The new price to set
   */
  async updateVariantPrice(variantSku: string, newPrice: number): Promise<void> {
    try {
      const accessToken = await this.getAccessToken();

      // Find the inventory item by SKU
      const inventoryData = await recordApiCall<any>(
        {
          channel: 'EBAY',
          operation: 'listInventoryItems',
          endpoint: '/sell/inventory/v1/inventory',
          method: 'GET',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const inventoryResponse = await fetch(
            `${EBAY_API_BASE}/sell/inventory/v1/inventory`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            }
          );

          if (!inventoryResponse.ok) {
            const errorBody = await inventoryResponse.text().catch(() => "");
            const err = new Error(
              `Failed to fetch inventory items: ${inventoryResponse.statusText}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = inventoryResponse.status;
            err.body = errorBody;
            throw err;
          }

          return (await inventoryResponse.json()) as any;
        },
      );
      const inventoryItem = inventoryData.inventoryItems?.find(
        (item: any) => item.sku === variantSku
      );

      if (!inventoryItem) {
        throw new Error(`Inventory item not found for SKU: ${variantSku}`);
      }

      // Find the offer for this inventory item
      const offersData = await recordApiCall<any>(
        {
          channel: 'EBAY',
          operation: 'getOffers',
          endpoint: '/sell/inventory/v1/offer',
          method: 'GET',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const offersResponse = await fetch(
            `${EBAY_API_BASE}/sell/inventory/v1/offer?sku=${variantSku}`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            }
          );

          if (!offersResponse.ok) {
            const errorBody = await offersResponse.text().catch(() => "");
            const err = new Error(
              `Failed to fetch offers: ${offersResponse.statusText}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = offersResponse.status;
            err.body = errorBody;
            throw err;
          }

          return (await offersResponse.json()) as any;
        },
      );
      const offer = (offersData as any).offers?.[0];

      if (!offer) {
        throw new Error(`No active offer found for SKU: ${variantSku}`);
      }

      // Update the offer price
      await recordApiCall<void>(
        {
          channel: 'EBAY',
          operation: 'updateOffer',
          endpoint: '/sell/inventory/v1/offer',
          method: 'PATCH',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const updateResponse = await fetch(
            `${EBAY_API_BASE}/sell/inventory/v1/offer/${offer.offerId}`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                pricingSummary: {
                  price: {
                    currency: EBAY_CURRENCY,
                    value: newPrice.toFixed(2),
                  },
                },
              }),
            }
          );

          if (!updateResponse.ok) {
            const errorBody = await updateResponse.text().catch(() => "");
            let parsed: any = null;
            try { parsed = JSON.parse(errorBody); } catch { /* keep raw */ }
            const message =
              parsed?.message ?? updateResponse.statusText;
            const err = new Error(
              `Failed to update eBay price: ${message}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = updateResponse.status;
            err.body = errorBody;
            throw err;
          }
        },
      );

      console.log(`[EbayService] ✓ Updated price for SKU ${variantSku} to ${newPrice.toFixed(2)} ${EBAY_CURRENCY}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[EbayService] ✗ Failed to update variant price for ${variantSku}:`, message);
      throw error;
    }
  }

  private async publishOffer(
    token: string,
    offerId: string
  ): Promise<string> {
    const url = `${EBAY_API_BASE}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`;

    try {
      const data = await recordApiCall<EbayPublishResponse>(
        {
          channel: 'EBAY',
          operation: 'publishOffer',
          endpoint: '/sell/inventory/v1/offer/{offerId}/publish',
          method: 'POST',
          marketplace: EBAY_MARKETPLACE_ID,
          triggeredBy: 'api',
        },
        async () => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            const err = new Error(
              `eBay publish offer failed for offerId "${offerId}" (${response.status}): ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = response.status;
            err.body = errorBody;
            throw err;
          }

          return (await response.json()) as EbayPublishResponse;
        },
      );

      console.log(
        `[EbayService] Offer published: offerId=${offerId}, listingId=${data.listingId}`
      );

      return data.listingId;
    } catch (error) {
      console.error(
        `[EbayService] Failed to publish offer "${offerId}":`,
        error
      );
      throw error;
    }
  }
}
