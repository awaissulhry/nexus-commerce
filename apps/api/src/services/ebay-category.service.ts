/**
 * eBay Category Service
 * Resolves real eBay categories and aspects via the Taxonomy API
 * Includes in-memory caching by marketplace and category ID
 */

interface CategoryAspect {
  name: string;
  required: boolean;
  recommended: boolean;
}

interface CachedCategory {
  categoryId: string;
  categoryName: string;
  aspects: CategoryAspect[];
  timestamp: number;
}

const MARKETPLACE_TREE_IDS: Record<string, number> = {
  EBAY_IT: 101,
  EBAY_US: 0,
  EBAY_DE: 77,
  EBAY_FR: 71,
  EBAY_UK: 3,
};

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

export class EbayCategoryService {
  private cache: Map<string, CachedCategory> = new Map();
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  /**
   * Get a valid access token for Taxonomy API calls
   * Uses the same OAuth2 flow as EbayService
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const appId = process.env.EBAY_APP_ID;
    const certId = process.env.EBAY_CERT_ID;

    if (!appId || !certId) {
      throw new Error(
        "EBAY_APP_ID and EBAY_CERT_ID environment variables must be set"
      );
    }

    const credentials = Buffer.from(`${appId}:${certId}`).toString("base64");
    const authUrl = process.env.EBAY_AUTH_URL ?? "https://api.ebay.com/identity/v1/oauth2/token";

    try {
      const response = await fetch(authUrl, {
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
        const errorBody = await response.text();
        throw new Error(
          `eBay OAuth token request failed (${response.status}): ${errorBody}`
        );
      }

      const data = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };
      this.accessToken = data.access_token;
      this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

      return this.accessToken;
    } catch (error) {
      console.error("[EbayCategoryService] Failed to obtain access token:", error);
      throw error;
    }
  }

  /**
   * Get cache key for a category
   */
  private getCacheKey(marketplaceId: string, categoryId: string): string {
    return `${marketplaceId}:${categoryId}`;
  }

  /**
   * Check if cached entry is still valid
   */
  private isCacheValid(cached: CachedCategory): boolean {
    return Date.now() - cached.timestamp < CACHE_TTL;
  }

  /**
   * Suggest a category ID based on product title
   * Uses eBay Taxonomy API's suggestCategoryTree endpoint
   */
  async suggestCategoryId(
    title: string,
    marketplaceId: string = "EBAY_IT"
  ): Promise<string> {
    try {
      const token = await this.getAccessToken();
      const treeId = MARKETPLACE_TREE_IDS[marketplaceId];

      if (treeId === undefined) {
        throw new Error(
          `Unknown marketplace: ${marketplaceId}. Supported: ${Object.keys(MARKETPLACE_TREE_IDS).join(", ")}`
        );
      }

      const apiBase = process.env.EBAY_API_BASE ?? "https://api.ebay.com";
      const url = `${apiBase}/commerce/taxonomy/v1/category_tree/${treeId}/suggest_category?q=${encodeURIComponent(title)}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.warn(
          `[EbayCategoryService] Category suggestion failed for "${title}" (${response.status}): ${errorBody}`
        );
        // Return a fallback category ID if suggestion fails
        return "0"; // General category
      }

      const data = (await response.json()) as {
        categorySuggestions?: Array<{
          category: {
            categoryId: string;
            categoryName: string;
          };
          matchPercentage: string;
        }>;
      };

      // Return the best match (first suggestion)
      if (
        data.categorySuggestions &&
        data.categorySuggestions.length > 0 &&
        data.categorySuggestions[0].category
      ) {
        const categoryId = data.categorySuggestions[0].category.categoryId;
        console.log(
          `[EbayCategoryService] Suggested category for "${title}": ${categoryId}`
        );
        return categoryId;
      }

      // Fallback if no suggestions found
      console.warn(
        `[EbayCategoryService] No category suggestions found for "${title}"`
      );
      return "0";
    } catch (error) {
      console.error(
        `[EbayCategoryService] Error suggesting category for "${title}":`,
        error
      );
      // Return fallback category on error
      return "0";
    }
  }

  /**
   * Get required and recommended aspects for a category
   * Uses eBay Taxonomy API's getRequiredAndRecommendedAspects endpoint
   * Results are cached by marketplace and category ID
   */
  async getCategoryAspects(
    categoryId: string,
    marketplaceId: string = "EBAY_IT"
  ): Promise<CategoryAspect[]> {
    // Check cache first
    const cacheKey = this.getCacheKey(marketplaceId, categoryId);
    const cached = this.cache.get(cacheKey);

    if (cached && this.isCacheValid(cached)) {
      console.log(
        `[EbayCategoryService] Cache hit for ${cacheKey}: ${cached.aspects.length} aspects`
      );
      return cached.aspects;
    }

    try {
      const token = await this.getAccessToken();
      const treeId = MARKETPLACE_TREE_IDS[marketplaceId];

      if (treeId === undefined) {
        throw new Error(
          `Unknown marketplace: ${marketplaceId}. Supported: ${Object.keys(MARKETPLACE_TREE_IDS).join(", ")}`
        );
      }

      const apiBase = process.env.EBAY_API_BASE ?? "https://api.ebay.com";
      const url = `${apiBase}/commerce/taxonomy/v1/category_tree/${treeId}/get_required_and_recommended_aspects?category_id=${encodeURIComponent(categoryId)}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.warn(
          `[EbayCategoryService] Failed to fetch aspects for category ${categoryId} (${response.status}): ${errorBody}`
        );
        // Return empty array if fetch fails
        return [];
      }

      const data = (await response.json()) as {
        categoryId?: string;
        categoryName?: string;
        requiredAspects?: Array<{ aspectName: string }>;
        recommendedAspects?: Array<{ aspectName: string }>;
      };

      // Transform API response to our format
      const aspects: CategoryAspect[] = [];

      if (data.requiredAspects) {
        data.requiredAspects.forEach((aspect) => {
          aspects.push({
            name: aspect.aspectName,
            required: true,
            recommended: false,
          });
        });
      }

      if (data.recommendedAspects) {
        data.recommendedAspects.forEach((aspect) => {
          aspects.push({
            name: aspect.aspectName,
            required: false,
            recommended: true,
          });
        });
      }

      // Cache the result
      const cacheEntry: CachedCategory = {
        categoryId,
        categoryName: data.categoryName || "",
        aspects,
        timestamp: Date.now(),
      };

      this.cache.set(cacheKey, cacheEntry);

      console.log(
        `[EbayCategoryService] Fetched ${aspects.length} aspects for category ${categoryId} (${marketplaceId})`
      );

      return aspects;
    } catch (error) {
      console.error(
        `[EbayCategoryService] Error fetching aspects for category ${categoryId}:`,
        error
      );
      // Return empty array on error
      return [];
    }
  }

  /**
   * Clear cache (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.cache.clear();
    console.log("[EbayCategoryService] Cache cleared");
  }

  /**
   * Get cache statistics (for debugging)
   */
  getCacheStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    };
  }
}
