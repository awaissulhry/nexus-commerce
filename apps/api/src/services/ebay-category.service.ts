/**
 * eBay Category Service
 * Resolves real eBay categories and aspects via the Taxonomy API
 * Includes in-memory caching by marketplace and category ID
 */

import { recordApiCall } from './outbound-api-call-log.service.js'

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
  EBAY_ES: 186,
};

/** Y.1 — short marketplace codes the rest of the system uses
 *  ('IT', 'DE', etc.) → the EBAY_<CODE> form this service speaks.
 *  Lets the productType picker pass `marketplace='IT'` without
 *  every caller needing to know eBay's prefix convention. */
function normaliseMarketplace(marketplace: string | null): string {
  if (!marketplace) return 'EBAY_US'
  const upper = marketplace.toUpperCase()
  if (upper.startsWith('EBAY_')) return upper
  return `EBAY_${upper}`
}

/** Y.1 — public type matching ProductTypesService.ProductTypeListItem
 *  so listProductTypes can spread eBay results into the same shape
 *  the Amazon path returns. */
export interface EbayCategoryListItem {
  productType: string
  displayName: string
  bundled: boolean
  matchPercentage?: number
}

/** Y.1 — multi-suggestion cache. eBay's suggest_category endpoint
 *  returns up to 10 ranked categories per query; we cache the full
 *  array per (marketplace, query) so retyping the same search hits
 *  cache. Search-result caching also doubles as our "manual refresh"
 *  store via forceRefresh. */
interface CachedSearch {
  items: EbayCategoryListItem[]
  expiresAt: number
}

/** Z.1 — rich aspect schema (data types + enum values + cardinality)
 *  fetched via get_item_aspects_for_category. The simpler aspects
 *  shape returned by getCategoryAspects (just name + required) stays
 *  alongside this for legacy callers (workers/listings.ts). */
export interface EbayAspectRich {
  name: string
  /** English label fetched with Accept-Language: en-US. Undefined when
   *  the marketplace is already English or when the parallel fetch fails. */
  englishName?: string
  dataType: 'STRING' | 'NUMBER' | 'DATE' | string
  mode: 'FREE_TEXT' | 'SELECTION_ONLY' | string
  usage: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL' | string
  required: boolean
  maxLength?: number
  cardinality: 'SINGLE' | 'MULTI' | string
  variantEligible: boolean
  values: string[]
}

interface CachedRichAspects {
  aspects: EbayAspectRich[]
  expiresAt: number
}

export interface EbayConditionPolicy {
  /** eBay's numeric condition id, e.g. "1000" = NEW. */
  conditionId: string
  /** Localised label for the user, e.g. "New" / "Nuovo". */
  conditionDescription: string
}

interface CachedConditionPolicies {
  conditions: EbayConditionPolicy[]
  expiresAt: number
}

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

export class EbayCategoryService {
  private cache: Map<string, CachedCategory> = new Map();
  private searchCache: Map<string, CachedSearch> = new Map();
  private richCache: Map<string, CachedRichAspects> = new Map();
  // GG.1 — condition policies per (marketplace, categoryId).
  private conditionCache: Map<string, CachedConditionPolicies> = new Map();
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  /** Y.1 — return multiple ranked category candidates for a search
   *  query. Used by the productType picker so users see a real
   *  dropdown of eBay categories, not just one auto-pick.
   *
   *  eBay's suggest_category endpoint requires a query (q) and
   *  returns up to 10 ranked candidates. Empty queries return [].
   *  Cached per (marketplace, query.toLowerCase()) for 24h to avoid
   *  re-hitting eBay on retypes; forceRefresh skips the cache.
   *
   *  Falls back to [] (not throw) when SP-API equivalent isn't
   *  configured — the picker treats an empty list as "no matches"
   *  and the user can still type a raw category id manually
   *  through the modal's free-text fallback for unsupported channels.
   */
  async searchCategories(
    marketplace: string | null,
    query: string,
    options?: {
      forceRefresh?: boolean
      limit?: number
      /** HH — when true, throws on auth/network/API errors instead
       *  of swallowing them as []. Routes that want to surface a
       *  real error to the UI pass throwOnError; legacy callers that
       *  expected silent [] don't, preserving back-compat. */
      throwOnError?: boolean
    },
  ): Promise<EbayCategoryListItem[]> {
    const trimmed = query.trim()
    if (trimmed.length < 2) return []
    const marketplaceId = normaliseMarketplace(marketplace)
    const treeId = MARKETPLACE_TREE_IDS[marketplaceId]
    if (treeId === undefined) {
      const msg = `Unknown eBay marketplace: ${marketplaceId}. Supported: ${Object.keys(MARKETPLACE_TREE_IDS).join(', ')}`
      console.warn(`[EbayCategoryService] ${msg}`)
      if (options?.throwOnError) throw new Error(msg)
      return []
    }
    const cacheKey = `${marketplaceId}:${trimmed.toLowerCase()}`
    if (!options?.forceRefresh) {
      const cached = this.searchCache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        return options?.limit ? cached.items.slice(0, options.limit) : cached.items
      }
    }
    let token: string
    try {
      token = await this.getAccessToken()
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err)
      console.warn(
        `[EbayCategoryService] No token available for searchCategories: ${msg}`,
      )
      if (options?.throwOnError) throw new Error(`auth: ${msg}`)
      return []
    }
    const apiBase = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'
    const url = `${apiBase}/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(
      trimmed,
    )}`
    let json: {
      categorySuggestions?: Array<{
        category?: { categoryId?: string; categoryName?: string }
        categoryTreeNodeAncestors?: Array<{ categoryName?: string }>
        matchPercentage?: number | string
      }>
    } | null
    try {
      json = await recordApiCall<{
        categorySuggestions?: Array<{
          category?: { categoryId?: string; categoryName?: string }
          categoryTreeNodeAncestors?: Array<{ categoryName?: string }>
          matchPercentage?: number | string
        }>
      } | null>(
        {
          channel: 'EBAY',
          operation: 'getCategorySuggestions',
          endpoint: `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions`,
          method: 'GET',
          marketplace: marketplaceId,
          triggeredBy: 'api',
        },
        async () => {
          const res = await fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          })
          if (!res.ok) {
            const errorBody = await res.text().catch(() => '')
            const err = new Error(
              `eBay API error ${res.status}: ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string }
            err.statusCode = res.status
            err.body = errorBody
            throw err
          }
          return (await res.json().catch(() => null)) as {
            categorySuggestions?: Array<{
              category?: { categoryId?: string; categoryName?: string }
              categoryTreeNodeAncestors?: Array<{ categoryName?: string }>
              matchPercentage?: number | string
            }>
          } | null
        },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = (err as { statusCode?: number })?.statusCode
      if (status != null) {
        console.warn(
          `[EbayCategoryService] searchCategories ${status}: ${msg.slice(0, 300)}`,
        )
        if (options?.throwOnError) {
          throw new Error(`eBay ${status}: ${msg.slice(0, 200)}`)
        }
      } else {
        console.warn(
          `[EbayCategoryService] searchCategories network error: ${msg}`,
        )
        if (options?.throwOnError) throw new Error(`network: ${msg}`)
      }
      return []
    }
    const suggestions = json?.categorySuggestions ?? []
    const items: EbayCategoryListItem[] = []
    for (const s of suggestions) {
      const id = s?.category?.categoryId
      const name = s?.category?.categoryName
      if (!id || !name) continue
      // Build a path-style display name: "Clothing › Men > Coats &
      // Jackets" so users can disambiguate sibling category names
      // (eBay's "Helmets" exists under several parents).
      const ancestors = (s.categoryTreeNodeAncestors ?? [])
        .map((a) => a.categoryName)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
        .reverse() // ancestors come root-last from eBay; reverse so the path reads top-down
      const path = [...ancestors, name].join(' › ')
      const matchRaw = s.matchPercentage
      const matchPct =
        typeof matchRaw === 'number'
          ? matchRaw
          : typeof matchRaw === 'string'
          ? Number(matchRaw)
          : undefined
      items.push({
        productType: id,
        displayName: path,
        bundled: false,
        matchPercentage:
          typeof matchPct === 'number' && !Number.isNaN(matchPct)
            ? matchPct
            : undefined,
      })
    }
    this.searchCache.set(cacheKey, {
      items,
      expiresAt: Date.now() + CACHE_TTL,
    })
    return options?.limit ? items.slice(0, options.limit) : items
  }

  /**
   * HH — get a valid access token for Taxonomy / Metadata API calls.
   *
   * Strategy (in order):
   *  1. Use the seller's OAuth token from an active EBAY
   *     ChannelConnection. The user already linked their eBay
   *     account in Settings — that token is good for Taxonomy +
   *     Metadata API calls, and refreshes automatically via
   *     ebayAuthService.
   *  2. Fall back to a Client Credentials (app-only) token using
   *     EBAY_APP_ID + EBAY_CERT_ID. Only useful for catalog/taxonomy
   *     queries, not seller-scoped writes. Skipped when the env
   *     values are blank or look like the placeholder strings the
   *     repo's .env.example ships with.
   *
   * Both paths fail with a SPECIFIC error message so the route can
   * surface it to the UI instead of returning an empty list that
   * looks like "no results."
   */
  private async getAccessToken(): Promise<string> {
    // 1. Prefer the seller's OAuth token. We import lazily to avoid
    //    a circular-import / load-order issue with ebayAuthService.
    try {
      const { default: prisma } = await import('../db.js')
      const conn = await prisma.channelConnection.findFirst({
        where: { channelType: 'EBAY', isActive: true },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, ebayAccessToken: true, ebayRefreshToken: true },
      })
      if (conn && conn.ebayAccessToken && conn.ebayRefreshToken) {
        const { ebayAuthService } = await import('./ebay-auth.service.js')
        return await ebayAuthService.getValidToken(conn.id)
      }
    } catch (err) {
      // Fall through to client-credentials. Don't swallow — log so
      // ops can see the connection-token attempt was tried.
      console.warn(
        '[EbayCategoryService] Connection-token path failed, falling back to client-credentials:',
        err instanceof Error ? err.message : String(err),
      )
    }

    // 2. Cached client-credentials token still valid?
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const appId = process.env.EBAY_APP_ID;
    const certId = process.env.EBAY_CERT_ID;
    const looksLikePlaceholder = (v?: string) =>
      !v || v === 'your_app_id' || v === 'your_cert_id' || v.length < 8

    if (looksLikePlaceholder(appId) || looksLikePlaceholder(certId)) {
      throw new Error(
        'No eBay credentials available. Either link an eBay account in /settings/channels (preferred) or set real EBAY_APP_ID + EBAY_CERT_ID env vars.',
      );
    }

    const credentials = Buffer.from(`${appId}:${certId}`).toString("base64");
    const authUrl = process.env.EBAY_AUTH_URL ?? "https://api.ebay.com/identity/v1/oauth2/token";

    try {
      const data = await recordApiCall<{
        access_token: string;
        expires_in: number;
      }>(
        {
          channel: 'EBAY',
          operation: 'clientCredentialsToken',
          endpoint: '/identity/v1/oauth2/token',
          method: 'POST',
          triggeredBy: 'api',
        },
        async () => {
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
            const errorBody = await response.text().catch(() => "");
            const err = new Error(
              `eBay OAuth token request failed (${response.status}): ${errorBody.slice(0, 300)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = response.status;
            err.body = errorBody;
            throw err;
          }

          return (await response.json()) as {
            access_token: string;
            expires_in: number;
          };
        },
      );
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

      let data: {
        categorySuggestions?: Array<{
          category: {
            categoryId: string;
            categoryName: string;
          };
          matchPercentage: string;
        }>;
      };
      try {
        data = await recordApiCall<{
          categorySuggestions?: Array<{
            category: {
              categoryId: string;
              categoryName: string;
            };
            matchPercentage: string;
          }>;
        }>(
          {
            channel: 'EBAY',
            operation: 'suggestCategory',
            endpoint: `/commerce/taxonomy/v1/category_tree/${treeId}/suggest_category`,
            method: 'GET',
            marketplace: marketplaceId,
            triggeredBy: 'api',
          },
          async () => {
            const response = await fetch(url, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            });

            if (!response.ok) {
              const errorBody = await response.text().catch(() => "");
              const err = new Error(
                `eBay API error ${response.status}: ${errorBody.slice(0, 500)}`,
              ) as Error & { statusCode: number; body: string };
              err.statusCode = response.status;
              err.body = errorBody;
              throw err;
            }

            return (await response.json()) as {
              categorySuggestions?: Array<{
                category: {
                  categoryId: string;
                  categoryName: string;
                };
                matchPercentage: string;
              }>;
            };
          },
        );
      } catch (err) {
        console.warn(
          `[EbayCategoryService] Category suggestion failed for "${title}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return "0";
      }

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

      let data: {
        categoryId?: string;
        categoryName?: string;
        requiredAspects?: Array<{ aspectName: string }>;
        recommendedAspects?: Array<{ aspectName: string }>;
      };
      try {
        data = await recordApiCall<{
          categoryId?: string;
          categoryName?: string;
          requiredAspects?: Array<{ aspectName: string }>;
          recommendedAspects?: Array<{ aspectName: string }>;
        }>(
          {
            channel: 'EBAY',
            operation: 'getRequiredAndRecommendedAspects',
            endpoint: `/commerce/taxonomy/v1/category_tree/${treeId}/get_required_and_recommended_aspects`,
            method: 'GET',
            marketplace: marketplaceId,
            triggeredBy: 'api',
          },
          async () => {
            const response = await fetch(url, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            });

            if (!response.ok) {
              const errorBody = await response.text().catch(() => "");
              const err = new Error(
                `eBay API error ${response.status}: ${errorBody.slice(0, 500)}`,
              ) as Error & { statusCode: number; body: string };
              err.statusCode = response.status;
              err.body = errorBody;
              throw err;
            }

            return (await response.json()) as {
              categoryId?: string;
              categoryName?: string;
              requiredAspects?: Array<{ aspectName: string }>;
              recommendedAspects?: Array<{ aspectName: string }>;
            };
          },
        );
      } catch (err) {
        console.warn(
          `[EbayCategoryService] Failed to fetch aspects for category ${categoryId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [];
      }

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
   * Z.1 — full aspect schema for a category (data types, enum values,
   * cardinality, max length). Drives the schema-editor / bulk grid
   * the same way Amazon's CategorySchema does. The simpler
   * getCategoryAspects() above stays for callers that only need the
   * required/recommended name list.
   *
   * Endpoint: get_item_aspects_for_category. Cached per
   * (marketplace, categoryId) for 24h via richCache.
   */
  async getCategoryAspectsRich(
    categoryId: string,
    marketplace: string | null,
    options?: {
      forceRefresh?: boolean
      cacheOnly?: boolean
      /** HH — propagate auth/network/API errors to the caller
       *  instead of returning []. The Step 4 schema endpoint sets
       *  this so the wizard surfaces a real error banner. */
      throwOnError?: boolean
    },
  ): Promise<EbayAspectRich[]> {
    const marketplaceId = normaliseMarketplace(marketplace);
    const treeId = MARKETPLACE_TREE_IDS[marketplaceId];
    if (treeId === undefined) {
      const msg = `Unknown eBay marketplace: ${marketplaceId}`;
      console.warn(`[EbayCategoryService] ${msg}`);
      if (options?.throwOnError) throw new Error(msg);
      return [];
    }
    const key = `${marketplaceId}:${categoryId}`;
    if (!options?.forceRefresh) {
      const cached = this.richCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.aspects;
      }
    }
    // BB.1 — cache-only mode skips the live eBay API call when the
    // cache misses. Used by the field-registry's bulk-grid path so a
    // cold categoryId returns [] quickly instead of blocking the page
    // load on a slow API call. The dedicated prewarm endpoint warms
    // the cache asynchronously; the next /api/pim/fields tick picks
    // up the populated entries.
    if (options?.cacheOnly) {
      return [];
    }
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[EbayCategoryService] No token for getCategoryAspectsRich: ${msg}`,
      );
      if (options?.throwOnError) throw new Error(`auth: ${msg}`);
      return [];
    }
    const apiBase = process.env.EBAY_API_BASE ?? "https://api.ebay.com";
    const url = `${apiBase}/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${encodeURIComponent(
      categoryId,
    )}`;
    let json: {
      aspects?: Array<{
        localizedAspectName?: string;
        aspectConstraint?: {
          aspectDataType?: string;
          aspectMode?: string;
          aspectRequired?: boolean;
          aspectUsage?: string;
          aspectMaxLength?: number;
          itemToAspectCardinality?: string;
          aspectEnabledForVariations?: boolean;
        };
        aspectValues?: Array<{ localizedValue?: string }>;
      }>;
    } | null;
    try {
      json = await recordApiCall<{
        aspects?: Array<{
          localizedAspectName?: string;
          aspectConstraint?: {
            aspectDataType?: string;
            aspectMode?: string;
            aspectRequired?: boolean;
            aspectUsage?: string;
            aspectMaxLength?: number;
            itemToAspectCardinality?: string;
            aspectEnabledForVariations?: boolean;
          };
          aspectValues?: Array<{ localizedValue?: string }>;
        }>;
      } | null>(
        {
          channel: 'EBAY',
          operation: 'getItemAspectsForCategory',
          endpoint: `/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category`,
          method: 'GET',
          marketplace: marketplaceId,
          triggeredBy: 'api',
        },
        async () => {
          const res = await fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          });
          if (!res.ok) {
            const errorBody = await res.text().catch(() => "");
            const err = new Error(
              `eBay API error ${res.status}: ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = res.status;
            err.body = errorBody;
            throw err;
          }
          return (await res.json().catch(() => null)) as {
            aspects?: Array<{
              localizedAspectName?: string;
              aspectConstraint?: {
                aspectDataType?: string;
                aspectMode?: string;
                aspectRequired?: boolean;
                aspectUsage?: string;
                aspectMaxLength?: number;
                itemToAspectCardinality?: string;
                aspectEnabledForVariations?: boolean;
              };
              aspectValues?: Array<{ localizedValue?: string }>;
            }>;
          } | null;
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { statusCode?: number })?.statusCode;
      if (status != null) {
        console.warn(
          `[EbayCategoryService] getCategoryAspectsRich ${status}: ${msg.slice(0, 300)}`,
        );
        if (options?.throwOnError) {
          throw new Error(`eBay ${status}: ${msg.slice(0, 200)}`);
        }
      } else {
        console.warn(
          `[EbayCategoryService] getCategoryAspectsRich network error: ${msg}`,
        );
        if (options?.throwOnError) throw new Error(`network: ${msg}`);
      }
      return [];
    }
    const rows = json?.aspects ?? [];

    // For non-English marketplaces, fetch English aspect names in parallel so
    // the UI can show "Marca (Brand)" and "Taglia (Size)" alongside the local
    // label. Accept-Language: en-US asks the same tree for English labels —
    // same category IDs, same structure, different locale strings.
    const isEnglishMarket = ['EBAY_UK', 'EBAY_US', 'EBAY_AU', 'EBAY_CA'].includes(marketplaceId)
    let englishNames: Map<number, string> = new Map()
    if (!isEnglishMarket) {
      try {
        const enRes = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept-Language': 'en-US',
          },
        })
        if (enRes.ok) {
          const enJson = await enRes.json().catch(() => null) as any
          const enRows: any[] = enJson?.aspects ?? []
          enRows.forEach((a: any, i: number) => {
            if (typeof a?.localizedAspectName === 'string') {
              englishNames.set(i, a.localizedAspectName)
            }
          })
        }
      } catch {
        // non-fatal — English names are a best-effort enhancement
      }
    }

    const aspects: EbayAspectRich[] = [];
    rows.forEach((a: any, i: number) => {
      const name = a?.localizedAspectName;
      if (!name) return;
      const c = a.aspectConstraint ?? {};
      const englishName = englishNames.get(i)
      aspects.push({
        name,
        // Only store englishName when it differs from the localized label
        ...(englishName && englishName !== name ? { englishName } : {}),
        dataType: (c.aspectDataType ?? "STRING") as EbayAspectRich["dataType"],
        mode: (c.aspectMode ?? "FREE_TEXT") as EbayAspectRich["mode"],
        required: !!c.aspectRequired,
        usage:
          (c.aspectUsage as EbayAspectRich["usage"]) ?? "RECOMMENDED",
        maxLength:
          typeof c.aspectMaxLength === "number" ? c.aspectMaxLength : undefined,
        cardinality: (c.itemToAspectCardinality ?? "SINGLE") as EbayAspectRich["cardinality"],
        variantEligible: !!c.aspectEnabledForVariations,
        values: (a.aspectValues ?? [])
          .map((v: any) => v.localizedValue)
          .filter((v: any): v is string => typeof v === "string" && v.length > 0),
      });
    });
    this.richCache.set(key, {
      aspects,
      expiresAt: Date.now() + CACHE_TTL,
    });
    return aspects;
  }

  /**
   * GG.1 — fetch eBay's allowed item conditions for a given category.
   * Endpoint: get_item_condition_policies. Categories vary widely:
   * "New" handhelds vs antique books take very different condition
   * sets, and submitting an unsupported one is a publish error.
   *
   * Cached per (marketplace, categoryId) for 24h.
   */
  async getItemConditionPolicies(
    categoryId: string,
    marketplace: string | null,
  ): Promise<EbayConditionPolicy[]> {
    const marketplaceId = normaliseMarketplace(marketplace);
    const key = `${marketplaceId}:${categoryId}`;
    const cached = this.conditionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.conditions;
    }
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err) {
      console.warn(
        `[EbayCategoryService] No token for getItemConditionPolicies: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
    const apiBase = process.env.EBAY_API_BASE ?? "https://api.ebay.com";
    const url = `${apiBase}/sell/metadata/v1/marketplace/${marketplaceId}/get_item_condition_policies?filter=${encodeURIComponent(
      `categoryIds:{${categoryId}}`,
    )}`;
    let json: {
      itemConditionPolicies?: Array<{
        categoryId?: string;
        itemConditions?: Array<{
          conditionId?: string;
          conditionDescription?: string;
        }>;
      }>;
    } | null;
    try {
      json = await recordApiCall<{
        itemConditionPolicies?: Array<{
          categoryId?: string;
          itemConditions?: Array<{
            conditionId?: string;
            conditionDescription?: string;
          }>;
        }>;
      } | null>(
        {
          channel: 'EBAY',
          operation: 'getItemConditionPolicies',
          endpoint: `/sell/metadata/v1/marketplace/${marketplaceId}/get_item_condition_policies`,
          method: 'GET',
          marketplace: marketplaceId,
          triggeredBy: 'api',
        },
        async () => {
          const res = await fetch(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              "Accept-Language": "en-US",
            },
          });
          if (!res.ok) {
            const errorBody = await res.text().catch(() => "");
            const err = new Error(
              `eBay API error ${res.status}: ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = res.status;
            err.body = errorBody;
            throw err;
          }
          return (await res.json().catch(() => null)) as {
            itemConditionPolicies?: Array<{
              categoryId?: string;
              itemConditions?: Array<{
                conditionId?: string;
                conditionDescription?: string;
              }>;
            }>;
          } | null;
        },
      );
    } catch (err) {
      console.warn(
        `[EbayCategoryService] getItemConditionPolicies error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
    const row = (json?.itemConditionPolicies ?? []).find(
      (r) => r.categoryId === categoryId,
    );
    const conditions: EbayConditionPolicy[] = (row?.itemConditions ?? [])
      .map((c) => ({
        conditionId: c.conditionId ?? "",
        conditionDescription: c.conditionDescription ?? "",
      }))
      .filter((c) => c.conditionId.length > 0);
    this.conditionCache.set(key, {
      conditions,
      expiresAt: Date.now() + CACHE_TTL,
    });
    return conditions;
  }

  /**
   * Clear cache (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.cache.clear();
    this.searchCache.clear();
    this.richCache.clear();
    this.conditionCache.clear();
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
